-- The bidding database's half of the Connections page (#2338, build PR 3),
-- migration 20261020200000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The envelopes and
-- tokens below are planted placeholders shaped like the seal's, not ciphertext
-- of anything.
--
-- WHAT IT PROVES (each case inside a block that is rolled back):
--   A. The service_type CHECK takes every service key of the catalogue's shape,
--      and refuses a key that is not one.
--   B. A service that exists only on the ops lane (anything but salesforce,
--      supabase, snowflake and slack) must be an ops_key row: a bidding_ring
--      row and an unsealed row naming one are refused; the four money lane
--      services still take a non ops row.
--   C. acts_as is a nullable column, recorded by the table's audit.
--   D. connection_references finds the workflows whose definition holds the
--      connection's id, at any depth and under any key, soft deleted ones
--      included and marked, and never one that names it only by name, nor
--      another organization's workflow.
--   E. remove_ops_connection is refused while a workflow uses the connection,
--      naming every one (deleted ones marked), and writes nothing.
--   F. A soft deleted workflow alone blocks the removal, and is named as deleted.
--   G. A removal writes exactly one tombstone at the row's generation and
--      deletes exactly one row, audited under its actor.
--   H. reconnect_ops_connection with a stale generation writes nothing and
--      answers stale_generation; with the current one it writes the envelope,
--      the new generation and acts_as, audited under its actor.
--   I. reconnect refuses an envelope not of the seal's shape, and a new
--      generation not above the expected one, by name.
--   J. connection_history returns the connection's audit rows, newest first,
--      and never credential_enc: neither its key nor its value.
--   K. Another organization's connection is refused by every function, and the
--      Slack alert row (not ops_key) by remove and reconnect.
--   L. Only service_role may call the four; each is SECURITY DEFINER with its
--      search_path set; the two read only ones are STABLE.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS cpb_cases (name text PRIMARY KEY);
DELETE FROM cpb_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111c2338aa', 'CPB Org', 'cpb-org-2338') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111c2338bb', 'CPB Org B', 'cpb-org-2338b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222c2338aa', '11111111-1111-1111-1111-11111c2338aa', 'cpb2338@example.test', 'CPB User')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.workflows WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb');
  DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb');
  DELETE FROM public.connection_tombstones WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb');
END
$do$;

-- A planted envelope of the seal's shape, told apart by its iv.
CREATE OR REPLACE FUNCTION pg_temp.cpb_envelope(p_iv text)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object('v', 1, 'kid', 'ops-test-1',
    'wrapped_key', encode(convert_to('planted-wrapped', 'UTF8'), 'base64'), 'iv', p_iv,
    'ct', encode(convert_to('planted-ct-2338', 'UTF8'), 'base64'))
$fn$;

