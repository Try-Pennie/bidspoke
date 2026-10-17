-- The store level audit of service_connections (#2331, phase 1 of #1689).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The token and the
-- ciphertext below are planted placeholders, not credentials.
--
-- WHAT IT PROVES. One audit_log row per change, whoever made it, naming the
-- actor the way partner_configs_audit does (#1409), so the routes write none of
-- their own and a change is never recorded twice (F119):
--   A. An app insert names its user; the token and ciphertext are never copied,
--      only whether each is present.
--   B. A backfill shaped UPDATE (ciphertext sealed, updated_by set) makes
--      exactly one row naming the caller and holding no token value.
--   C. A hand run UPDATE is labelled direct_sql with no actor.
--   D. An upsert landing on an existing row names its user.
--   E. delete_service_connection deletes and names its actor; a hand run delete
--      is labelled direct_sql.
--   F. A change to nothing audited writes no row.
--   G. The planted token and ciphertext appear in no audit row.
--   H. With audit_log locked by another session, a save fails by name
--      (connection_audit_failed) within the bound rather than hanging, and the
--      write does not land unaudited.

CREATE TEMP TABLE IF NOT EXISTS sca_cases (name text PRIMARY KEY);
DELETE FROM sca_cases;

\if :{?self_host}
\else
  \echo 'service_connections_audit.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('sca_test.self_host', :'self_host', false) AS self_host_set \gset

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112331a', 'SCA Org', 'sca-org-2331') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222222331a', '11111111-1111-1111-1111-11111112331a', 'sca2331@example.test', 'SCA User')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
END
$do$;

-- ── A. An app insert ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  a record;
  n int;
BEGIN
  INSERT INTO public.service_connections (organization_id, service_type, auth_type, cf_secret_key, config, updated_by, updated_by_email)
  VALUES ('11111111-1111-1111-1111-11111112331a', 'slack', 'oauth', '',
          '{"bot_token":"planted-bot-token-2331","default_channel":"#alerts","workspace_name":"Test"}',
          '22222222-2222-2222-2222-22222222331a', 'sca2331@example.test');
  SELECT count(*) INTO n FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF n <> 1 THEN RAISE EXCEPTION 'an insert wrote % audit rows', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF a.entity_type <> 'service_connection' OR a.action <> 'created' THEN RAISE EXCEPTION 'insert audited as % %', a.entity_type, a.action; END IF;
  IF a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222331a' THEN RAISE EXCEPTION 'the insert did not name its user: %', a.changed_by; END IF;
  IF a.changes ? '_source' THEN RAISE EXCEPTION 'an app insert was labelled %', a.changes ->> '_source'; END IF;
  IF a.changes -> 'config' -> 'new' ->> 'default_channel' <> '#alerts' THEN RAISE EXCEPTION 'the new config was not recorded: %', a.changes; END IF;
  IF a.changes -> 'config' -> 'new' ? 'bot_token' THEN RAISE EXCEPTION 'the token key was copied into the audit row'; END IF;
  IF (a.changes -> 'bot_token' ->> 'new_present')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'the token arriving was not recorded as present: %', a.changes; END IF;
  INSERT INTO sca_cases VALUES ('an app insert names its user and records the token only as present');
END
$do$;

-- ── B. The backfill's UPDATE ─────────────────────────────────────────────────
DO $do$
DECLARE
  a record;
  n int;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  UPDATE public.service_connections
  SET credential_enc = 'planted-ciphertext-2331', sealed_for = 'bidding_ring', updated_by = '22222222-2222-2222-2222-22222222331a'
  WHERE organization_id = '11111111-1111-1111-1111-11111112331a' AND service_type = 'slack' AND credential_enc IS NULL;
  SELECT count(*) INTO n FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF n <> 1 THEN RAISE EXCEPTION 'the backfill UPDATE wrote % audit rows', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF a.action <> 'updated' OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222331a' THEN
    RAISE EXCEPTION 'the backfill was audited as % by %', a.action, a.changed_by;
  END IF;
  IF (a.changes -> 'credential_enc' ->> 'changed')::boolean IS DISTINCT FROM true
     OR (a.changes -> 'credential_enc' ->> 'new_present')::boolean IS DISTINCT FROM true
     OR (a.changes -> 'credential_enc' ->> 'old_present')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the seal was not recorded as a ciphertext arriving: %', a.changes;
  END IF;
  IF a.changes -> 'sealed_for' ->> 'new' <> 'bidding_ring' THEN RAISE EXCEPTION 'sealed_for was not recorded: %', a.changes; END IF;
  IF a.changes ? 'bot_token' OR a.changes ? 'config' THEN RAISE EXCEPTION 'an unchanged config or token was recorded as changed: %', a.changes; END IF;
  -- A second run of the same backfill matches nothing and writes nothing.
  UPDATE public.service_connections
  SET credential_enc = 'planted-ciphertext-2331-again', sealed_for = 'bidding_ring', updated_by = '22222222-2222-2222-2222-22222222331a'
  WHERE organization_id = '11111111-1111-1111-1111-11111112331a' AND service_type = 'slack' AND credential_enc IS NULL;
  IF (SELECT count(*) FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a') <> 1 THEN
    RAISE EXCEPTION 'a second backfill run was audited';
  END IF;
  INSERT INTO sca_cases VALUES ('the backfill UPDATE makes exactly one row naming its caller and no token value');
END
$do$;

-- ── C. A hand run UPDATE ─────────────────────────────────────────────────────
DO $do$
DECLARE
  a record;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  UPDATE public.service_connections SET config = config || '{"volume_alerts_enabled": false}'
  WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF a IS NULL THEN RAISE EXCEPTION 'a hand run UPDATE was not audited'; END IF;
  IF a.changed_by IS NOT NULL OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' THEN
    RAISE EXCEPTION 'a hand run UPDATE was attributed to % (%)', a.changed_by, a.changes ->> '_source';
  END IF;
  IF a.changes -> 'config' -> 'old' ? 'bot_token' OR a.changes -> 'config' -> 'new' ? 'bot_token' THEN
    RAISE EXCEPTION 'the token key was copied into the audit row';
  END IF;
  IF a.changes ? 'bot_token' THEN RAISE EXCEPTION 'an unchanged token was recorded as changed'; END IF;
  INSERT INTO sca_cases VALUES ('a hand run UPDATE is labelled direct_sql and never inherits the last app editor');
END
$do$;

-- ── D. An upsert landing on the existing row ─────────────────────────────────
DO $do$
DECLARE
  a record;
  n int;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  -- The shape PostgREST sends for the integrations save.
  INSERT INTO public.service_connections (organization_id, service_type, auth_type, cf_secret_key, config, credential_enc, sealed_for, updated_by, updated_by_email)
  VALUES ('11111111-1111-1111-1111-11111112331a', 'slack', 'oauth', '',
          '{"bot_token":"planted-bot-token-2331-b","default_channel":"#alerts"}', 'planted-ciphertext-2331-b', 'bidding_ring',
          '22222222-2222-2222-2222-22222222331a', 'sca2331@example.test')
  ON CONFLICT (organization_id, service_type) DO UPDATE SET
    auth_type = EXCLUDED.auth_type, cf_secret_key = EXCLUDED.cf_secret_key, config = EXCLUDED.config,
    credential_enc = EXCLUDED.credential_enc, sealed_for = EXCLUDED.sealed_for,
    updated_by = EXCLUDED.updated_by, updated_by_email = EXCLUDED.updated_by_email;
  SELECT count(*) INTO n FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF n <> 1 THEN RAISE EXCEPTION 'an upsert wrote % audit rows', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF a.action <> 'updated' OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222331a' THEN
    RAISE EXCEPTION 'the upsert was audited as % by %', a.action, a.changed_by;
  END IF;
  IF (a.changes -> 'bot_token' ->> 'changed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'a new token was not recorded as a change: %', a.changes; END IF;
  INSERT INTO sca_cases VALUES ('an upsert onto the existing row names its user');
END
$do$;

-- ── E. Deletes ───────────────────────────────────────────────────────────────
DO $do$
DECLARE
  a record;
  ids uuid[];
  row_id uuid;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  SELECT id INTO row_id FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  SELECT array_agg(d.id) INTO ids FROM public.delete_service_connection('11111111-1111-1111-1111-11111112331a', 'slack', '22222222-2222-2222-2222-22222222331a') d;
  IF ids IS DISTINCT FROM ARRAY[row_id] THEN RAISE EXCEPTION 'the delete function returned % for row %', ids, row_id; END IF;
  IF EXISTS (SELECT 1 FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112331a') THEN
    RAISE EXCEPTION 'the delete function left the row';
  END IF;
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF a.action <> 'deleted' OR a.entity_id <> row_id OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222331a' THEN
    RAISE EXCEPTION 'the delete was audited as % of % by %', a.action, a.entity_id, a.changed_by;
  END IF;
  IF (SELECT count(*) FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a') <> 1 THEN
    RAISE EXCEPTION 'a delete wrote more than one audit row';
  END IF;
  -- The actor belongs to that call only: a later hand run delete names nobody.
  INSERT INTO public.service_connections (organization_id, service_type, auth_type, cf_secret_key, config)
  VALUES ('11111111-1111-1111-1111-11111112331a', 'slack', 'oauth', '', '{"bot_token":"planted-bot-token-2331-c","default_channel":"#alerts"}');
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF a.action <> 'deleted' OR a.changed_by IS NOT NULL OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' THEN
    RAISE EXCEPTION 'a hand run delete was audited as % by % (%)', a.action, a.changed_by, a.changes ->> '_source';
  END IF;
  -- Deleting nothing returns nothing and audits nothing.
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF EXISTS (SELECT 1 FROM public.delete_service_connection('11111111-1111-1111-1111-11111112331a', 'slack', '22222222-2222-2222-2222-22222222331a')) THEN
    RAISE EXCEPTION 'deleting a missing connection returned a row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a') THEN
    RAISE EXCEPTION 'deleting a missing connection was audited';
  END IF;
  INSERT INTO sca_cases VALUES ('the delete function names its actor and a hand run delete is labelled direct_sql');
END
$do$;

-- ── F. Nothing audited changed ───────────────────────────────────────────────
DO $do$
BEGIN
  INSERT INTO public.service_connections (organization_id, service_type, auth_type, cf_secret_key, config, updated_by)
  VALUES ('11111111-1111-1111-1111-11111112331a', 'slack', 'oauth', '', '{"bot_token":"planted-bot-token-2331-d","default_channel":"#alerts"}', '22222222-2222-2222-2222-22222222331a');
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  UPDATE public.service_connections SET updated_by = '22222222-2222-2222-2222-22222222331a', updated_by_email = 'sca2331@example.test'
  WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a') THEN
    RAISE EXCEPTION 'a change to bookkeeping only was audited';
  END IF;
  -- The captured actor of that statement must not leak into a later hand run one.
  UPDATE public.service_connections SET config = config || '{"matrix_alerts_enabled": false}'
  WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF (SELECT changed_by FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a') IS NOT NULL THEN
    RAISE EXCEPTION 'a hand run UPDATE inherited the actor of the statement before it';
  END IF;
  INSERT INTO sca_cases VALUES ('a change to nothing audited writes no row, and its actor does not leak');
END
$do$;

-- ── F2. One statement updating several rows names its actor on every row ─────
-- Every BEFORE row trigger of a statement runs before any AFTER row trigger, so
-- an actor captured per row and cleared by the first audit row would leave the
-- later rows of the same statement labelled direct_sql (lessons review of #2331).
DO $do$
DECLARE
  n_named int;
  n_all int;
BEGIN
  INSERT INTO public.service_connections (organization_id, service_type, auth_type, cf_secret_key, config, updated_by)
  VALUES ('11111111-1111-1111-1111-11111112331a', 'salesforce', 'oauth', 'CONN_TEST_2331', '{}', '22222222-2222-2222-2222-22222222331a');
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  UPDATE public.service_connections SET schema_synced_at = now(), updated_by = '22222222-2222-2222-2222-22222222331a'
  WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  SELECT count(*), count(*) FILTER (WHERE changed_by = '22222222-2222-2222-2222-22222222331a' AND NOT changes ? '_source')
  INTO n_all, n_named FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF n_all <> 2 OR n_named <> 2 THEN RAISE EXCEPTION 'a two row app UPDATE named its actor on % of % audit rows', n_named, n_all; END IF;
  -- And a hand run statement after it in the same transaction names nobody.
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  UPDATE public.service_connections SET schema_synced_at = now() WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a' AND changed_by IS NOT NULL) THEN
    RAISE EXCEPTION 'a hand run statement inherited the actor of the statement before it in the same transaction';
  END IF;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112331a' AND service_type = 'salesforce';
  INSERT INTO sca_cases VALUES ('one statement updating several rows names its actor on every row, and it does not leak');
END
$do$;

-- ── G. No token or ciphertext anywhere ───────────────────────────────────────
DO $do$
DECLARE
  leaked int;
BEGIN
  SELECT count(*) INTO leaked FROM public.audit_log
  WHERE entity_type = 'service_connection'
    AND (changes::text LIKE '%planted-bot-token-2331%' OR changes::text LIKE '%planted-ciphertext-2331%');
  IF leaked <> 0 THEN RAISE EXCEPTION '% audit rows hold the planted token or ciphertext', leaked; END IF;
  INSERT INTO sca_cases VALUES ('the planted token and ciphertext appear in no audit row');
END
$do$;

-- ── H. A stuck audit insert fails the save by name, inside the bound ─────────
DO $do$
DECLARE
  created boolean := NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink');
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('sca_test.self_host'));
  started timestamptz;
  took interval;
  said text;
  detail_said text;
BEGIN
  IF created THEN
    CREATE EXTENSION dblink;
  END IF;
  PERFORM dblink_connect('sca_lock', conn);
  PERFORM dblink_exec('sca_lock', 'BEGIN');
  PERFORM dblink_exec('sca_lock', 'LOCK TABLE public.audit_log IN ACCESS EXCLUSIVE MODE');
  started := clock_timestamp();
  BEGIN
    UPDATE public.service_connections SET config = config || '{"config_alerts_enabled": false}', updated_by = '22222222-2222-2222-2222-22222222331a'
    WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS said = MESSAGE_TEXT, detail_said = PG_EXCEPTION_DETAIL;
  END;
  took := clock_timestamp() - started;
  PERFORM dblink_exec('sca_lock', 'ROLLBACK');
  PERFORM dblink_disconnect('sca_lock');
  IF created THEN
    DROP EXTENSION dblink;
  END IF;
  IF said IS DISTINCT FROM 'connection_audit_failed' THEN RAISE EXCEPTION 'a stuck audit insert surfaced as: % (%)', said, detail_said; END IF;
  IF took > interval '5 seconds' THEN RAISE EXCEPTION 'the save waited % for its audit insert', took; END IF;
  IF (SELECT config ->> 'config_alerts_enabled' FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112331a') IS NOT NULL THEN
    RAISE EXCEPTION 'the save landed without its audit row';
  END IF;
  INSERT INTO sca_cases VALUES ('a stuck audit insert fails the save by name within the bound');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112331a';
DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112331a';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM sca_cases);
BEGIN
  IF n <> 9 THEN RAISE EXCEPTION 'expected 9 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_audit.test.sql: % cases passed', n;
END
$do$;
