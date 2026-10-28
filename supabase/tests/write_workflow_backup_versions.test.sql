-- write_workflow answers the version a create or a duplicate writes, so both
-- are backed up to GitHub like a save (#2879, migration 20261028010000).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Everything runs in
-- one transaction that is rolled back. No real identity.
--
-- Until #2879 neither op answered a version_id, so writeWorkflow had nothing to
-- push or stamp and a new or duplicated workflow was missing from the backup
-- until its first save; and duplicate copied the source's commit_sha onto every
-- copied version, so the copy's history pointed at commits of the source's file.
--
-- WHAT IT PROVES, each call made as service_role, the Worker's role:
--   A. create writes a first version holding exactly the definition and stamp
--      the row holds, by the creator, and answers its id and number; the next
--      save numbers after it.
--   B. duplicate copies the source's history with no commit_sha on any copied
--      row, and answers the newest copied version when it holds exactly the
--      copy's definition and stamp, writing nothing more.
--   C. duplicate writes a new version on top of the copied history when the
--      copy's definition differs from the newest copied one, and answers it.
--   D. duplicate of a source never saved writes a first version holding the
--      copy's definition, and answers it.
--
-- Mutations tried (each turned its case red, then was put back):
--  - create's version insert removed: A red;
--  - commit_sha put back in duplicate's copy: B red;
--  - the definition compare in duplicate made always true: C red;
--  - the version on top writing the source row's definition, not the copy's:
--    C red (D covers the same line for a source never saved).

BEGIN;

CREATE TEMP TABLE wb_cases (name text PRIMARY KEY);

INSERT INTO public.organizations (id, name, slug) VALUES
  ('11111111-1111-1111-1111-111111112879', 'WB Org', 'wb-org-2879');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES
  ('22222222-2222-2222-2222-222222222879', '11111111-1111-1111-1111-111111112879', 'wb2879@example.test', 'WB Alice');

-- One call as service_role: {ok: result} or {state, message, detail}.
CREATE FUNCTION pg_temp.ww(p_op text, p_id uuid, p_expected integer, p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE v jsonb; s text; m text; d text;
BEGIN
  EXECUTE 'SET ROLE service_role';
  BEGIN
    v := public.write_workflow(p_op, '11111111-1111-1111-1111-111111112879', p_id, p_expected, p_fields, NULL,
                               '22222222-2222-2222-2222-222222222879', 'wb2879@example.test', 'WB Alice');
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

-- ── A. create ────────────────────────────────────────────────────────────────
DO $do$
DECLARE v jsonb; w jsonb; r record; n integer;
BEGIN
  v := pg_temp.ww('create', NULL, NULL, jsonb_build_object('name', 'Lead Routing', 'definition', pg_temp.def('a'), 'definition_schema_version', 1));
  w := v -> 'ok' -> 'workflow';
  IF w IS NULL THEN RAISE EXCEPTION 'A: create refused: %', v; END IF;
  IF v -> 'ok' ->> 'version_id' IS NULL OR (v -> 'ok' ->> 'version_number')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'A: create answered no version: %', v;
  END IF;
  SELECT * INTO r FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid;
  IF r.id IS NULL OR r.workflow_id <> (w ->> 'id')::uuid OR r.version_number <> 1 OR r.definition <> pg_temp.def('a')
     OR r.definition_schema_version IS DISTINCT FROM 1::smallint OR r.created_by <> '22222222-2222-2222-2222-222222222879'
     OR r.commit_sha IS NOT NULL THEN
    RAISE EXCEPTION 'A: the created version is %', r;
  END IF;
  SELECT count(*) INTO n FROM public.workflow_versions WHERE workflow_id = (w ->> 'id')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'A: create wrote % versions', n; END IF;
  -- The next save numbers after the created version.
  v := pg_temp.ww('save', (w ->> 'id')::uuid, (w ->> 'version')::int, jsonb_build_object('definition', pg_temp.def('a2'), 'definition_schema_version', 1));
  IF (v -> 'ok' ->> 'version_number')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'A: the save after a create answered %', v; END IF;
  INSERT INTO wb_cases VALUES ('A create');
END
$do$;

-- ── B. duplicate, the newest copied version is the copy's definition ─────────
DO $do$
DECLARE src uuid; v jsonb; w jsonb; r record; n integer;
BEGIN
  INSERT INTO public.workflows (organization_id, name, definition, definition_schema_version)
  VALUES ('11111111-1111-1111-1111-111111112879', 'Backed up', pg_temp.def('s'), 1) RETURNING id INTO src;
  INSERT INTO public.workflow_versions (workflow_id, version_number, definition, definition_schema_version, message, commit_sha) VALUES
    (src, 1, pg_temp.def('s1'), NULL, 'one', 'sha-of-the-source-1'), (src, 2, pg_temp.def('s'), 1, 'two', 'sha-of-the-source-2');
  v := pg_temp.ww('duplicate', src, NULL, jsonb_build_object('name', 'Backed up (copy)', 'definition', pg_temp.def('s')));
  w := v -> 'ok' -> 'workflow';
  IF w IS NULL THEN RAISE EXCEPTION 'B: duplicate refused: %', v; END IF;
  SELECT count(*) INTO n FROM public.workflow_versions WHERE workflow_id = (w ->> 'id')::uuid AND commit_sha IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'B: % copied versions carry the source''s commit', n; END IF;
  SELECT count(*) INTO n FROM public.workflow_versions WHERE workflow_id = (w ->> 'id')::uuid;
  IF n <> 2 OR (v -> 'ok' ->> 'versions_copied')::int <> 2 THEN RAISE EXCEPTION 'B: the copy holds % versions: %', n, v; END IF;
  SELECT * INTO r FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid;
  IF r.id IS NULL OR r.workflow_id <> (w ->> 'id')::uuid OR r.version_number <> 2 OR (v -> 'ok' ->> 'version_number')::int <> 2 THEN
    RAISE EXCEPTION 'B: duplicate answered % for version %', v, r;
  END IF;
  -- The source keeps its own commits.
  IF (SELECT count(*) FROM public.workflow_versions WHERE workflow_id = src AND commit_sha IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'B: the source lost its commits';
  END IF;
  INSERT INTO wb_cases VALUES ('B duplicate answers the newest copied version');
END
$do$;

-- ── C. duplicate, the copy's definition differs from the newest copied one ────
DO $do$
DECLARE src uuid; v jsonb; w jsonb; r record;
BEGIN
  INSERT INTO public.workflows (organization_id, name, definition, definition_schema_version)
  VALUES ('11111111-1111-1111-1111-111111112879', 'Edited by hand', pg_temp.def('h'), 1) RETURNING id INTO src;
  INSERT INTO public.workflow_versions (workflow_id, version_number, definition, definition_schema_version, message, commit_sha) VALUES
    (src, 1, pg_temp.def('h1'), 1, 'one', 'sha-of-the-source-1');
  -- The Worker sends the source's definition as it cleans and stamps it, which can differ from the snapshot.
  v := pg_temp.ww('duplicate', src, NULL, jsonb_build_object('name', 'Edited by hand (copy)', 'definition', pg_temp.def('h-clean')));
  w := v -> 'ok' -> 'workflow';
  IF w IS NULL THEN RAISE EXCEPTION 'C: duplicate refused: %', v; END IF;
  SELECT * INTO r FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid;
  IF r.id IS NULL OR r.workflow_id <> (w ->> 'id')::uuid OR r.version_number <> 2 OR r.definition <> pg_temp.def('h-clean')
     OR r.definition_schema_version IS DISTINCT FROM 1::smallint OR r.message <> 'Duplicated from Edited by hand' OR r.commit_sha IS NOT NULL
     OR (v -> 'ok' ->> 'version_number')::int <> 2 OR (v -> 'ok' ->> 'versions_copied')::int <> 1 THEN
    RAISE EXCEPTION 'C: duplicate answered % for version %', v, r;
  END IF;
  INSERT INTO wb_cases VALUES ('C duplicate writes the copy''s definition on top');
END
$do$;

-- ── D. duplicate of a source never saved ─────────────────────────────────────
DO $do$
DECLARE bare uuid; v jsonb; w jsonb; r record; n integer;
BEGIN
  INSERT INTO public.workflows (organization_id, name, definition) VALUES ('11111111-1111-1111-1111-111111112879', 'Never saved', pg_temp.def('n')) RETURNING id INTO bare;
  v := pg_temp.ww('duplicate', bare, NULL, jsonb_build_object('name', 'Never saved (copy)', 'definition', pg_temp.def('n-clean')));
  w := v -> 'ok' -> 'workflow';
  IF w IS NULL THEN RAISE EXCEPTION 'D: duplicate refused: %', v; END IF;
  SELECT * INTO r FROM public.workflow_versions WHERE id = (v -> 'ok' ->> 'version_id')::uuid;
  IF r.id IS NULL OR r.workflow_id <> (w ->> 'id')::uuid OR r.version_number <> 1 OR r.definition <> pg_temp.def('n-clean')
     OR r.message <> 'Duplicated from Never saved' OR (v -> 'ok' ->> 'version_number')::int <> 1 THEN
    RAISE EXCEPTION 'D: duplicate answered % for version %', v, r;
  END IF;
  SELECT count(*) INTO n FROM public.workflow_versions WHERE workflow_id = (w ->> 'id')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'D: the copy holds % versions', n; END IF;
  INSERT INTO wb_cases VALUES ('D duplicate of a source never saved');
END
$do$;

DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM wb_cases;
  IF n <> 4 THEN RAISE EXCEPTION 'write_workflow_backup_versions: % of 4 cases ran', n; END IF;
  RAISE NOTICE 'write_workflow_backup_versions.test.sql: % cases passed', n;
END
$do$;

ROLLBACK;
