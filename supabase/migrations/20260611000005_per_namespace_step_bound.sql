-- ============================================================
-- Per-namespace sampling for step duration percentiles (issue #32)
-- ============================================================
-- Both percentile RPCs bounded their sample to the workflow's most recent
-- 3000 EXECUTIONS before joining steps. For a high-volume workflow
-- (Main Flow, ~3.2K runs/day) that truncates every window to a rolling ~22h,
-- so a sparse node (e.g. fallback_engine_debt_missing, ~178 runs/week) can
-- never accumulate a real history: its p99 is roughly the second-slowest run
-- of a small rolling sample, and the timeout suggestion is jumpy as runs age
-- in and out.
--
-- Fix: bound per NAMESPACE instead — the most recent 3000 completed steps of
-- (workflow_id, step_namespace). Busy namespaces fill the limit within hours
-- (cheap, early-terminating index scan); sparse namespaces keep widening into
-- the full requested window. Needs workflow_id directly on execution_steps
-- (steps only knew their workflow through the executions join, which is what
-- forced the execution-driven bound). is_test is stamped alongside it because
-- the old test-run exclusion also came from that join.
--
-- The engine stamps both columns at flush from this deploy forward. Old rows
-- have NULL workflow_id and are invisible to the new sample path; since
-- partitions only hold ~7 days, samples self-heal to full depth within a week
-- (high-volume namespaces within hours). The suggestion endpoints already
-- degrade gracefully on thin samples during the transition.
--
-- The grouped function changes signature (callers pass the definition's
-- namespace list, which the worker already has — a DISTINCT scan for the
-- namespace seed would be a full scan on big workflows), so DROP + CREATE.

ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS workflow_id UUID;
ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS is_test BOOLEAN;

-- Cascades to every partition. Partitions are small daily tables, so the
-- per-partition build lock is brief; the engine's insert retry (issue #23)
-- covers any momentary queueing.
CREATE INDEX IF NOT EXISTS idx_steps_wf_ns_started
  ON execution_steps (workflow_id, step_namespace, started_at DESC);

-- Per-namespace RPC: same signature, namespace-direct sample.
CREATE OR REPLACE FUNCTION step_duration_percentiles(
  p_workflow_id UUID,
  p_namespace TEXT,
  p_since TIMESTAMPTZ
) RETURNS TABLE (
  p50         INT,
  p95         INT,
  p99         INT,
  max_ms      INT,
  sample_size BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    percentile_cont(0.50) WITHIN GROUP (ORDER BY r.duration_ms)::int AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms)::int AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY r.duration_ms)::int AS p99,
    max(r.duration_ms)::int                                          AS max_ms,
    count(*)                                                          AS sample_size
  FROM (
    SELECT es.duration_ms
    FROM execution_steps es
    WHERE es.workflow_id = p_workflow_id
      AND es.step_namespace = p_namespace
      AND es.started_at >= p_since
      AND es.status = 'completed'
      AND es.duration_ms IS NOT NULL
      AND es.is_test IS NOT TRUE
    ORDER BY es.started_at DESC
    LIMIT 3000
  ) r
$$;

-- Grouped RPC: namespace list supplied by the caller; one early-terminating
-- index probe per namespace via LATERAL.
DROP FUNCTION IF EXISTS step_duration_percentiles_by_workflow(UUID, TIMESTAMPTZ);

CREATE FUNCTION step_duration_percentiles_by_workflow(
  p_workflow_id UUID,
  p_since TIMESTAMPTZ,
  p_namespaces TEXT[]
) RETURNS TABLE (
  step_namespace TEXT,
  p50            INT,
  p99            INT,
  max_ms         INT,
  sample_size    BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT ns.namespace, s.p50, s.p99, s.max_ms, s.sample_size
  FROM unnest(p_namespaces) AS ns(namespace)
  CROSS JOIN LATERAL (
    SELECT
      percentile_cont(0.50) WITHIN GROUP (ORDER BY r.duration_ms)::int AS p50,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY r.duration_ms)::int AS p99,
      max(r.duration_ms)::int                                          AS max_ms,
      count(*)                                                          AS sample_size
    FROM (
      SELECT es.duration_ms
      FROM execution_steps es
      WHERE es.workflow_id = p_workflow_id
        AND es.step_namespace = ns.namespace
        AND es.started_at >= p_since
        AND es.status = 'completed'
        AND es.duration_ms IS NOT NULL
        AND es.is_test IS NOT TRUE
      ORDER BY es.started_at DESC
      LIMIT 3000
    ) r
  ) s
  WHERE s.sample_size > 0
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION step_duration_percentiles_by_workflow(UUID, TIMESTAMPTZ, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles_by_workflow(UUID, TIMESTAMPTZ, TEXT[]) TO service_role;
