-- Behavioural tests for drop_exported_sighting_partitions (#464, #781).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. It works in
-- partitions for months in 2025 that no real row can fall in, created here and
-- removed here, so the result does not depend on the date the suite runs (L130)
-- and a rerun is idempotent. No real identity appears anywhere in it.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS drop_cases (name text PRIMARY KEY);
DELETE FROM drop_cases;

-- ── Fixtures: past month partitions in 2025, one per case ────────────────────
DO $do$
DECLARE
  m int;
BEGIN
  FOR m IN 1..6 LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I', 'lead_sighting_bids_2025_' || lpad(m::text, 2, '0'));
    EXECUTE format('CREATE TABLE public.%I PARTITION OF public.lead_sighting_bids FOR VALUES FROM (%L) TO (%L)',
      'lead_sighting_bids_2025_' || lpad(m::text, 2, '0'),
      make_date(2025, m, 1), make_date(2025, m + 1, 1));
  END LOOP;
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  CREATE TABLE public.lead_sightings_2025_01 PARTITION OF public.lead_sightings FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  DROP TABLE IF EXISTS public.achieve_evaluations_2025_01;
  CREATE TABLE public.achieve_evaluations_2025_01 PARTITION OF public.achieve_evaluations FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  -- The current month and the next three always exist in production.
  PERFORM public.create_monthly_analytics_partitions();
END
$do$;

-- 2025_01 stays empty: an empty past month.
-- 2025_02: every row exported and past the grace.
INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at)
VALUES (gen_random_uuid(), 'drop-test', gen_random_uuid(), 'drop-test', '2025-02-10', '2025-02-10', now() - interval '48 hours');
-- 2025_03: a row not yet exported.
INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at)
VALUES (gen_random_uuid(), 'drop-test', gen_random_uuid(), 'drop-test', '2025-03-10', '2025-03-10', NULL);
-- 2025_04: a row Snowflake refused and the export set aside (#427).
INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at, export_rejected_at, export_rejected_reason)
VALUES (gen_random_uuid(), 'drop-test', gen_random_uuid(), 'drop-test', '2025-04-10', '2025-04-10', NULL, now(), 'Snowflake 422: refused');
-- 2025_05: exported, but only an hour ago.
INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at)
VALUES (gen_random_uuid(), 'drop-test', gen_random_uuid(), 'drop-test', '2025-05-10', '2025-05-10', now() - interval '1 hour');
-- 2025_06: one past-grace row beside one unexported row, so a check that only
-- looked at the first row it met could pass it.
INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at)
VALUES (gen_random_uuid(), 'drop-test', gen_random_uuid(), 'drop-test', '2025-06-10', '2025-06-10', now() - interval '72 hours'),
       (gen_random_uuid(), 'drop-test', gen_random_uuid(), 'drop-test', '2025-06-11', '2025-06-11', NULL);

-- ── 1. Grants: only service_role may call it, and it runs as its owner ───────
DO $do$
DECLARE
  fn text := 'public.drop_exported_sighting_partitions(interval)';
  bad text[] := '{}';
  p record;
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN bad := array_append(bad, 'anon can execute'); END IF;
  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN bad := array_append(bad, 'authenticated can execute'); END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN bad := array_append(bad, 'service_role cannot execute'); END IF;
  SELECT prosecdef, proconfig INTO p FROM pg_proc WHERE oid = fn::regprocedure;
  IF NOT p.prosecdef THEN bad := array_append(bad, 'not SECURITY DEFINER'); END IF;
  IF p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
    bad := array_append(bad, 'no fixed search_path');
  END IF;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO drop_cases(name) VALUES ('grants');
END
$do$;

-- ── Run it once; every case below reads what that run did ─────────────────────
CREATE TEMP TABLE drop_result AS SELECT * FROM public.drop_exported_sighting_partitions();

