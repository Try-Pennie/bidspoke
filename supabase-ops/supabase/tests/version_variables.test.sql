-- A workflow version's variables, kept beside its frozen definition (#2702;
-- migration 20261028200000_version_variables_2702.sql).
--
-- Dan's decisions of 2026-10-28: an ops run's plain variables are frozen with
-- the workflow version, and a run never reads the bidding database for them.
-- The bidding Worker serves them with the version's definition, and ops keeps
-- them beside it in ops_workflow_definitions.variables, so a run uses what was
-- saved through a bidding outage, as it does the definition.
--
-- WHAT IT PROVES.
--   A. save_workflow_definition keeps the variables served with a version, and
--      workflow_definition reads them back; a version served with none keeps
--      null, and the call the ops Worker made before #2702 (no variables
--      argument) still saves.
--   B. The same definition and the same variables again is already_saved;
--      different variables for a held version, or none where some are held,
--      is conflict, and the first are kept.
--   C. Variables that are not an object are refused by name and write nothing;
--      the column itself holds only an object.
--   D. Each function is still under the ops rules (SECURITY DEFINER, a fixed
--      search_path, service_role alone may execute it), and no overload of the
--      old shape is left behind.
--
-- Mutations tried (each turned its case red, then was put back):
--  - the variables compare dropped from the conflict check: B red;
--  - p_variables not written by the insert: A red;
--  - the old four argument function left in place: A red (the four argument
--    call is ambiguous, which is what would break the running ops Worker).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), in one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE vv_cases (name text PRIMARY KEY);

CREATE FUNCTION pg_temp.vv_copy(p_wf uuid, p_org uuid, p_version integer) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM public.save_workflow_copies('2026-10-28T10:00:00Z', false, jsonb_build_array(jsonb_build_object(
    'workflow_id', p_wf, 'organization_id', p_org, 'is_active', true, 'deleted_at', NULL,
    'row_updated_at', '2026-10-28T09:00:00Z', 'version_number', p_version, 'trigger', NULL)));
END
$f$;

-- ── A. kept and read back ────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002702';
  v_wf uuid := '00000000-0000-4000-8000-0000000027a1';
  v_def jsonb := '{"nodes":[{"id":"a","type":"transform"}],"edges":[]}';
  v_vars jsonb := '{"values":{"API_BASE":"https://api.example.test"},"secret_keys":["TOKEN"]}';
  v_out text;
  v_row record;
BEGIN
  PERFORM pg_temp.vv_copy(v_wf, v_org, 3);
  v_out := public.save_workflow_definition(p_organization_id => v_org, p_workflow_id => v_wf, p_version_number => 2, p_definition => v_def, p_variables => v_vars);
  IF v_out <> 'saved' THEN RAISE EXCEPTION 'A: a save with variables answered %', v_out; END IF;
  SELECT * INTO v_row FROM public.workflow_definition(v_org, v_wf, 2);
  IF v_row.definition <> v_def OR v_row.variables IS DISTINCT FROM v_vars THEN RAISE EXCEPTION 'A: read back %', to_jsonb(v_row); END IF;

  -- The call the ops Worker made before #2702 names no variables, and keeps none.
  v_out := public.save_workflow_definition(p_organization_id => v_org, p_workflow_id => v_wf, p_version_number => 3, p_definition => v_def);
  IF v_out <> 'saved' THEN RAISE EXCEPTION 'A: a save without variables answered %', v_out; END IF;
  IF (SELECT variables FROM public.workflow_definition(v_org, v_wf, 3)) IS NOT NULL THEN RAISE EXCEPTION 'A: a save without variables kept some'; END IF;
  INSERT INTO vv_cases VALUES ('A variables are kept beside the definition and read back');
END
$do$;

-- ── B. a held version's variables never change ───────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002702';
  v_wf uuid := '00000000-0000-4000-8000-0000000027a1';
  v_def jsonb := '{"nodes":[{"id":"a","type":"transform"}],"edges":[]}';
  v_out text;
BEGIN
  -- Keys in another order: jsonb equality, not text.
  v_out := public.save_workflow_definition(v_org, v_wf, 2, v_def, '{"secret_keys":["TOKEN"],"values":{"API_BASE":"https://api.example.test"}}');
  IF v_out <> 'already_saved' THEN RAISE EXCEPTION 'B: the same variables again answered %', v_out; END IF;
  v_out := public.save_workflow_definition(v_org, v_wf, 2, v_def, '{"values":{"API_BASE":"https://changed.example.test"},"secret_keys":["TOKEN"]}');
  IF v_out <> 'conflict' THEN RAISE EXCEPTION 'B: different variables for a held version answered %', v_out; END IF;
  v_out := public.save_workflow_definition(v_org, v_wf, 2, v_def);
  IF v_out <> 'conflict' THEN RAISE EXCEPTION 'B: no variables where some are held answered %', v_out; END IF;
  v_out := public.save_workflow_definition(v_org, v_wf, 3, v_def, '{"values":{},"secret_keys":[]}');
  IF v_out <> 'conflict' THEN RAISE EXCEPTION 'B: variables where none are held answered %', v_out; END IF;
  IF (SELECT variables ->> 'values' FROM public.workflow_definition(v_org, v_wf, 2)) <> '{"API_BASE": "https://api.example.test"}' THEN
    RAISE EXCEPTION 'B: a conflict replaced the held variables';
  END IF;
  INSERT INTO vv_cases VALUES ('B a held version''s variables never change');
END
$do$;

-- ── C. variables that are not an object ──────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002702';
  v_wf uuid := '00000000-0000-4000-8000-0000000027a1';
  v_refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.save_workflow_definition(v_org, v_wf, 4, '{"nodes":[]}', '[1]');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'C: variables that are a list were saved'; END IF;
  IF EXISTS (SELECT 1 FROM public.ops_workflow_definitions WHERE workflow_id = v_wf AND version_number = 4) THEN RAISE EXCEPTION 'C: a refused save wrote a row'; END IF;
  v_refused := false;
  BEGIN
    UPDATE public.ops_workflow_definitions SET variables = '"text"' WHERE workflow_id = v_wf AND version_number = 2;
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'C: the column held something other than an object'; END IF;
  INSERT INTO vv_cases VALUES ('C variables that are not an object are refused');
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
  INSERT INTO vv_cases VALUES ('D still under the ops rules, one function of each name');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM vv_cases);
BEGIN
  IF v_n <> 4 THEN RAISE EXCEPTION 'version_variables: % of 4 cases ran', v_n; END IF;
  RAISE NOTICE 'version_variables.test.sql: % cases passed', v_n;
END
$do$;

ROLLBACK;
