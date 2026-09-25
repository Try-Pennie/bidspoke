-- How far behind the sightings buffer is, per table, for the daily watchdog
-- (#463).
--
-- WHY. lead_sightings, lead_sighting_bids and achieve_evaluations are a write
-- buffer: exported to Snowflake, then purged a day later. On 2026-07-01 the
-- purge had silently failed to keep up for about a month (2.3M un-purged
-- lead_sightings rows) and surfaced only when an unbounded DELETE hit the
-- statement timeout. Nothing measured the two ways the buffer falls behind:
--   waiting  rows the export should have shipped by now and has not;
--   overdue  rows exported long enough ago that the purge should have removed
--            them, still sitting in Supabase.
--
-- THE FILTERS ARE THE EXPORT'S OWN. "Waiting" uses the predicate each export
-- selects by (sightings-export.ts runSightingsExport, achieve-export.ts
-- runAchieveExport), so a row the export deliberately never ships (a test row,
-- an in-flight sighting, an Achieve sandbox row, a row set aside because
-- Snowflake refused it, which has its own alert, #427) is never counted as late.
-- "Overdue" uses the purge's predicate (exported_at IS NOT NULL, older than a
-- cutoff). If either filter changes, change it here too.
--
-- THE CUTOFFS COME FROM THE CALLER, so the per-table thresholds live in one
-- place in the Worker (sightings-buffer-lag.ts) and this function answers only
-- what it measured.
--
-- CAPPED COUNTS. An exact count over a large backlog is the query shape that
-- times out on exactly the day it is needed (sightings-export.ts,
-- purgeableBacklogExists). Each count stops at p_cap, so the answer is "at
-- least p_cap" on a bad day rather than no answer. Both counts and both oldest
-- values are read through the existing partial indexes (the export index on the
-- partition key WHERE exported_at IS NULL, and the purge index on exported_at
-- WHERE exported_at IS NOT NULL).
--
-- NAMES. p_table selects one of three fixed statements; anything else raises.
-- No caller text reaches SQL (L702: an unlisted value must raise, never return
-- zeros that read as healthy).

CREATE OR REPLACE FUNCTION public.sightings_buffer_lag(
  p_table           TEXT,
  p_waiting_before  TIMESTAMP,
  p_exported_before TIMESTAMPTZ,
  p_cap             INTEGER DEFAULT 10001
) RETURNS TABLE (
  waiting_rows       BIGINT,
  oldest_waiting     TIMESTAMP,
  overdue_rows       BIGINT,
  oldest_exported_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_table = 'lead_sightings' THEN
    RETURN QUERY SELECT
      (SELECT count(*) FROM (SELECT 1 FROM public.lead_sightings
         WHERE outcome_state = 'finalized' AND exported_at IS NULL AND export_rejected_at IS NULL AND NOT is_test
           AND execution_started_at_utc < p_waiting_before LIMIT p_cap) w),
      (SELECT min(execution_started_at_utc) FROM public.lead_sightings
         WHERE outcome_state = 'finalized' AND exported_at IS NULL AND export_rejected_at IS NULL AND NOT is_test
           AND execution_started_at_utc < p_waiting_before),
      (SELECT count(*) FROM (SELECT 1 FROM public.lead_sightings
         WHERE exported_at IS NOT NULL AND exported_at < p_exported_before LIMIT p_cap) o),
      (SELECT min(exported_at) FROM public.lead_sightings
         WHERE exported_at IS NOT NULL AND exported_at < p_exported_before);
  ELSIF p_table = 'lead_sighting_bids' THEN
    RETURN QUERY SELECT
      (SELECT count(*) FROM (SELECT 1 FROM public.lead_sighting_bids
         WHERE exported_at IS NULL AND export_rejected_at IS NULL AND NOT is_test
           AND attempted_at_utc < p_waiting_before LIMIT p_cap) w),
      (SELECT min(attempted_at_utc) FROM public.lead_sighting_bids
         WHERE exported_at IS NULL AND export_rejected_at IS NULL AND NOT is_test
           AND attempted_at_utc < p_waiting_before),
      (SELECT count(*) FROM (SELECT 1 FROM public.lead_sighting_bids
         WHERE exported_at IS NOT NULL AND exported_at < p_exported_before LIMIT p_cap) o),
      (SELECT min(exported_at) FROM public.lead_sighting_bids
         WHERE exported_at IS NOT NULL AND exported_at < p_exported_before);
  ELSIF p_table = 'achieve_evaluations' THEN
    RETURN QUERY SELECT
      (SELECT count(*) FROM (SELECT 1 FROM public.achieve_evaluations
         WHERE exported_at IS NULL AND NOT is_test AND NOT is_sandbox
           AND requested_at_utc < p_waiting_before LIMIT p_cap) w),
      (SELECT min(requested_at_utc) FROM public.achieve_evaluations
         WHERE exported_at IS NULL AND NOT is_test AND NOT is_sandbox
           AND requested_at_utc < p_waiting_before),
      (SELECT count(*) FROM (SELECT 1 FROM public.achieve_evaluations
         WHERE exported_at IS NOT NULL AND exported_at < p_exported_before LIMIT p_cap) o),
      (SELECT min(exported_at) FROM public.achieve_evaluations
         WHERE exported_at IS NOT NULL AND exported_at < p_exported_before);
  ELSE
    RAISE EXCEPTION 'sightings_buffer_lag: unknown table %', p_table;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.sightings_buffer_lag(TEXT, TIMESTAMP, TIMESTAMPTZ, INTEGER) IS
  'Rows the export should have shipped and has not, and rows past the purge still in Supabase, for one of the three sightings buffer tables, each count capped at p_cap (#463). Read by the daily buffer watchdog in the Worker.';

REVOKE ALL ON FUNCTION public.sightings_buffer_lag(TEXT, TIMESTAMP, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sightings_buffer_lag(TEXT, TIMESTAMP, TIMESTAMPTZ, INTEGER) TO service_role;
