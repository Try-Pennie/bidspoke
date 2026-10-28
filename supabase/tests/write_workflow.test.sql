-- write_workflow, the version trigger and the browser revokes (#1947, migration
-- 20261023120000).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Everything runs in
-- one transaction that is rolled back. No real identity.
--
-- WHAT IT PROVES, each call made as service_role, the Worker's role:
--   A. create: a switched off money workflow at version 0 with the stamp sent
--      and the save id, and since #2879 a first snapshot (v1), so the saves
--      below number from 2 (supabase/tests/write_workflow_backup_versions.test.sql
--      proves that snapshot); a written definition without its stamp, a field the op
--      does not take, a definition that is not an object, a blank name and a
--      folder of another organization are each refused by name, writing nothing.
--   B. save: from the stored version it writes the snapshot and the row
--      together, numbered after the last snapshot, with the stamp and the
--      report, and moves the version; a second save from the same version is
--      refused stale_version (BP409) with the current row, the save that won
--      and who made it in its DETAIL, and writes nothing; a save sending no
--      definition snapshots the stored one with its stamp.
--   C. restore: a new version holding the old definition under the old
--      version's own stamp, never the caller's; another workflow's version is
--      version_not_found.
--   D. patch: switching on without the checked version is refused; with it,
--      it switches on and the version does not move; a stale version is
--      refused; switching off needs none.
--   E. delete: a soft delete, switched off, version unmoved; any later write
--      is workflow_not_found, and so is another organization's workflow.
--   F. duplicate: a switched off copy on the source's lane with its stamp and
--      its whole history; a copy named from a version the source no longer
--      holds is refused stale_version (BP409), so its definition always
--      matches the history and stamp copied beside it; a source with no
--      history gets a first version.
--   G. A save refused by workflows_refuse_missing_connections takes its
--      snapshot back with it.
--   H. The version trigger: any writer's change to a versioned column moves
--      it, a change to an unversioned one does not, and nobody can set it.
--   I. anon and authenticated execute none of the new functions and write
--      neither table; service_role executes write_workflow.
--
-- Mutations tried (each turned its case red, then was put back):
--  - the version compare removed from write_workflow: B red;
--  - is_active taken off the unversioned list: D red (the switch on moved it);
--  - the browser REVOKE on workflows replaced by a GRANT: I red;
--  - the expected version requirement on switching on removed: D red.

BEGIN;

CREATE TEMP TABLE ww_cases (name text PRIMARY KEY);

