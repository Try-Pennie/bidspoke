-- Rewrite step_duration_percentiles{,_typed} to bound the sample.
--
-- Background: migration 20260528000001 fixed the workflow_executions partition
-- pruning, and 20260528000002 added idx_exec_steps_namespace_completed. But the
-- RPC still timed out: the Engine Bidding / Main Flow workflows produce ~34k
-- equifax_credit_report steps/day (~241k over 7 days), and aggregating ALL of
-- them — plus joining ~265k executions to filter workflow_id/is_test — is
-- inherently too much work for the 8s window, regardless of indexing.
--
-- A timeout SUGGESTION only needs a representative recent sample, not the full
-- history. So we bound it: take the most recent N completed steps for the
-- namespace via idx_exec_steps_namespace_completed (index scan backward, early
-- terminates at the LIMIT), THEN join those few rows to workflow_executions by
-- primary key to apply the workflow_id / is_test filters. The inner LIMIT is a
-- hard boundary, so the plan stays a small nested loop even under the function's
-- generic (parameterized) plan. Measured: ~2.6s cold / ~35ms warm vs. >8s before.
--
-- Sampling the most RECENT runs is also better for the suggestion: it reflects
-- current latency behavior rather than week-old outliers.

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
  FROM (
    SELECT execution_id, execution_started_at, duration_ms
    FROM execution_steps
    WHERE step_namespace = p_namespace
      AND status = 'completed'
      AND duration_ms IS NOT NULL
      AND started_at >= p_since
    ORDER BY started_at DESC
    LIMIT 3000
  ) es
  JOIN workflow_executions we
    ON we.id = es.execution_id
   AND we.started_at = es.execution_started_at
   AND we.workflow_id = p_workflow_id
   AND we.is_test = false
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO service_role;

-- Cross-workflow fallback (used only when the per-step sample is < 10). Same
-- bounding strategy: cap the recent sample, then join for the org/is_test filter.
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
  FROM (
    SELECT execution_id, execution_started_at, duration_ms
    FROM execution_steps
    WHERE step_type = p_step_type
      AND (p_step_subtype IS NULL OR step_subtype = p_step_subtype)
      AND status = 'completed'
      AND duration_ms IS NOT NULL
      AND started_at >= p_since
    ORDER BY started_at DESC
    LIMIT 3000
  ) es
  JOIN workflow_executions we
    ON we.id = es.execution_id
   AND we.started_at = es.execution_started_at
   AND we.is_test = false
  JOIN workflows w ON w.id = we.workflow_id AND w.organization_id = p_org_id
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles_typed(UUID, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles_typed(UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