-- The rows every case starts from. Org A: an ops Salesforce connection at
-- generation 3 (a1) used by three workflows, one of them soft deleted; an ops
-- OpenAI connection (a2) no workflow uses; an ops Snowflake connection (a4)
-- used only by a soft deleted workflow; the Slack alert row (a3). Org B: an ops
-- Salesforce connection (b1), and a workflow of org B that names org A's a1.
CREATE OR REPLACE FUNCTION pg_temp.cpb_rows()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.service_connections
    (id, organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, credential_generation, target, acts_as, updated_by)
  VALUES
    ('33333333-3333-3333-3333-33333c2338a1', '11111111-1111-1111-1111-11111c2338aa', 'salesforce', 'Pennie Salesforce', 'oauth_client_credentials', NULL,
     NULL, pg_temp.cpb_envelope('aXYtYTEtZ2VuMw')::text, 'ops_key', 3, '{"instance_url":"https://example.my.salesforce.com","client_id":"planted-client"}',
     'integration@example.test', '22222222-2222-2222-2222-22222c2338aa'),
    ('33333333-3333-3333-3333-33333c2338a2', '11111111-1111-1111-1111-11111c2338aa', 'openai', 'Ops OpenAI', 'api_key', NULL,
     NULL, pg_temp.cpb_envelope('aXYtYTI')::text, 'ops_key', 1, NULL, NULL, '22222222-2222-2222-2222-22222c2338aa'),
    ('33333333-3333-3333-3333-33333c2338a4', '11111111-1111-1111-1111-11111c2338aa', 'snowflake', 'Ops Snowflake', 'key_pair', NULL,
     NULL, pg_temp.cpb_envelope('aXYtYTQ')::text, 'ops_key', 2, NULL, NULL, '22222222-2222-2222-2222-22222c2338aa'),
    ('33333333-3333-3333-3333-33333c2338a3', '11111111-1111-1111-1111-11111c2338aa', 'slack', 'slack', 'oauth', NULL,
     '{"bot_token":"planted-bot-token-2338"}', 'planted-ciphertext-2338', 'bidding_ring', 1, NULL, NULL, '22222222-2222-2222-2222-22222c2338aa'),
    ('33333333-3333-3333-3333-33333c2338b1', '11111111-1111-1111-1111-11111c2338bb', 'salesforce', 'B Salesforce', 'oauth_client_credentials', NULL,
     NULL, pg_temp.cpb_envelope('aXYtYjE')::text, 'ops_key', 1, NULL, NULL, NULL);

  INSERT INTO public.workflows (id, organization_id, name, definition, deleted_at)
  VALUES
    -- The id at the top of a node's config.
    ('44444444-4444-4444-4444-44444c2338a1', '11111111-1111-1111-1111-11111c2338aa', 'Achieve report import',
     '{"nodes":[{"id":"n1","namespace":"sf","type":"code","config":{"connection_id":"33333333-3333-3333-3333-33333c2338a1"}}],"edges":[]}', NULL),
    -- Deep in an array of objects, in upper case, under another key.
    ('44444444-4444-4444-4444-44444c2338a2', '11111111-1111-1111-1111-11111c2338aa', 'Daily Salesforce cleanup',
     '{"nodes":[{"id":"n1","namespace":"x","type":"code","config":{"steps":[{"auth":{"salesforce_connection":"33333333-3333-3333-3333-33333C2338A1"}}]}}],"edges":[]}', NULL),
    -- Soft deleted, still referencing it.
    ('44444444-4444-4444-4444-44444c2338a3', '11111111-1111-1111-1111-11111c2338aa', 'Old Salesforce import',
     '{"nodes":[{"id":"n1","namespace":"sf","type":"code","config":{"connection_id":"33333333-3333-3333-3333-33333c2338a1"}}],"edges":[]}', now() - interval '3 days'),
    -- Names the connection by its name only, and another connection's id: not a reference to a1.
    ('44444444-4444-4444-4444-44444c2338a4', '11111111-1111-1111-1111-11111c2338aa', 'By name only',
     '{"nodes":[{"id":"n1","namespace":"x","type":"code","config":{"connection":"Pennie Salesforce","connection_id":"33333333-3333-3333-3333-333333333399"}}],"edges":[]}', NULL),
    -- The only workflow using a4, and it is soft deleted.
    ('44444444-4444-4444-4444-44444c2338a5', '11111111-1111-1111-1111-11111c2338aa', 'Retired Snowflake export',
     '{"nodes":[{"id":"n1","namespace":"x","type":"code","config":{"connection_id":"33333333-3333-3333-3333-33333c2338a4"}}],"edges":[]}', now() - interval '1 day'),
    -- Org B's workflow naming org A's connection.
    ('44444444-4444-4444-4444-44444c2338b1', '11111111-1111-1111-1111-11111c2338bb', 'B workflow',
     '{"nodes":[{"id":"n1","namespace":"x","type":"code","config":{"connection_id":"33333333-3333-3333-3333-33333c2338a1"}}],"edges":[]}', NULL);
END
$fn$;

-- Runs a statement and answers the error message it raised, or null when it raised none.
CREATE OR REPLACE FUNCTION pg_temp.cpb_error_of(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $fn$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$fn$;

-- ── A. The service_type CHECK takes the catalogue's key shape ────────────────
DO $do$
DECLARE
  err text;
BEGIN
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111c2338aa', 'google_drive', 'A drive', 'service_account', 'planted', 'ops_key'),
           ('11111111-1111-1111-1111-11111c2338aa', 'anthropic', 'A key', 'api_key', 'planted', 'ops_key');
    err := pg_temp.cpb_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
      VALUES ('11111111-1111-1111-1111-11111c2338aa', 'Open-AI', 'Bad key', 'api_key', 'planted', 'ops_key')$q$);
    IF err IS NULL OR err NOT LIKE '%service_connections_service_type_check%' THEN
      RAISE EXCEPTION 'a service key not of the catalogue''s shape was not refused by the service_type CHECK: %', coalesce(err, 'no error');
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('the service_type CHECK takes every key of the catalogue''s shape and refuses any other');
END
$do$;

