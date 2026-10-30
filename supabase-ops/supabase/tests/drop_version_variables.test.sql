-- The variables kept beside an ops version's definition are dropped (#3003),
-- the contract step of #2982. Migration 20261030230000_drop_version_variables_3003.sql.
--
-- Since #2982 a run reads each variable's current value when it starts, carried
-- in its dispatch, so nothing reads ops_workflow_definitions.variables, and
-- the ops Worker stopped sending save_workflow_definition's p_variables in
-- #3044.
--
-- WHAT IT PROVES.
--   A. The column is gone; save_workflow_definition takes exactly the four
--      arguments the ops Worker sends, and workflow_definition answers the
--      definition and when it was saved, nothing more.
--   B. The save still keeps a version and reads it back: the same definition
--      again is already_saved, a different one is conflict and the first is
--      kept, and no copy is no_copy.
--   C. A call naming p_variables, as the ops Worker did before #3044, finds no
--      function, so it can never be read as a save.
--   D. Each function is still under the ops rules (SECURITY DEFINER, a fixed
--      search_path, service_role alone may execute it), with one function of
--      each name.
--   E. The migration runs again cleanly on a database where the column and
--      the old functions are already gone.
--
-- E runs the migration file itself, read from the migrations folder the
-- harness copies into the container (scripts/sql-suite/project.sh).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), in one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE dvv_cases (name text PRIMARY KEY);

CREATE FUNCTION pg_temp.dvv_copy(p_wf uuid, p_org uuid, p_version integer) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM public.save_workflow_copies('2026-10-30T10:00:00Z', false, jsonb_build_array(jsonb_build_object(
    'workflow_id', p_wf, 'organization_id', p_org, 'is_active', true, 'deleted_at', NULL,
    'row_updated_at', '2026-10-30T09:00:00Z', 'version_number', p_version, 'trigger', NULL)));
END
$f$;

-- ── A. the shapes left ───────────────────────────────────────────────────────
DO $do$
DECLARE
  v_args text;
  v_result text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ops_workflow_definitions' AND column_name = 'variables') THEN
    RAISE EXCEPTION 'A: ops_workflow_definitions.variables still exists after every migration ran';
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'save_workflow_definition';
  IF v_args IS DISTINCT FROM 'p_organization_id uuid, p_workflow_id uuid, p_version_number integer, p_definition jsonb' THEN
    RAISE EXCEPTION 'A: save_workflow_definition takes %', v_args;
  END IF;
  SELECT pg_get_function_result(p.oid) INTO v_result FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'workflow_definition';
  IF v_result IS DISTINCT FROM 'TABLE(definition jsonb, saved_at timestamp with time zone)' THEN
    RAISE EXCEPTION 'A: workflow_definition answers %', v_result;
  END IF;
  INSERT INTO dvv_cases VALUES ('A the column is gone and each function has the shape the ops Worker uses');
END
$do$;

-- ── B. a version is still kept and never changes ─────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000003003';
  v_wf uuid := '00000000-0000-4000-8000-0000000030a1';
  v_def jsonb := '{"nodes":[{"id":"a","type":"transform"}],"edges":[]}';
  v_out text;
  v_row record;
BEGIN
  PERFORM pg_temp.dvv_copy(v_wf, v_org, 2);
  -- Named as the ops Worker names them (saveWorkflowDefinition).
  v_out := public.save_workflow_definition(p_organization_id => v_org, p_workflow_id => v_wf, p_version_number => 2, p_definition => v_def);
  IF v_out <> 'saved' THEN RAISE EXCEPTION 'B: a save answered %', v_out; END IF;
  SELECT * INTO v_row FROM public.workflow_definition(v_org, v_wf, 2);
  IF v_row.definition <> v_def OR v_row.saved_at IS NULL THEN RAISE EXCEPTION 'B: read back %', to_jsonb(v_row); END IF;
  -- Keys in another order: jsonb equality, not text.
  v_out := public.save_workflow_definition(v_org, v_wf, 2, '{"edges":[],"nodes":[{"type":"transform","id":"a"}]}');
  IF v_out <> 'already_saved' THEN RAISE EXCEPTION 'B: the same definition again answered %', v_out; END IF;
  v_out := public.save_workflow_definition(v_org, v_wf, 2, '{"nodes":[],"edges":[]}');
  IF v_out <> 'conflict' THEN RAISE EXCEPTION 'B: a different definition answered %', v_out; END IF;
  IF (SELECT definition FROM public.workflow_definition(v_org, v_wf, 2)) <> v_def THEN RAISE EXCEPTION 'B: a conflict replaced the held definition'; END IF;
  v_out := public.save_workflow_definition(v_org, '00000000-0000-4000-8000-0000000030a9', 1, v_def);
  IF v_out <> 'no_copy' THEN RAISE EXCEPTION 'B: a workflow with no copy answered %', v_out; END IF;
  INSERT INTO dvv_cases VALUES ('B a version is kept, read back and never changed');
END
$do$;

-- ── C. a call naming p_variables finds nothing ───────────────────────────────
DO $do$
DECLARE
  v_refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.save_workflow_definition(p_organization_id => 'aaaaaaaa-0000-4000-8000-000000003003', p_workflow_id => '00000000-0000-4000-8000-0000000030a1',
      p_version_number => 3, p_definition => '{"nodes":[]}', p_variables => '{"values":{},"secret_keys":[]}');
  EXCEPTION WHEN undefined_function THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'C: a call naming p_variables was answered'; END IF;
  IF EXISTS (SELECT 1 FROM public.ops_workflow_definitions WHERE workflow_id = '00000000-0000-4000-8000-0000000030a1' AND version_number = 3) THEN
    RAISE EXCEPTION 'C: a call naming p_variables wrote a row';
  END IF;
  INSERT INTO dvv_cases VALUES ('C a call naming p_variables finds no function');
END
$do$;

-- ── D. still under the ops rules, one function of each name ──────────────────
DO $do$
DECLARE
  v_name text;
  v_fn record;
  v_count integer;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['save_workflow_definition', 'workflow_definition'] LOOP
    SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN RAISE EXCEPTION 'D: % functions are named %', v_count, v_name; END IF;
    SELECT p.oid, p.prosecdef, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION 'D: % is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'D: % has no fixed search_path', v_name;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'D: service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'D: a browser role can execute %', v_name;
    END IF;
  END LOOP;
  INSERT INTO dvv_cases VALUES ('D still under the ops rules, one function of each name');
END
$do$;

-- ── E. a rerun on a database without them is clean ───────────────────────────
DO $do$
DECLARE
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261030230000_drop_version_variables_3003.sql');
  v_count integer;
BEGIN
  EXECUTE v_file;
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('save_workflow_definition', 'workflow_definition');
  IF v_count <> 2 THEN RAISE EXCEPTION 'E: a rerun left % functions of the two names', v_count; END IF;
  INSERT INTO dvv_cases VALUES ('E a rerun is clean');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM dvv_cases);
BEGIN
  IF v_n <> 5 THEN RAISE EXCEPTION 'drop_version_variables: % of 5 cases ran', v_n; END IF;
  RAISE NOTICE 'drop_version_variables.test.sql: % cases passed', v_n;
END
$do$;

ROLLBACK;
