-- Fix: step_duration_percentiles{,_typed} were timing out (57014) in production,
-- which made the config-panel timeout-suggestion callout silently disappear
-- (the endpoint 500s and the UI swallows the error to a blank state).
--
-- Root cause: both functions join execution_steps -> workflow_executions but
-- only bound execution_steps.started_at. workflow_executions is also partitioned
-- by started_at, so with no predicate on we.started_at the join scanned every
-- workflow_executions partition and couldn't use idx_executions_workflow
-- (workflow_id, started_at DESC).
--
-- Fix: complete the FK join on the denormalized partition key
-- (we.started_at = es.execution_started_at) and add a lower bound on
-- we.started_at. The 1-hour slack below p_since guarantees we never drop a
-- step whose own started_at is inside the window but whose parent execution
-- began just before it (executions run for seconds, so 1h is ample headroom).

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
  JOIN workflow_executions we
    ON we.id = es.execution_id
   AND we.started_at = es.execution_started_at
  WHERE we.workflow_id = p_workflow_id
    AND es.step_namespace = p_namespace
    AND es.status = 'completed'
    AND es.duration_ms IS NOT NULL
    AND we.is_test = false
    AND es.started_at >= p_since
    AND we.started_at >= p_since - INTERVAL '1 hour'
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION step_duration_percentiles_typed(
  p_org_id UUID,
  p_step_type TEXT,
  p_step_subtype TEXT,
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
    percentile_cont(0.50) WITHIN GROUP (ORDER BY es.duration_ms)::int,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY es.duration_ms)::int,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY es.duration_ms)::int,
    max(es.duration_ms)::int,
    count(*)
  FROM execution_steps es
  JOIN workflow_executions we
    ON we.id = es.execution_id
   AND we.started_at = es.execution_started_at
  JOIN workflows w ON w.id = we.workflow_id
  WHERE w.organization_id = p_org_id
    AND es.step_type = p_step_type
    AND (p_step_subtype IS NULL OR es.step_subtype = p_step_subtype)
    AND es.status = 'completed'
    AND es.duration_ms IS NOT NULL
    AND we.is_test = false
    AND es.started_at >= p_since
    AND we.started_at >= p_since - INTERVAL '1 hour'
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles_typed(UUID, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles_typed(UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
