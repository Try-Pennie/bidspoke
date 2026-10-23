-- A step's test result, kept on ops (#2339). Migration 20261024010000_step_test_results_2339.sql.
--
-- Dan decided on 2026-10-23 (recorded on #2339): a step's test result is kept
-- in the ops database only, never the bidding database; only the latest result
-- per step is kept, and it is deleted 7 days after the test, the same as run
-- history; it is read back for the data picker through the ops connection.
--
-- WHAT IT PROVES.
--   A. The table is under the ops rules: row level security on,
--      organization_id uuid NOT NULL, the browser roles shut out, service_role
--      read only, and a direct write as service_role refused by the database.
--   B. record_step_test keeps only the latest result per step: a second test of
--      the same step replaces the first, another step keeps its own.
--   C. It refuses another organization's workflow when ops holds a copy of it,
--      and a malformed result (a status outside the list, an output over its
--      cap) by name.
--   D. step_test_result answers one organization's result for one step, and
--      nothing once the result is 7 days old by the database clock.
--   E. purge_step_test_results deletes, by the database clock, exactly the
--      results tested more than 7 days ago, a page at a time.
--   F. The three functions are SECURITY DEFINER with a fixed search_path,
--      executable by service_role alone, the read STABLE.
--   G. An answer not kept (over its cap) is named by its size; a kept one's
--      size is measured, never taken from the caller.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE st_cases (name text PRIMARY KEY);

CREATE TEMP TABLE st_ids AS SELECT
  '00000000-0000-4000-8000-0000000023a0'::uuid AS org,
  '00000000-0000-4000-8000-0000000023a9'::uuid AS other_org,
  '00000000-0000-4000-8000-0000000023b0'::uuid AS wf,
  '00000000-0000-4000-8000-0000000023d1'::uuid AS dan;

-- ── A. The ops rules ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_wrote boolean;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.step_test_results'::regclass) THEN
    RAISE EXCEPTION 'step_test_results has row level security off';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'step_test_results'
      AND column_name = 'organization_id' AND data_type = 'uuid' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'step_test_results.organization_id is not uuid NOT NULL';
  END IF;
  IF has_table_privilege('anon', 'public.step_test_results', 'SELECT') OR has_table_privilege('authenticated', 'public.step_test_results', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role can read step_test_results';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.step_test_results', 'SELECT')
      OR has_table_privilege('service_role', 'public.step_test_results', 'INSERT')
      OR has_table_privilege('service_role', 'public.step_test_results', 'UPDATE')
      OR has_table_privilege('service_role', 'public.step_test_results', 'DELETE') THEN
    RAISE EXCEPTION 'service_role is not read only on step_test_results';
  END IF;
  -- And a direct write as service_role is refused by the database, not only absent from the grants.
  SET LOCAL ROLE service_role;
  BEGIN
    INSERT INTO public.step_test_results (organization_id, workflow_id, node_id, namespace, tested_by, status, duration_ms)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'direct', 'direct', gen_random_uuid(), 'completed', 1);
    v_wrote := true;
  EXCEPTION WHEN insufficient_privilege THEN
    v_wrote := false;
  END;
  RESET ROLE;
  IF v_wrote THEN RAISE EXCEPTION 'service_role wrote step_test_results directly'; END IF;
  INSERT INTO st_cases VALUES ('rules: row level security, organization uuid, browser roles shut out, service_role read only');
END
$do$;

-- ── B. Only the latest result per step ───────────────────────────────────────
DO $do$
DECLARE
  i st_ids%ROWTYPE;
  v_n integer;