-- ── B. An ops only service must be an ops_key row ────────────────────────────
DO $do$
DECLARE
  err text;
  svc text;
BEGIN
  BEGIN
    err := pg_temp.cpb_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
      VALUES ('11111111-1111-1111-1111-11111c2338aa', 'openai', 'Money OpenAI', 'api_key', 'planted', 'bidding_ring')$q$);
    IF err IS NULL OR err NOT LIKE '%service_connections_ops_only_services%' THEN
      RAISE EXCEPTION 'a bidding_ring row naming an ops only service was not refused: %', coalesce(err, 'no error');
    END IF;
    -- Unsealed (sealed_for null) is not ops_key either: a CHECK reading null as a pass would let it in.
    err := pg_temp.cpb_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key)
      VALUES ('11111111-1111-1111-1111-11111c2338aa', 'openai', 'Legacy OpenAI', 'api_key', 'OPENAI_KEY')$q$);
    IF err IS NULL OR err NOT LIKE '%service_connections_ops_only_services%' THEN
      RAISE EXCEPTION 'an unsealed row naming an ops only service was not refused: %', coalesce(err, 'no error');
    END IF;
    -- Control: the money lane's own four still take a non ops row.
    FOREACH svc IN ARRAY ARRAY['salesforce', 'supabase', 'snowflake'] LOOP
      INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key)
      VALUES ('11111111-1111-1111-1111-11111c2338aa', svc, 'legacy ' || svc, 'api_key', 'LEGACY_SECRET');
    END LOOP;
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, config, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111c2338aa', 'slack', 'slack', 'oauth', '{}', 'planted', 'bidding_ring');
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('an ops only service must be an ops_key row, and the four money lane services still take a non ops row');
END
$do$;

-- ── C. acts_as: nullable, and recorded by the audit ──────────────────────────
DO $do$
DECLARE
  a record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'service_connections' AND column_name = 'acts_as'
                   AND data_type = 'text' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'service_connections.acts_as is not a nullable text column';
  END IF;
  BEGIN
    PERFORM pg_temp.cpb_rows();
    SELECT * INTO a FROM public.audit_log
    WHERE entity_id = '33333333-3333-3333-3333-33333c2338a1' AND action = 'created';
    IF NOT FOUND OR a.changes -> 'acts_as' ->> 'new' IS DISTINCT FROM 'integration@example.test' THEN
      RAISE EXCEPTION 'the audit of a new connection did not record acts_as: %', a.changes;
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('acts_as is a nullable text column the audit records');
END
$do$;

-- ── D. connection_references ─────────────────────────────────────────────────
DO $do$
DECLARE
  got text;
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    SELECT string_agg(r.name || ':' || r.deleted::text || ':' || r.workflow_id::text, ' | ' ORDER BY r.deleted, r.name) INTO got
    FROM public.connection_references('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1') r;
    IF got IS DISTINCT FROM
       'Achieve report import:false:44444444-4444-4444-4444-44444c2338a1 | Daily Salesforce cleanup:false:44444444-4444-4444-4444-44444c2338a2 | Old Salesforce import:true:44444444-4444-4444-4444-44444c2338a3' THEN
      RAISE EXCEPTION 'connection_references named %, not the two live workflows and the soft deleted one', got;
    END IF;
    -- Its own order: live workflows first, by name, then the deleted ones.
    SELECT string_agg(r.name, ' | ') INTO got
    FROM public.connection_references('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1') r;
    IF got IS DISTINCT FROM 'Achieve report import | Daily Salesforce cleanup | Old Salesforce import' THEN
      RAISE EXCEPTION 'connection_references came back in the order %', got;
    END IF;
    SELECT count(*) INTO n FROM public.connection_references('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a2');
    IF n <> 0 THEN RAISE EXCEPTION 'connection_references found % workflows using a connection no workflow names', n; END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('connection_references finds the id at any depth and key, soft deleted workflows marked, never by name nor another organization''s');
END
$do$;

