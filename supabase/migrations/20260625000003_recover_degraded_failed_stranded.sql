-- ============================================================
-- Recover degraded/failed stranded sightings, not just completed (#376 / #353)
-- ============================================================
-- reduce_finalize_stranded only recovered in_flight sightings whose execution
-- reached status='completed'. A strand on a 'degraded' run (the lead WAS served
-- correctly, but the post-response Salesforce writeback failed) or a 'failed' run
-- was skipped by the recoverable drain, then swept 26h later by
-- finalize_unrecoverable_stranded and mislabeled reject_reason='strand_unrecoverable'
-- with a NULL outcome -- even though its real outcome was sitting right there in the
-- workflow_executions.sighting_finalize projection (block 1 writes that projection
-- regardless of final status). That understated served volume and corrupted outcome
-- analytics for the slice that hit a post-response failure.
--
-- Fix: widen the main UPDATE's status filter to include 'degraded' and 'failed'.
--   - degraded: the projection's outcome is the REAL served outcome (the walk
--     completed; degraded came only from the post-response continuation), so a
--     degraded winner recovers its winner/bid just like a completed one.
--   - failed: the projection's outcome is 'failed'; recovering that (with the real
--     reject_reason) is honest and strictly better than 'strand_unrecoverable'/NULL.
--   - 'running' stays EXCLUDED: the execution record never reached a terminal write,
--     so there is no outcome to recover -- those correctly fall to the unrecoverable
--     relabel.
--
-- The winner-flip and per-attempt bid re-INSERT below key off recovered_by='rich'
-- (set by the main UPDATE), so they extend to degraded/failed automatically. The
-- recoverable drain runs every 30 min, well ahead of the 26h unrecoverable sweep,
-- so a degraded/failed strand is now recovered within minutes. Everything else is
-- unchanged from 20260625000002.

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
