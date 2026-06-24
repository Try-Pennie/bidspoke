-- ============================================================
-- Daily reduced-finalize of stranded sightings (#343 / #309 Phase 4)
-- ============================================================
-- ~5% of leads/day strand: finalizeSighting runs in a post-response waitUntil
-- that the Worker isolate can be evicted before it completes, leaving the
-- lead_sightings row outcome_state='in_flight' on an execution that actually
-- COMPLETED (lead was served). The nightly Snowflake export then falsifies these
-- to outcome='abandoned' with null winner/bid/enrichment — real money-outcome
-- facts recorded wrong (Phase 0).
--
-- This drains the recoverable subset: in_flight rows whose execution still exists
-- (workflow_executions retains ~7 days) and completed. It writes a REDUCED
-- finalize derived purely from already-persisted workflow_executions columns
-- (no ctx.steps needed): outcome, terminal node, response status, duration. The
-- distinct reject_reason='reduced_finalize' marks these as reconstructed (vs a
-- full live finalize) so they stay auditable.
--
-- It must run DAILY: workflow_executions purges at ~7 days, so a strand must be
-- reduced-finalized before its execution row is gone. Strands older than the
-- exec-log window (~72K, May 7–Jun 16 as of 2026-06-24) are NOT recoverable here
-- and are handled separately (honest relabel).

CREATE OR REPLACE FUNCTION public.reduce_finalize_stranded(p_lookback_days int DEFAULT 8)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  UPDATE lead_sightings s
  SET outcome_state = 'finalized',
      outcome = COALESCE(e.outcome, s.outcome),
      terminal_node_label = COALESCE(e.final_node_namespace, s.terminal_node_label),
      response_status_code = COALESCE(e.response_status, s.response_status_code),
      duration_ms = COALESCE(e.duration_ms, s.duration_ms),
      reject_reason = 'reduced_finalize',
      updated_at = now()
  FROM workflow_executions e
  WHERE s.execution_id = e.id
    AND e.status = 'completed'
    AND s.outcome_state = 'in_flight'
    -- Bound to the partition key so we only scan recoverable (recent) strands,
    -- not the unrecoverable historical backlog.
    AND s.execution_started_at_utc >= now() - make_interval(days => p_lookback_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'reduce_finalize_stranded: finalized % stranded sighting(s)', n;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reduce_finalize_stranded(int) TO service_role;

-- Daily at 08:00 UTC, ahead of the 09:00 UTC Snowflake export, so recovered rows
-- export as finalized (reject_reason='reduced_finalize') instead of being
-- falsified to 'abandoned'. Idempotent: re-running only touches still-in_flight
-- rows. unschedule-first so re-applying the migration doesn't duplicate the job.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reduce-finalize-stranded'; END $$;
SELECT cron.schedule(
  'reduce-finalize-stranded',
  '0 8 * * *',
  'SELECT public.reduce_finalize_stranded(8)'
);
