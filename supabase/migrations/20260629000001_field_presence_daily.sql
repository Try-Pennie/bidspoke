-- Phase 2 (#421) of silent-output-field detection (#410). Daily rollup of the
-- Phase 0 workflow_executions.field_presence booleans, so the Phase 3 detector
-- reads small per-(workflow, field, day, is_test) aggregates instead of scanning
-- the daily-partitioned, 7-day-retention raw tables.
--
-- ran_count     = executions where the producing node ran (the field key was present)
-- present_count = executions where the field carried a value (the JSON boolean was true)
-- The gap (ran_count - present_count) is the Scout signal: ran but empty.
--
-- Clones the proven refresh_workflow_stats_daily pattern (delete-then-insert a
-- recent window, statement_timeout=0 backfill, pg_cron). Additive/expand-only.
-- Ships dark: field_presence is empty until FIELD_PRESENCE_CAPTURE is enabled, so
-- this rollup is correct-but-empty until then.

CREATE TABLE field_presence_daily (
  workflow_id    UUID    NOT NULL,
  field_path     TEXT    NOT NULL,
  day            DATE    NOT NULL,
  is_test        BOOLEAN NOT NULL,
  ran_count      BIGINT  NOT NULL DEFAULT 0,
  present_count  BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (workflow_id, field_path, day, is_test)
);

CREATE INDEX field_presence_daily_day_idx ON field_presence_daily (day);

-- Refresh: delete-then-insert a recent window. Idempotent and safe to re-run.
-- A large lookback doubles as the initial backfill. jsonb_each expands each
-- execution's presence map into one row per watched field; an execution with
-- NULL/'{}' field_presence contributes no rows, so ran_count only counts
-- executions where that field's node actually ran.
CREATE OR REPLACE FUNCTION refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM field_presence_daily
  WHERE day >= (CURRENT_DATE - p_lookback_days);

  INSERT INTO field_presence_daily (
    workflow_id, field_path, day, is_test, ran_count, present_count
  )
  SELECT
    we.workflow_id,
    je.key,
    (we.started_at AT TIME ZONE 'UTC')::date,
    we.is_test,
    count(*),
    count(*) FILTER (WHERE je.value = 'true'::jsonb)
  FROM workflow_executions we
  CROSS JOIN LATERAL jsonb_each(we.field_presence) AS je(key, value)
  WHERE we.started_at >= (CURRENT_DATE - p_lookback_days)::timestamptz
    AND we.started_at <  (CURRENT_DATE + 1)::timestamptz
    AND we.field_presence IS NOT NULL
  GROUP BY
    we.workflow_id, je.key,
    (we.started_at AT TIME ZONE 'UTC')::date, we.is_test;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_field_presence_daily(INTEGER) TO service_role;

-- RLS: org-scoped via the workflows join (table has workflow_id, no
-- organization_id) — identical shape to workflow_stats_daily_org. The worker
-- (service_role) and pg_cron (postgres) both bypass RLS; this only gates direct
-- PostgREST reads by an authenticated user.
ALTER TABLE field_presence_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "field_presence_daily_org" ON field_presence_daily
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );

-- Initial backfill. SET LOCAL statement_timeout = 0 so the migration won't be
-- killed at the 8s default. With the flag off this is near-instant (no rows).
DO $$
BEGIN
  PERFORM set_config('statement_timeout', '0', true);
  PERFORM refresh_field_presence_daily(90);
END;
$$;

-- Incremental refresh every 5 minutes — 2-day lookback covers UTC day rollover
-- and late-completing executions.
SELECT cron.schedule(
  'refresh-field-presence-daily',
  '*/5 * * * *',
  $$SELECT refresh_field_presence_daily(2)$$
);

-- Daily full refresh covering 90 days at 03:50 UTC (staggered after
-- refresh-workflow-stats-daily-full at 03:45). Catches drift from cron blips.
SELECT cron.schedule(
  'refresh-field-presence-daily-full',
  '50 3 * * *',
  $$SELECT refresh_field_presence_daily(90)$$
);