-- ── E. Remove is refused while a workflow uses the connection ────────────────
DO $do$
DECLARE
  r record;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111c2338aa';
    SELECT * INTO r FROM public.remove_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1', '22222222-2222-2222-2222-22222c2338aa');
    IF r.outcome IS DISTINCT FROM 'connection_in_use' THEN
      RAISE EXCEPTION 'removing a used connection answered %, not connection_in_use', r.outcome;
    END IF;
    IF r.removed_generation IS NOT NULL THEN
      RAISE EXCEPTION 'a refused removal named a removed generation %', r.removed_generation;
    END IF;
    IF r.workflows IS DISTINCT FROM jsonb_build_array(
         jsonb_build_object('id', '44444444-4444-4444-4444-44444c2338a1', 'name', 'Achieve report import', 'deleted', false),
         jsonb_build_object('id', '44444444-4444-4444-4444-44444c2338a2', 'name', 'Daily Salesforce cleanup', 'deleted', false),
         jsonb_build_object('id', '44444444-4444-4444-4444-44444c2338a3', 'name', 'Old Salesforce import', 'deleted', true)) THEN
      RAISE EXCEPTION 'the refusal named %, not every workflow using it with the deleted one marked', r.workflows;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a1') THEN
      RAISE EXCEPTION 'a refused removal deleted the row';
    END IF;
    IF EXISTS (SELECT 1 FROM public.connection_tombstones WHERE connection_id = '33333333-3333-3333-3333-33333c2338a1') THEN
      RAISE EXCEPTION 'a refused removal wrote a tombstone';
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111c2338aa') THEN
      RAISE EXCEPTION 'a refused removal wrote an audit row';
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('remove is refused while a workflow uses the connection, naming each, and writes nothing');
END
$do$;

-- ── F. A soft deleted workflow alone blocks the removal ──────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    SELECT * INTO r FROM public.remove_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a4', '22222222-2222-2222-2222-22222c2338aa');
    IF r.outcome IS DISTINCT FROM 'connection_in_use'
       OR r.workflows IS DISTINCT FROM jsonb_build_array(
         jsonb_build_object('id', '44444444-4444-4444-4444-44444c2338a5', 'name', 'Retired Snowflake export', 'deleted', true)) THEN
      RAISE EXCEPTION 'a connection used only by a soft deleted workflow answered % naming %', r.outcome, r.workflows;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a4') THEN
      RAISE EXCEPTION 'the removal went ahead past a soft deleted workflow';
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('a soft deleted workflow alone blocks the removal and is named as deleted');
END
$do$;