-- ── 2. An empty past month is dropped, for each of the three tables ──────────
DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_sighting_bids_2025_01', 'lead_sightings_2025_01', 'achieve_evaluations_2025_01'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN RAISE EXCEPTION '% was not dropped', t; END IF;
    IF NOT EXISTS (SELECT 1 FROM drop_result WHERE partition_name = t AND outcome = 'dropped') THEN
      RAISE EXCEPTION '% dropped without saying so', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.purge_run_log WHERE partition_name = t AND outcome = 'dropped' AND job = 'sightings-partition-drop') THEN
      RAISE EXCEPTION '% dropped without a purge_run_log row', t;
    END IF;
  END LOOP;
  INSERT INTO drop_cases(name) VALUES ('empty past month dropped and logged');
END
$do$;

-- ── 3. A past month whose every row is exported and past the grace is dropped
DO $do$
BEGIN
  IF to_regclass('public.lead_sighting_bids_2025_02') IS NOT NULL THEN
    RAISE EXCEPTION 'a month holding only exported, past-grace rows was kept';
  END IF;
  INSERT INTO drop_cases(name) VALUES ('fully exported past month dropped');
END
$do$;

-- ── 4. to 7. Anything not yet safe in Snowflake keeps its month, with the reason
DO $do$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
      ('lead_sighting_bids_2025_03', 'unexported'),
      ('lead_sighting_bids_2025_04', 'set_aside'),
      ('lead_sighting_bids_2025_05', 'within_grace'),
      ('lead_sighting_bids_2025_06', 'unexported')) v(part, reason)
  LOOP
    IF to_regclass('public.' || c.part) IS NULL THEN RAISE EXCEPTION '% was dropped while it held a % row', c.part, c.reason; END IF;
    IF NOT EXISTS (SELECT 1 FROM drop_result WHERE partition_name = c.part AND outcome = 'refused_non_empty' AND reason = c.reason) THEN
      RAISE EXCEPTION '% kept without the reason %: %', c.part, c.reason,
        (SELECT string_agg(outcome || '/' || coalesce(reason, ''), ', ') FROM drop_result WHERE partition_name = c.part);
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.lead_sighting_bids WHERE trace_id = 'drop-test' AND attempted_at_utc >= '2025-03-01') <> 5 THEN
    RAISE EXCEPTION 'a kept month lost rows';
  END IF;
  INSERT INTO drop_cases(name) VALUES ('unexported month kept');
  INSERT INTO drop_cases(name) VALUES ('set aside month kept');
  INSERT INTO drop_cases(name) VALUES ('within grace month kept');
  INSERT INTO drop_cases(name) VALUES ('mixed month kept');
END
$do$;

-- ── 8. The current month and the months ahead are never candidates ──────────
DO $do$
DECLARE
  t text;
  m date;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_sightings', 'lead_sighting_bids', 'achieve_evaluations'] LOOP
    m := date_trunc('month', now() AT TIME ZONE 'utc')::date;
    FOR i IN 0..3 LOOP
      IF to_regclass('public.' || t || '_' || to_char(m, 'YYYY_MM')) IS NULL THEN
        RAISE EXCEPTION '% for % was dropped', t, m;
      END IF;
      IF EXISTS (SELECT 1 FROM drop_result WHERE partition_name = t || '_' || to_char(m, 'YYYY_MM')) THEN
        RAISE EXCEPTION '% for % was even considered', t, m;
      END IF;
      m := (m + interval '1 month')::date;
    END LOOP;
  END LOOP;
  INSERT INTO drop_cases(name) VALUES ('current and future months untouched');
END
$do$;

-- ── Cleanup, then the count ─────────────────────────────────────────────────
DO $do$
DECLARE
  m int;
BEGIN
  FOR m IN 1..6 LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I', 'lead_sighting_bids_2025_' || lpad(m::text, 2, '0'));
  END LOOP;
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  DROP TABLE IF EXISTS public.achieve_evaluations_2025_01;
  DELETE FROM public.purge_run_log WHERE job = 'sightings-partition-drop';
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM drop_cases);
BEGIN
  IF n <> 8 THEN RAISE EXCEPTION 'expected 8 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