BEGIN
  SELECT * INTO i FROM st_ids;
  PERFORM public.record_step_test(i.org, i.wf, 'n1', 'find_files', i.dan, 'completed', '{"files": [1]}'::jsonb, NULL, NULL, '[]'::jsonb, 120);
  PERFORM public.record_step_test(i.org, i.wf, 'n1', 'find_files', i.dan, 'failed', NULL, NULL, 'drive_failed: the service answered 500', '[]'::jsonb, 80);
  PERFORM public.record_step_test(i.org, i.wf, 'n2', 'notify', i.dan, 'completed', '{"ok": true}'::jsonb, NULL, NULL, '[]'::jsonb, 40);
  SELECT count(*) INTO v_n FROM public.step_test_results WHERE organization_id = i.org AND workflow_id = i.wf;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected one result per step, found % rows', v_n; END IF;
  IF (SELECT status FROM public.step_test_results WHERE workflow_id = i.wf AND node_id = 'n1') <> 'failed' THEN
    RAISE EXCEPTION 'the second test of a step did not replace the first';
  END IF;
  IF (SELECT output FROM public.step_test_results WHERE workflow_id = i.wf AND node_id = 'n1') IS NOT NULL THEN
    RAISE EXCEPTION 'the replaced result kept the first test''s output';
  END IF;
  INSERT INTO st_cases VALUES ('latest only: a second test replaces the first, another step keeps its own');
END
$do$;

-- ── C. Refusals ──────────────────────────────────────────────────────────────
DO $do$
DECLARE
  i st_ids%ROWTYPE;
  v_refused integer := 0;
BEGIN
  SELECT * INTO i FROM st_ids;
  -- Ops holds this workflow as another organization's.
  INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, row_updated_at, version_number, served_at)
  VALUES ('00000000-0000-4000-8000-0000000023b9', i.other_org, false, now(), 1, now());
  BEGIN
    PERFORM public.record_step_test(i.org, '00000000-0000-4000-8000-0000000023b9', 'n1', 'x', i.dan, 'completed', '{}'::jsonb, NULL, NULL, '[]'::jsonb, 1);
  EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM public.record_step_test(i.org, i.wf, 'n3', 'x', i.dan, 'running', NULL, NULL, NULL, '[]'::jsonb, 1);
  EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM public.record_step_test(i.org, i.wf, 'n3', 'x', i.dan, 'completed', jsonb_build_object('big', repeat('x', 300000)), NULL, NULL, '[]'::jsonb, 1);
  EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
  END;
  IF v_refused <> 3 THEN RAISE EXCEPTION 'refused % of 3 malformed or foreign results', v_refused; END IF;
  INSERT INTO st_cases VALUES ('refusals: another organization''s workflow, an unknown status, an output over its cap');
END
$do$;

-- ── D. The read, by the database clock ───────────────────────────────────────
DO $do$
DECLARE
  i st_ids%ROWTYPE;
  v_r record;
BEGIN
  SELECT * INTO i FROM st_ids;
  SELECT * INTO v_r FROM public.step_test_result(i.org, i.wf, 'n2');
  IF v_r.node_id IS DISTINCT FROM 'n2' OR v_r.output IS DISTINCT FROM '{"ok": true}'::jsonb OR v_r.tested_by IS DISTINCT FROM i.dan THEN
    RAISE EXCEPTION 'step_test_result did not answer the step''s result: %', v_r;
  END IF;
  IF EXISTS (SELECT 1 FROM public.step_test_result(i.other_org, i.wf, 'n2')) THEN
    RAISE EXCEPTION 'another organization read the result';
  END IF;
  UPDATE public.step_test_results SET tested_at = now() - interval '7 days' - interval '1 minute' WHERE workflow_id = i.wf AND node_id = 'n2';
  IF EXISTS (SELECT 1 FROM public.step_test_result(i.org, i.wf, 'n2')) THEN
    RAISE EXCEPTION 'a result older than 7 days was answered';
  END IF;
  INSERT INTO st_cases VALUES ('read: one organization''s step, nothing once 7 days old');
END
$do$;

-- ── E. The purge, by the database clock ──────────────────────────────────────
DO $do$
DECLARE
  i st_ids%ROWTYPE;
  v_p record;