-- ── G. A removal: one tombstone, one row deleted, audited ────────────────────
DO $do$
DECLARE
  r record;
  a record;
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    -- Generation 5, so the tombstone is seen to take the row's own.
    UPDATE public.service_connections SET credential_generation = 5 WHERE id = '33333333-3333-3333-3333-33333c2338a2';
    DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111c2338aa';
    SELECT count(*) INTO n FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb');
    SELECT * INTO r FROM public.remove_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a2', '22222222-2222-2222-2222-22222c2338aa');
    IF r.outcome IS DISTINCT FROM 'removed' OR r.removed_generation IS DISTINCT FROM 5 OR r.workflows IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'removing an unused connection answered %, generation %, workflows %', r.outcome, r.removed_generation, r.workflows;
    END IF;
    IF EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a2') THEN
      RAISE EXCEPTION 'the removed connection''s row is still there';
    END IF;
    IF (SELECT count(*) FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb')) <> n - 1 THEN
      RAISE EXCEPTION 'the removal deleted more than one row';
    END IF;
    IF (SELECT count(*) FROM public.connection_tombstones WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb')) <> 1 THEN
      RAISE EXCEPTION 'the removal did not write exactly one tombstone';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.connection_tombstones
                   WHERE connection_id = '33333333-3333-3333-3333-33333c2338a2' AND organization_id = '11111111-1111-1111-1111-11111c2338aa' AND generation = 5) THEN
      RAISE EXCEPTION 'the tombstone does not name the connection, its organization and its generation 5';
    END IF;
    SELECT * INTO a FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333c2338a2' AND action = 'deleted';
    IF NOT FOUND OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222c2338aa'::uuid THEN
      RAISE EXCEPTION 'the removal was not audited under its actor';
    END IF;
    IF coalesce(current_setting('bidspoke.actor_id', true), '') <> '' THEN
      RAISE EXCEPTION 'the actor setting outlived the removal';
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('a removal writes exactly one tombstone at the row''s generation and deletes exactly one row, audited');
END
$do$;

-- ── H. Reconnect: compare and set on the generation ──────────────────────────
DO $do$
DECLARE
  r record;
  before_row record;
  after_row record;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111c2338aa';
    SELECT * INTO before_row FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a1';
    -- Stale: the row is at 3, the caller last knew 2.
    SELECT * INTO r FROM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1',
      2, 3, pg_temp.cpb_envelope('aXYtc3RhbGU'), 'someone@example.test', '22222222-2222-2222-2222-22222c2338aa', 'cpb2338@example.test');
    IF r.outcome IS DISTINCT FROM 'stale_generation' OR r.current_generation IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'a stale reconnect answered % at %, not stale_generation at 3', r.outcome, r.current_generation;
    END IF;
    SELECT * INTO after_row FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a1';
    IF to_jsonb(after_row) IS DISTINCT FROM to_jsonb(before_row) THEN
      RAISE EXCEPTION 'a stale reconnect changed the row';
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111c2338aa') THEN
      RAISE EXCEPTION 'a stale reconnect wrote an audit row';
    END IF;

    -- Current: the row is at 3.
    SELECT * INTO r FROM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1',
      3, 4, pg_temp.cpb_envelope('aXYtZ2VuNA'), 'new-integration@example.test', '22222222-2222-2222-2222-22222c2338aa', 'cpb2338@example.test');
    IF r.outcome IS DISTINCT FROM 'reconnected' OR r.current_generation IS DISTINCT FROM 4 THEN
      RAISE EXCEPTION 'a current reconnect answered % at %', r.outcome, r.current_generation;
    END IF;
    SELECT * INTO after_row FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a1';
    IF after_row.credential_generation <> 4 OR after_row.credential_enc::jsonb ->> 'iv' <> 'aXYtZ2VuNA'
       OR after_row.acts_as IS DISTINCT FROM 'new-integration@example.test'
       OR after_row.updated_by IS DISTINCT FROM '22222222-2222-2222-2222-22222c2338aa'::uuid
       OR after_row.updated_by_email IS DISTINCT FROM 'cpb2338@example.test' THEN
      RAISE EXCEPTION 'the reconnect did not write the envelope, generation 4, acts_as and the actor';
    END IF;
    IF after_row.name <> before_row.name OR after_row.target IS DISTINCT FROM before_row.target OR after_row.sealed_for <> 'ops_key'
       OR after_row.service_type <> before_row.service_type THEN
      RAISE EXCEPTION 'the reconnect moved a column it does not own';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333c2338a1' AND action = 'updated'
                   AND changed_by = '22222222-2222-2222-2222-22222c2338aa') THEN
      RAISE EXCEPTION 'the reconnect was not audited under its actor';
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('a stale reconnect writes nothing and answers stale_generation; a current one writes the new login');
END
$do$;

