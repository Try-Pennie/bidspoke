-- Per-workflow, all-namespaces percentile rollup for the over-provisioned
-- ("could be lower") side of the timeout audit.
--
-- The existing step_duration_percentiles(workflow, namespace, since) answers one
-- node at a time. The audit needs every node's p99 + sample size to decide which
-- are configured far above what they actually need — calling the per-namespace
-- function once per node would be N round-trips per workflow. This returns all
-- namespaces in a single grouped query.
--
-- Same per-workflow bound as 20260602000001: drive from workflow_executions
-- (idx_executions_workflow, backward index scan, early-terminates at LIMIT) to
-- take this workflow's most recent 3000 non-test runs, THEN join their steps and
-- group by namespace. The bound is per workflow, so a namespace shared with a
-- high-volume workflow doesn't starve this one's sample.

CREATE OR REPLACE FUNCTION step_duration_percentiles_by_workflow(
  p_workflow_id UUID,
  p_since TIMESTAMPTZ
) RETURNS TABLE (
  step_namespace TEXT,
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
