-- Behavioural tests for the rollup refresh schedule of #1884.
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. No real
-- identity appears in it.
--
-- WHAT IT PROVES. The workflow_stats frequent pass calls the refresh with a
-- lookback of 0 and an hourly pass calls it with 2. (The field presence frequent
-- pass moved to a watermark incremental in #1150, proved in
-- field_presence_incremental.test.sql; refresh_field_presence_daily keeps the
-- delete-then-insert behaviour this file drives directly, as the reconcile.) A
-- lookback of 0 is only safe if it rewrites TODAY and leaves every earlier day
-- exactly as it was: if it deleted a past day without rewriting it, the dashboard
-- and the volume check would read a hole until the next hourly pass. And the
-- hourly pass must still fold a late change into its own past day.
--
-- THE CLOCK. Both refresh functions take today from CURRENT_DATE and cannot be
-- given another, so the rows are placed relative to it (yesterday and today at
-- noon UTC) and any partition missing for those two days is created for the
-- test and dropped after it.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS rollup_cases (name text PRIMARY KEY);
DELETE FROM rollup_cases;
CREATE TEMP TABLE IF NOT EXISTS rollup_made_partitions (name text PRIMARY KEY);
DELETE FROM rollup_made_partitions;

-- A partition for each of the two days, unless one already covers it.
DO $do$
DECLARE
  d date;
  v_name text;
BEGIN
  FOREACH d IN ARRAY ARRAY[CURRENT_DATE - 1, CURRENT_DATE] LOOP
    v_name := 'workflow_executions_' || to_char(d, 'YYYY_MM_DD');
    BEGIN
      EXECUTE format('CREATE TABLE %I PARTITION OF public.workflow_executions FOR VALUES FROM (%L) TO (%L)', v_name, d, d + 1);
      INSERT INTO rollup_made_partitions VALUES (v_name);
    EXCEPTION
      -- Covered already, by a daily or a monthly partition.
      WHEN invalid_object_definition OR duplicate_table THEN NULL;
    END;
  END LOOP;

  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111884', 'Rollup Org', 'rollup-org-1884') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444441884', '11111111-1111-1111-1111-111111111884', 'Rollup Flow') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441884';
END
$do$;

-- Yesterday: two completed. Today: three completed. Every one saw field a, none saw b.
INSERT INTO public.workflow_executions (workflow_id, status, started_at, is_test, duration_ms, field_presence)
SELECT '44444444-4444-4444-4444-444444441884', 'completed', (CURRENT_DATE - 1)::timestamptz + interval '12 hours' + g * interval '1 minute', false, 100, '{"a": true, "b": false}'::jsonb
FROM generate_series(1, 2) g;
INSERT INTO public.workflow_executions (workflow_id, status, started_at, is_test, duration_ms, field_presence)
SELECT '44444444-4444-4444-4444-444444441884', 'completed', CURRENT_DATE::timestamptz + interval '1 minute' * g, false, 100, '{"a": true, "b": false}'::jsonb
FROM generate_series(1, 3) g;

SELECT refresh_workflow_stats_daily(2);
SELECT refresh_field_presence_daily(2);

-- ── 1. The hourly pass counts both days ─────────────────────────────────────
DO $do$
DECLARE
  y bigint := (SELECT sum(run_count) FROM workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE - 1);
  t bigint := (SELECT sum(run_count) FROM workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE);
BEGIN
  IF y IS DISTINCT FROM 2 OR t IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'refresh(2) counted yesterday % and today %, expected 2 and 3', y, t; END IF;
  INSERT INTO rollup_cases VALUES ('the two day pass counts yesterday and today');
END
$do$;

-- A late change to yesterday (one execution finalised as failed long after it
-- started) and a new execution today, then only the frequent pass.
UPDATE public.workflow_executions SET status = 'failed', field_presence = '{"a": false, "b": true}'::jsonb
WHERE workflow_id = '44444444-4444-4444-4444-444444441884'
  AND started_at = (CURRENT_DATE - 1)::timestamptz + interval '12 hours' + interval '1 minute';
INSERT INTO public.workflow_executions (workflow_id, status, started_at, is_test, duration_ms, field_presence)
VALUES ('44444444-4444-4444-4444-444444441884', 'completed', CURRENT_DATE::timestamptz + interval '30 minutes', false, 100, '{"a": true, "b": false}'::jsonb);

SELECT refresh_workflow_stats_daily(0);
SELECT refresh_field_presence_daily(0);

-- ── 2. The frequent pass rewrites today ─────────────────────────────────────
DO $do$
DECLARE
  t bigint := (SELECT sum(run_count) FROM workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE);
  ft bigint := (SELECT ran_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE AND field_path = 'a' AND NOT is_test);
