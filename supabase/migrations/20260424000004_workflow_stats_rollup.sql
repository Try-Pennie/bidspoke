-- SQL-side rollup for the dashboard. Replaces the row-fetch-and-JS-aggregate
-- approach in stats.ts, which was capped at 1000 rows by Supabase's default
-- limit and silently truncated noisy workflows over quiet ones.
--
-- Returns one row per (workflow_id, status, outcome, day, is_test) bucket with
-- a count, sum of duration_ms (for avg), and sum of cost_usd. The worker
-- reshapes into summary / by_workflow / by_day.

CREATE OR REPLACE FUNCTION workflow_stats_rollup(
  p_org_id UUID,
  p_since TIMESTAMPTZ
) RETURNS TABLE (
  workflow_id          UUID,
  workflow_name        TEXT,
  status               TEXT,
  outcome              TEXT,
  day                  DATE,
  is_test              BOOLEAN,
  run_count            BIGINT,
  duration_ms_sum      BIGINT,
  duration_ms_count    BIGINT,
  cost_usd_sum         NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    we.workflow_id,
    w.name                                    AS workflow_name,
    we.status,
    we.outcome,
    (we.started_at AT TIME ZONE 'UTC')::date  AS day,
    we.is_test,
    count(*)                                  AS run_count,
    COALESCE(sum(we.duration_ms), 0)::bigint  AS duration_ms_sum,
    count(we.duration_ms)                     AS duration_ms_count,
    COALESCE(sum(we.cost_usd), 0)             AS cost_usd_sum
  FROM workflow_executions we
  JOIN workflows w ON w.id = we.workflow_id
  WHERE w.organization_id = p_org_id
    AND w.deleted_at IS NULL
    AND we.started_at >= p_since
  GROUP BY we.workflow_id, w.name, we.status, we.outcome,
           (we.started_at AT TIME ZONE 'UTC')::date, we.is_test
$$;

-- Grant to the service role used by the Worker
GRANT EXECUTE ON FUNCTION workflow_stats_rollup(UUID, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION workflow_stats_rollup(UUID, TIMESTAMPTZ) TO service_role;
