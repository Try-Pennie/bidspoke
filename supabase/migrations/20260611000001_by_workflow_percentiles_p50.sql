-- Add p50 to the grouped per-workflow percentile rollup.
--
-- The batched timeout-suggestions endpoint is becoming the single stats source
-- for BOTH the canvas badge and the config panel callout (so the two can never
-- disagree about the same node). The panel copy leads with the median ("This
-- step usually finishes in 66ms"), which the grouped function didn't return.
--
-- Postgres can't CREATE OR REPLACE with a different OUT row type, so drop and
-- recreate. The drop+create runs in one transaction; callers degrade gracefully
-- on RPC error during the instant in between.

DROP FUNCTION IF EXISTS step_duration_percentiles_by_workflow(UUID, TIMESTAMPTZ);

CREATE FUNCTION step_duration_percentiles_by_workflow(
  p_workflow_id UUID,
  p_since TIMESTAMPTZ
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
  SELECT
    es.step_namespace,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY es.duration_ms)::int AS p50,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY es.duration_ms)::int AS p99,
    max(es.duration_ms)::int                                          AS max_ms,
    count(*)                                                          AS sample_size
  FROM (
    SELECT id, started_at
    FROM workflow_executions
    WHERE workflow_id = p_workflow_id
      AND is_test = false
      AND started_at >= p_since
    ORDER BY started_at DESC
    LIMIT 3000
  ) we
  JOIN execution_steps es
    ON es.execution_id = we.id
   AND es.execution_started_at = we.started_at
   AND es.started_at >= p_since
   AND es.status = 'completed'
   AND es.duration_ms IS NOT NULL
  GROUP BY es.step_namespace
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles_by_workflow(UUID, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles_by_workflow(UUID, TIMESTAMPTZ) TO service_role;
