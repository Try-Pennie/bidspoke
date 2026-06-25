-- ============================================================
-- Rich recovery of stranded sightings + winner-flip (#360 / #353 Phase 2)
-- ============================================================
-- Phase 1 (#353) now projects the full finalize (winner/bid/enrichment/
-- reject_reason/outcome) onto workflow_executions.sighting_finalize at the
-- execution-record write, which survives the isolate eviction that strands the
-- live finalizeSighting. This upgrades the daily drain from a REDUCED finalize
-- (scalar columns only, null winner/bid/enrichment) to a FULL-fidelity recovery
-- from that projection, and flips the winning bid the reduced drain dropped. It
-- also runs every 30 min instead of once daily, so strands recover within minutes
-- (the in_flight window shrinks) rather than waiting for the 08:00 run.
--
-- Audit marker: reject_reason now carries the REAL reason (or NULL for a winner),
-- not the 'reduced_finalize' placeholder, so a new column records the recovery
-- source instead: NULL = written by the live finalize; 'rich' = drain recovered
-- from the projection; 'reduced' = drain recovered without a projection (strands
-- from before Phase 1, scalar fields only).

ALTER TABLE lead_sightings ADD COLUMN IF NOT EXISTS recovered_by text;

CREATE OR REPLACE FUNCTION public.reduce_finalize_stranded(p_lookback_days int DEFAULT 8)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  -- Recover the full finalize from the sighting_finalize projection; fall back to
  -- the scalar workflow_executions columns + a 'reduced' marker when it's absent.
  UPDATE lead_sightings s
  SET outcome_state        = 'finalized',
      outcome              = COALESCE(e.sighting_finalize->>'outcome', e.outcome, s.outcome),
      terminal_node_id     = COALESCE(e.sighting_finalize->>'terminal_node_id', s.terminal_node_id),
      terminal_node_label  = COALESCE(e.sighting_finalize->>'terminal_node_label', e.final_node_namespace, s.terminal_node_label),
      response_status_code = COALESCE((e.sighting_finalize->>'response_status_code')::int, e.response_status, s.response_status_code),
      duration_ms          = COALESCE(e.duration_ms, s.duration_ms),
      prospect_id          = COALESCE(e.sighting_finalize->>'prospect_id', s.prospect_id),
      equifax_status       = COALESCE(e.sighting_finalize->>'equifax_status', s.equifax_status),
      equifax_error_type   = COALESCE(e.sighting_finalize->>'equifax_error_type', s.equifax_error_type),
      equifax_score        = COALESCE((e.sighting_finalize->>'equifax_score')::int, s.equifax_score),
      winning_partner_slug = COALESCE(e.sighting_finalize->>'winning_partner_slug', s.winning_partner_slug),
      winning_bid_cents    = COALESCE((e.sighting_finalize->>'winning_bid_cents')::int, s.winning_bid_cents),
      partners_attempted   = COALESCE((e.sighting_finalize->>'partners_attempted')::int, s.partners_attempted),
      partners_responded   = COALESCE((e.sighting_finalize->>'partners_responded')::int, s.partners_responded),
      reject_reason        = CASE
                               WHEN e.sighting_finalize IS NOT NULL THEN e.sighting_finalize->>'reject_reason'
                               ELSE 'reduced_finalize'
                             END,
      recovered_by         = CASE WHEN e.sighting_finalize IS NOT NULL THEN 'rich' ELSE 'reduced' END,
      updated_at           = now()
  FROM workflow_executions e
  WHERE s.execution_id = e.id
    AND e.status = 'completed'
    AND s.outcome_state = 'in_flight'
    -- Bound to the partition key so we only scan recoverable (recent) strands.
    AND s.execution_started_at_utc >= now() - make_interval(days => p_lookback_days);
  GET DIAGNOSTICS n = ROW_COUNT;

  -- Flip the winning bid for rich-recovered rows whose projection named a winner,
  -- mirroring finalizeSighting's winner UPDATE (set is_winner + re-queue export by
  -- nulling exported_at so the corrected flag re-MERGEs to Snowflake). Idempotent:
  -- only touches is_winner=false rows. recovered_by='rich' means the live finalize
  -- never ran, so its bid was never flipped. Bounded to the lookback for pruning.
  UPDATE lead_sighting_bids b
  SET is_winner = true, exported_at = NULL
  FROM lead_sightings s
  JOIN workflow_executions e ON e.id = s.execution_id
  WHERE b.execution_id = s.execution_id
    AND b.partner_slug = e.sighting_finalize->>'winning_partner_slug'
    AND s.recovered_by = 'rich'
    AND s.winning_partner_slug IS NOT NULL
    AND b.is_winner = false
    AND b.attempted_at_utc >= now() - make_interval(days => p_lookback_days);

  RAISE NOTICE 'reduce_finalize_stranded: finalized % stranded sighting(s)', n;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reduce_finalize_stranded(int) TO service_role;

-- Run every 30 min (was daily 08:00) so strands recover within minutes. The 08:30
-- unrecoverable relabel and 09:00 Snowflake export are unaffected; the recoverable
-- drain is idempotent so the extra runs only touch newly-stranded in_flight rows.
-- unschedule-first so re-applying doesn't duplicate the job.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reduce-finalize-stranded'; END $$;
SELECT cron.schedule(
  'reduce-finalize-stranded',
  '*/30 * * * *',
  'SELECT public.reduce_finalize_stranded(8)'
);
