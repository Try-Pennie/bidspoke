-- Behavioural tests for the key presence counts of #2018.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. No real identity.
--
-- WHAT IT PROVES.
--   A. The recount counts key_present_count (a value or empty, never a wrong path)
--      and key_measured_count over version 2 runs only. A version 1 run, whose
--      empty values were recorded as false, adds to ran but to neither new count.
--   B. The incremental pass adds the same two counts onto a day's row.
--
-- THE CLOCK. Every completed_at sits minutes inside the passes' one minute
-- ceiling and the watermark is set by hand, so no assertion depends on timing.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS fp_key_cases (name text PRIMARY KEY);
DELETE FROM fp_key_cases;

DO $do$
DECLARE
  d date;
  v_name text;
BEGIN
  FOREACH d IN ARRAY ARRAY[CURRENT_DATE - 1, CURRENT_DATE] LOOP
    v_name := 'workflow_executions_' || to_char(d, 'YYYY_MM_DD');
    BEGIN
      EXECUTE format('CREATE TABLE %I PARTITION OF public.workflow_executions FOR VALUES FROM (%L) TO (%L)', v_name, d, d + 1);
    EXCEPTION
      WHEN invalid_object_definition OR duplicate_table THEN NULL;
    END;
  END LOOP;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112018', 'FP Key Org', 'fp-key-org-2018') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444442018', '11111111-1111-1111-1111-111111112018', 'FP Key Flow') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444442018';
  DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444442018';
END
$do$;

-- ── A. The recount ───────────────────────────────────────────────────────────
-- Yesterday, five runs. Field `marker` is empty by design (null at version 2);
-- field `typo` names a key that is not there (false); field `v` has a value.
--   three version 2 runs: marker null, typo false, v true
--   one version 2 run:    marker true,  typo false, v null
--   one version 1 run:    marker false, typo false, v true   (old meaning)
INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence, field_presence_version)
SELECT '44444444-4444-4444-4444-444444442018', 'completed',
       (CURRENT_DATE - 1)::timestamptz + interval '12 hours' + g * interval '1 minute',
       (CURRENT_DATE - 1)::timestamptz + interval '12 hours' + g * interval '1 minute' + interval '2 seconds',
       false, 100, '{"marker": null, "typo": false, "v": true}'::jsonb, 2
FROM generate_series(1, 3) g;

INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence, field_presence_version)
VALUES ('44444444-4444-4444-4444-444444442018', 'completed',
        (CURRENT_DATE - 1)::timestamptz + interval '13 hours',
        (CURRENT_DATE - 1)::timestamptz + interval '13 hours 2 seconds',
        false, 100, '{"marker": true, "typo": false, "v": null}'::jsonb, 2);

INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence)
VALUES ('44444444-4444-4444-4444-444444442018', 'completed',
        (CURRENT_DATE - 1)::timestamptz + interval '14 hours',
        (CURRENT_DATE - 1)::timestamptz + interval '14 hours 2 seconds',
        false, 100, '{"marker": false, "typo": false, "v": true}'::jsonb);

SELECT refresh_field_presence_daily(2);

DO $do$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT field_path, ran_count, present_count, key_present_count, key_measured_count
    FROM field_presence_daily
    WHERE workflow_id = '44444444-4444-4444-4444-444444442018' AND day = CURRENT_DATE - 1 AND NOT is_test
  LOOP
    IF r.field_path = 'marker' AND (r.ran_count, r.present_count, r.key_present_count, r.key_measured_count) IS DISTINCT FROM (5::bigint, 1::bigint, 4::bigint, 4::bigint) THEN
      RAISE EXCEPTION 'marker counted (ran, present, key, measured) = (%, %, %, %), expected (5, 1, 4, 4)', r.ran_count, r.present_count, r.key_present_count, r.key_measured_count;
    END IF;
    IF r.field_path = 'typo' AND (r.ran_count, r.present_count, r.key_present_count, r.key_measured_count) IS DISTINCT FROM (5::bigint, 0::bigint, 0::bigint, 4::bigint) THEN
      RAISE EXCEPTION 'typo counted (ran, present, key, measured) = (%, %, %, %), expected (5, 0, 0, 4)', r.ran_count, r.present_count, r.key_present_count, r.key_measured_count;
    END IF;
    IF r.field_path = 'v' AND (r.ran_count, r.present_count, r.key_present_count, r.key_measured_count) IS DISTINCT FROM (5::bigint, 4::bigint, 4::bigint, 4::bigint) THEN
      RAISE EXCEPTION 'v counted (ran, present, key, measured) = (%, %, %, %), expected (5, 4, 4, 4)', r.ran_count, r.present_count, r.key_present_count, r.key_measured_count;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444442018' AND day = CURRENT_DATE - 1) <> 3 THEN
    RAISE EXCEPTION 'expected three field rows for yesterday';
  END IF;
  INSERT INTO fp_key_cases VALUES ('the recount counts key presence over version 2 runs only');
END
$do$;

-- ── B. The incremental pass adds the same counts ─────────────────────────────
UPDATE field_presence_rollup_state SET watermark = now() - interval '10 minutes' WHERE id;
INSERT INTO public.workflow_executions (workflow_id, status, started_at, completed_at, is_test, duration_ms, field_presence, field_presence_version)
SELECT '44444444-4444-4444-4444-444444442018', 'completed',
       (CURRENT_DATE - 1)::timestamptz + interval '15 hours' + g * interval '1 minute',
       now() - interval '5 minutes',
       false, 100, '{"marker": null, "typo": false, "v": true}'::jsonb, 2
FROM generate_series(1, 2) g;
SELECT refresh_field_presence_incremental();

DO $do$
DECLARE
  r record;
BEGIN
  SELECT ran_count, key_present_count, key_measured_count INTO r
  FROM field_presence_daily
  WHERE workflow_id = '44444444-4444-4444-4444-444444442018' AND field_path = 'marker' AND day = CURRENT_DATE - 1 AND NOT is_test;
  IF (r.ran_count, r.key_present_count, r.key_measured_count) IS DISTINCT FROM (7::bigint, 6::bigint, 6::bigint) THEN
    RAISE EXCEPTION 'after the incremental marker is (ran, key, measured) = (%, %, %), expected (7, 6, 6)', r.ran_count, r.key_present_count, r.key_measured_count;
  END IF;
  INSERT INTO fp_key_cases VALUES ('the incremental pass adds the key presence counts');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444442018';
DELETE FROM public.field_presence_daily WHERE workflow_id = '44444444-4444-4444-4444-444444442018';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM fp_key_cases);
BEGIN
  IF n <> 2 THEN RAISE EXCEPTION 'expected 2 cases, % ran', n; END IF;
  RAISE NOTICE 'field_presence_key_counts.test.sql: % cases passed', n;
END
$do$;
