-- service_connections widened for several named connections (#2332, phase 2 of
-- #1689): release 1, step (a), migration 20261017150000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The token and the
-- ciphertexts below are planted placeholders, not credentials.
--
-- WHAT IT PROVES (as the schema stands after every migration, release 2's
-- contract step 20261019150000 included, which dropped the old one row per
-- service unique, the name defaulting trigger and the delete by service type;
-- what release 2 changed is proven in service_connections_contract.test.sql):
--   B. The upsert integrations.ts POST /slack sends (name 'slack', cf_secret_key
--      null, ON CONFLICT (organization_id, service_type, name)) lands on the
--      alert row the release 1 backfill named and updates it rather than
--      erroring (L168).
--   C. An ops_key row with no name is refused by NOT NULL, never defaulted.
--   D. The alert name is reserved: an ops_key slack row named 'slack' is refused
--      by its CHECK, so it can never take the alert row's place.
--   (A, E and F were the upsert of the code before release 1, a simulated
--   release 2 and the delete by service type. All three went with release 2:
--   their coverage is service_connections_contract.test.sql cases C to G and
--   service_connections_delete_by_id.test.sql cases B to D.)
--   G. auth_type accepts the six catalogue kinds (api_key among them) and still
--      the legacy oauth and credentials; anything else is
--      refused.
--   H. The new columns default (person_bound false, credential_generation 1,
--      target null), and cf_secret_key may be null.
--   I. connection_tombstones: no browser privilege, RLS on, service_role keeps
--      access, and one tombstone per (connection_id, generation).
--   J. The audit row of an insert records the name it was given.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS sce_cases (name text PRIMARY KEY);
DELETE FROM sce_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112332a', 'SCE Org', 'sce-org-2332') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112332b', 'SCE Org B', 'sce-org-2332b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222222332a', '11111111-1111-1111-1111-11111112332a', 'sce2332@example.test', 'SCE User')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112332a', '11111111-1111-1111-1111-11111112332b');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112332a', '11111111-1111-1111-1111-11111112332b');
  DELETE FROM public.connection_tombstones WHERE organization_id IN ('11111111-1111-1111-1111-11111112332a', '11111111-1111-1111-1111-11111112332b');
END
$do$;

-- ── B. The release 1 upsert lands on the alert row ───────────────────────────
DO $do$
DECLARE
  alert_id uuid;
  landed_id uuid;
