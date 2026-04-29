-- Returns duration percentiles for a single step (workflow_id + namespace) over
-- a recent window. Used by the config panel to suggest a sensible timeout and
-- warn when the configured value is too tight or too generous.
--
-- Limited to completed, non-test steps so a workflow's flaky/timeout history
-- doesn't poison the suggestion for the next user.

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
    percentile_cont(0.50) WITHIN GROUP (ORDER BY es.duration_ms)::int  AS p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY es.duration_ms)::int  AS p95,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY es.duration_ms)::int  AS p99,
    max(es.duration_ms)::int                                            AS max_ms,
    count(*)                                                            AS sample_size
  FROM execution_steps es
  JOIN workflow_executions we ON we.id = es.execution_id
  WHERE es.workflow_id = p_workflow_id
    AND es.step_namespace = p_namespace
    AND es.status = 'completed'
    AND es.duration_ms IS NOT NULL
    AND we.is_test = false
    AND es.started_at >= p_since
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO service_role;
