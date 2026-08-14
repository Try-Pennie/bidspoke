-- ============================================================
-- Daily finalize of UNRECOVERABLE stranded sightings (#351 / #343 / #309 Phase 4)
-- ============================================================
-- Companion to reduce_finalize_stranded (the 08:00 recoverable drain). After that
-- drain finalizes in_flight rows whose execution still exists and completed, the
-- remaining old in_flight rows are UNRECOVERABLE: their workflow_executions row is
-- purged (~7-day retention) or never completed, so the real outcome can't be
-- reconstructed.
--
-- The previous mechanism (sweepStaleInFlightSightings in the Worker export) ran
-- these as outcome='abandoned'/'never_finalized' through the PostgREST gateway,
-- where the ~72K-row multi-partition UPDATE exceeded the Worker's statement_timeout
-- and FAILED SILENTLY (#351) — which is a big reason the strand backlog grew to
-- 104K. That ceiling is service_role's 30s, not the 8s originally written here
-- (#614): 8s is the authenticator/authenticated limit, and the Worker authenticates
-- with SUPABASE_SECRET_KEY. Moving it DB-side as a pg_cron function (which runs as
-- postgres, with no role-level override, so the 120s cluster default) makes the big
-- UPDATE complete, and the honest label reject_reason='strand_unrecoverable' (with
-- outcome left NULL = unknown) replaces the falsifying 'abandoned' marker (Dan's
-- 'label honestly' decision). On its first run this also drains the existing
-- historical backlog (~72K as of 2026-06-24).

CREATE OR REPLACE FUNCTION public.finalize_unrecoverable_stranded(p_min_age_hours int DEFAULT 26)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  -- Only in_flight rows old enough that any completed execution would already
  -- have been caught by reduce_finalize_stranded, so what remains is genuinely
  -- unrecoverable. Bounded to the partition floor for partition pruning.
  UPDATE lead_sightings
  SET outcome_state = 'finalized',
      reject_reason = 'strand_unrecoverable',
      updated_at = now()
  WHERE outcome_state = 'in_flight'
    AND is_test = false
    AND execution_started_at_utc < now() - make_interval(hours => p_min_age_hours)
    AND execution_started_at_utc >= now() - interval '95 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'finalize_unrecoverable_stranded: labeled % unrecoverable sighting(s)', n;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.finalize_unrecoverable_stranded(int) TO service_role;

-- Daily at 08:30 UTC, AFTER the 08:00 recoverable drain (reduce_finalize_stranded)
-- and BEFORE the 09:00 export, so recoverable rows are recovered first and only
-- the genuinely-unrecoverable remainder is labeled. unschedule-first for idempotent
-- re-apply.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'finalize-unrecoverable-stranded'; END $$;
SELECT cron.schedule(
  'finalize-unrecoverable-stranded',
  '30 8 * * *',
  'SELECT public.finalize_unrecoverable_stranded(26)'
);