BEGIN
  -- The alert row as the release 1 backfill left it: named after its
  -- service_type, cf_secret_key normalised to null.
  INSERT INTO public.service_connections
    (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, updated_by, updated_by_email)
  VALUES ('11111111-1111-1111-1111-11111112332a', 'slack', 'slack', 'oauth', NULL,
          '{"bot_token":"planted-bot-token-2332","default_channel":"#alerts","workspace_name":"Test"}',
          'planted-ciphertext-2332-a', 'bidding_ring', '22222222-2222-2222-2222-22222222332a', 'sce2332@example.test')
  RETURNING id INTO alert_id;

  -- What this release's integrations.ts sends: name 'slack' explicitly, cf_secret_key null, and the new
  -- conflict target.
  INSERT INTO public.service_connections
    (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, updated_by, updated_by_email)
  VALUES ('11111111-1111-1111-1111-11111112332a', 'slack', 'slack', 'oauth', NULL,
          '{"bot_token":"planted-bot-token-2332","default_channel":"#alerts-3","workspace_name":"Test"}',
          'planted-ciphertext-2332-c', 'bidding_ring', '22222222-2222-2222-2222-22222222332a', 'sce2332@example.test')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET
    auth_type = EXCLUDED.auth_type, cf_secret_key = EXCLUDED.cf_secret_key, config = EXCLUDED.config,
    credential_enc = EXCLUDED.credential_enc, sealed_for = EXCLUDED.sealed_for,
    updated_by = EXCLUDED.updated_by, updated_by_email = EXCLUDED.updated_by_email
  RETURNING id INTO landed_id;

  IF landed_id IS DISTINCT FROM alert_id THEN RAISE EXCEPTION 'the release 1 upsert did not land on the alert row'; END IF;
  IF (SELECT count(*) FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112332a') <> 1 THEN
    RAISE EXCEPTION 'the release 1 upsert made a second row';
  END IF;
  IF (SELECT cf_secret_key FROM public.service_connections WHERE id = alert_id) IS NOT NULL THEN
    RAISE EXCEPTION 'the release 1 upsert could not clear cf_secret_key';
  END IF;
  INSERT INTO sce_cases VALUES ('the release 1 upsert on the new conflict target updates the alert row rather than erroring');
END
$do$;

-- ── C. An ops row with no name is refused ────────────────────────────────────
DO $do$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, auth_type, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111112332b', 'salesforce', 'oauth_client_credentials', 'planted-ops-ciphertext-2332', 'ops_key');
  EXCEPTION WHEN not_null_violation THEN
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'an ops_key row with no name was saved (named %)',
    (SELECT name FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112332b');
  END IF;
  INSERT INTO sce_cases VALUES ('an ops_key row with no name fails NOT NULL instead of being defaulted');
END
$do$;

-- ── D. The alert name is reserved ────────────────────────────────────────────
DO $do$
DECLARE
  refused text;
  alert_enc text;
BEGIN
  -- Org B has no alert row, so only the reserved name CHECK can refuse this.
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111112332b', 'slack', 'slack', 'bot_token', 'planted-ops-ciphertext-2332', 'ops_key');
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS refused = CONSTRAINT_NAME;
  END;
  IF refused IS DISTINCT FROM 'service_connections_alert_name_reserved' THEN
    RAISE EXCEPTION 'an ops slack row named slack was not refused by the reserved name check (refused by %)', refused;
  END IF;

  -- In org A, beside the alert row, the attempt changes nothing on it.
  SELECT credential_enc INTO alert_enc FROM public.service_connections
  WHERE organization_id = '11111111-1111-1111-1111-11111112332a' AND service_type = 'slack';
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-11111112332a', 'slack', 'slack', 'bot_token', 'planted-ops-ciphertext-2332', 'ops_key');
    RAISE EXCEPTION 'an ops slack row named slack was saved beside the alert row';
  EXCEPTION WHEN check_violation OR unique_violation THEN
    NULL;
  END;
  IF (SELECT credential_enc FROM public.service_connections
      WHERE organization_id = '11111111-1111-1111-1111-11111112332a' AND service_type = 'slack') IS DISTINCT FROM alert_enc
     OR (SELECT count(*) FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112332a') <> 1 THEN
    RAISE EXCEPTION 'the refused ops save changed the alert row';
  END IF;
  INSERT INTO sce_cases VALUES ('an ops slack row can never take the alert name, and the alert row is unchanged byte for byte');
END
$do$;

-- ── G. auth_type ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  k text;
  refused boolean := false;
BEGIN
  FOREACH k IN ARRAY ARRAY['service_account', 'bot_token', 'oauth_client_credentials', 'oauth_user', 'key_pair', 'api_key', 'oauth', 'credentials'] LOOP
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key)
    VALUES ('11111111-1111-1111-1111-11111112332b', 'snowflake', 'auth-' || k, k, 'CONN_PLANTED');
    DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112332b' AND service_type = 'snowflake';
  END LOOP;
  BEGIN
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key)
    VALUES ('11111111-1111-1111-1111-11111112332b', 'snowflake', 'auth-bogus', 'password_in_a_text_file', 'CONN_PLANTED');
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'an unknown auth_type was saved'; END IF;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-11111112332b';
  INSERT INTO sce_cases VALUES ('auth_type takes the six catalogue kinds and the legacy oauth and credentials, and refuses anything else');
END
$do$;

-- ── H. New column defaults; cf_secret_key nullable ───────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
  VALUES ('11111111-1111-1111-1111-11111112332b', 'supabase', 'ops db', 'api_key', 'planted-ops-ciphertext-2332', 'ops_key')
  RETURNING * INTO r;
  IF r.person_bound IS DISTINCT FROM false THEN RAISE EXCEPTION 'person_bound defaulted to %', r.person_bound; END IF;
  IF r.credential_generation IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'credential_generation defaulted to %', r.credential_generation; END IF;
  IF r.target IS NOT NULL THEN RAISE EXCEPTION 'target defaulted to %', r.target; END IF;
  IF r.cf_secret_key IS NOT NULL THEN RAISE EXCEPTION 'cf_secret_key was not left null'; END IF;
  DELETE FROM public.service_connections WHERE id = r.id;
  INSERT INTO sce_cases VALUES ('the new columns default, and cf_secret_key may be null');
END
$do$;

-- ── I. connection_tombstones ─────────────────────────────────────────────────
DO $do$
DECLARE
  r text;
  p text;
  refused boolean := false;
  conn uuid := gen_random_uuid();
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.connection_tombstones', p) THEN
        RAISE EXCEPTION '% holds % on public.connection_tombstones', r, p;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.connection_tombstones'::regclass) THEN
    RAISE EXCEPTION 'connection_tombstones does not have RLS on';
  END IF;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT'] LOOP
    IF NOT has_table_privilege('service_role', 'public.connection_tombstones', p) THEN
      RAISE EXCEPTION 'service_role lacks % on connection_tombstones', p;
    END IF;
  END LOOP;

  INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
  VALUES ('11111111-1111-1111-1111-11111112332b', conn, 1);
  IF (SELECT removed_at FROM public.connection_tombstones WHERE connection_id = conn) IS NULL THEN
    RAISE EXCEPTION 'removed_at was not defaulted';
  END IF;
  BEGIN
    INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
    VALUES ('11111111-1111-1111-1111-11111112332b', conn, 1);
  EXCEPTION WHEN unique_violation THEN
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a second tombstone for the same connection generation was saved'; END IF;
  -- A later generation of the same connection is its own tombstone.
  INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
  VALUES ('11111111-1111-1111-1111-11111112332b', conn, 2);
  DELETE FROM public.connection_tombstones WHERE connection_id = conn;
  INSERT INTO sce_cases VALUES ('connection_tombstones: no browser privilege, RLS on, one per connection generation');
END
$do$;

-- ── J. The name is audited ───────────────────────────────────────────────────
DO $do$
DECLARE
  a record;
  conn uuid;
BEGIN
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112332b';
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for, updated_by)
  VALUES ('11111111-1111-1111-1111-11111112332b', 'snowflake', 'warehouse ops', 'key_pair', 'planted-ops-ciphertext-2332', 'ops_key',
          '22222222-2222-2222-2222-22222222332a')
  RETURNING id INTO conn;
  SELECT * INTO a FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112332b' AND entity_id = conn;
  IF a.changes -> 'name' ->> 'new' IS DISTINCT FROM 'warehouse ops' THEN
    RAISE EXCEPTION 'the insert audit row did not record the name: %', a.changes;
  END IF;
  IF a.changes::text LIKE '%planted-ops-ciphertext%' THEN RAISE EXCEPTION 'the ciphertext was copied into the audit row'; END IF;
  DELETE FROM public.service_connections WHERE id = conn;
  INSERT INTO sce_cases VALUES ('the audit row of an insert records the name');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112332a', '11111111-1111-1111-1111-11111112332b');
DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112332a', '11111111-1111-1111-1111-11111112332b');
DELETE FROM public.connection_tombstones WHERE organization_id IN ('11111111-1111-1111-1111-11111112332a', '11111111-1111-1111-1111-11111112332b');

DO $do$
DECLARE
  n int := (SELECT count(*) FROM sce_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_expand.test.sql: % cases passed', n;
END
$do$;
