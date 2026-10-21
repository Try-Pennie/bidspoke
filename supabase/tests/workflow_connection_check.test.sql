-- Workflow writers re-check connection ids (#2338, build PR 7), migration
-- 20261020220000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Fixed ids, deleted
-- first, so a rerun starts clean. The envelopes are planted placeholders shaped
-- like the seal's, not ciphertext of anything. No real identity.
--
-- WHAT IT PROVES:
--   A. definition_connection_ids holds every string of a definition that could
--      be a connection id, once each, ignoring case and surrounding spaces, at
--      any depth, and nothing else: not a key, not a name, not a near uuid.
--   B. It is the one predicate: for every fixture workflow and connection,
--      connection_references names the workflow exactly when the workflow's
--      definition holds the id by definition_connection_ids, and
--      definition_connection_problems judges only ids it holds.
--   C. A workflow INSERT naming a removed connection (a tombstone of the
--      organization and no live row) is refused with BP409
--      workflow_names_missing_connection, its DETAIL naming the id, the
--      connection's name as it was, and the step; nothing is written.
--   D. An UPDATE naming another organization's connection, live or removed, is
--      refused as not_this_organization, and never carries that connection's
--      name; nothing is written.
--   E. A definition naming no connection, or a live one of the organization,
--      is written exactly as sent (its text unchanged at the store), and so is
--      every live money workflow the money gate replays, by insert and update.
--   F. An UPDATE that leaves the definition as it was (a rename) is not
--      re-judged; one that changes it while it still names a removed
--      connection is refused.
--   G. A save that holds a connection when a removal starts makes the removal
--      wait, and the removal then answers connection_in_use (a second session
--      through dblink).
--   H. A removal in flight makes a save naming the connection wait, and the
--      save is then refused; the workflow keeps its definition.
--   I. definition_connection_problems is STABLE, SECURITY DEFINER with its
--      search_path, service_role only; definition_connection_ids is IMMUTABLE;
--      the trigger fires before an insert and before an update of the
--      definition or the organization.
--
-- Mutations tried (each turned its case red, then was put back):
--  - the trigger's FOR KEY SHARE removed: G red (the removal did not wait) and
--    H red (the save did not wait);
--  - definition_connection_ids without lower(): A and B red;
--  - the not_this_organization arm for a live row of another organization
--    removed: D red;
--  - the trigger's early return on an unchanged definition removed: F red.

\if :{?self_host}
\else
  \echo 'workflow_connection_check.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  \quit
\endif
SELECT set_config('wcc_test.self_host', :'self_host', false) AS self_host_set \gset

CREATE TEMP TABLE IF NOT EXISTS wcc_cases (name text PRIMARY KEY);
DELETE FROM wcc_cases;

-- Org A: ...d2338aa. Org B: ...d2338bb.
CREATE OR REPLACE FUNCTION pg_temp.wcc_clean()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM public.workflows WHERE organization_id IN ('11111111-1111-1111-1111-11111d2338aa', '11111111-1111-1111-1111-11111d2338bb');
  DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111d2338aa', '11111111-1111-1111-1111-11111d2338bb');
  DELETE FROM public.connection_tombstones WHERE organization_id IN ('11111111-1111-1111-1111-11111d2338aa', '11111111-1111-1111-1111-11111d2338bb');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111d2338aa', '11111111-1111-1111-1111-11111d2338bb');
END
$fn$;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111d2338aa', 'WCC Org', 'wcc-org-2338') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111d2338bb', 'WCC Org B', 'wcc-org-2338b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222d2338aa', '11111111-1111-1111-1111-11111d2338aa', 'wcc2338@example.test', 'WCC User')
  ON CONFLICT (id) DO NOTHING;
  PERFORM pg_temp.wcc_clean();
END
$do$;

CREATE OR REPLACE FUNCTION pg_temp.wcc_envelope(p_iv text)
RETURNS text
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object('v', 1, 'kid', 'ops-test-1',
    'wrapped_key', encode(convert_to('planted-wrapped', 'UTF8'), 'base64'), 'iv', p_iv,
    'ct', encode(convert_to('planted-ct-2338', 'UTF8'), 'base64'))::text
$fn$;

