-- The daily step timeout alert's five day reading (#2934), migration
-- 20261029180000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Fixed ids, deleted
-- first, so a rerun starts clean. No real identity.
--
-- WHAT IT PROVES:
--   A. The finished run sample is even across the period: at most p_per_hour
--      runs from each hour, so 50 quick runs in one hour count 10 and 5 slow
--      runs in another count 5. A test run, another workflow's run and a run at
--      the period's end are not sampled.
--   B. timed_out counts only final failures with the engine's own "Step timed
--      out after" message inside [p_since, p_until): not a parallel group's
--      timeout, a token fetch timeout, a test run, a fallback, or a run on either
--      side of the period. timed_out_at lists them, latest first.
--   C. A step whose only runs in the period timed out still answers, with an
--      empty sample; a step with nothing in the period and a step not asked about
--      answer nothing.
--   D. A bad period, a bad per hour count or too many steps is refused, never
--      clamped.
--   E. It is STABLE, SECURITY INVOKER with its own search_path, only
--      service_role may call it, and the index it reads failed rows through is
--      partial on status = 'failed'.
--
-- Mutations tried on 2026-10-29 (each turned its case red, then the function was
-- put back): dropping `LIMIT p_per_hour` (A sampled 55), dropping
-- `AND es.error_message LIKE 'Step timed out after %'` (B counted 5), and
-- dropping `AND es.is_test IS NOT TRUE` from the timeouts (B counted 4).
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS stab_cases (name text PRIMARY KEY);
DELETE FROM stab_cases;

DO $do$
DECLARE
  d date;
  t text;
  v_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_executions', 'execution_steps'] LOOP
    FOREACH d IN ARRAY ARRAY[CURRENT_DATE - 3, CURRENT_DATE - 2, CURRENT_DATE - 1, CURRENT_DATE] LOOP
      v_name := t || '_' || to_char(d, 'YYYY_MM_DD');
      BEGIN
        EXECUTE format('CREATE TABLE %I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)', v_name, t, d, d + 1);
      EXCEPTION
        WHEN invalid_object_definition OR duplicate_table THEN NULL;
      END;
    END LOOP;
  END LOOP;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112934', 'STAB Org', 'stab-org-2934') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES
    ('44444444-4444-4444-4444-444444442934', '11111111-1111-1111-1111-111111112934', 'STAB Flow'),
    ('44444444-4444-4444-4444-444444442935', '11111111-1111-1111-1111-111111112934', 'STAB Other Flow')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.execution_steps WHERE workflow_id IN ('44444444-4444-4444-4444-444444442934', '44444444-4444-4444-4444-444444442935');
  DELETE FROM public.workflow_executions WHERE workflow_id IN ('44444444-4444-4444-4444-444444442934', '44444444-4444-4444-4444-444444442935');
  -- One execution holds every step: the foreign key wants one, the function never reads it.
  INSERT INTO public.workflow_executions (id, workflow_id, status, started_at)
  VALUES ('55555555-5555-5555-5555-555555552934', '44444444-4444-4444-4444-444444442934', 'completed',
          (CURRENT_DATE - 3)::timestamp AT TIME ZONE 'UTC');
END
$do$;

-- The period is T0 = two days ago 00:00 UTC to T0 + 48 hours.
-- step(namespace, workflow, status, offset from T0, duration, message, is_test)
INSERT INTO public.execution_steps (execution_id, execution_started_at, workflow_id, step_namespace, step_type, status, started_at, duration_ms, error_message, is_test)
SELECT '55555555-5555-5555-5555-555555552934', (CURRENT_DATE - 3)::timestamp AT TIME ZONE 'UTC', w::uuid, ns, 'webhook', s,
       ((CURRENT_DATE - 2)::timestamp AT TIME ZONE 'UTC') + at_offset, dur, msg, tst