BEGIN
  IF t IS DISTINCT FROM 4 THEN RAISE EXCEPTION 'refresh_workflow_stats_daily(0) left today at %, expected 4', t; END IF;
  IF ft IS DISTINCT FROM 4 THEN RAISE EXCEPTION 'refresh_field_presence_daily(0) left today at %, expected 4', ft; END IF;
  INSERT INTO rollup_cases VALUES ('the today pass rewrites today');
END
$do$;

-- ── 3. ...and leaves yesterday exactly as the last two day pass wrote it ─────
DO $do$
DECLARE
  completed bigint := (SELECT sum(run_count) FROM workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE - 1 AND status = 'completed');
  failed bigint := (SELECT sum(run_count) FROM workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE - 1 AND status = 'failed');
  present_a bigint := (SELECT present_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE - 1 AND field_path = 'a' AND NOT is_test);
BEGIN
  -- Neither deleted (a hole until the hourly pass) nor rewritten (a full read).
  IF completed IS DISTINCT FROM 2 OR failed IS NOT NULL THEN
    RAISE EXCEPTION 'refresh_workflow_stats_daily(0) touched yesterday: completed %, failed %', completed, failed;
  END IF;
  IF present_a IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'refresh_field_presence_daily(0) touched yesterday: a present %', present_a; END IF;
  INSERT INTO rollup_cases VALUES ('the today pass leaves past days alone');
END
$do$;

SELECT refresh_workflow_stats_daily(2);
SELECT refresh_field_presence_daily(2);

-- ── 4. The hourly pass folds the late change into its own day ───────────────
DO $do$
DECLARE
  completed bigint := (SELECT sum(run_count) FROM workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE - 1 AND status = 'completed');
  failed bigint := (SELECT sum(run_count) FROM workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE - 1 AND status = 'failed');
  present_a bigint := (SELECT present_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884' AND day = CURRENT_DATE - 1 AND field_path = 'a' AND NOT is_test);
BEGIN
  IF completed IS DISTINCT FROM 1 OR failed IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'refresh_workflow_stats_daily(2) did not pick up the late change: completed %, failed %', completed, failed;
  END IF;
  IF present_a IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'refresh_field_presence_daily(2) did not pick up the late change: a present %', present_a; END IF;
  INSERT INTO rollup_cases VALUES ('the hourly pass folds a late change into its day');
END
$do$;

-- ── 5. The schedule: today often, the two days before hourly ─────────────────
DO $do$
DECLARE
  bad text[] := '{}';
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('refresh-workflow-stats-daily',        '1-59/5 * * * *',  'refresh_workflow_stats_daily(0)'),
      ('refresh-workflow-stats-daily-recent', '8 * * * *',       'refresh_workflow_stats_daily(2)'),
      ('refresh-workflow-stats-daily-full',   '47 3 * * *',      'refresh_workflow_stats_daily(7)'),
      ('refresh-field-presence-daily',        '4-59/15 * * * *', 'refresh_field_presence_incremental()'),
      ('refresh-field-presence-daily-recent', '42 * * * *',      'refresh_field_presence_daily(2)'),
      ('refresh-field-presence-daily-full',   '52 3 * * *',      'refresh_field_presence_daily(7)')
    ) AS v(jobname, schedule, call)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM cron.job j
      WHERE j.jobname = r.jobname AND j.schedule = r.schedule AND j.active
        AND position(r.call IN j.command) > 0
        AND j.command LIKE 'SET statement_timeout%'
    ) THEN
      bad := array_append(bad, format('%s is not %s running %s with its own statement_timeout', r.jobname, r.schedule, r.call));
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reduce-finalize-stranded' AND schedule = '27,57 * * * *' AND active AND command LIKE '%reduce_finalize_stranded(%') THEN
    bad := array_append(bad, 'reduce-finalize-stranded is not on 27,57 with its command untouched');
  END IF;

  -- Altered in place, not rescheduled: an unschedule and reschedule would mint
  -- a jobid above the recent jobs this migration created after it.
  IF (SELECT jobid FROM cron.job WHERE jobname = 'refresh-workflow-stats-daily') >
     (SELECT jobid FROM cron.job WHERE jobname = 'refresh-workflow-stats-daily-recent') THEN
    bad := array_append(bad, 'refresh-workflow-stats-daily was rescheduled rather than altered, so its run history was discarded');
  END IF;
  IF (SELECT jobid FROM cron.job WHERE jobname = 'refresh-field-presence-daily') >
     (SELECT jobid FROM cron.job WHERE jobname = 'refresh-field-presence-daily-recent') THEN
    bad := array_append(bad, 'refresh-field-presence-daily was rescheduled rather than altered, so its run history was discarded');
  END IF;

  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO rollup_cases VALUES ('the schedule');
END
$do$;

-- ── Clean up ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_name text;
BEGIN
  DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441884';
  DELETE FROM public.workflow_stats_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884';
  DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441884';
  FOR v_name IN SELECT name FROM rollup_made_partitions LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I', v_name);
  END LOOP;
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM rollup_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