INSERT INTO public.organizations (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111111947', 'WW Org', 'ww-org-1947'),
  ('11111111-1111-1111-1111-11111111194b', 'WW Org B', 'ww-org-1947b');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES
  ('22222222-2222-2222-2222-222222221947', '11111111-1111-1111-1111-111111111947', 'ww1947@example.test', 'WW Alice'),
  ('22222222-2222-2222-2222-22222222194b', '11111111-1111-1111-1111-111111111947', 'ww1947b@example.test', 'WW Bob');
INSERT INTO public.folders (id, organization_id, name) VALUES
  ('44444444-4444-4444-4444-44444444194b', '11111111-1111-1111-1111-11111111194b', 'Org B folder');

-- One call as service_role: {ok: result} or {state, message, detail}.
CREATE FUNCTION pg_temp.ww(p_op text, p_id uuid, p_expected integer, p_fields jsonb,
                           p_save uuid DEFAULT NULL, p_actor uuid DEFAULT '22222222-2222-2222-2222-222222221947',
                           p_org uuid DEFAULT '11111111-1111-1111-1111-111111111947')
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE v jsonb; s text; m text; d text;
BEGIN
  EXECUTE 'SET ROLE service_role';
  BEGIN
    v := public.write_workflow(p_op, p_org, p_id, p_expected, p_fields, p_save, p_actor, 'ww1947@example.test', 'WW Alice');
    EXECUTE 'RESET ROLE';
    RETURN jsonb_build_object('ok', v);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, m = MESSAGE_TEXT, d = PG_EXCEPTION_DETAIL;
    EXECUTE 'RESET ROLE';
    RETURN jsonb_build_object('state', s, 'message', m, 'detail', d);
  END;
END
$fn$;

CREATE FUNCTION pg_temp.def(p_label text)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_object('trigger', jsonb_build_object('type', 'http_webhook', 'config', jsonb_build_object('method', 'POST', 'auth_method', 'api_key')),
    'nodes', jsonb_build_array(jsonb_build_object('id', 'n1', 'namespace', p_label, 'type', 'code', 'config', jsonb_build_object('script', 'return 1'))),
    'edges', '[]'::jsonb)
$fn$;

CREATE FUNCTION pg_temp.expect_refused(p_out jsonb, p_state text, p_message text, p_case text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF p_out ->> 'state' IS DISTINCT FROM p_state OR p_out ->> 'message' IS DISTINCT FROM p_message THEN
    RAISE EXCEPTION '%: expected % %, got %', p_case, p_state, p_message, p_out;
  END IF;
END
$fn$;

-- ── A. create ────────────────────────────────────────────────────────────────
DO $do$
DECLARE v jsonb; w jsonb; n integer;
BEGIN
  v := pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'Lead Routing', 'definition', pg_temp.def('a'), 'definition_schema_version', 1),
                  '55555555-5555-5555-5555-555555550001');
  w := v -> 'ok' -> 'workflow';
  IF w IS NULL THEN RAISE EXCEPTION 'A: create refused: %', v; END IF;
  IF (w ->> 'is_active')::boolean OR w ->> 'lane' <> 'money' OR (w ->> 'version')::int <> 0
     OR (w ->> 'definition_schema_version')::int <> 1 OR w ->> 'last_save_id' <> '55555555-5555-5555-5555-555555550001'
     OR w ->> 'updated_by_name' <> 'WW Alice' THEN
    RAISE EXCEPTION 'A: created row is %', w;
  END IF;
  PERFORM set_config('ww.wf', w ->> 'id', false);

  SELECT count(*) INTO n FROM public.workflows WHERE organization_id = '11111111-1111-1111-1111-111111111947';
  PERFORM pg_temp.expect_refused(pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'x', 'definition', pg_temp.def('a'))), 'BP422', 'schema_version_required', 'A no stamp');
  PERFORM pg_temp.expect_refused(pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'x', 'definition', pg_temp.def('a'), 'definition_schema_version', 1, 'is_active', true)), 'BP422', 'field_not_writable', 'A is_active');
  PERFORM pg_temp.expect_refused(pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'x', 'definition', '[]'::jsonb, 'definition_schema_version', 1)), 'BP422', 'definition_not_object', 'A array');
  PERFORM pg_temp.expect_refused(pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', '  ', 'definition', pg_temp.def('a'), 'definition_schema_version', 1)), 'BP422', 'name_required', 'A blank name');
  PERFORM pg_temp.expect_refused(pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'x', 'definition', pg_temp.def('a'), 'definition_schema_version', 1.5)), 'BP422', 'schema_version_invalid', 'A fraction');
  PERFORM pg_temp.expect_refused(pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'x', 'definition', pg_temp.def('a'), 'definition_schema_version', 1, 'folder_id', '44444444-4444-4444-4444-44444444194b')), 'P0002', 'folder_not_found', 'A other org folder');
  IF (SELECT count(*) FROM public.workflows WHERE organization_id = '11111111-1111-1111-1111-111111111947') <> n THEN
    RAISE EXCEPTION 'A: a refused create wrote a row';
  END IF;
  INSERT INTO ww_cases VALUES ('A create');
END
$do$;