FROM (
  -- A: 50 quick runs in hour 1, 5 slow ones in hour 30.
  SELECT '44444444-4444-4444-4444-444444442934' AS w, 'busy' AS ns, 'completed' AS s, interval '1 hour' + make_interval(secs => g) AS at_offset, 100 AS dur, NULL::text AS msg, false AS tst
  FROM generate_series(0, 49) g
  UNION ALL
  SELECT '44444444-4444-4444-4444-444444442934', 'busy', 'completed', interval '30 hours' + make_interval(secs => g), 900, NULL, false
  FROM generate_series(0, 4) g
  UNION ALL VALUES
  -- Not sampled.
  ('44444444-4444-4444-4444-444444442934', 'busy', 'completed', interval '5 hours', 99999, NULL, true),
  ('44444444-4444-4444-4444-444444442935', 'busy', 'completed', interval '5 hours', 88888, NULL, false),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'completed', interval '48 hours', 77777, NULL, false),
  -- B: three counted timeouts.
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '2 hours', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', false),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '3 hours', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', false),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '40 hours', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', false),
  -- B: not counted.
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '6 hours', 20000, 'Parallel group timed out after 20000ms before this child completed', false),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '7 hours', 5000, 'Salesforce token fetch timed out after 5000 ms', false),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '8 hours', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', true),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed_with_fallback', interval '9 hours', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', false),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '-1 second', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', false),
  ('44444444-4444-4444-4444-444444442934', 'busy', 'failed', interval '48 hours', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', false),
  ('44444444-4444-4444-4444-444444442935', 'busy', 'failed', interval '10 hours', 3750, 'Step timed out after 3750ms (in-flight upstream call canceled via abort signal)', false),
  -- C: a step that only timed out, and a step nobody asks about.
  ('44444444-4444-4444-4444-444444442934', 'only_timeouts', 'failed', interval '12 hours', 4500, 'Step timed out after 4500ms (in-flight upstream call canceled via abort signal)', false),
  ('44444444-4444-4444-4444-444444442934', 'only_timeouts', 'failed', interval '13 hours', 4500, 'Step timed out after 4500ms (in-flight upstream call canceled via abort signal)', false),
  ('44444444-4444-4444-4444-444444442934', 'not_asked', 'completed', interval '12 hours', 50, NULL, false)
) AS v(w, ns, s, at_offset, dur, msg, tst);

-- ── A. An even sample ────────────────────────────────────────────────────────
DO $do$
DECLARE
  t0 timestamptz := (CURRENT_DATE - 2)::timestamp AT TIME ZONE 'UTC';
  r record;
BEGIN
  SELECT * INTO r FROM public.step_timeout_audit_by_workflow('44444444-4444-4444-4444-444444442934', t0, t0 + interval '48 hours',
    ARRAY['busy', 'only_timeouts', 'quiet'], 10) WHERE step_namespace = 'busy';
  IF NOT FOUND THEN RAISE EXCEPTION 'busy answered nothing'; END IF;
  IF (r.sample_size, r.max_ms, r.p50) IS DISTINCT FROM (15::bigint, 900, 100) THEN
    RAISE EXCEPTION '(sample_size, max_ms, p50) = (%, %, %), expected (15, 900, 100)', r.sample_size, r.max_ms, r.p50;
  END IF;
  INSERT INTO stab_cases VALUES ('samples at most p_per_hour finished live runs of the workflow from each hour of the period');
END
$do$;

-- ── B. Runs that failed on the step timeout ──────────────────────────────────
DO $do$
DECLARE
  t0 timestamptz := (CURRENT_DATE - 2)::timestamp AT TIME ZONE 'UTC';
  r record;
BEGIN
  SELECT * INTO r FROM public.step_timeout_audit_by_workflow('44444444-4444-4444-4444-444444442934', t0, t0 + interval '48 hours',
    ARRAY['busy'], 10);
  IF r.timed_out <> 3 THEN RAISE EXCEPTION 'timed_out = %, expected 3', r.timed_out; END IF;
  IF r.timed_out_at IS DISTINCT FROM ARRAY[t0 + interval '40 hours', t0 + interval '3 hours', t0 + interval '2 hours'] THEN
    RAISE EXCEPTION 'timed_out_at = %', r.timed_out_at;
  END IF;
  INSERT INTO stab_cases VALUES ('counts only live final failures on the step timeout inside the period, latest first');
END
$do$;

-- ── C. Which steps answer ────────────────────────────────────────────────────
DO $do$
DECLARE
  t0 timestamptz := (CURRENT_DATE - 2)::timestamp AT TIME ZONE 'UTC';
  r record;
  names text[];
