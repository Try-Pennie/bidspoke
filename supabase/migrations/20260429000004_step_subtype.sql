-- Adds `step_subtype` to execution_steps so the timeout-suggestion endpoint
-- can fall back to a cross-workflow aggregate when a fresh workflow has no
-- prior runs of a given step. For Salesforce nodes the subtype is the op
-- (create / update / query / etc.); future expansion can carry the upstream
-- service for integration nodes too.

ALTER TABLE execution_steps ADD COLUMN IF NOT EXISTS step_subtype TEXT;

-- Backfill historical Salesforce rows: pull `config.op` from the workflow
-- version's node definition and write it onto the matching step row.
-- Salesforce executor defaults `operation` to 'create' when the field is absent;
-- mirror that default here so creates aggregate as a single subtype.
UPDATE execution_steps es SET step_subtype = (
  SELECT COALESCE(n->'config'->>'operation', 'create')
  FROM workflow_executions we
  JOIN workflow_versions wv ON wv.id = we.workflow_version_id
  CROSS JOIN LATERAL jsonb_array_elements(wv.definition->'nodes') n
  WHERE we.id = es.execution_id
    AND n->>'namespace' = es.step_namespace
    AND n->>'type' = 'salesforce'
  LIMIT 1
)
WHERE es.step_type = 'salesforce' AND es.step_subtype IS NULL;

-- Partial index supports the typed aggregate query without bloating storage
-- for rows where subtype isn't tracked.
CREATE INDEX IF NOT EXISTS idx_exec_steps_type_subtype
  ON execution_steps(step_type, step_subtype)
  WHERE step_subtype IS NOT NULL;

-- Cross-workflow aggregate: same percentiles as the per-step variant but
-- aggregated by (step_type, optional subtype) within an org. Used as a
-- fallback when (workflow_id, namespace) doesn't have enough history yet.
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
  JOIN workflow_executions we ON we.id = es.execution_id
  JOIN workflows w ON w.id = we.workflow_id
  WHERE w.organization_id = p_org_id
    AND es.step_type = p_step_type
    AND (p_step_subtype IS NULL OR es.step_subtype = p_step_subtype)
    AND es.status = 'completed'
    AND es.duration_ms IS NOT NULL
    AND we.is_test = false
    AND es.started_at >= p_since
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles_typed(UUID, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles_typed(UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
