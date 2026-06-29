-- ============================================================
-- Populate finish timestamps on recoverable strand recovery (#353 follow-on)
-- ============================================================
-- reduce_finalize_stranded recovers in_flight sightings from a completed/degraded/
-- failed execution and copies duration_ms, outcome, winner, etc. from the
-- workflow_executions row -- but it never set execution_finished_at_et /
-- execution_ended_at_utc. So every drain-recovered strand finalized with a NULL
-- finish time even though the execution genuinely finished and its real finish
-- instant (workflow_executions.completed_at) was right there. That left ~80K
-- finalized rows with a NULL finish, and was the second cause (besides the
-- truly-unrecoverable strands) of the Snowflake export's NOT-NULL rejection on
-- EXECUTION_FINISHED_AT_ET (2026-06-27 export incident).
--
-- Fix: set both finish columns from e.completed_at. COALESCE-guarded so it is
-- idempotent and never overwrites a value the live finalize already wrote.
--   - execution_finished_at_et (timestamptz): the finish instant, stored directly.
--   - execution_ended_at_utc (timestamp without tz): the same instant as UTC
--     wall-clock, matching how the live finalize's .toISOString() lands in that
--     column (see finalizeSighting in apps/worker/src/engine/lead-sightings.ts).
--
-- finalize_unrecoverable_stranded is deliberately NOT changed: those rows have no
-- surviving/completed execution to recover a finish time from, so a NULL finish is
-- the honest value (now accepted -- the Snowflake column was relaxed to nullable).
--
-- Everything else is unchanged from 20260625000003.

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
  SET outcome_state            = 'finalized',
      outcome                  = COALESCE(e.sighting_finalize->>'outcome', e.outcome, s.outcome),
      terminal_node_id         = COALESCE(e.sighting_finalize->>'terminal_node_id', s.terminal_node_id),
      terminal_node_label      = COALESCE(e.sighting_finalize->>'terminal_node_label', e.final_node_namespace, s.terminal_node_label),
      response_status_code     = COALESCE((e.sighting_finalize->>'response_status_code')::int, e.response_status, s.response_status_code),
      duration_ms              = COALESCE(e.duration_ms, s.duration_ms),
      execution_finished_at_et = COALESCE(s.execution_finished_at_et, e.completed_at),
      execution_ended_at_utc   = COALESCE(s.execution_ended_at_utc, e.completed_at AT TIME ZONE 'UTC'),
      prospect_id              = COALESCE(e.sighting_finalize->>'prospect_id', s.prospect_id),
      equifax_status           = COALESCE(e.sighting_finalize->>'equifax_status', s.equifax_status),
      equifax_error_type       = COALESCE(e.sighting_finalize->>'equifax_error_type', s.equifax_error_type),
      equifax_score            = COALESCE((e.sighting_finalize->>'equifax_score')::int, s.equifax_score),
      winning_partner_slug     = COALESCE(e.sighting_finalize->>'winning_partner_slug', s.winning_partner_slug),
      winning_bid_cents        = COALESCE((e.sighting_finalize->>'winning_bid_cents')::int, s.winning_bid_cents),
      partners_attempted       = COALESCE((e.sighting_finalize->>'partners_attempted')::int, s.partners_attempted),
      partners_responded       = COALESCE((e.sighting_finalize->>'partners_responded')::int, s.partners_responded),
      reject_reason            = CASE
                                   WHEN e.sighting_finalize IS NOT NULL THEN e.sighting_finalize->>'reject_reason'
                                   ELSE 'reduced_finalize'
                                 END,
      recovered_by             = CASE WHEN e.sighting_finalize IS NOT NULL THEN 'rich' ELSE 'reduced' END,
      updated_at               = now()
  FROM workflow_executions e
  WHERE s.execution_id = e.id
    AND e.status IN ('completed', 'degraded', 'failed')
    AND s.outcome_state = 'in_flight'
    AND s.execution_started_at_utc >= now() - make_interval(days => p_lookback_days);
  GET DIAGNOSTICS n = ROW_COUNT;

  -- Flip the winning bid on an EXISTING row (rare partial-block-2 case). Idempotent.
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

  -- Re-insert the per-attempt rows the strand lost, from the projected array.
  INSERT INTO lead_sighting_bids (
    sighting_id, trace_id, execution_id, partner_slug, is_winner,
    attempted_at_utc, attempted_at_et,
    http_status, bid_cents, classification, decline_reason, resolver_type, skip_reason, is_test
  )
  SELECT
    s.id, s.trace_id, s.execution_id, a->>'partner_slug',
    COALESCE((a->>'partner_slug') = e.sighting_finalize->>'winning_partner_slug', false),
    s.execution_started_at_utc::timestamp, s.execution_started_at_et,
    (a->>'http_status')::int, (a->>'bid_cents')::int,
    a->>'classification', a->>'decline_reason', a->>'resolver_type', a->>'skip_reason', false
  FROM lead_sightings s
  JOIN workflow_executions e ON e.id = s.execution_id
  CROSS JOIN LATERAL jsonb_array_elements(e.sighting_finalize->'bid_attempts') a
  WHERE s.recovered_by = 'rich'
    AND s.execution_started_at_utc >= now() - make_interval(days => p_lookback_days)
    AND jsonb_typeof(e.sighting_finalize->'bid_attempts') = 'array'
  ON CONFLICT (execution_id, partner_slug, attempted_at_utc) DO NOTHING;

  RAISE NOTICE 'reduce_finalize_stranded: finalized % stranded sighting(s)', n;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reduce_finalize_stranded(int) TO service_role;

-- NOTE: this migration only fixes the recovery function going forward. A one-time
-- backfill of the ~40K rows finalized before this fix was deliberately NOT included:
-- on the live prod table it scans several months of partitions (~10M rows) for the
-- matching NULL-finish rows and exceeds the 120s statement limit. Those historical
-- rows export fine with a NULL finish (the Snowflake column is nullable), so the
-- backfill was abandoned as cosmetic. Run any future large backfill in chunks, not
-- as one statement (see issue #430).
