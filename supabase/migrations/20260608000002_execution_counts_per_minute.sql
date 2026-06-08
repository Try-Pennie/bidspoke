-- Per-minute execution counts for the real-time volume-cliff monitor.
--
-- runVolumeCliffCheck previously pulled every raw workflow_executions row in the
-- trailing 60-minute window into the Worker and bucketed them in JS, paginating
-- around PostgREST's 1000-row cap with a 200k hard ceiling. Two problems:
--   1. The paginated fetch had no stable ORDER BY, so Postgres recomputed each
--      page's OFFSET against an independent scan and silently dropped the newest
--      rows (the trailing-5-min window) -> false "0 executions" cliff alerts.
--   2. The 200k ceiling silently truncated very high-volume windows.
--
-- Aggregating at the minute grain in the database collapses thousands of rows to
-- ~60 per workflow, removing pagination, the cap, and the ordering hazard in one
-- move. Drives off workflow_executions (partition pruning on started_at).

CREATE OR REPLACE FUNCTION execution_counts_per_minute(
  p_workflow_ids UUID[],
  p_since        TIMESTAMPTZ
) RETURNS TABLE (
  workflow_id UUID,
  minute      TIMESTAMPTZ,
  cnt         BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    we.workflow_id,
    date_trunc('minute', we.started_at) AS minute,
    count(*)                            AS cnt
  FROM workflow_executions we
  WHERE we.workflow_id = ANY(p_workflow_ids)
    AND we.started_at >= p_since
    AND we.is_test = false
  GROUP BY we.workflow_id, date_trunc('minute', we.started_at)
$$;

GRANT EXECUTE ON FUNCTION execution_counts_per_minute(UUID[], TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION execution_counts_per_minute(UUID[], TIMESTAMPTZ) TO service_role;
