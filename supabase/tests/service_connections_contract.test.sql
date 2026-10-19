-- service_connections release 2, the contract step (#2332, phase 2 of #1689),
-- migration 20261019150000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The tokens and the
-- ciphertexts below are planted placeholders, not credentials.
--
-- WHAT IT PROVES:
--   A. The old UNIQUE (organization_id, service_type) is gone and the new
--      UNIQUE (organization_id, service_type, name) is still there.
--   B. The name defaulting trigger and its function are gone, so a row saved
--      with no name fails NOT NULL, whoever saves it (alert row or ops row).
--   C. The upsert integrations.ts POST /slack sends today (name 'slack',
--      cf_secret_key null, ON CONFLICT (organization_id, service_type, name))
--      inserts, and a second save updates the same row.
--   D. The rollback floor: the upsert of the code before #2368 (no name,
--      ON CONFLICT (organization_id, service_type)) is now refused, because no
--      constraint matches its conflict target. A rollback past #2368 breaks
--      the Slack save; this case is what says so.
--   E. A second row per service can now exist: a named ops slack row saves
--      beside the alert row, and so does a second legacy salesforce row under
--      another name, while a second row of the same name and a second alert row
--      (slack, bidding_ring) are still refused.
--   F. The old delete by service type, delete_service_connection(uuid, text,
--      uuid), is gone, and delete_service_connection_by_id is still there.
--   G. The Slack Disconnect, delete by id of the alert row, beside an ops slack
--      row and a second non ops slack row removes only the alert row.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS scc_cases (name text PRIMARY KEY);
DELETE FROM scc_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112334a', 'SCC Org', 'scc-org-2332') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222222334a', '11111111-1111-1111-1111-11111112334a', 'scc2332@example.test', 'SCC User')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112334a';
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112334a';
END
$do$;

-- ── A. The old unique is gone, the new one stays ─────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_connections'::regclass AND conname = 'service_connections_org_type_unique') THEN
    RAISE EXCEPTION 'the old UNIQUE (organization_id, service_type) is still there';
  END IF;
  -- Gone under any name, not only the one it had.
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.service_connections'::regclass AND i.indisunique AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)) = ARRAY['organization_id', 'service_type']
  ) THEN
    RAISE EXCEPTION 'a unique index on exactly (organization_id, service_type) is still there';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid = 'public.service_connections'::regclass AND conname = 'service_connections_org_type_name_unique'))
     IS DISTINCT FROM 'UNIQUE (organization_id, service_type, name)' THEN
    RAISE EXCEPTION 'the UNIQUE (organization_id, service_type, name) the Slack upsert names is missing';
  END IF;
  INSERT INTO scc_cases VALUES ('the old one row per service unique is gone and the named unique stays');
END
$do$;