-- ── I. Reconnect refuses a bad envelope and a generation not above ───────────
DO $do$
DECLARE
  err text;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    err := pg_temp.cpb_error_of($q$SELECT * FROM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1',
      3, 4, '{"v":1,"kid":"ops-test-1","iv":"aXY","ct":"Y3Q"}', NULL, '22222222-2222-2222-2222-22222c2338aa', NULL)$q$);
    IF err IS NULL OR err NOT LIKE 'reconnect_refused:%shape%' THEN
      RAISE EXCEPTION 'an envelope missing wrapped_key was not refused by name: %', coalesce(err, 'no error');
    END IF;
    err := pg_temp.cpb_error_of($q$SELECT * FROM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1',
      3, 3, pg_temp.cpb_envelope('aXYtc2FtZQ'), NULL, '22222222-2222-2222-2222-22222c2338aa', NULL)$q$);
    IF err IS NULL OR err NOT LIKE 'reconnect_refused:%above%' THEN
      RAISE EXCEPTION 'a new generation equal to the expected one was not refused by name: %', coalesce(err, 'no error');
    END IF;
    err := pg_temp.cpb_error_of($q$SELECT * FROM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1',
      3, 4, pg_temp.cpb_envelope('aXYtbm9hY3Rvcg'), NULL, NULL, NULL)$q$);
    IF err IS NULL OR err NOT LIKE 'reconnect_refused:%actor%' THEN
      RAISE EXCEPTION 'a reconnect with no actor was not refused by name: %', coalesce(err, 'no error');
    END IF;
    IF (SELECT credential_generation FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a1') <> 3 THEN
      RAISE EXCEPTION 'a refused reconnect moved the generation';
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('reconnect refuses by name an envelope not of the seal''s shape, a generation not above, and no actor');
END
$do$;

-- ── J. History: newest first, never credential_enc ───────────────────────────
DO $do$
DECLARE
  h record;
  actions text;
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    -- Every write of one transaction shares now(), so the insert's row is moved a
    -- minute back to give the three rows an order to be returned in.
    UPDATE public.audit_log SET changed_at = now() - interval '1 minute'
    WHERE entity_id = '33333333-3333-3333-3333-33333c2338a1' AND action = 'created';
    -- A hand written row that carries a ciphertext value under credential_enc
    -- and a token in config: history must drop both.
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes, changed_at)
    VALUES ('11111111-1111-1111-1111-11111c2338aa', 'service_connection', '33333333-3333-3333-3333-33333c2338a1', 'updated', NULL,
            '{"credential_enc":"planted-ct-in-audit-2338","bot_token":{"changed":true},"config":{"new":{"bot_token":"planted-bot-2338","workspace_name":"W"}}}',
            now() + interval '1 minute');
    PERFORM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1',
      3, 4, pg_temp.cpb_envelope('aXYtaGlzdG9yeQ'), 'integration@example.test', '22222222-2222-2222-2222-22222c2338aa', 'cpb2338@example.test');
    -- Another connection's row, which must not appear.
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changes)
    VALUES ('11111111-1111-1111-1111-11111c2338aa', 'service_connection', '33333333-3333-3333-3333-33333c2338a2', 'updated', '{"name":{"old":"x","new":"y"}}');

    SELECT string_agg(x.action, ',' ORDER BY x.ord) INTO actions
    FROM (SELECT hh.action, row_number() OVER () AS ord
          FROM public.connection_history('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1', 50) hh) x;
    -- The hand written row is a minute ahead, then the reconnect, then the insert.
    IF actions IS DISTINCT FROM 'updated,updated,created' THEN
      RAISE EXCEPTION 'connection_history returned %, not its three rows newest first', actions;
    END IF;
    FOR h IN SELECT * FROM public.connection_history('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1', 50) LOOP
      IF to_jsonb(h)::text LIKE '%credential_enc%' OR to_jsonb(h)::text LIKE '%planted-ct%' OR to_jsonb(h)::text LIKE '%bot_token%'
         OR to_jsonb(h)::text LIKE '%planted-bot%' OR to_jsonb(h)::text LIKE '%' || encode(convert_to('planted-ct-2338', 'UTF8'), 'base64') || '%' THEN
        RAISE EXCEPTION 'connection_history returned a credential: %', to_jsonb(h);
      END IF;
    END LOOP;
    SELECT count(*) INTO n FROM public.connection_history('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1', 50) hh
    WHERE hh.credential_changed;
    IF n <> 3 THEN
      RAISE EXCEPTION 'connection_history marked % rows as changing the credential, not the insert, the reconnect and the hand written one', n;
    END IF;
    SELECT * INTO h FROM public.connection_history('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1', 50) hh WHERE hh.action = 'created';
    IF h.changed_by_name IS DISTINCT FROM 'CPB User' THEN
      RAISE EXCEPTION 'connection_history did not name who made the change: %', h.changed_by_name;
    END IF;
    SELECT count(*) INTO n FROM public.connection_history('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a1', 1);
    IF n <> 1 THEN RAISE EXCEPTION 'connection_history with limit 1 returned % rows', n; END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('connection_history returns the connection''s audit rows newest first and never credential_enc');
END
$do$;

-- ── K. Another organization's connection, and the alert row ──────────────────
DO $do$
DECLARE
  err text;
  stmt text;
