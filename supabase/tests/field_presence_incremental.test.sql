-- Behavioural tests for the incremental field presence rollup of #1150.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. No real identity
-- appears in it. "Runs from empty" is the suite itself: these functions and the
-- watermark state table exist only because the migration replayed onto a bare
-- database before this file ran.
--
-- WHAT IT PROVES.
--   A. The incremental pass, run from a watermark before every execution,
--      produces exactly what a full delete-then-insert reaggregation produces,
--      including bucketing a cross-midnight run into its START day.
--   B. The pass ADDS to the counts already in a day rather than replacing them,
--      and an execution at or below the watermark is never counted again (the
--      half-open lower boundary is exactly-once).
--   C. Running the pass again with nothing new adds nothing.
--   D. A full reconcile advances the watermark past everything it counted, so the
--      incremental pass that follows it cannot double-count the reconciled rows.
--   F. A reconcile shares the incremental's one minute ceiling: a run stamped
--      inside the last minute is left to the incremental, and the watermark stays
--      below it.
--   G. A recount narrower than two days leaves the watermark alone.
--   E. A reconcile re-seeds the state table a restore leaves empty.
--
-- THE CLOCK. The pass takes executions with completed_at in (watermark, now() -
-- 1 minute]. The test anchors every execution's completed_at a comfortable
-- several minutes inside that window and sets the watermark by hand, so no
-- assertion depends on wall-clock timing between statements (L290).
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS fp_incr_cases (name text PRIMARY KEY);
DELETE FROM fp_incr_cases;
CREATE TEMP TABLE IF NOT EXISTS fp_incr_made_partitions (name text PRIMARY KEY);
DELETE FROM fp_incr_made_partitions;

-- A partition for each of the three days, unless one already covers it.
DO $do$
DECLARE
  d date;
  v_name text;
BEGIN
  FOREACH d IN ARRAY ARRAY[CURRENT_DATE - 2, CURRENT_DATE - 1, CURRENT_DATE] LOOP
    v_name := 'workflow_executions_' || to_char(d, 'YYYY_MM_DD');
    BEGIN
      EXECUTE format('CREATE TABLE %I PARTITION OF public.workflow_executions FOR VALUES FROM (%L) TO (%L)', v_name, d, d + 1);
      INSERT INTO fp_incr_made_partitions VALUES (v_name);
    EXCEPTION
      WHEN invalid_object_definition OR duplicate_table THEN NULL;
    END;
  END LOOP;

  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111150', 'FP Incr Org', 'fp-incr-org-1150') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444441150', '11111111-1111-1111-1111-111111111150', 'FP Incr Flow') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
  DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
END
$do$;

-- ── A. Incremental from a low watermark equals a full rebuild ────────────────
-- Two completed yesterday, three completed today, plus one that started at 23:59
-- two days ago and finished at 00:05 yesterday (it belongs to its start day).
-- Every one saw field a, none saw b. All finished minutes ago, inside the pass's
-- ceiling.
DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';

INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
SELECT '44444444-4444-4444-4444-444444441150', 'completed',
       (CURRENT_DATE - 1)::timestamptz + interval '12 hours' + g * interval '1 minute',
       (CURRENT_DATE - 1)::timestamptz + interval '12 hours' + g * interval '1 minute' + interval '2 seconds',
       false, 100, '{"a": true, "b": false}'::jsonb
FROM generate_series(1, 2) g;

INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
SELECT '44444444-4444-4444-4444-444444441150', 'completed',
       CURRENT_DATE::timestamptz + g * interval '1 minute',
       now() - interval '5 minutes',
       false, 100, '{"a": true, "b": false}'::jsonb
FROM generate_series(1, 3) g;

-- Cross midnight: started at 23:59 two days ago, finished at 00:05 yesterday.
-- Buckets to its start day. It crosses the PREVIOUS midnight, not the last one,
-- because a run finishing at 00:05 today is outside the pass's now() - 1 minute
-- ceiling whenever the suite runs between 00:00 and 00:06 UTC.
INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
VALUES ('44444444-4444-4444-4444-444444441150', 'completed',
        (CURRENT_DATE - 2)::timestamptz + interval '23 hours 59 minutes',
        (CURRENT_DATE - 1)::timestamptz + interval '5 minutes',
        false, 100, '{"a": true, "b": false}'::jsonb);

