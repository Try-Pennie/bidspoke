-- Daily-bucketed rollup of workflow_executions for the dashboard.
--
-- Background: workflow_stats_rollup() aggregated live from workflow_executions,
-- which timed out at Postgres's 8s statement_timeout once the table grew past
-- ~200K rows for a 30-day window. Both the dashboard and the workflows list
-- call /api/stats and were getting HTTP 500 (PostgREST 57014).
--
-- Strategy: materialize one row per (workflow_id, status, outcome, day,
-- is_test) bucket. The refresh function re-aggregates a recent lookback window
-- (default 2 days — covers UTC day boundary and late-completing executions),
-- and pg_cron runs it every 5 minutes. The RPC then reads the precomputed
-- table — sub-100ms regardless of window.

CREATE TABLE workflow_stats_daily (
  workflow_id        UUID    NOT NULL,
  status             TEXT    NOT NULL,
  outcome            TEXT    NOT NULL DEFAULT '',
  day                DATE    NOT NULL,
  is_test            BOOLEAN NOT NULL,
  run_count          BIGINT  NOT NULL DEFAULT 0,
  duration_ms_sum    BIGINT  NOT NULL DEFAULT 0,
  duration_ms_count  BIGINT  NOT NULL DEFAULT 0,
  cost_usd_sum       NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (workflow_id, status, outcome, day, is_test)
);

-- Read path: JOIN workflows for org filter + current workflow name
CREATE INDEX workflow_stats_daily_day_idx ON workflow_stats_daily (day);

-- Refresh: delete-then-insert a recent window. Idempotent and safe to re-run.
-- Passing a large lookback (e.g. 90) doubles as the initial backfill.
CREATE OR REPLACE FUNCTION refresh_workflow_stats_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM workflow_stats_daily
  WHERE day >= (CURRENT_DATE - p_lookback_days);

  INSERT INTO workflow_stats_daily (
    workflow_id, status, outcome, day, is_test,
    run_count, duration_ms_sum, duration_ms_count, cost_usd_sum
  )
  SELECT
    we.workflow_id,
    we.status,
    COALESCE(we.outcome, ''),
    (we.started_at AT TIME ZONE 'UTC')::date,
    we.is_test,
    count(*),
    COALESCE(sum(we.duration_ms), 0)::bigint,
    count(we.duration_ms),
    COALESCE(sum(we.cost_usd), 0)
  FROM workflow_executions we
  WHERE we.started_at >= (CURRENT_DATE - p_lookback_days)::timestamptz
    AND we.started_at <  (CURRENT_DATE + 1)::timestamptz
  GROUP BY
    we.workflow_id, we.status, we.outcome,
    (we.started_at AT TIME ZONE 'UTC')::date, we.is_test;
END;
$$;

-- Replace the live-aggregate RPC with one that reads from the rollup table.
-- Signature stays the same so the worker doesn't need a code change.
CREATE OR REPLACE FUNCTION workflow_stats_rollup(
  p_org_id UUID,
  p_since  TIMESTAMPTZ
) RETURNS TABLE (
  workflow_id        UUID,
  workflow_name      TEXT,
  status             TEXT,
  outcome            TEXT,
  day                DATE,
  is_test            BOOLEAN,
  run_count          BIGINT,
  duration_ms_sum    BIGINT,
  duration_ms_count  BIGINT,
  cost_usd_sum       NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    sd.workflow_id,
    w.name                   AS workflow_name,
    sd.status,
    NULLIF(sd.outcome, '')   AS outcome,
    sd.day,
    sd.is_test,
    sd.run_count,
    sd.duration_ms_sum,
    sd.duration_ms_count,
    sd.cost_usd_sum
  FROM workflow_stats_daily sd
  JOIN workflows w ON w.id = sd.workflow_id
  WHERE w.organization_id = p_org_id
    AND w.deleted_at IS NULL
    AND sd.day >= p_since::date;
$$;

GRANT EXECUTE ON FUNCTION workflow_stats_rollup(UUID, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION workflow_stats_rollup(UUID, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_workflow_stats_daily(INTEGER) TO service_role;

-- Initial backfill: 90 days. SET LOCAL statement_timeout = 0 inside a
-- transaction so the migration won't be killed at 8s. Re-aggregating ~600K
-- rows in one shot can take 15-60s on a warm cache.
DO $$
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM refresh_workflow_stats_daily(90);
END;
$$;

-- Incremental refresh every 5 minutes — 2-day lookback covers UTC day rollover
-- and late-completing executions. Aggregates ~14K rows = sub-second on warm DB.
SELECT cron.schedule(
  'refresh-workflow-stats-daily',
  '*/5 * * * *',
  $$SELECT refresh_workflow_stats_daily(2)$$
);

-- Daily full refresh covering 90 days at 03:45 UTC (after compaction at 03:00).
-- Catches any drift from cron blips or backfilled data.
SELECT cron.schedule(
  'refresh-workflow-stats-daily-full',
  '45 3 * * *',
  $$SELECT refresh_workflow_stats_daily(90)$$
);