BEGIN
  BEGIN
    PERFORM pg_temp.cpb_rows();
    -- Org B's caller names org A's connections; a1 is even named by org B's own workflow.
    FOREACH stmt IN ARRAY ARRAY[
      $q$SELECT * FROM public.connection_references('11111111-1111-1111-1111-11111c2338bb', '33333333-3333-3333-3333-33333c2338a1')$q$,
      $q$SELECT * FROM public.remove_ops_connection('11111111-1111-1111-1111-11111c2338bb', '33333333-3333-3333-3333-33333c2338a2', '22222222-2222-2222-2222-22222c2338aa')$q$,
      $q$SELECT * FROM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338bb', '33333333-3333-3333-3333-33333c2338a1', 3, 4, pg_temp.cpb_envelope('aXYtb3RoZXI'), NULL, '22222222-2222-2222-2222-22222c2338aa', NULL)$q$,
      $q$SELECT * FROM public.connection_history('11111111-1111-1111-1111-11111c2338bb', '33333333-3333-3333-3333-33333c2338a1', 50)$q$
    ] LOOP
      err := pg_temp.cpb_error_of(stmt);
      IF err IS DISTINCT FROM 'connection_not_found' THEN
        RAISE EXCEPTION 'another organization''s connection was not refused as connection_not_found (%): %', coalesce(err, 'no error'), stmt;
      END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a2')
       OR (SELECT credential_generation FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a1') <> 3
       OR EXISTS (SELECT 1 FROM public.connection_tombstones WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb')) THEN
      RAISE EXCEPTION 'a refused call for another organization wrote something';
    END IF;
    -- The Slack alert row is the organization's, but not an ops connection.
    FOREACH stmt IN ARRAY ARRAY[
      $q$SELECT * FROM public.remove_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a3', '22222222-2222-2222-2222-22222c2338aa')$q$,
      $q$SELECT * FROM public.reconnect_ops_connection('11111111-1111-1111-1111-11111c2338aa', '33333333-3333-3333-3333-33333c2338a3', 1, 2, pg_temp.cpb_envelope('aXYtYWxlcnQ'), NULL, '22222222-2222-2222-2222-22222c2338aa', NULL)$q$
    ] LOOP
      err := pg_temp.cpb_error_of(stmt);
      IF err IS DISTINCT FROM 'connection_not_ops_key' THEN
        RAISE EXCEPTION 'the alert row was not refused as connection_not_ops_key (%): %', coalesce(err, 'no error'), stmt;
      END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333c2338a3' AND credential_enc = 'planted-ciphertext-2338') THEN
      RAISE EXCEPTION 'a refused call on the alert row changed it';
    END IF;
    RAISE EXCEPTION 'cpb_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cpb_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO cpb_cases VALUES ('another organization''s connection is refused by every function, and the alert row by remove and reconnect');
END
$do$;

-- ── L. Grants, SECURITY DEFINER, search_path and volatility ──────────────────
DO $do$
DECLARE
  fn text;
  r text;
  p record;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.connection_references(uuid, uuid)',
    'public.remove_ops_connection(uuid, uuid, uuid)',
    'public.reconnect_ops_connection(uuid, uuid, bigint, bigint, jsonb, text, uuid, text)',
    'public.connection_history(uuid, uuid, integer)'
  ] LOOP
    IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION '% does not exist', fn; END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, fn, 'EXECUTE') THEN RAISE EXCEPTION '% may call %', r, fn; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role may not call %', fn; END IF;
    SELECT prosecdef, proconfig, provolatile INTO p FROM pg_proc WHERE oid = to_regprocedure(fn);
    IF NOT p.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% has no search_path of its own', fn;
    END IF;
    IF fn LIKE 'public.connection_%' AND p.provolatile <> 's' THEN RAISE EXCEPTION '% is read only and not STABLE', fn; END IF;
    IF fn NOT LIKE 'public.connection_%' AND p.provolatile <> 'v' THEN RAISE EXCEPTION '% writes and is not VOLATILE', fn; END IF;
  END LOOP;
  INSERT INTO cpb_cases VALUES ('only service_role may call the four, each SECURITY DEFINER with its search_path, the read only two STABLE');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb'))
     OR EXISTS (SELECT 1 FROM public.workflows WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb')) THEN
    RAISE EXCEPTION 'a case''s rows were not rolled back';
  END IF;
END
$do$;
DELETE FROM public.connection_tombstones WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb');
DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111c2338aa', '11111111-1111-1111-1111-11111c2338bb');

DO $do$
DECLARE
  n int := (SELECT count(*) FROM cpb_cases);
BEGIN
  IF n <> 12 THEN RAISE EXCEPTION 'expected 12 cases, % ran', n; END IF;
  RAISE NOTICE 'connections_page_bidding.test.sql: % cases passed', n;
END
$do$;