-- Watermark before every execution above, so the incremental pass sees them all.
UPDATE field_presence_rollup_state SET watermark = (CURRENT_DATE - 2)::timestamptz WHERE id;
SELECT refresh_field_presence_incremental();

CREATE TEMP TABLE fp_incr_snap AS
SELECT field_path, day, is_test, ran_count, present_count
FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';

-- The same executions through the full reaggregation.
DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
SELECT refresh_field_presence_daily(2);

CREATE TEMP TABLE fp_full_snap AS
SELECT field_path, day, is_test, ran_count, present_count
FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';

DO $do$
DECLARE
  diff int := (
    SELECT count(*) FROM (
      (SELECT * FROM fp_incr_snap EXCEPT SELECT * FROM fp_full_snap)
      UNION ALL
      (SELECT * FROM fp_full_snap EXCEPT SELECT * FROM fp_incr_snap)
    ) d
  );
  d2_a bigint := (SELECT ran_count FROM fp_incr_snap WHERE field_path = 'a' AND day = CURRENT_DATE - 2 AND NOT is_test);
  y_a bigint := (SELECT ran_count FROM fp_incr_snap WHERE field_path = 'a' AND day = CURRENT_DATE - 1 AND NOT is_test);
  t_a bigint := (SELECT ran_count FROM fp_incr_snap WHERE field_path = 'a' AND day = CURRENT_DATE AND NOT is_test);
BEGIN
  IF diff <> 0 THEN
    RAISE EXCEPTION 'incremental and full rebuild differ in % row(s)', diff;
  END IF;
  -- The cross-midnight run lands in its start day (1), not the day it finished
  -- (yesterday stays 2).
  IF d2_a IS DISTINCT FROM 1 OR y_a IS DISTINCT FROM 2 OR t_a IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'expected two days ago a=1, yesterday a=2 and today a=3, got %, % and %', d2_a, y_a, t_a;
  END IF;
  INSERT INTO fp_incr_cases VALUES ('incremental equals a full rebuild and buckets by start day');
END
$do$;

-- ── B. The pass adds to a day, and never recounts at or below the watermark ──
DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';

-- Batch A: three today, already counted (we seed the rollup directly, as an
-- earlier pass would have left it, and place their completed_at below the
-- watermark we set).
INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
SELECT '44444444-4444-4444-4444-444444441150', 'completed',
       CURRENT_DATE::timestamptz + g * interval '1 minute',
       now() - interval '10 minutes',
       false, 100, '{"a": true, "b": false}'::jsonb
FROM generate_series(1, 3) g;
INSERT INTO public.field_presence_daily (workflow_id, field_path, day, is_test, ran_count, present_count) VALUES
  ('44444444-4444-4444-4444-444444441150', 'a', CURRENT_DATE, false, 3, 3),
  ('44444444-4444-4444-4444-444444441150', 'b', CURRENT_DATE, false, 3, 0);

-- Batch B: two more today, finished after the watermark.
INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
SELECT '44444444-4444-4444-4444-444444441150', 'completed',
       CURRENT_DATE::timestamptz + (10 + g) * interval '1 minute',
       now() - interval '3 minutes',
       false, 100, '{"a": true, "b": false}'::jsonb
FROM generate_series(1, 2) g;

-- Watermark between batch A (now - 10 min) and batch B (now - 3 min).
UPDATE field_presence_rollup_state SET watermark = now() - interval '4 minutes' WHERE id;
SELECT refresh_field_presence_incremental();