-- ── B. save ──────────────────────────────────────────────────────────────────
DO $do$
DECLARE wf uuid := current_setting('ww.wf')::uuid; v jsonb; d jsonb; snaps integer; r record;
BEGIN
  v := pg_temp.ww('save', wf, 0, jsonb_build_object('definition', pg_temp.def('b'), 'definition_schema_version', 1, 'message', 'first',
                  'definition_report', '{"verdict":"judged","would_refuse":0}'::jsonb), '55555555-5555-5555-5555-555555550002');
  IF v -> 'ok' IS NULL THEN RAISE EXCEPTION 'B: save refused: %', v; END IF;
  IF (v -> 'ok' ->> 'version_number')::int <> 2 OR (v -> 'ok' -> 'workflow' ->> 'version')::int <> 1 THEN RAISE EXCEPTION 'B: save returned %', v; END IF;
  SELECT * INTO r FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid;
  IF r.definition <> pg_temp.def('b') OR r.definition_schema_version <> 1 OR r.message <> 'first' OR r.definition_report ->> 'verdict' <> 'judged'
     OR r.created_by <> '22222222-2222-2222-2222-222222221947' THEN
    RAISE EXCEPTION 'B: snapshot is %', to_jsonb(r);
  END IF;
  IF (SELECT definition FROM public.workflows WHERE id = wf) <> pg_temp.def('b') THEN RAISE EXCEPTION 'B: row not written'; END IF;

  -- Bob's tab still holds version 0.
  SELECT count(*) INTO snaps FROM public.workflow_versions WHERE workflow_id = wf;
  v := pg_temp.ww('save', wf, 0, jsonb_build_object('definition', pg_temp.def('stale'), 'definition_schema_version', 1), '55555555-5555-5555-5555-555555550003', '22222222-2222-2222-2222-22222222194b');
  PERFORM pg_temp.expect_refused(v, 'BP409', 'stale_version', 'B stale');
  d := (v ->> 'detail')::jsonb;
  IF (d -> 'current' ->> 'version')::int <> 1 OR d ->> 'last_save_id' <> '55555555-5555-5555-5555-555555550002'
     OR d ->> 'changed_by_name' <> 'WW Alice' OR d ->> 'changed_at' IS NULL OR d -> 'current' -> 'definition' <> pg_temp.def('b') THEN
    RAISE EXCEPTION 'B: stale detail is %', d;
  END IF;
  IF (SELECT count(*) FROM public.workflow_versions WHERE workflow_id = wf) <> snaps OR (SELECT definition FROM public.workflows WHERE id = wf) <> pg_temp.def('b') THEN
    RAISE EXCEPTION 'B: a stale save wrote something';
  END IF;
  PERFORM pg_temp.expect_refused(pg_temp.ww('save', wf, NULL, jsonb_build_object('name', 'x')), 'BP422', 'expected_version_required', 'B no version');
  PERFORM pg_temp.expect_refused(pg_temp.ww('save', wf, 1, jsonb_build_object('definition_schema_version', 1)), 'BP422', 'schema_version_without_definition', 'B stamp alone');

  -- A rename: the snapshot holds the stored definition and its stamp.
  v := pg_temp.ww('save', wf, 1, jsonb_build_object('name', 'Renamed'));
  SELECT * INTO r FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid;
  IF r.version_number <> 3 OR r.definition <> pg_temp.def('b') OR r.definition_schema_version <> 1 OR r.definition_report IS NOT NULL
     OR (v -> 'ok' -> 'workflow' ->> 'version')::int <> 2 OR v -> 'ok' -> 'workflow' ->> 'name' <> 'Renamed' THEN
    RAISE EXCEPTION 'B: rename snapshot % row %', to_jsonb(r), v;
  END IF;
  INSERT INTO ww_cases VALUES ('B save');
END
$do$;

