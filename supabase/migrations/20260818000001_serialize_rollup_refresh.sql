-- Serialize the analytics rollup refreshes, and stop the nightly collision.
-- Fixes #833, #849, #837.
--
-- workflow_stats_daily and field_presence_daily are each refreshed by one
-- delete-then-insert function driven by two pg_cron jobs: an incremental pass
-- every 5 minutes, and a nightly reconciler at 03:45 and 03:50. Those minutes
-- are themselves multiples of 5, so the reconciler and the incremental pass
-- started at the same instant every night:
--
--   03:45:00.171  refresh-workflow-stats-daily-full  succeeded 03:45:10.870
--   03:45:00.281  refresh-workflow-stats-daily       FAILED   03:45:12.762
--
-- Neither DELETE can see the other's uncommitted rows, so both re-insert the
-- same day and whichever commits second aborts on the primary key. 128
-- duplicate-key failures and 6 deadlocks between 2026-05-18 and 2026-08-18.
-- The rollups themselves stayed correct, because a failing run rolls back its
-- own DELETE too and the next incremental pass rewrites the window, but the
-- nightly reconciler only completed on about one night in five.
--
-- Three changes, in order of what actually does the work:
--
--   1. Each refresh takes a transaction-scoped advisory lock, so a second pass
--      waits for the first to commit and then does its own delete-and-insert.
--      This is the fix. A reschedule alone would still collide any time a run
--      overran its own 5-minute slot, which is what the 6 deadlocks were.
--   2. The nightly jobs move to 03:47 and 03:52, off the */5 grid, so the
--      common case never contends and never waits.
--   3. refresh_field_presence_daily's nightly lookback drops from 90 days to 7.
--      Raw workflow_executions is on 7-day retention, so a 90-day re-aggregate
--      deleted 90 days of rollup rows and could only put back the ~8 days raw
--      still held. workflow_stats_daily had this cut from 90 to 7 in
--      20260522000002, whose comment says "Must be <= retention or the daily
--      full refresh zeroes out rollup rows"; field_presence_daily was cloned
--      from the original pattern a month later and inherited the 90 anyway.
--      Measured 2026-08-18: workflow_stats_daily held 110 days of history,
--      field_presence_daily held 10.
--
-- Also folds in #837 while this statement is open: the INSERT normalises
-- outcome with COALESCE(outcome, '') because the column is NOT NULL DEFAULT '',
-- while the GROUP BY used the raw column, so a NULL and an empty-string outcome
-- formed two groups that collide on one primary key. Dormant so far (11 NULL
-- and 0 empty-string outcomes in the current window), and a single execution
-- written with '' would have frozen the dashboard rollup until it aged out.
--
-- Additive and backward compatible: no schema change, CREATE OR REPLACE only,
-- so code and schema can deploy in either order.

-- ------------------------------------------------------------
-- 1. workflow_stats_daily
-- ------------------------------------------------------------
-- Lock keys are (namespace, table) pairs. 883301 is this file; 1 and 2
-- distinguish the two rollup tables so they never wait on each other.
CREATE OR REPLACE FUNCTION refresh_workflow_stats_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Bound the wait rather than leaving it open ended: the real work is ~11s, so
  -- a wait past 60s means something is wrong and should fail loudly instead of
  -- queueing another waiter every 5 minutes (LESSONS L110).
  SET LOCAL lock_timeout = '60s';
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

-- ------------------------------------------------------------
-- 2. field_presence_daily
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL lock_timeout = '60s';
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

-- ------------------------------------------------------------
-- 3. Privileges
-- ------------------------------------------------------------
-- CREATE OR REPLACE preserves the existing ACL, so the PUBLIC revoke from
-- 20260814000002 (#762) survives. Re-issued anyway: the cost of being wrong is
-- two security-definer-adjacent maintenance functions callable by anon over
-- REST, and the only evidence would be a REVOKE that is absent (LESSONS L124).
REVOKE ALL ON FUNCTION refresh_workflow_stats_daily(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_field_presence_daily(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_workflow_stats_daily(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_field_presence_daily(INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 4. Move the nightly reconcilers off the */5 grid
-- ------------------------------------------------------------
-- 03:47 and 03:52, both after the 03:30 purge so the oldest day each one
-- recomputes still has raw data behind it.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'refresh-workflow-stats-daily-full'; END $$;

SELECT cron.schedule(
  'refresh-workflow-stats-daily-full',
  '47 3 * * *',
  $$SELECT refresh_workflow_stats_daily(7)$$
);

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'refresh-field-presence-daily-full'; END $$;

SELECT cron.schedule(
  'refresh-field-presence-daily-full',
  '52 3 * * *',
  $$SELECT refresh_field_presence_daily(7)$$
);