-- Connections. Org A: a1 Ops Salesforce, a2 Ops OpenAI, ag and ah (the two
-- race cases'), ar (removed in case C). Org B: b1 live, bt removed.
CREATE OR REPLACE FUNCTION pg_temp.wcc_connections()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.service_connections
    (id, organization_id, service_type, name, auth_type, credential_enc, sealed_for, credential_generation, updated_by)
  VALUES
    ('33333333-3333-3333-3333-33333d2338a1', '11111111-1111-1111-1111-11111d2338aa', 'salesforce', 'Ops Salesforce', 'oauth_client_credentials', pg_temp.wcc_envelope('aXYtYTE'), 'ops_key', 1, '22222222-2222-2222-2222-22222d2338aa'),
    ('33333333-3333-3333-3333-33333d2338a2', '11111111-1111-1111-1111-11111d2338aa', 'openai', 'Ops OpenAI', 'api_key', pg_temp.wcc_envelope('aXYtYTI'), 'ops_key', 1, '22222222-2222-2222-2222-22222d2338aa'),
    ('33333333-3333-3333-3333-33333d2338a7', '11111111-1111-1111-1111-11111d2338aa', 'anthropic', 'Race save first', 'api_key', pg_temp.wcc_envelope('aXYtYWc'), 'ops_key', 1, '22222222-2222-2222-2222-22222d2338aa'),
    ('33333333-3333-3333-3333-33333d2338a8', '11111111-1111-1111-1111-11111d2338aa', 'anthropic', 'Race removal first', 'api_key', pg_temp.wcc_envelope('aXYtYWg'), 'ops_key', 1, '22222222-2222-2222-2222-22222d2338aa'),
    ('33333333-3333-3333-3333-33333d2338a9', '11111111-1111-1111-1111-11111d2338aa', 'openai', 'Retired OpenAI', 'api_key', pg_temp.wcc_envelope('aXYtYXI'), 'ops_key', 4, '22222222-2222-2222-2222-22222d2338aa'),
    ('33333333-3333-3333-3333-33333d2338b1', '11111111-1111-1111-1111-11111d2338bb', 'salesforce', 'B Secret Salesforce', 'oauth_client_credentials', pg_temp.wcc_envelope('aXYtYjE'), 'ops_key', 1, NULL);
  -- Org B's removed connection: a tombstone and no row.
  INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
  VALUES ('11111111-1111-1111-1111-11111d2338bb', '33333333-3333-3333-3333-33333d2338b2', 1);
END
$fn$;

-- A definition with one code step whose config names the given id.
CREATE OR REPLACE FUNCTION pg_temp.wcc_def(p_namespace text, p_id text)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object('nodes', jsonb_build_array(jsonb_build_object('id', 'n1', 'namespace', p_namespace, 'type', 'code',
    'config', jsonb_build_object('connection_id', p_id))), 'edges', '[]'::jsonb)
$fn$;

-- Runs a statement; answers 'none', or the error's SQLSTATE, message and detail.
CREATE OR REPLACE FUNCTION pg_temp.wcc_error_of(p_sql text)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_state text; v_msg text; v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN jsonb_build_object('state', 'none');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
  RETURN jsonb_build_object('state', v_state, 'message', v_msg, 'detail', v_detail);
END
$fn$;

-- ── A. definition_connection_ids ─────────────────────────────────────────────
DO $do$
DECLARE
  got text;
BEGIN
  SELECT string_agg(i::text, ' ' ORDER BY i::text) INTO got
  FROM public.definition_connection_ids($j${
    "nodes": [
      {"namespace": "a", "config": {"connection_id": "33333333-3333-3333-3333-33333D2338A1"}},
      {"namespace": "b", "config": {"steps": [{"auth": {"x": "  33333333-3333-3333-3333-33333d2338a2 "}}, "33333333-3333-3333-3333-33333D2338a1"]}},
      {"namespace": "c", "config": {"44444444-4444-4444-4444-44444d2338a1": "a key is not a value",
                                     "near": "33333333-3333-3333-3333-33333d2338a",
                                     "braced": "{33333333-3333-3333-3333-33333d2338a3}",
                                     "name": "Ops Salesforce", "n": 12}}
    ]
  }$j$::jsonb) i;
  IF got IS DISTINCT FROM '33333333-3333-3333-3333-33333d2338a1 33333333-3333-3333-3333-33333d2338a2' THEN
    RAISE EXCEPTION 'case A: definition_connection_ids held %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM public.definition_connection_ids(NULL)) THEN
    RAISE EXCEPTION 'case A: a null definition holds an id';
  END IF;
  INSERT INTO wcc_cases VALUES ('definition_connection_ids holds each id once, by case and space, and nothing else');
END
$do$;

-- ── B. One predicate: connection_references agrees with it ───────────────────
DO $do$
DECLARE
  bad text;
BEGIN
  BEGIN
    PERFORM pg_temp.wcc_connections();
    INSERT INTO public.workflows (id, organization_id, name, definition, deleted_at) VALUES
      ('44444444-4444-4444-4444-44444d2338b1', '11111111-1111-1111-1111-11111d2338aa', 'Upper case, deep',
       '{"nodes":[{"namespace":"x","config":{"steps":[{"c":" 33333333-3333-3333-3333-33333D2338A1"}]}}]}', NULL),
      ('44444444-4444-4444-4444-44444d2338b2', '11111111-1111-1111-1111-11111d2338aa', 'By name only',
       '{"nodes":[{"namespace":"x","config":{"connection":"Ops OpenAI"}}]}', NULL),
      ('44444444-4444-4444-4444-44444d2338b3', '11111111-1111-1111-1111-11111d2338aa', 'Deleted, both',
       '{"nodes":[{"namespace":"x","config":{"a":"33333333-3333-3333-3333-33333d2338a1","b":"33333333-3333-3333-3333-33333d2338a2"}}]}', now());
    SELECT string_agg(format('%s/%s', w.name, sc.name), ', ') INTO bad
    FROM public.workflows w
    CROSS JOIN public.service_connections sc
    WHERE w.organization_id = '11111111-1111-1111-1111-11111d2338aa' AND sc.organization_id = w.organization_id
      AND EXISTS (SELECT 1 FROM public.connection_references(sc.organization_id, sc.id) r WHERE r.workflow_id = w.id)
       IS DISTINCT FROM EXISTS (SELECT 1 FROM public.definition_connection_ids(w.definition) i WHERE i = sc.id);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'case B: connection_references and definition_connection_ids disagree on %', bad; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.connection_references('11111111-1111-1111-1111-11111d2338aa', '33333333-3333-3333-3333-33333d2338a1') r
                   WHERE r.workflow_id = '44444444-4444-4444-4444-44444d2338b1') THEN
      RAISE EXCEPTION 'case B: the comparison above compared nothing: the upper case reference was not found';
    END IF;
    -- The problems function judges only the ids the predicate holds: a definition
    -- naming org B's connection only by its name has no problem.
    IF EXISTS (SELECT 1 FROM public.definition_connection_problems('11111111-1111-1111-1111-11111d2338aa',
                 '{"nodes":[{"namespace":"x","config":{"connection":"B Secret Salesforce"}}]}')) THEN
      RAISE EXCEPTION 'case B: a connection named only by its name was judged';
    END IF;
    RAISE EXCEPTION 'wcc_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'wcc_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO wcc_cases VALUES ('connection_references and the write check read the one predicate');