-- ── B. No name default: a row with no name fails NOT NULL ────────────────────
DO $do$
DECLARE
  refused int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.service_connections'::regclass AND tgname = 'service_connections_default_name') THEN
    RAISE EXCEPTION 'the name defaulting trigger is still there';
  END IF;
  IF to_regprocedure('public.service_connections_default_name()') IS NOT NULL THEN
    RAISE EXCEPTION 'the name defaulting trigger function is still there';
  END IF;
  -- The alert row with no name: the trigger used to name it service_type.
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, auth_type, cf_secret_key, config, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111112334a', 'slack', 'oauth', NULL, '{"default_channel":"#alerts"}', 'planted-ciphertext-2334-a', 'bidding_ring');
  EXCEPTION WHEN not_null_violation THEN
    refused := refused + 1;
  END;
  -- An ops row with no name was never defaulted, and still fails.
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, auth_type, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111112334a', 'salesforce', 'oauth_client_credentials', 'planted-ops-ciphertext-2334', 'ops_key');
  EXCEPTION WHEN not_null_violation THEN
    refused := refused + 1;
  END;
  IF refused <> 2 THEN RAISE EXCEPTION 'only % of 2 rows saved with no name were refused', refused; END IF;
  IF EXISTS (SELECT 1 FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112334a') THEN
    RAISE EXCEPTION 'a row with no name was saved';
  END IF;
  INSERT INTO scc_cases VALUES ('a row saved with no name fails NOT NULL, the trigger and its function gone');
END
$do$;

-- ── C. Today's Slack upsert inserts, then updates the same row ───────────────
DO $do$
DECLARE
  first_id uuid;
  second_id uuid;
BEGIN
  -- Exactly what routes/api/integrations.ts POST /slack sends.
  INSERT INTO public.service_connections
    (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, updated_by, updated_by_email)
  VALUES ('11111111-1111-1111-1111-11111112334a', 'slack', 'slack', 'oauth', NULL,
          '{"bot_token":"planted-bot-token-2334","default_channel":"#alerts"}', 'planted-ciphertext-2334-c', 'bidding_ring',
          '22222222-2222-2222-2222-22222222334a', 'scc2332@example.test')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET
    auth_type = EXCLUDED.auth_type, cf_secret_key = EXCLUDED.cf_secret_key, config = EXCLUDED.config,
    credential_enc = EXCLUDED.credential_enc, sealed_for = EXCLUDED.sealed_for,
    updated_by = EXCLUDED.updated_by, updated_by_email = EXCLUDED.updated_by_email
  RETURNING id INTO first_id;

  INSERT INTO public.service_connections
    (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, updated_by, updated_by_email)
  VALUES ('11111111-1111-1111-1111-11111112334a', 'slack', 'slack', 'oauth', NULL,
          '{"bot_token":"planted-bot-token-2334","default_channel":"#alerts-2"}', 'planted-ciphertext-2334-d', 'bidding_ring',
          '22222222-2222-2222-2222-22222222334a', 'scc2332@example.test')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET
    auth_type = EXCLUDED.auth_type, cf_secret_key = EXCLUDED.cf_secret_key, config = EXCLUDED.config,
    credential_enc = EXCLUDED.credential_enc, sealed_for = EXCLUDED.sealed_for,
    updated_by = EXCLUDED.updated_by, updated_by_email = EXCLUDED.updated_by_email
  RETURNING id INTO second_id;

  IF second_id IS DISTINCT FROM first_id THEN RAISE EXCEPTION 'the second Slack save made a new row'; END IF;
  IF (SELECT count(*) FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112334a') <> 1 THEN
    RAISE EXCEPTION 'the Slack saves left more than one row';
  END IF;
  IF (SELECT config ->> 'default_channel' FROM public.service_connections WHERE id = first_id) <> '#alerts-2' THEN
    RAISE EXCEPTION 'the second Slack save did not update the row';
  END IF;
  INSERT INTO scc_cases VALUES ('today''s Slack upsert inserts the alert row and a second save updates it');
END
$do$;

-- ── D. The rollback floor: the pre #2368 upsert is refused ───────────────────
DO $do$
DECLARE
  state text;
BEGIN
  BEGIN
    INSERT INTO public.service_connections
      (organization_id, service_type, auth_type, cf_secret_key, config, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111112334a', 'slack', 'oauth', '',
            '{"bot_token":"planted-bot-token-2334","default_channel":"#old"}', 'planted-ciphertext-2334-e', 'bidding_ring')
    ON CONFLICT (organization_id, service_type) DO UPDATE SET config = EXCLUDED.config;
  EXCEPTION WHEN OTHERS THEN
    state := SQLSTATE;
  END;
  -- 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification.
  IF state IS DISTINCT FROM '42P10' THEN
    RAISE EXCEPTION 'the pre #2368 upsert was not refused for its conflict target (SQLSTATE %)', coalesce(state, 'none, it saved');
  END IF;
  IF (SELECT config ->> 'default_channel' FROM public.service_connections
      WHERE organization_id = '11111111-1111-1111-1111-11111112334a' AND name = 'slack') <> '#alerts-2' THEN
    RAISE EXCEPTION 'the refused pre #2368 upsert changed the alert row';
  END IF;
  INSERT INTO scc_cases VALUES ('the pre #2368 upsert is refused for its conflict target and changes nothing (the rollback floor)');
END
$do$;

-- ── E. A second row per service, never a duplicate name or a second alert row
DO $do$
DECLARE
  refused text;
BEGIN
  -- A named ops slack row beside the alert row.
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
  VALUES ('11111111-1111-1111-1111-11111112334a', 'slack', 'ops-alerts', 'bot_token', 'planted-ops-ciphertext-2334', 'ops_key');
  -- Two legacy rows of one service under different names.
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key)
  VALUES ('11111111-1111-1111-1111-11111112334a', 'salesforce', 'first', 'credentials', 'CONN_PLANTED_A'),
         ('11111111-1111-1111-1111-11111112334a', 'salesforce', 'second', 'credentials', 'CONN_PLANTED_B');
  IF (SELECT count(*) FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112334a' AND service_type = 'slack') <> 2
     OR (SELECT count(*) FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112334a' AND service_type = 'salesforce') <> 2 THEN
    RAISE EXCEPTION 'a second row of a service under its own name was not saved';
  END IF;

  -- The same name twice is still refused, by the named unique.
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key)
    VALUES ('11111111-1111-1111-1111-11111112334a', 'salesforce', 'first', 'credentials', 'CONN_PLANTED_C');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS refused = CONSTRAINT_NAME;
  END;
  IF refused IS DISTINCT FROM 'service_connections_org_type_name_unique' THEN
    RAISE EXCEPTION 'a second row of the same name was refused by % rather than the named unique', refused;
  END IF;

  -- A second alert row under another name is refused by the partial unique index.
  refused := NULL;
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111112334a', 'slack', 'second-alert', 'oauth', NULL, 'planted-ciphertext-2334-f', 'bidding_ring');
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS refused = CONSTRAINT_NAME;
  END;
  IF refused IS DISTINCT FROM 'service_connections_one_alert_row' THEN
    RAISE EXCEPTION 'a second alert row was refused by % rather than the partial unique index', refused;
  END IF;
  INSERT INTO scc_cases VALUES ('a second row of a service saves under its own name, never a duplicate name or a second alert row');
END
$do$;

-- ── F. The old delete by service type is gone ────────────────────────────────
DO $do$
BEGIN
  IF to_regprocedure('public.delete_service_connection(uuid, text, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'the old delete_service_connection(uuid, text, uuid) is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'delete_service_connection') THEN
    RAISE EXCEPTION 'a delete_service_connection overload is still there';
  END IF;
  IF to_regprocedure('public.delete_service_connection_by_id(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'delete_service_connection_by_id, which both callers use, is gone';
  END IF;
  INSERT INTO scc_cases VALUES ('the old delete by service type is gone and the delete by id stays');
END
$do$;

-- ── G. The Disconnect beside other slack rows removes only the alert row ─────
DO $do$
DECLARE
  alert_id uuid;
  ids uuid[];
BEGIN
  -- A second non ops slack row as well, the case a delete by type removed too.
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, config)
  VALUES ('11111111-1111-1111-1111-11111112334a', 'slack', 'second slack', 'oauth', NULL, '{"default_channel":"#b"}');
  SELECT id INTO alert_id FROM public.service_connections
  WHERE organization_id = '11111111-1111-1111-1111-11111112334a' AND service_type = 'slack' AND name = 'slack';

  SELECT array_agg(d.id) INTO ids
  FROM public.delete_service_connection_by_id('11111111-1111-1111-1111-11111112334a', alert_id, '22222222-2222-2222-2222-22222222334a') d;
  IF ids IS DISTINCT FROM ARRAY[alert_id] THEN RAISE EXCEPTION 'the Disconnect returned %, not the alert row', ids; END IF;
  IF EXISTS (SELECT 1 FROM public.service_connections WHERE id = alert_id) THEN
    RAISE EXCEPTION 'the Disconnect left the alert row';
  END IF;
  IF (SELECT array_agg(name ORDER BY name) FROM public.service_connections
      WHERE organization_id = '11111111-1111-1111-1111-11111112334a' AND service_type = 'slack') IS DISTINCT FROM ARRAY['ops-alerts', 'second slack'] THEN
    RAISE EXCEPTION 'the Disconnect removed a slack row other than the alert row';
  END IF;
  INSERT INTO scc_cases VALUES ('the Disconnect beside an ops slack row and a second slack row removes only the alert row');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112334a';
DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112334a';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM scc_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_contract.test.sql: % cases passed', n;
END
$do$;
