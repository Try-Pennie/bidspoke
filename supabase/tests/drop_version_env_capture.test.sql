-- The variables a version kept at its save are dropped (#3003), the contract
-- step of #2982. Migration 20261030220000_drop_version_env_capture_3003.sql.
--
-- Since #2982 an ops run reads each variable's current value when it starts,
-- so nothing reads workflow_versions.env_capture, and its writer, the trigger
-- capture_version_env_variables, has no purpose.
--
-- WHAT IT PROVES.
--   A. After every migration the column, the trigger and its function are
--      gone, and no function or view names either.
--   B. Every op of write_workflow on an ops workflow still writes its version
--      (create, save, restore, duplicate), and the version holds the
--      definition saved.
--   C. The migration runs again cleanly on a database where all three are
--      already gone.
--
-- C runs the migration file itself, read from the migrations folder the harness
-- copies into the container (scripts/sql-suite/project.sh).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds, inside one transaction rolled back at the end. No real identity, no
-- real value.

BEGIN;

CREATE TEMP TABLE dvec_cases (name text PRIMARY KEY);

INSERT INTO public.organizations (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111113003', 'DVEC Org', 'dvec-org-3003');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES
  ('22222222-2222-2222-2222-222222223003', '11111111-1111-1111-1111-111111113003', 'dvec3003@example.test', 'DVEC Alice');

-- One call as service_role: {ok: result} or {state, message, detail}.
CREATE FUNCTION pg_temp.ww(p_op text, p_id uuid, p_expected integer, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE v jsonb; s text; m text; d text;
BEGIN
  EXECUTE 'SET ROLE service_role';
  BEGIN
    v := public.write_workflow(p_op, '11111111-1111-1111-1111-111111113003', p_id, p_expected, p_fields, NULL,
                               '22222222-2222-2222-2222-222222223003', 'dvec3003@example.test', 'DVEC Alice');
    EXECUTE 'RESET ROLE';
    RETURN jsonb_build_object('ok', v);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, d = PG_EXCEPTION_DETAIL;
    EXECUTE 'RESET ROLE';
    RETURN jsonb_build_object('state', s, 'message', m, 'detail', d);
  END;
END
$fn$;

-- A definition whose transform reads each named variable as a path.
CREATE FUNCTION pg_temp.def(p_keys text[])
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('trigger', jsonb_build_object('type', 'schedule', 'config', jsonb_build_object('cron', '0 9 * * *')),
    'nodes', jsonb_build_array(jsonb_build_object('id', 'n1', 'namespace', 'shape', 'type', 'transform', 'config', jsonb_build_object('mappings',
      coalesce((SELECT jsonb_agg(jsonb_build_object('source', 'env.' || k, 'target', lower(k))) FROM unnest(p_keys) k), '[]'::jsonb)))),
    'edges', '[]'::jsonb)
$fn$;

-- The definition of the version a write answered, or null when it wrote none.
CREATE FUNCTION pg_temp.version_definition(v jsonb)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT definition FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid
$fn$;

CREATE FUNCTION pg_temp.version_of(p_id uuid)
RETURNS integer LANGUAGE sql AS $fn$ SELECT version FROM public.workflows WHERE id = p_id $fn$;

-- ── A. Gone after the migrations, and named by nothing ───────────────────────
DO $do$
DECLARE
  v_names text;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workflow_versions' AND column_name = 'env_capture') THEN
    RAISE EXCEPTION 'A: workflow_versions.env_capture still exists after every migration ran';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_version_env_variables' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'A: the trigger capture_version_env_variables still exists';
  END IF;
  IF to_regproc('public.capture_version_env_variables') IS NOT NULL THEN
    RAISE EXCEPTION 'A: the function capture_version_env_variables still exists';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_names FROM pg_proc p
  WHERE (p.prosrc ILIKE '%env_capture%' OR p.prosrc ILIKE '%capture_version_env_variables%')
    AND p.pronamespace <> pg_my_temp_schema();
  IF v_names IS NOT NULL THEN RAISE EXCEPTION 'A: a function still names the dropped capture: %', v_names; END IF;
  IF EXISTS (SELECT 1 FROM pg_views WHERE definition ILIKE '%env_capture%') THEN
    RAISE EXCEPTION 'A: a view still names env_capture';
  END IF;
  INSERT INTO dvec_cases VALUES ('A gone: no column, trigger or function, and nothing names them');
END
$do$;

-- ── B. Every op still writes the version of an ops workflow ──────────────────
DO $do$
DECLARE wf uuid; v jsonb; first_id uuid; copy_id uuid;
BEGIN
  v := pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'DVEC Ops', 'definition', pg_temp.def('{}'), 'definition_schema_version', 1));
  wf := (v -> 'ok' -> 'workflow' ->> 'id')::uuid;
  IF wf IS NULL THEN RAISE EXCEPTION 'B: create refused: %', v; END IF;
  IF pg_temp.version_definition(v) IS DISTINCT FROM pg_temp.def('{}') THEN RAISE EXCEPTION 'B: the create wrote no version: %', v; END IF;
  UPDATE public.workflows SET lane = 'ops' WHERE id = wf;
  INSERT INTO public.environment_variables (organization_id, key, value, is_secret, scope, workflow_id) VALUES
    ('11111111-1111-1111-1111-111111113003', 'API_BASE', 'https://org.example.test', false, 'global', NULL);

  v := pg_temp.ww('save', wf, pg_temp.version_of(wf), jsonb_build_object('definition', pg_temp.def('{API_BASE}'), 'definition_schema_version', 1));
  IF pg_temp.version_definition(v) IS DISTINCT FROM pg_temp.def('{API_BASE}') THEN RAISE EXCEPTION 'B: the save wrote no version: %', v; END IF;

  SELECT id INTO first_id FROM public.workflow_versions WHERE workflow_id = wf AND version_number = 1;
  v := pg_temp.ww('restore', wf, pg_temp.version_of(wf), jsonb_build_object('version_id', first_id, 'definition', pg_temp.def('{}')));
  IF pg_temp.version_definition(v) IS DISTINCT FROM pg_temp.def('{}') THEN RAISE EXCEPTION 'B: the restore wrote no version: %', v; END IF;

  v := pg_temp.ww('duplicate', wf, NULL, jsonb_build_object('name', 'DVEC Ops (copy)', 'definition', pg_temp.def('{API_BASE}')));
  copy_id := (v -> 'ok' -> 'workflow' ->> 'id')::uuid;
  IF copy_id IS NULL OR pg_temp.version_definition(v) IS NULL THEN RAISE EXCEPTION 'B: the duplicate wrote no version: %', v; END IF;
  INSERT INTO dvec_cases VALUES ('B every op still writes the version of an ops workflow');
END
$do$;

-- ── C. A rerun on a database without them is clean ───────────────────────────
DO $do$
DECLARE
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261030220000_drop_version_env_capture_3003.sql');
BEGIN
  EXECUTE v_file;
  INSERT INTO dvec_cases VALUES ('C a rerun is clean');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM dvec_cases);
BEGIN
  IF v_n <> 3 THEN RAISE EXCEPTION 'drop_version_env_capture.test.sql: % of 3 cases ran', v_n; END IF;
  RAISE NOTICE 'drop_version_env_capture.test.sql: % cases passed', v_n;
END
$do$;

ROLLBACK;