END
$do$;

-- ── C. An insert naming a removed connection is refused, by name ─────────────
DO $do$
DECLARE
  e jsonb;
  d jsonb;
BEGIN
  BEGIN
    PERFORM pg_temp.wcc_connections();
    IF (SELECT outcome FROM public.remove_ops_connection('11111111-1111-1111-1111-11111d2338aa', '33333333-3333-3333-3333-33333d2338a9', '22222222-2222-2222-2222-22222d2338aa')) <> 'removed' THEN
      RAISE EXCEPTION 'case C: the fixture removal did not remove';
    END IF;
    e := pg_temp.wcc_error_of(format($q$INSERT INTO public.workflows (id, organization_id, name, definition)
      VALUES ('44444444-4444-4444-4444-44444d2338c1', '11111111-1111-1111-1111-11111d2338aa', 'Uses the retired key', %L)$q$,
      pg_temp.wcc_def('summarise', ' 33333333-3333-3333-3333-33333D2338A9')));
    IF e ->> 'state' <> 'BP409' OR e ->> 'message' <> 'workflow_names_missing_connection' THEN
      RAISE EXCEPTION 'case C: the insert answered %', e;
    END IF;
    d := (e ->> 'detail')::jsonb;
    IF d IS DISTINCT FROM '[{"id":"33333333-3333-3333-3333-33333d2338a9","name":"Retired OpenAI","steps":["summarise"],"problem":"removed"}]'::jsonb THEN
      RAISE EXCEPTION 'case C: the refusal named %', d;
    END IF;
    IF EXISTS (SELECT 1 FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444d2338c1') THEN
      RAISE EXCEPTION 'case C: the refused insert wrote a workflow';
    END IF;
    RAISE EXCEPTION 'wcc_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'wcc_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO wcc_cases VALUES ('an insert naming a removed connection is refused, naming it, the step and the cause');
END
$do$;

-- ── D. Another organization's connection is refused, never named ─────────────
DO $do$
DECLARE
  e jsonb;
  d jsonb;
BEGIN
  BEGIN
    PERFORM pg_temp.wcc_connections();
    INSERT INTO public.workflows (id, organization_id, name, definition)
    VALUES ('44444444-4444-4444-4444-44444d2338d1', '11111111-1111-1111-1111-11111d2338aa', 'Plain', '{"nodes":[],"edges":[]}');
    e := pg_temp.wcc_error_of(format($q$UPDATE public.workflows SET definition = %L WHERE id = '44444444-4444-4444-4444-44444d2338d1'$q$,
      jsonb_build_object('nodes', jsonb_build_array(
        jsonb_build_object('namespace', 'live_b', 'config', jsonb_build_object('c', '33333333-3333-3333-3333-33333d2338b1')),
        jsonb_build_object('namespace', 'gone_b', 'config', jsonb_build_object('c', '33333333-3333-3333-3333-33333d2338b2'))))));
    IF e ->> 'state' <> 'BP409' THEN RAISE EXCEPTION 'case D: the update answered %', e; END IF;
    d := (e ->> 'detail')::jsonb;
    IF d IS DISTINCT FROM '[{"id":"33333333-3333-3333-3333-33333d2338b1","name":null,"steps":["live_b"],"problem":"not_this_organization"},
                            {"id":"33333333-3333-3333-3333-33333d2338b2","name":null,"steps":["gone_b"],"problem":"not_this_organization"}]'::jsonb THEN
      RAISE EXCEPTION 'case D: the refusal named %', d;
    END IF;
    IF e::text LIKE '%B Secret Salesforce%' THEN RAISE EXCEPTION 'case D: the refusal carried another organization''s connection name'; END IF;
    IF (SELECT definition FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444d2338d1') <> '{"nodes":[],"edges":[]}'::jsonb THEN
      RAISE EXCEPTION 'case D: the refused update wrote the definition';
    END IF;
    RAISE EXCEPTION 'wcc_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'wcc_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO wcc_cases VALUES ('another organization''s connection, live or removed, is refused and never named');
END
$do$;

-- ── E. A definition naming no connection, or a live one, is written as sent ──
DO $do$
DECLARE
  sent text := '{"edges": [{"source": "n1", "target": "n2"}], "nodes": [{"id": "n1", "type": "code", "config": {"script": "return 1", "partner_id": "55555555-5555-5555-5555-55555d2338e1"}, "namespace": "price"}, {"id": "n2", "config": {"connection_id": "33333333-3333-3333-3333-33333d2338a1"}, "namespace": "sf"}], "trigger": {"type": "http_webhook"}}';
  f text;
  money jsonb;
  saved int := 0;
BEGIN
  BEGIN
    PERFORM pg_temp.wcc_connections();
    INSERT INTO public.workflows (id, organization_id, name, definition)
    VALUES ('44444444-4444-4444-4444-44444d2338e1', '11111111-1111-1111-1111-11111d2338aa', 'Money shaped', '{"nodes":[{"namespace":"price","config":{"partner_id":"55555555-5555-5555-5555-55555d2338e1"}}]}');
    UPDATE public.workflows SET definition = sent::jsonb WHERE id = '44444444-4444-4444-4444-44444d2338e1';
    IF (SELECT definition::text FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444d2338e1') IS DISTINCT FROM sent::jsonb::text THEN
      RAISE EXCEPTION 'case E: the stored definition is not the one sent';
    END IF;
    -- Every live money workflow the money gate replays, saved through the
    -- trigger by insert and by update, is stored exactly as sent.
    FOR f IN SELECT unnest(ARRAY[
      '/sql-suite-fixtures/money-gate/definitions/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json',
      '/sql-suite-fixtures/money-gate/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json',
      '/sql-suite-fixtures/money-gate/definitions/89b1a6af-7e0f-43de-bc66-1e888184551f.json',
      '/sql-suite-fixtures/money-gate/definitions/8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08.json',
      '/sql-suite-fixtures/money-gate/definitions/da82a183-1a4a-417e-b0b8-5f3fe5e14840.json',
      '/sql-suite-fixtures/money-gate/definitions/e1b810da-16c0-49eb-bf12-ba1c9b67c914.json',
      '/sql-suite-fixtures/money-gate/definitions/ee8ebc50-07dc-4670-89c7-d8ae47401558.json'
    ]) LOOP
      money := pg_read_file(f)::jsonb -> 'definition';
      IF jsonb_typeof(money -> 'nodes') <> 'array' OR jsonb_array_length(money -> 'nodes') = 0 THEN
        RAISE EXCEPTION 'case E: % holds no definition with nodes', f;
      END IF;
      INSERT INTO public.workflows (id, organization_id, name, definition)
      VALUES ('44444444-4444-4444-4444-44444d2338e2', '11111111-1111-1111-1111-11111d2338aa', 'Money copy', money);
      IF (SELECT definition::text FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444d2338e2') IS DISTINCT FROM money::text THEN
        RAISE EXCEPTION 'case E: % was not stored as sent by an insert', f;
      END IF;
      UPDATE public.workflows SET definition = '{"nodes":[]}' WHERE id = '44444444-4444-4444-4444-44444d2338e2';
      UPDATE public.workflows SET definition = money WHERE id = '44444444-4444-4444-4444-44444d2338e2';
      IF (SELECT definition::text FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444d2338e2') IS DISTINCT FROM money::text THEN
        RAISE EXCEPTION 'case E: % was not stored as sent by an update', f;
      END IF;
      DELETE FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444d2338e2';
      saved := saved + 1;
    END LOOP;
    IF saved <> 7 THEN RAISE EXCEPTION 'case E: % money definitions were saved, not 7', saved; END IF;
    RAISE EXCEPTION 'wcc_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'wcc_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO wcc_cases VALUES ('a definition naming no connection or a live one is written exactly as sent');
END
$do$;

-- ── F. A rename is not re-judged; a changed definition is ────────────────────
DO $do$
DECLARE
  e jsonb;
BEGIN
  BEGIN
    PERFORM pg_temp.wcc_connections();
    -- Planted as a hand run restore leaves it: saved while the id named nothing,
    -- then a tombstone for it.
    INSERT INTO public.workflows (id, organization_id, name, definition)
    VALUES ('44444444-4444-4444-4444-44444d2338f1', '11111111-1111-1111-1111-11111d2338aa', 'Restored by hand',
            pg_temp.wcc_def('old', '33333333-3333-3333-3333-33333d2338f9'));
    INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
    VALUES ('11111111-1111-1111-1111-11111d2338aa', '33333333-3333-3333-3333-33333d2338f9', 1);
    e := pg_temp.wcc_error_of($q$UPDATE public.workflows SET name = 'Restored by hand (renamed)', definition = definition WHERE id = '44444444-4444-4444-4444-44444d2338f1'$q$);
    IF e ->> 'state' <> 'none' THEN RAISE EXCEPTION 'case F: a rename was refused: %', e; END IF;
    e := pg_temp.wcc_error_of(format($q$UPDATE public.workflows SET definition = %L WHERE id = '44444444-4444-4444-4444-44444d2338f1'$q$,
      pg_temp.wcc_def('renamed_step', '33333333-3333-3333-3333-33333d2338f9')));
    IF e ->> 'state' <> 'BP409' OR (e ->> 'detail')::jsonb -> 0 ->> 'problem' <> 'removed' OR (e ->> 'detail')::jsonb -> 0 -> 'name' <> 'null'::jsonb THEN
      RAISE EXCEPTION 'case F: a changed definition still naming a removed connection answered %', e;
    END IF;
    RAISE EXCEPTION 'wcc_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'wcc_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO wcc_cases VALUES ('a rename is not re-judged, and a changed definition still naming a removed connection is refused');
END
$do$;

-- ── G and H fixtures: committed, so the second session sees them ─────────────
DO $do$
BEGIN
  PERFORM pg_temp.wcc_connections();
  INSERT INTO public.workflows (id, organization_id, name, definition) VALUES
    ('44444444-4444-4444-4444-44444d2338a7', '11111111-1111-1111-1111-11111d2338aa', 'Race save first', '{"nodes":[],"edges":[]}'),
    ('44444444-4444-4444-4444-44444d2338a8', '11111111-1111-1111-1111-11111d2338aa', 'Race removal first', '{"nodes":[],"edges":[]}');
END
$do$;

-- ── G. A save holding the connection makes a removal wait, then refuse ───────
DO $do$
DECLARE
  created boolean := NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink');
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('wcc_test.self_host'));
  v_pid integer;
  v_waiting boolean := false;
  i integer;
BEGIN
  IF created THEN CREATE EXTENSION dblink; END IF;
  PERFORM set_config('wcc_test.created_dblink', created::text, false);
  PERFORM dblink_connect('wcc_b', conn);
  SELECT pid INTO v_pid FROM dblink('wcc_b', 'SELECT pg_backend_pid()') AS t(pid integer);
  -- The save, not yet committed.
  UPDATE public.workflows SET definition = pg_temp.wcc_def('ask', '33333333-3333-3333-3333-33333d2338a7')
  WHERE id = '44444444-4444-4444-4444-44444d2338a7';
  PERFORM dblink_send_query('wcc_b', $q$SELECT outcome, workflows FROM public.remove_ops_connection('11111111-1111-1111-1111-11111d2338aa', '33333333-3333-3333-3333-33333d2338a7', '22222222-2222-2222-2222-22222d2338aa')$q$);
  FOR i IN 1..200 LOOP
    SELECT wait_event_type = 'Lock' INTO v_waiting FROM pg_stat_activity WHERE pid = v_pid;
    EXIT WHEN v_waiting;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF NOT coalesce(v_waiting, false) THEN
    PERFORM dblink_cancel_query('wcc_b');
    PERFORM dblink_disconnect('wcc_b');
    RAISE EXCEPTION 'case G: the removal did not wait for the save holding its connection';
  END IF;
END
$do$;

DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM dblink_get_result('wcc_b', true) AS t(outcome text, workflows jsonb);
  PERFORM * FROM dblink_get_result('wcc_b', true) AS t(outcome text, workflows jsonb);
  IF r.outcome IS DISTINCT FROM 'connection_in_use' OR r.workflows -> 0 ->> 'name' IS DISTINCT FROM 'Race save first' THEN
    RAISE EXCEPTION 'case G: the removal after the save answered % %', r.outcome, r.workflows;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333d2338a7')
     OR EXISTS (SELECT 1 FROM public.connection_tombstones WHERE connection_id = '33333333-3333-3333-3333-33333d2338a7') THEN
    RAISE EXCEPTION 'case G: the refused removal removed the connection';
  END IF;
  INSERT INTO wcc_cases VALUES ('a save holding a connection makes a removal wait, and the removal is then refused');
END
$do$;

-- ── H. A removal in flight makes a save wait, then the save is refused ───────
DO $do$
DECLARE
  v_pid integer;
  v_waiting boolean := false;
  i integer;
BEGIN
  SELECT pid INTO v_pid FROM dblink('wcc_b', 'SELECT pg_backend_pid()') AS t(pid integer);
  -- The removal, not yet committed.
  IF (SELECT outcome FROM public.remove_ops_connection('11111111-1111-1111-1111-11111d2338aa', '33333333-3333-3333-3333-33333d2338a8', '22222222-2222-2222-2222-22222d2338aa')) <> 'removed' THEN
    RAISE EXCEPTION 'case H: the removal did not remove';
  END IF;
  PERFORM dblink_send_query('wcc_b', format($q$UPDATE public.workflows SET definition = %L WHERE id = '44444444-4444-4444-4444-44444d2338a8'$q$,
    pg_temp.wcc_def('ask', '33333333-3333-3333-3333-33333d2338a8')));
  FOR i IN 1..200 LOOP
    SELECT wait_event_type = 'Lock' INTO v_waiting FROM pg_stat_activity WHERE pid = v_pid;
    EXIT WHEN v_waiting;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF NOT coalesce(v_waiting, false) THEN
    PERFORM dblink_cancel_query('wcc_b');
    PERFORM dblink_disconnect('wcc_b');
    RAISE EXCEPTION 'case H: the save did not wait for the removal of its connection';
  END IF;
END
$do$;

DO $do$
DECLARE
  v_err text;
BEGIN
  BEGIN
    PERFORM * FROM dblink_get_result('wcc_b', true) AS t(r text);
    v_err := 'none';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM dblink_disconnect('wcc_b');
  IF current_setting('wcc_test.created_dblink', true) = 'true' THEN DROP EXTENSION dblink; END IF;
  IF v_err NOT LIKE '%workflow_names_missing_connection%' THEN RAISE EXCEPTION 'case H: the save after the removal answered %', v_err; END IF;
  IF (SELECT definition FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444d2338a8') <> '{"nodes":[],"edges":[]}'::jsonb THEN
    RAISE EXCEPTION 'case H: the refused save wrote the definition';
  END IF;
  INSERT INTO wcc_cases VALUES ('a removal in flight makes a save wait, and the save is then refused');
END
$do$;

-- ── I. Grants, volatility and the trigger ────────────────────────────────────
DO $do$
DECLARE
  fn text := 'public.definition_connection_problems(uuid, jsonb)';
  r text;
  p record;
  t record;
BEGIN
  IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION '% does not exist', fn; END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, fn, 'EXECUTE') THEN RAISE EXCEPTION '% may call %', r, fn; END IF;
    IF has_function_privilege(r, 'public.definition_connection_ids(jsonb)', 'EXECUTE') THEN RAISE EXCEPTION '% may call definition_connection_ids', r; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role may not call %', fn; END IF;
  SELECT prosecdef, proconfig, provolatile INTO p FROM pg_proc WHERE oid = to_regprocedure(fn);
  IF NOT p.prosecdef OR p.provolatile <> 's' OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION '% is not STABLE SECURITY DEFINER with its own search_path', fn;
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('public.definition_connection_ids(jsonb)')) <> 'i' THEN
    RAISE EXCEPTION 'definition_connection_ids is not IMMUTABLE';
  END IF;
  SELECT tgtype, tgattr INTO t FROM pg_trigger
  WHERE tgrelid = 'public.workflows'::regclass AND tgname = 'workflows_refuse_missing_connections' AND NOT tgisinternal;
  IF NOT FOUND THEN RAISE EXCEPTION 'the workflows trigger does not exist'; END IF;
  -- BEFORE (2), ROW (1), INSERT (4), UPDATE (16).
  IF (t.tgtype & 2) = 0 OR (t.tgtype & 1) = 0 OR (t.tgtype & 4) = 0 OR (t.tgtype & 16) = 0 THEN
    RAISE EXCEPTION 'the workflows trigger is not BEFORE INSERT OR UPDATE FOR EACH ROW (tgtype %)', t.tgtype;
  END IF;
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
      WHERE a.attrelid = 'public.workflows'::regclass AND a.attnum = ANY (t.tgattr::int2[])) IS DISTINCT FROM ARRAY['definition', 'organization_id'] THEN
    RAISE EXCEPTION 'the workflows trigger does not fire on an update of exactly the definition and the organization';
  END IF;
  INSERT INTO wcc_cases VALUES ('the check is service_role only, STABLE, and its trigger fires before every definition write');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
SELECT pg_temp.wcc_clean();

DO $do$
DECLARE
  n int := (SELECT count(*) FROM wcc_cases);
BEGIN
  IF n <> 9 THEN RAISE EXCEPTION 'expected 9 cases, % ran', n; END IF;
  RAISE NOTICE 'workflow_connection_check.test.sql: % cases passed', n;
END
$do$;
