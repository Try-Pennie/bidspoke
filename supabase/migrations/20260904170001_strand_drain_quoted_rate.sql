-- ============================================================
-- Strand recovery carries the quoted rate (follows 20260904170000)
-- ============================================================
-- lead_sightings.quoted_rate_cents is written by the live finalize and projected
-- onto workflow_executions.sighting_finalize like every other finalize field.
-- The drain has to read it back, or a lead whose isolate was evicted mid-run is
-- recovered with every other field intact and this one silently null, which is
-- indistinguishable from a run that quoted nothing.
--
-- Caught by apps/web/src/lib/__guards__/worker/worker-strand-drain-contract.test.ts,
-- which requires every SightingFinalizeFields key to be read by this SQL. The
-- guard reads the LAST migration (sorted) that defines the function, so the whole
-- body is restated here rather than patched: there is no ALTER for one assignment.
--
-- Unchanged from 20260627000001 apart from the one new assignment.

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
      quoted_rate_cents        = COALESCE((e.sighting_finalize->>'quoted_rate_cents')::int, s.quoted_rate_cents),
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

-- Restated rather than assumed. CREATE OR REPLACE preserves an existing ACL, so
-- the revoke from 20260813000004 should survive, but this function is
-- SECURITY DEFINER, it WRITES, and it takes a caller-supplied lookback: an
-- anonymous caller passing zero could mass-finalize live in-flight rows. A
-- posture that matters this much is asserted on every replace, not inferred from
-- how the statement is documented to behave.
REVOKE ALL ON FUNCTION public.reduce_finalize_stranded(integer) FROM PUBLIC, anon, authenticated;