BEGIN
  SELECT * INTO i FROM st_ids;
  PERFORM public.record_step_test(i.org, i.wf, 'fresh', 'fresh', i.dan, 'completed', '{}'::jsonb, NULL, NULL, '[]'::jsonb, 1);
  PERFORM public.record_step_test(i.org, i.wf, 'old_a', 'old_a', i.dan, 'completed', '{}'::jsonb, NULL, NULL, '[]'::jsonb, 1);
  PERFORM public.record_step_test(i.org, i.wf, 'old_b', 'old_b', i.dan, 'completed', '{}'::jsonb, NULL, NULL, '[]'::jsonb, 1);
  UPDATE public.step_test_results SET tested_at = now() - interval '7 days' + interval '1 minute' WHERE node_id = 'fresh';
  UPDATE public.step_test_results SET tested_at = now() - interval '8 days' WHERE node_id IN ('old_a', 'old_b');
  -- n2 is already 7 days and a minute old (case D); n1 was tested just now.
  SELECT * INTO v_p FROM public.purge_step_test_results(2);
  IF v_p.purged <> 2 OR NOT v_p.more THEN RAISE EXCEPTION 'the first page purged % (more %), not 2 with more to come', v_p.purged, v_p.more; END IF;
  SELECT * INTO v_p FROM public.purge_step_test_results(2);
  IF v_p.purged <> 1 OR v_p.more THEN RAISE EXCEPTION 'the second page purged % (more %), not the last 1', v_p.purged, v_p.more; END IF;
  IF (SELECT array_agg(node_id ORDER BY node_id) FROM public.step_test_results WHERE workflow_id = i.wf) IS DISTINCT FROM ARRAY['fresh', 'n1'] THEN
    RAISE EXCEPTION 'the purge left %, not the two results under 7 days old', (SELECT array_agg(node_id ORDER BY node_id) FROM public.step_test_results WHERE workflow_id = i.wf);
  END IF;
  INSERT INTO st_cases VALUES ('purge: exactly the results tested more than 7 days ago, a page at a time');
END
$do$;

-- ── F. Privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('record_step_test', 'step_test_result', 'purge_step_test_results') LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE proname = 'step_test_result') <> 's' THEN RAISE EXCEPTION 'step_test_result is not STABLE'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('record_step_test', 'step_test_result', 'purge_step_test_results')) <> 3 THEN
    RAISE EXCEPTION 'the three step test functions are not each defined once';
  END IF;
  INSERT INTO st_cases VALUES ('privileges: definer, fixed search_path, service_role alone, the read STABLE');
END
$do$;

-- ── G. An answer not kept is named by its size ───────────────────────────────
DO $do$
DECLARE
  i st_ids%ROWTYPE;
  v_wf uuid := '00000000-0000-4000-8000-0000000023b1';
BEGIN
  SELECT * INTO i FROM st_ids;
  PERFORM public.record_step_test(i.org, v_wf, 'big', 'big', i.dan, 'completed', NULL, 300000, NULL, '[]'::jsonb, 1);
  PERFORM public.record_step_test(i.org, v_wf, 'small', 'small', i.dan, 'completed', '{"a": 1}'::jsonb, 5, NULL, '[]'::jsonb, 1);
  IF (SELECT output_bytes FROM public.step_test_results WHERE workflow_id = v_wf AND node_id = 'big') IS DISTINCT FROM 300000 THEN
    RAISE EXCEPTION 'an answer over the cap did not keep its size';
  END IF;
  IF (SELECT output_bytes FROM public.step_test_results WHERE workflow_id = v_wf AND node_id = 'small') IS DISTINCT FROM octet_length('{"a": 1}'::jsonb::text) THEN
    RAISE EXCEPTION 'a kept answer''s size was taken from the caller, not measured';
  END IF;
  INSERT INTO st_cases VALUES ('size: an answer not kept is named by its size, a kept one measured');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM st_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'step_test_results: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'step_test_results: % cases passed', v_n;
END
$do$;

ROLLBACK;
