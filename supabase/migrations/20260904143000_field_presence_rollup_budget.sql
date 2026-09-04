-- #1147: give the analytics rollup refreshes a budget they actually own, and
-- stop the field-presence incremental pass from re-aggregating the same two
-- days 288 times a day.
--
-- On 2026-09-03 at 21:40 UTC one run of refresh-field-presence-daily hit
-- Postgres's statement timeout at 121.97s. The other 287 runs that day
-- succeeded, and the rollup was never wrong: a failed run rolls back its own
-- DELETE and the next pass rewrites the window (verified 2026-09-04, rollup
-- totals matched the raw counts exactly for 09-01, 09-02 and 09-03).
--
-- WHAT CHANGED UNDERNEATH IT. #435 (alias resolution, deployed 2026-09-01
-- ~19:30 UTC) roughly doubled the watched-field set. Execution volume did not
-- move (~100K/day throughout), but keys per execution went from 17.5 to 34.0,
-- so the CROSS JOIN LATERAL expanded ~7.1M rows per refresh instead of ~3.5M:
--
--   before #435   avg 5.9s   p95  8.1s   p99 10.1s   max  14.7s   0 runs >60s
--   after  #435   avg 12.7s  p95 27.5s   p99 38.8s   max 122.0s   1 run  >60s
--
-- WHY 120s. pg_cron runs as `postgres`, which carries no statement_timeout in
-- rolconfig, so it inherited the cluster default of 120000ms. Nothing in this
-- codebase chose that number. The 120s also had to cover the advisory-lock wait
-- added by #833, whose 60s bound was sized when the work took ~11s; with the
-- work at a p99 of 39s, a long wait plus the work crosses the ceiling.
--
-- MEASURED PLATFORM FACT, and the reason the budget is set here and not in the
-- function body: `SET LOCAL statement_timeout` inside a plpgsql function does
-- NOT bind the running call. The timer is armed when the outer statement
-- begins, so the setting takes effect only for the NEXT statement. Probed on
-- this database 2026-09-04: a function setting it to 1s then sleeping 3s slept
-- the full 3s. Written inside refresh_field_presence_daily it would have read
-- as a safeguard and done nothing (LESSONS L188). In the cron command it is a
-- separate statement that lands before the SELECT, which is why it works.
--
-- lock_timeout is different: it is armed at each lock wait, so the in-function
-- SET LOCAL does take effect. It is set on BOTH sides here, to the same value,
-- so the guarantee does not depend on which one wins.
--
-- Expand/contract: additive. CREATE OR REPLACE plus a reschedule, no schema
-- change, no signature change, so code and schema deploy in either order.

-- ------------------------------------------------------------
-- 1. Tighten the lock wait so it cannot eat the whole budget
-- ------------------------------------------------------------
-- 60s to 30s. A run that cannot get the lock in 30s gives up loudly with a
-- lock_timeout error, which is a DIFFERENT message from a statement timeout and
-- names its own cause (L11). Skipping one pass is harmless: the next one
-- rewrites the same window.
CREATE OR REPLACE FUNCTION refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL lock_timeout = '30s';
  PERFORM pg_advisory_xact_lock(883301, 2);

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

CREATE OR REPLACE FUNCTION refresh_workflow_stats_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL lock_timeout = '30s';
  PERFORM pg_advisory_xact_lock(883301, 1);

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
    we.workflow_id, we.status, COALESCE(we.outcome, ''),
    (we.started_at AT TIME ZONE 'UTC')::date, we.is_test;
END;
$$;

-- CREATE OR REPLACE preserves the ACL, so the PUBLIC revoke from 20260814000002
-- survives. Re-issued for the same reason 20260818000001 gives: the evidence of
-- a missing REVOKE is an absence (L124).
REVOKE ALL ON FUNCTION refresh_field_presence_daily(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_workflow_stats_daily(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_field_presence_daily(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_workflow_stats_daily(INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 2. Reschedule with an explicit budget, and cut the cadence
-- ------------------------------------------------------------
-- The field-presence incremental pass drops from every 5 minutes to every 15.
--
-- Its 2-day window is recomputed in full on every run, and today's rows have
-- almost no reader. Since #1101 the drought detector takes its baseline from
-- prior COMPLETE days (it filters `day < today`) and reads today's observed
-- side from workflow_executions directly via field_presence_window. The only
-- consumer of today's rollup rows is the field-coverage page in the UI, which a
-- person opens occasionally, so 15-minute freshness is ample and 288 full
-- re-aggregations a day were buying nothing.
--
-- 03:52 stays off the */15 grid (52 mod 15 = 7), so the nightly reconciler and
-- the incremental pass still never start together, which is what #833 fixed.
--
-- The nightly full pass gets 300s rather than 180s: it re-aggregates 7 days,
-- and at 26.1s on 2026-09-04 it has further to grow before it is at risk.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'refresh-field-presence-daily'; END $$;

SELECT cron.schedule(
  'refresh-field-presence-daily',
  '*/15 * * * *',
  $$SET statement_timeout = '180s'; SET lock_timeout = '30s'; SELECT refresh_field_presence_daily(2)$$
);

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'refresh-field-presence-daily-full'; END $$;

SELECT cron.schedule(
  'refresh-field-presence-daily-full',
  '52 3 * * *',
  $$SET statement_timeout = '300s'; SET lock_timeout = '30s'; SELECT refresh_field_presence_daily(7)$$
);

-- The sibling rollup inherits the identical 120s ceiling and the identical 60s
-- lock wait, so it is one traffic increase away from the same failure. Fixing
-- the class rather than the instance (L30); its cadence is unchanged because
-- its work is ~11s and nothing about it is near a limit yet.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'refresh-workflow-stats-daily'; END $$;

SELECT cron.schedule(
  'refresh-workflow-stats-daily',
  '*/5 * * * *',
  $$SET statement_timeout = '180s'; SET lock_timeout = '30s'; SELECT refresh_workflow_stats_daily(2)$$
);

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'refresh-workflow-stats-daily-full'; END $$;

SELECT cron.schedule(
  'refresh-workflow-stats-daily-full',
  '47 3 * * *',
  $$SET statement_timeout = '300s'; SET lock_timeout = '30s'; SELECT refresh_workflow_stats_daily(7)$$
);