-- ── C. restore ───────────────────────────────────────────────────────────────
DO $do$
DECLARE wf uuid := current_setting('ww.wf')::uuid; v1 uuid; v jsonb; other uuid;
BEGIN
  -- An unstamped old version, as every row before #1947 is.
  INSERT INTO public.workflow_versions (workflow_id, version_number, definition) VALUES (wf, 4, pg_temp.def('old')) RETURNING id INTO v1;
  PERFORM pg_temp.expect_refused(pg_temp.ww('restore', wf, 2, jsonb_build_object('version_id', v1, 'definition', pg_temp.def('old'), 'definition_schema_version', 1)), 'BP422', 'field_not_writable', 'C caller stamp');
  v := pg_temp.ww('restore', wf, 2, jsonb_build_object('version_id', v1, 'definition', pg_temp.def('old')));
  IF (v -> 'ok' ->> 'version_number')::int <> 5 OR (v -> 'ok' ->> 'restored_from')::int <> 4
     OR v -> 'ok' -> 'workflow' -> 'definition_schema_version' <> 'null'::jsonb OR v -> 'ok' -> 'workflow' -> 'definition' <> pg_temp.def('old') THEN
    RAISE EXCEPTION 'C: restore returned %', v;
  END IF;
  IF (SELECT message FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid) <> 'Restored from v4'
     OR (SELECT definition_schema_version FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'C: restore snapshot wrong';
  END IF;
  INSERT INTO public.workflows (organization_id, name) VALUES ('11111111-1111-1111-1111-111111111947', 'Other') RETURNING id INTO other;
  INSERT INTO public.workflow_versions (workflow_id, version_number, definition) VALUES (other, 1, pg_temp.def('other')) RETURNING id INTO v1;
  PERFORM pg_temp.expect_refused(pg_temp.ww('restore', wf, 3, jsonb_build_object('version_id', v1, 'definition', pg_temp.def('other'))), 'P0002', 'version_not_found', 'C other version');
  INSERT INTO ww_cases VALUES ('C restore');
END
$do$;

-- ── D. patch ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE wf uuid := current_setting('ww.wf')::uuid; v jsonb; ver int;
BEGIN
  SELECT version INTO ver FROM public.workflows WHERE id = wf;
  PERFORM pg_temp.expect_refused(pg_temp.ww('patch', wf, NULL, '{"is_active": true}'::jsonb), 'BP422', 'expected_version_required', 'D switch on unchecked');
  PERFORM pg_temp.expect_refused(pg_temp.ww('patch', wf, ver - 1, '{"is_active": true}'::jsonb), 'BP409', 'stale_version', 'D switch on stale');
  v := pg_temp.ww('patch', wf, ver, '{"is_active": true}'::jsonb);
  IF NOT (v -> 'ok' -> 'workflow' ->> 'is_active')::boolean OR (v -> 'ok' -> 'workflow' ->> 'version')::int <> ver THEN
    RAISE EXCEPTION 'D: switch on returned %', v;
  END IF;
  PERFORM pg_temp.expect_refused(pg_temp.ww('patch', wf, NULL, '{"is_active": "yes"}'::jsonb), 'BP422', 'is_active_not_boolean', 'D not boolean');
  v := pg_temp.ww('patch', wf, NULL, '{"is_active": false}'::jsonb);
  IF (v -> 'ok' -> 'workflow' ->> 'is_active')::boolean THEN RAISE EXCEPTION 'D: switch off returned %', v; END IF;
  PERFORM pg_temp.expect_refused(pg_temp.ww('patch', wf, NULL, '{"folder_id": "44444444-4444-4444-4444-44444444194b"}'::jsonb), 'P0002', 'folder_not_found', 'D other org folder');
  INSERT INTO ww_cases VALUES ('D patch');
END
$do$;

-- ── G. a refusal by the connection trigger takes the snapshot back ───────────
DO $do$
DECLARE wf uuid := current_setting('ww.wf')::uuid; v jsonb; ver int; snaps int;
BEGIN
  INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
  VALUES ('11111111-1111-1111-1111-111111111947', '33333333-3333-3333-3333-333333331947', 1);
  SELECT version INTO ver FROM public.workflows WHERE id = wf;
  SELECT count(*) INTO snaps FROM public.workflow_versions WHERE workflow_id = wf;
  v := pg_temp.ww('save', wf, ver, jsonb_build_object('definition_schema_version', 1, 'definition',
         jsonb_set(pg_temp.def('g'), '{nodes,0,config,connection_id}', '"33333333-3333-3333-3333-333333331947"')));
  PERFORM pg_temp.expect_refused(v, 'BP409', 'workflow_names_missing_connection', 'G removed connection');
  IF (SELECT count(*) FROM public.workflow_versions WHERE workflow_id = wf) <> snaps THEN RAISE EXCEPTION 'G: the snapshot stayed'; END IF;
  INSERT INTO ww_cases VALUES ('G connection refusal takes the snapshot back');
END
$do$;

-- ── E. delete ────────────────────────────────────────────────────────────────
DO $do$
DECLARE wf uuid := current_setting('ww.wf')::uuid; v jsonb; ver int;
BEGIN
  PERFORM pg_temp.expect_refused(pg_temp.ww('delete', wf, NULL, '{}'::jsonb, NULL, '22222222-2222-2222-2222-222222221947', '11111111-1111-1111-1111-11111111194b'), 'P0002', 'workflow_not_found', 'E other org');
  UPDATE public.workflows SET is_active = true WHERE id = wf;
  SELECT version INTO ver FROM public.workflows WHERE id = wf;
  v := pg_temp.ww('delete', wf, NULL, '{}'::jsonb);
  IF v -> 'ok' -> 'workflow' ->> 'deleted_at' IS NULL OR (v -> 'ok' -> 'workflow' ->> 'is_active')::boolean OR (v -> 'ok' -> 'workflow' ->> 'version')::int <> ver THEN
    RAISE EXCEPTION 'E: delete returned %', v;
  END IF;
  PERFORM pg_temp.expect_refused(pg_temp.ww('save', wf, ver, jsonb_build_object('name', 'Back')), 'P0002', 'workflow_not_found', 'E save after delete');
  PERFORM pg_temp.expect_refused(pg_temp.ww('delete', wf, NULL, '{}'::jsonb), 'P0002', 'workflow_not_found', 'E delete twice');
  INSERT INTO ww_cases VALUES ('E delete');
END
$do$;

-- ── F. duplicate ─────────────────────────────────────────────────────────────
DO $do$
DECLARE src uuid; bare uuid; v jsonb; w jsonb;
BEGIN
  INSERT INTO public.workflows (organization_id, name, definition, definition_schema_version, lane, is_active)
  VALUES ('11111111-1111-1111-1111-111111111947', 'Ops source', pg_temp.def('s'), 1, 'ops', true) RETURNING id INTO src;
  INSERT INTO public.workflow_versions (workflow_id, version_number, definition, definition_schema_version, message) VALUES
    (src, 1, pg_temp.def('s1'), NULL, 'one'), (src, 2, pg_temp.def('s'), 1, 'two');
  v := pg_temp.ww('duplicate', src, NULL, jsonb_build_object('name', 'Ops source (copy)', 'definition', pg_temp.def('s')));
  w := v -> 'ok' -> 'workflow';
  IF w IS NULL OR (w ->> 'is_active')::boolean OR w ->> 'lane' <> 'ops' OR (w ->> 'definition_schema_version')::int <> 1 OR (v -> 'ok' ->> 'versions_copied')::int <> 2 THEN
    RAISE EXCEPTION 'F: duplicate returned %', v;
  END IF;
  IF (SELECT array_agg(definition_schema_version ORDER BY version_number)::text FROM public.workflow_versions WHERE workflow_id = (w ->> 'id')::uuid) <> '{NULL,1}' THEN
    RAISE EXCEPTION 'F: copied history stamps wrong';
  END IF;
  -- A copy made from a version the source no longer holds is refused: its definition would not match
  -- the history and stamp copied beside it.
  PERFORM pg_temp.expect_refused(pg_temp.ww('duplicate', src, 5, jsonb_build_object('name', 'Stale copy', 'definition', pg_temp.def('s'))), 'BP409', 'stale_version', 'F stale duplicate');
  INSERT INTO public.workflows (organization_id, name, definition) VALUES ('11111111-1111-1111-1111-111111111947', 'Never saved', pg_temp.def('n')) RETURNING id INTO bare;
  v := pg_temp.ww('duplicate', bare, NULL, jsonb_build_object('name', 'Never saved (copy)', 'definition', pg_temp.def('n')));
  IF (SELECT message FROM public.workflow_versions WHERE workflow_id = (v -> 'ok' -> 'workflow' ->> 'id')::uuid AND version_number = 1) <> 'Duplicated from Never saved' THEN
    RAISE EXCEPTION 'F: the never saved source was not seeded: %', v;
  END IF;
  INSERT INTO ww_cases VALUES ('F duplicate');
END
$do$;

-- ── H. the version trigger, whoever writes ───────────────────────────────────
DO $do$
DECLARE wf uuid; ver int;
BEGIN
  INSERT INTO public.workflows (organization_id, name, definition) VALUES ('11111111-1111-1111-1111-111111111947', 'Hand', pg_temp.def('h')) RETURNING id INTO wf;
  UPDATE public.workflows SET definition = pg_temp.def('h2') WHERE id = wf RETURNING version INTO ver;
  IF ver <> 1 THEN RAISE EXCEPTION 'H: a hand definition change left version %', ver; END IF;
  UPDATE public.workflows SET test_payloads = '[{"name":"p","payload":{}}]', folder_id = NULL, is_active = true WHERE id = wf RETURNING version INTO ver;
  IF ver <> 1 THEN RAISE EXCEPTION 'H: an unversioned change moved version to %', ver; END IF;
  UPDATE public.workflows SET version = 99 WHERE id = wf RETURNING version INTO ver;
  IF ver <> 1 THEN RAISE EXCEPTION 'H: a writer set version to %', ver; END IF;
  INSERT INTO ww_cases VALUES ('H version trigger');
END
$do$;

-- ── I. grants ────────────────────────────────────────────────────────────────
DO $do$
DECLARE r text; fn text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH fn IN ARRAY ARRAY['public.write_workflow(text, uuid, uuid, integer, jsonb, uuid, uuid, text, text)',
                              'public.workflows_unversioned_columns()', 'public.workflows_bump_version()'] LOOP
      IF has_function_privilege(r, fn, 'EXECUTE') THEN RAISE EXCEPTION 'I: % can execute %', r, fn; END IF;
    END LOOP;
    IF has_table_privilege(r, 'public.workflows', 'INSERT') OR has_table_privilege(r, 'public.workflows', 'UPDATE') OR has_table_privilege(r, 'public.workflows', 'DELETE')
       OR has_table_privilege(r, 'public.workflow_versions', 'INSERT') OR has_table_privilege(r, 'public.workflow_versions', 'UPDATE') OR has_table_privilege(r, 'public.workflow_versions', 'DELETE') THEN
      RAISE EXCEPTION 'I: % can still write a workflow table', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.write_workflow(text, uuid, uuid, integer, jsonb, uuid, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'I: service_role cannot execute write_workflow';
  END IF;
  INSERT INTO ww_cases VALUES ('I grants');
END
$do$;

DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM ww_cases;
  IF n <> 9 THEN RAISE EXCEPTION 'write_workflow: % of 9 cases ran', n; END IF;
  RAISE NOTICE 'write_workflow.test.sql: % cases passed', n;
END
$do$;

ROLLBACK;
