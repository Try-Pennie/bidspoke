-- Canonical body of public.reduce_finalize_stranded (#1161).
--
-- Single source of truth for the strand-drain function. The guard
-- apps/web/src/lib/__tests__/strand-drain-canonical-body.test.ts fails unless
-- the latest supabase/migrations file that restates the drain is identical to
-- the block below (trailing whitespace normalized), and unless that block
-- revokes EXECUTE from PUBLIC, anon and authenticated.
--
-- To change the function: edit this file (its version-control diff is the
-- reviewable intended change), then paste everything from the CREATE OR REPLACE
-- line down verbatim under a new migration header. Do NOT edit an
-- already-applied migration. This file is never run by the migration runner.

CREATE OR REPLACE FUNCTION public.reduce_finalize_stranded(p_lookback_days int DEFAULT 8)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
  -- now() is fixed per transaction, so the statements already shared one value;
  -- computing it once is behaviour-preserving and lets it reach the planner as a
  -- literal. The UTC wall clock of the cutoff bounds the two `timestamp` columns
  -- (immutable timestamp-vs-timestamp, so the planner prunes).
  v_cutoff_utc timestamp   := (now() - make_interval(days => p_lookback_days)) AT TIME ZONE 'UTC';
  -- Pruning-only bounds, widened by a day so they never trim a row the semantic
  -- cutoff keeps: one in UTC for the lead_sightings join, one timestamptz for the
  -- workflow_executions join.
  v_prune_utc  timestamp   := ((now() - make_interval(days => p_lookback_days)) - interval '1 day') AT TIME ZONE 'UTC';
  v_prune_tz   timestamptz := (now() - make_interval(days => p_lookback_days)) - interval '1 day';
BEGIN
  EXECUTE format($q$
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
        quoted_rate_cents        = COALESCE((e.sighting_finalize->>'quoted_rate_cents')::int, s.quoted_rate_cents),
        external_debt            = COALESCE((e.sighting_finalize->>'external_debt')::int, s.external_debt),
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
      AND s.execution_started_at_utc >= %L
      AND e.started_at >= %L
  $q$, v_cutoff_utc, v_prune_tz);
  GET DIAGNOSTICS n = ROW_COUNT;

  -- Flip the winning bid on an EXISTING row (rare partial-block-2 case). Idempotent.
  EXECUTE format($q$
    UPDATE lead_sighting_bids b
    SET is_winner = true, exported_at = NULL
    FROM lead_sightings s
    JOIN workflow_executions e ON e.id = s.execution_id
    WHERE b.execution_id = s.execution_id
      AND b.partner_slug = e.sighting_finalize->>'winning_partner_slug'
      AND s.recovered_by = 'rich'
      AND s.winning_partner_slug IS NOT NULL
      AND b.is_winner = false
      AND b.attempted_at_utc >= %L
      AND s.execution_started_at_utc >= %L
      AND e.started_at >= %L
  $q$, v_cutoff_utc, v_prune_utc, v_prune_tz);

  -- Re-insert the per-attempt rows the strand lost, from the projected array.
  EXECUTE format($q$
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
      AND s.execution_started_at_utc >= %L
      AND e.started_at >= %L
      AND jsonb_typeof(e.sighting_finalize->'bid_attempts') = 'array'
    ON CONFLICT (execution_id, partner_slug, attempted_at_utc) DO NOTHING
  $q$, v_cutoff_utc, v_prune_tz);

  RAISE NOTICE 'reduce_finalize_stranded: finalized % stranded sighting(s)', n;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reduce_finalize_stranded(int) TO service_role;

-- Restated rather than assumed. CREATE OR REPLACE preserves an existing ACL, so
-- the revoke from 20260813000004 should survive, but this function is
-- SECURITY DEFINER, it WRITES, and it takes a caller-supplied lookback: an
-- anonymous caller passing zero could mass-finalize live in-flight rows. A
-- posture that matters this much is asserted on every replace, not inferred from
-- how the statement is documented to behave.
REVOKE ALL ON FUNCTION public.reduce_finalize_stranded(integer) FROM PUBLIC, anon, authenticated;
