-- Fix step_duration_percentiles returning 0 samples for nodes whose namespace
-- is also used by a high-volume workflow.
--
-- Bug: migration 20260528000003 bounded the sample by taking the most recent
-- 3000 completed steps for the namespace ACROSS ALL WORKFLOWS, and only THEN
-- joined workflow_executions to filter workflow_id. Generic namespaces
-- (constants, parsed_name, prospect_body, equifax_credit_report, …) are shared
-- across workflows, and the Main Flow / Engine Bidding workflows alone produce
-- 50k–100k+ completed steps per namespace per 7 days. So for any OTHER workflow
-- using the same namespace, all of its rows fall outside the recent-3000 global
-- window, and the post-join count is 0 → the config panel shows
-- "Not enough runs yet to suggest a value (0 in the last week)" for steps that
-- have plenty of runs.
--
-- Fix: bound the sample PER-WORKFLOW. Drive from workflow_executions using
-- idx_executions_workflow (workflow_id, started_at DESC) — index scan backward,
-- early-terminates at the LIMIT — to take this workflow's most recent 3000
-- non-test runs, THEN join their steps for the namespace. The sample is now this
-- workflow's runs, not whatever workflow happens to dominate the namespace.
--
-- es.started_at >= p_since is redundant for correctness (a step always starts at
-- or after its execution, and the execution is already filtered >= p_since) but
-- lets the planner prune execution_steps partitions on the nested-loop side.
--
-- The cross-workflow fallback (step_duration_percentiles_typed) is intentionally
-- left as-is: it WANTS similar steps across the whole org, so bounding by type
-- across workflows is correct there.

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
   AND es.step_namespace = p_namespace
   AND es.status = 'completed'
   AND es.duration_ms IS NOT NULL
$$;

GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION step_duration_percentiles(UUID, TEXT, TIMESTAMPTZ) TO service_role;