BEGIN
  SELECT array_agg(step_namespace ORDER BY step_namespace) INTO names
  FROM public.step_timeout_audit_by_workflow('44444444-4444-4444-4444-444444442934', t0, t0 + interval '48 hours', ARRAY['busy', 'only_timeouts', 'quiet'], 10);
  IF names IS DISTINCT FROM ARRAY['busy', 'only_timeouts'] THEN RAISE EXCEPTION 'answered %', names; END IF;
  SELECT * INTO r FROM public.step_timeout_audit_by_workflow('44444444-4444-4444-4444-444444442934', t0, t0 + interval '48 hours', ARRAY['only_timeouts'], 10);
  IF (r.sample_size, r.timed_out) IS DISTINCT FROM (0::bigint, 2::bigint) OR r.p99 IS NOT NULL THEN
    RAISE EXCEPTION 'only_timeouts answered (%, %, %)', r.sample_size, r.timed_out, r.p99;
  END IF;
  INSERT INTO stab_cases VALUES ('a step that only timed out answers with an empty sample; a quiet or unasked step answers nothing');
END
$do$;

-- ── D. Refusals ──────────────────────────────────────────────────────────────
DO $do$
DECLARE
  t0 timestamptz := (CURRENT_DATE - 2)::timestamp AT TIME ZONE 'UTC';
  bad record;
  refused int := 0;
BEGIN
  FOR bad IN
    SELECT * FROM (VALUES
      (t0, t0 + interval '1 day', 0, 1),
      (t0, t0 + interval '1 day', 51, 1),
      (t0, t0 + interval '1 day', NULL, 1),
      (t0, t0, 10, 1),
      (t0, t0 + interval '9 days', 10, 1),
      (t0, t0 + interval '1 day', 10, 51)
    ) AS v(since, until, per_hour, steps)
  LOOP
    BEGIN
      PERFORM * FROM public.step_timeout_audit_by_workflow('44444444-4444-4444-4444-444444442934', bad.since, bad.until,
        (SELECT array_agg('s' || g) FROM generate_series(1, bad.steps) g), bad.per_hour);
    EXCEPTION WHEN invalid_parameter_value THEN
      refused := refused + 1;
    END;
  END LOOP;
  IF refused <> 6 THEN RAISE EXCEPTION 'refused % of 6 bad calls', refused; END IF;
  INSERT INTO stab_cases VALUES ('refuses a bad period, per hour count or step list rather than clamping it');
END
$do$;

-- ── E. Grants, volatility and the index ──────────────────────────────────────
DO $do$
DECLARE
  fn text := 'public.step_timeout_audit_by_workflow(uuid, timestamptz, timestamptz, text[], int)';
  r text;
  p record;
BEGIN
  IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION '% does not exist', fn; END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, fn, 'EXECUTE') THEN RAISE EXCEPTION '% may call %', r, fn; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role may not call %', fn; END IF;
  SELECT prosecdef, proconfig, provolatile INTO p FROM pg_proc WHERE oid = to_regprocedure(fn);
  IF p.prosecdef OR p.provolatile <> 's' OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION '% is not STABLE SECURITY INVOKER with its own search_path', fn;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'execution_steps' AND indexname = 'idx_steps_wf_ns_failed'
      AND indexdef LIKE '%(workflow_id, step_namespace, started_at)%' AND indexdef LIKE '%WHERE (status = ''failed''::text)%'
  ) THEN
    RAISE EXCEPTION 'idx_steps_wf_ns_failed is missing or not partial on failed rows';
  END IF;
  INSERT INTO stab_cases VALUES ('service_role only, STABLE SECURITY INVOKER, with a partial index on failed rows');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.execution_steps WHERE workflow_id IN ('44444444-4444-4444-4444-444444442934', '44444444-4444-4444-4444-444444442935');
DELETE FROM public.workflow_executions WHERE workflow_id IN ('44444444-4444-4444-4444-444444442934', '44444444-4444-4444-4444-444444442935');

DO $do$
DECLARE
  n int := (SELECT count(*) FROM stab_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'step_timeout_audit.test.sql: % cases passed', n;
END
$do$;
