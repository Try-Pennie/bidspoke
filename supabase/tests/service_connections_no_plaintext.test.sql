-- No service_connections row holds a plaintext token (#2331's contract
-- release, phase 1 of #1689): CHECK (NOT (config ? 'bot_token')).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Every value below
-- is a planted placeholder, not a credential.
--
-- WHAT IT PROVES:
--   A. A row whose config carries bot_token is refused by
--      service_connections_no_plaintext_token, on insert and on update.
--   B. The Slack alert save as the code sends it since the contract release
--      (config without the token, the token sealed) inserts, a second save
--      updates the same row, and a settings change updates it.
--   C. A row with no config (an ops connection) is accepted.
--   D. The constraint is validated, so no stored row holds a plaintext token.

CREATE TEMP TABLE IF NOT EXISTS snp_cases (name text PRIMARY KEY);
DELETE FROM snp_cases;

CREATE OR REPLACE FUNCTION pg_temp.snp_error_of(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$$;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-1111111d2331', 'SNP Org', 'snp-org-2331') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
END
$do$;

-- ── A. A plaintext token is refused ─────────────────────────────────────────
DO $do$
DECLARE
  err text;
BEGIN
  err := pg_temp.snp_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for, config)
    VALUES ('11111111-1111-1111-1111-1111111d2331', 'slack', 'slack', 'bot_token', 'planted-ciphertext', 'bidding_ring', '{"bot_token":"planted-2331","default_channel":"#a"}')$q$);
  IF err IS NULL OR err NOT LIKE '%service_connections_no_plaintext_token%' THEN
    RAISE EXCEPTION 'a row carrying a plaintext token was not refused: %', coalesce(err, 'no error');
  END IF;

  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for, config)
  VALUES ('11111111-1111-1111-1111-1111111d2331', 'slack', 'slack', 'bot_token', 'planted-ciphertext', 'bidding_ring', '{"default_channel":"#a"}');
  err := pg_temp.snp_error_of($q$UPDATE public.service_connections SET config = config || '{"bot_token":"planted-2331"}'
    WHERE organization_id = '11111111-1111-1111-1111-1111111d2331'$q$);
  IF err IS NULL OR err NOT LIKE '%service_connections_no_plaintext_token%' THEN
    RAISE EXCEPTION 'adding a plaintext token to a row was not refused: %', coalesce(err, 'no error');
  END IF;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  INSERT INTO snp_cases VALUES ('a plaintext token is refused on insert and on update');
END
$do$;

-- ── B. The Slack alert save and a settings change ───────────────────────────
DO $do$
DECLARE
  n int;
BEGIN
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for, config)
  VALUES ('11111111-1111-1111-1111-1111111d2331', 'slack', 'slack', 'bot_token', NULL, 'planted-ciphertext', 'bidding_ring', '{"default_channel":"#a","workspace_name":"Test"}')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET credential_enc = EXCLUDED.credential_enc, config = EXCLUDED.config;
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for, config)
  VALUES ('11111111-1111-1111-1111-1111111d2331', 'slack', 'slack', 'bot_token', NULL, 'planted-ciphertext-b', 'bidding_ring', '{"default_channel":"#b"}')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET credential_enc = EXCLUDED.credential_enc, config = EXCLUDED.config;
  UPDATE public.service_connections SET config = config || '{"volume_alerts_enabled": false}'
  WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  SELECT count(*) INTO n FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  IF n <> 1 THEN RAISE EXCEPTION 'two saves left % rows', n; END IF;
  INSERT INTO snp_cases VALUES ('the Slack alert save and a settings change are accepted');
END
$do$;

-- ── C. No config ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  err text;
BEGIN
  err := pg_temp.snp_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-1111111d2331', 'anthropic', 'Lead notes', 'api_key', 'planted-envelope', 'ops_key')$q$);
  IF err IS NOT NULL THEN RAISE EXCEPTION 'a row with no config was refused: %', err; END IF;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
  INSERT INTO snp_cases VALUES ('a row with no config is accepted');
END
$do$;

-- ── D. Validated ─────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.service_connections'::regclass AND conname = 'service_connections_no_plaintext_token' AND convalidated
  ) THEN
    RAISE EXCEPTION 'service_connections_no_plaintext_token is missing or not validated';
  END IF;
  INSERT INTO snp_cases VALUES ('the constraint is validated');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';
DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111d2331';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM snp_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_no_plaintext.test.sql: % cases passed', n;
END
$do$;
