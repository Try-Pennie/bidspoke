-- An ops workflow version keeps the environment variables its definition
-- names as they were when it was saved (#2702, migration 20261028200000).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Everything runs in
-- one transaction that is rolled back. No real identity, no real value.
--
-- Dan's decisions of 2026-10-28: a plain variable is frozen with the workflow
-- version, so a run uses what was saved and a change takes effect at the next
-- save; a secret variable never reaches an ops run, so only its name is kept.
-- The trigger capture_version_env_variables fills workflow_versions.env_capture
-- at the insert, so every writer of a version (each op of write_workflow) keeps
-- them, and the Worker serves from it (lib/version-variables.ts).
--
-- WHAT IT PROVES, each write made through write_workflow as service_role:
--   A. a save of an ops workflow keeps, for each variable its definition
--      names, the organization's rows and the workflow's own, in the order
--      they were saved, a secret's value left out; never another workflow's
--      row, another organization's, an unnamed variable or an empty value.
--   B. a variable changed after the save leaves that version as saved; the
--      next save keeps the new value.
--   C. a money lane workflow's version keeps nothing.
--   D. a restore and a duplicate of an ops workflow keep the values as they
--      are at that write.
--   E. a capture named by the writer is replaced by what the database reads.
--   F. service_role cannot change a kept capture, and the column holds only a
--      list.
--
-- Mutations tried (each turned its case red, then was put back):
--  - the secret's value kept: A red;
--  - the own workflow filter dropped (any workflow's rows kept): A red;
--  - the lane check dropped: C red;
--  - the trigger on UPDATE as well, recapturing: F red (the grant refuses
--    first, so F also checks the capture unchanged after a commit_sha write);
--  - the trigger keeping NEW.env_capture when the writer named one: E red.

BEGIN;

CREATE TEMP TABLE ec_cases (name text PRIMARY KEY);

INSERT INTO public.organizations (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111112702', 'EC Org', 'ec-org-2702'),
  ('11111111-1111-1111-1111-111111112703', 'EC Other Org', 'ec-other-org-2702');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES
  ('22222222-2222-2222-2222-222222222702', '11111111-1111-1111-1111-111111112702', 'ec2702@example.test', 'EC Alice');

-- One call as service_role: {ok: result} or {state, message, detail}.
CREATE FUNCTION pg_temp.ww(p_op text, p_id uuid, p_expected integer, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE v jsonb; s text; m text; d text;
BEGIN
  EXECUTE 'SET ROLE service_role';
  BEGIN
    v := public.write_workflow(p_op, '11111111-1111-1111-1111-111111112702', p_id, p_expected, p_fields, NULL,
                               '22222222-2222-2222-2222-222222222702', 'ec2702@example.test', 'EC Alice');
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

-- The version a write answered.
CREATE FUNCTION pg_temp.capture_of(v jsonb)
RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT env_capture FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid
$fn$;

-- An ops workflow, created as the Worker does and moved to the ops lane as the porting does.
CREATE FUNCTION pg_temp.ops_workflow(p_name text)
RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE v jsonb; v_id uuid;
BEGIN
  v := pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', p_name, 'definition', pg_temp.def('{}'), 'definition_schema_version', 1));
  v_id := (v -> 'ok' -> 'workflow' ->> 'id')::uuid;
  IF v_id IS NULL THEN RAISE EXCEPTION 'could not create %: %', p_name, v; END IF;
  UPDATE public.workflows SET lane = 'ops' WHERE id = v_id;
  RETURN v_id;
END
$fn$;

CREATE FUNCTION pg_temp.version_of(p_id uuid)
RETURNS integer LANGUAGE sql AS $fn$ SELECT version FROM public.workflows WHERE id = p_id $fn$;

-- ── A. a save keeps what the definition names, as it is now ────────────────
DO $do$
DECLARE wf uuid; other_wf uuid; v jsonb; got jsonb; want jsonb;
BEGIN
  wf := pg_temp.ops_workflow('EC Ops');
  other_wf := pg_temp.ops_workflow('EC Ops Other');
  INSERT INTO public.environment_variables (organization_id, key, value, is_secret, scope, workflow_id, created_at) VALUES
    ('11111111-1111-1111-1111-111111112702', 'API_BASE', 'https://org.example.test', false, 'global', NULL, '2026-10-01T00:00:00Z'),
    ('11111111-1111-1111-1111-111111112702', 'API_BASE', 'https://mine.example.test', false, 'workflow', wf, '2026-10-02T00:00:00Z'),
    ('11111111-1111-1111-1111-111111112702', 'TOKEN', 'ciphertext-not-a-real-secret', true, 'global', NULL, '2026-10-03T00:00:00Z'),
    ('11111111-1111-1111-1111-111111112702', 'LIST_ID', 'theirs', false, 'workflow', other_wf, '2026-10-04T00:00:00Z'),
    ('11111111-1111-1111-1111-111111112702', 'BLANK', '', false, 'global', NULL, '2026-10-05T00:00:00Z'),
    ('11111111-1111-1111-1111-111111112702', 'UNNAMED', 'not read', false, 'global', NULL, '2026-10-06T00:00:00Z'),
    ('11111111-1111-1111-1111-111111112703', 'API_BASE', 'another org', false, 'global', NULL, '2026-10-07T00:00:00Z');

  v := pg_temp.ww('save', wf, pg_temp.version_of(wf), jsonb_build_object('definition', pg_temp.def('{API_BASE,TOKEN,LIST_ID,BLANK}'), 'definition_schema_version', 1));
  IF v -> 'ok' IS NULL THEN RAISE EXCEPTION 'A: save refused: %', v; END IF;
  got := pg_temp.capture_of(v);
  want := jsonb_build_array(
    jsonb_build_object('key', 'API_BASE', 'value', 'https://org.example.test', 'is_secret', false, 'scope', 'global', 'workflow_id', NULL),
    jsonb_build_object('key', 'API_BASE', 'value', 'https://mine.example.test', 'is_secret', false, 'scope', 'workflow', 'workflow_id', wf),
    jsonb_build_object('key', 'TOKEN', 'value', NULL, 'is_secret', true, 'scope', 'global', 'workflow_id', NULL));
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'A: the save kept %, expected %', got, want; END IF;
  IF got::text LIKE '%ciphertext%' THEN RAISE EXCEPTION 'A: a secret''s value was kept'; END IF;
  INSERT INTO ec_cases VALUES ('A a save keeps what the definition names');
END
$do$;

-- ── B. a change after the save waits for the next save ───────────────────────
DO $do$
DECLARE wf uuid; v1 jsonb; v2 jsonb;
BEGIN
  SELECT id INTO wf FROM public.workflows WHERE name = 'EC Ops';
  SELECT jsonb_build_object('ok', jsonb_build_object('version_id', id)) INTO v1 FROM public.workflow_versions WHERE workflow_id = wf ORDER BY version_number DESC LIMIT 1;
  UPDATE public.environment_variables SET value = 'https://changed.example.test' WHERE key = 'API_BASE' AND workflow_id = wf;
  IF pg_temp.capture_of(v1) -> 1 ->> 'value' <> 'https://mine.example.test' THEN RAISE EXCEPTION 'B: the saved version changed with the variable: %', pg_temp.capture_of(v1); END IF;
  v2 := pg_temp.ww('save', wf, pg_temp.version_of(wf), jsonb_build_object('message', 'again'));
  IF v2 -> 'ok' IS NULL THEN RAISE EXCEPTION 'B: save refused: %', v2; END IF;
  IF pg_temp.capture_of(v2) -> 1 ->> 'value' <> 'https://changed.example.test' THEN RAISE EXCEPTION 'B: the next save kept %', pg_temp.capture_of(v2); END IF;
  INSERT INTO ec_cases VALUES ('B a change waits for the next save');
END
$do$;

-- ── C. a money lane version keeps nothing ────────────────────────────────────
DO $do$
DECLARE v jsonb; wf uuid;
BEGIN
  v := pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'EC Money', 'definition', pg_temp.def('{API_BASE}'), 'definition_schema_version', 1));
  wf := (v -> 'ok' -> 'workflow' ->> 'id')::uuid;
  IF pg_temp.capture_of(v) IS NOT NULL THEN RAISE EXCEPTION 'C: a money lane create kept %', pg_temp.capture_of(v); END IF;
  v := pg_temp.ww('save', wf, pg_temp.version_of(wf), jsonb_build_object('definition', pg_temp.def('{API_BASE}'), 'definition_schema_version', 1));
  IF v -> 'ok' IS NULL OR pg_temp.capture_of(v) IS NOT NULL THEN RAISE EXCEPTION 'C: a money lane save kept %', v; END IF;
  INSERT INTO ec_cases VALUES ('C a money lane version keeps nothing');
END
$do$;

-- ── D. a restore and a duplicate keep the values as they are then ───────────
DO $do$
DECLARE wf uuid; first_id uuid; v jsonb; copy_id uuid; n integer;
BEGIN
  SELECT id INTO wf FROM public.workflows WHERE name = 'EC Ops';
  UPDATE public.environment_variables SET value = 'https://restored.example.test' WHERE key = 'API_BASE' AND workflow_id = wf;
  SELECT id INTO first_id FROM public.workflow_versions WHERE workflow_id = wf AND version_number = 2;
  v := pg_temp.ww('restore', wf, pg_temp.version_of(wf), jsonb_build_object('version_id', first_id, 'definition', pg_temp.def('{API_BASE,TOKEN,LIST_ID,BLANK}')));
  IF v -> 'ok' IS NULL THEN RAISE EXCEPTION 'D: restore refused: %', v; END IF;
  IF pg_temp.capture_of(v) -> 1 ->> 'value' <> 'https://restored.example.test' THEN RAISE EXCEPTION 'D: the restore kept %', pg_temp.capture_of(v); END IF;

  v := pg_temp.ww('duplicate', wf, NULL, jsonb_build_object('name', 'EC Ops (copy)', 'definition', pg_temp.def('{API_BASE,TOKEN,LIST_ID,BLANK}')));
  copy_id := (v -> 'ok' -> 'workflow' ->> 'id')::uuid;
  IF copy_id IS NULL THEN RAISE EXCEPTION 'D: duplicate refused: %', v; END IF;
  -- The copy is a workflow of its own: every copied version keeps what the copy reads, which is never the source's own values.
  SELECT count(*) INTO n FROM public.workflow_versions WHERE workflow_id = copy_id AND (env_capture IS NULL OR env_capture @> '[{"scope": "workflow"}]');
  IF n <> 0 OR NOT pg_temp.capture_of(v) @> '[{"key": "API_BASE", "scope": "global", "value": "https://org.example.test"}]' THEN
    RAISE EXCEPTION 'D: the copy''s versions kept %', (SELECT jsonb_agg(env_capture ORDER BY version_number) FROM public.workflow_versions WHERE workflow_id = copy_id);
  END IF;
  INSERT INTO ec_cases VALUES ('D a restore and a duplicate keep the values as they are then');
END
$do$;

-- ── E. a capture named by the writer is replaced ─────────────────────────────
DO $do$
DECLARE wf uuid; got jsonb;
BEGIN
  SELECT id INTO wf FROM public.workflows WHERE name = 'EC Ops';
  INSERT INTO public.workflow_versions (workflow_id, version_number, definition, env_capture)
  VALUES (wf, 99, pg_temp.def('{TOKEN}'), '[{"key": "TOKEN", "value": "forged", "is_secret": false, "scope": "global", "workflow_id": null}]')
  RETURNING env_capture INTO got;
  IF got IS DISTINCT FROM '[{"key": "TOKEN", "value": null, "is_secret": true, "scope": "global", "workflow_id": null}]'::jsonb THEN
    RAISE EXCEPTION 'E: a named capture was kept: %', got;
  END IF;
  INSERT INTO ec_cases VALUES ('E a named capture is replaced');
END
$do$;

-- ── F. a kept capture cannot be changed, and is only ever a list ─────────────
DO $do$
DECLARE wf uuid; vid uuid; before jsonb; refused boolean := false;
BEGIN
  SELECT id INTO wf FROM public.workflows WHERE name = 'EC Ops';
  SELECT id, env_capture INTO vid, before FROM public.workflow_versions WHERE workflow_id = wf AND version_number = 2;
  EXECUTE 'SET ROLE service_role';
  BEGIN
    UPDATE public.workflow_versions SET env_capture = '[]' WHERE id = vid;
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  UPDATE public.workflow_versions SET commit_sha = 'abc123' WHERE id = vid;
  EXECUTE 'RESET ROLE';
  IF NOT refused THEN RAISE EXCEPTION 'F: service_role changed a kept capture'; END IF;
  IF (SELECT env_capture FROM public.workflow_versions WHERE id = vid) IS DISTINCT FROM before THEN RAISE EXCEPTION 'F: a commit stamp changed the kept capture'; END IF;
  refused := false;
  BEGIN
    UPDATE public.workflow_versions SET env_capture = '{"API_BASE": "x"}' WHERE id = vid;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'F: the column held something other than a list'; END IF;
  INSERT INTO ec_cases VALUES ('F a kept capture is fixed and only a list');
END
$do$;

DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM ec_cases;
  IF n <> 6 THEN RAISE EXCEPTION 'version_env_capture: % of 6 cases ran', n; END IF;
  RAISE NOTICE 'version_env_capture.test.sql: % cases passed', n;
END
$do$;

ROLLBACK;