DO $do$
DECLARE
  a_ran bigint := (SELECT ran_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150' AND field_path = 'a' AND day = CURRENT_DATE AND NOT is_test);
  a_present bigint := (SELECT present_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150' AND field_path = 'a' AND day = CURRENT_DATE AND NOT is_test);
  b_present bigint := (SELECT present_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150' AND field_path = 'b' AND day = CURRENT_DATE AND NOT is_test);
BEGIN
  -- 3 already there + 2 added = 5. Not 2 (replace) and not 8 (batch A recounted).
  IF a_ran IS DISTINCT FROM 5 OR a_present IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'expected a ran/present = 5/5 after the add, got %/%', a_ran, a_present;
  END IF;
  IF b_present IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'b was never present, expected present 0, got %', b_present;
  END IF;
  INSERT INTO fp_incr_cases VALUES ('the pass adds to a day and skips rows at or below the watermark');
END
$do$;

-- ── C. Running the pass again adds nothing ───────────────────────────────────
SELECT refresh_field_presence_incremental();

DO $do$
DECLARE
  a_ran bigint := (SELECT ran_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150' AND field_path = 'a' AND day = CURRENT_DATE AND NOT is_test);
BEGIN
  IF a_ran IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'a second pass with nothing new changed a ran to %, expected 5', a_ran;
  END IF;
  INSERT INTO fp_incr_cases VALUES ('a repeat pass with nothing new is a no-op');
END
$do$;

-- ── D. A reconcile advances the watermark past what it counted ───────────────
-- so the incremental pass behind it cannot double-count the reconciled rows.
DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';

INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
SELECT '44444444-4444-4444-4444-444444441150', 'completed',
       CURRENT_DATE::timestamptz + g * interval '1 minute',
       now() - interval '5 minutes',
       false, 100, '{"a": true, "b": false}'::jsonb
FROM generate_series(1, 4) g;

-- A stale watermark, as if the incremental pass were behind.
UPDATE field_presence_rollup_state SET watermark = (CURRENT_DATE - 2)::timestamptz WHERE id;

-- The reconcile recomputes today and must leave the watermark at or past the
-- newest completed_at it counted (now - 5 min), so it is no earlier than that.
SELECT refresh_field_presence_daily(2);

DO $do$
DECLARE
  a_ran bigint := (SELECT ran_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150' AND field_path = 'a' AND day = CURRENT_DATE AND NOT is_test);
  wm timestamptz := (SELECT watermark FROM field_presence_rollup_state WHERE id);
  -- The newest completed_at the reconcile counted, read from the rows themselves.
  -- Not `now() - 5 minutes`: this DO block runs in a later transaction than the
  -- INSERT that stamped those rows, so its now() is later, and comparing to it
  -- would fail by the milliseconds between statements rather than test the rule.
  newest timestamptz := (SELECT max(completed_at) FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150');
BEGIN
  IF a_ran IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'reconcile left a ran at %, expected 4', a_ran;
  END IF;
  IF wm < newest THEN
    RAISE EXCEPTION 'reconcile left the watermark at %, before the newest row it counted (%)', wm, newest;
  END IF;
END
$do$;

-- The incremental pass behind the reconcile adds nothing: every reconciled row is
-- at or below the watermark now.
SELECT refresh_field_presence_incremental();

DO $do$
DECLARE
  a_ran bigint := (SELECT ran_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150' AND field_path = 'a' AND day = CURRENT_DATE AND NOT is_test);
BEGIN
  IF a_ran IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'the pass after a reconcile double-counted: a ran is %, expected 4', a_ran;
  END IF;
  INSERT INTO fp_incr_cases VALUES ('a reconcile advances the watermark so the next pass cannot double-count');
END
$do$;

-- ── F. A reconcile leaves a run inside the last minute to the incremental ────
-- The reconcile shares the incremental's one minute ceiling. Without it the
-- watermark could jump to a run stamped just now, past an older-stamped run whose
-- row commits a moment after the reconcile's snapshot, and both passes would skip
-- that one until the next hourly recount (#1150 review). Here the newest run is
-- stamped 30 seconds AHEAD of the database clock, as a worker clock running fast
-- would stamp it: the reconcile must not count it, and must leave the watermark
-- below it so the incremental counts it once its ceiling passes.
INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
VALUES ('44444444-4444-4444-4444-444444441150', 'completed',
        CURRENT_DATE::timestamptz + interval '1 minute',
        clock_timestamp() + interval '30 seconds',
        false, 100, '{"a": true, "b": false}'::jsonb);

SELECT refresh_field_presence_daily(2);

DO $do$
DECLARE
  a_ran bigint := (SELECT ran_count FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150' AND field_path = 'a' AND day = CURRENT_DATE AND NOT is_test);
  wm timestamptz := (SELECT watermark FROM field_presence_rollup_state WHERE id);
  newest timestamptz := (SELECT max(completed_at) FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150');
BEGIN
  IF a_ran IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'reconcile counted a run inside the last minute: a ran is %, expected 4', a_ran;
  END IF;
  IF wm >= newest THEN
    RAISE EXCEPTION 'reconcile moved the watermark to % , at or past a run it did not count (%)', wm, newest;
  END IF;
  INSERT INTO fp_incr_cases VALUES ('a reconcile leaves a run inside the last minute to the incremental');
END
$do$;

-- ── G. A recount narrower than two days leaves the watermark alone ──────────
-- The incremental's floor reaches two days back, so a recount of today alone
-- cannot vouch for a run that started yesterday and finished since the watermark:
-- moving the watermark past it would hide it from both passes (#1150 review).
UPDATE field_presence_rollup_state SET watermark = (CURRENT_DATE - 2)::timestamptz WHERE id;
INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
VALUES ('44444444-4444-4444-4444-444444441150', 'completed',
        CURRENT_DATE::timestamptz + interval '1 minute', now() - interval '5 minutes',
        false, 100, '{"a": true, "b": false}'::jsonb);
SELECT refresh_field_presence_daily(0);

DO $do$
BEGIN
  IF (SELECT watermark FROM field_presence_rollup_state WHERE id) IS DISTINCT FROM (CURRENT_DATE - 2)::timestamptz THEN
    RAISE EXCEPTION 'a today-only recount moved the watermark to %', (SELECT watermark FROM field_presence_rollup_state WHERE id);
  END IF;
  INSERT INTO fp_incr_cases VALUES ('a recount narrower than two days leaves the watermark alone');
END
$do$;

-- ── E. After a restore the state table is empty, and a reconcile re-seeds it ──
-- The DR drill restores field_presence_rollup_state as structure only. The
-- incremental pass refuses on an empty table, and an UPDATE-based reconcile would
-- touch no row and never seed it, leaving the incremental refusing for ever. The
-- reconcile upserts, so the first one after a restore puts the row back.
DELETE FROM field_presence_rollup_state;

DO $do$
BEGIN
  BEGIN
    PERFORM refresh_field_presence_incremental();
    RAISE EXCEPTION 'the incremental pass ran on an empty state table instead of refusing';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%no watermark row%' THEN RAISE; END IF;
  END;
END
$do$;

SELECT refresh_field_presence_daily(2);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM field_presence_rollup_state WHERE id) THEN
    RAISE EXCEPTION 'a reconcile on an empty state table did not re-seed the watermark row';
  END IF;
  -- And the incremental pass now runs instead of refusing.
  PERFORM refresh_field_presence_incremental();
END
$do$;

-- With nothing to count, the seed is the reconcile's ceiling (now less a minute),
-- never the present: a seed at now() would sit above every run of the last minute,
-- which the reconcile leaves to the incremental, and the incremental would skip
-- them. This is also the first watermark the migration's own seed writes on a
-- fresh database.
DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
DELETE FROM field_presence_rollup_state;
SELECT refresh_field_presence_daily(2);

DO $do$
DECLARE
  wm timestamptz := (SELECT watermark FROM field_presence_rollup_state WHERE id);
BEGIN
  IF wm IS NULL OR wm > clock_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'a reconcile with nothing to count seeded the watermark at %, inside the last minute', wm;
  END IF;
  INSERT INTO fp_incr_cases VALUES ('a reconcile re-seeds an empty state table after a restore');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS fp_incr_snap;
DROP TABLE IF EXISTS fp_full_snap;
DO $do$
DECLARE
  v_name text;
BEGIN
  DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
  DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444441150';
  FOR v_name IN SELECT name FROM fp_incr_made_partitions LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I', v_name);
  END LOOP;
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM fp_incr_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
