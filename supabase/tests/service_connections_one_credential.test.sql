-- service_connections holds exactly one stored credential per row (#2332,
-- phase 2 of #1689): num_nonnulls(cf_secret_key, credential_enc) = 1.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Every value below
-- is a planted placeholder, not a credential.
--
-- WHAT IT PROVES:
--   A. A row holding neither (no sealed login, no Worker secret name) is refused
--      by service_connections_one_stored_credential, on insert and on update.
--   B. A row holding both is refused.
--   C. An empty cf_secret_key counts as one (num_nonnulls counts '' as set), so
--      '' beside a sealed login is refused: the migration normalised every
--      stored '' to NULL first, and no writer sends '' any more.
--   D. Every shape a deployed writer stores is accepted: the Slack alert save
--      (cf_secret_key NULL, credential_enc sealed) and its later settings
--      update, an ops connection insert, and a legacy Worker secret row.
--   E. The constraint is validated, so it holds for every stored row too.

CREATE TEMP TABLE IF NOT EXISTS soc_cases (name text PRIMARY KEY);
DELETE FROM soc_cases;

CREATE OR REPLACE FUNCTION pg_temp.soc_error_of(p_sql text) RETURNS text
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
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-1111111c2332', 'SOC Org', 'soc-org-2332') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111c2332';
END
$do$;

-- ── A. Neither ───────────────────────────────────────────────────────────────
DO $do$
DECLARE
  err text;
BEGIN
  err := pg_temp.soc_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, config)
    VALUES ('11111111-1111-1111-1111-1111111c2332', 'slack', 'slack', 'bot_token', NULL, NULL, '{"default_channel":"#a"}')$q$);
  IF err IS NULL OR err NOT LIKE '%service_connections_one_stored_credential%' THEN
    RAISE EXCEPTION 'a row with no stored credential was not refused: %', coalesce(err, 'no error');
  END IF;

  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for, config)
  VALUES ('11111111-1111-1111-1111-1111111c2332', 'slack', 'slack', 'bot_token', NULL, 'planted-ciphertext', 'bidding_ring', '{"default_channel":"#a"}');
  err := pg_temp.soc_error_of($q$UPDATE public.service_connections SET credential_enc = NULL, sealed_for = NULL
    WHERE organization_id = '11111111-1111-1111-1111-1111111c2332'$q$);
  IF err IS NULL OR err NOT LIKE '%service_connections_one_stored_credential%' THEN
    RAISE EXCEPTION 'clearing the only stored credential was not refused: %', coalesce(err, 'no error');
  END IF;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111c2332';
  INSERT INTO soc_cases VALUES ('a row with no stored credential is refused on insert and on update');
END
$do$;

-- ── B and C. Both, and an empty Worker secret name ──────────────────────────
DO $do$
DECLARE
  err text;
BEGIN
  err := pg_temp.soc_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-1111111c2332', 'salesforce', 'both', 'oauth_client_credentials', 'CONN_PLANTED', 'planted-ciphertext', 'ops_key')$q$);
  IF err IS NULL OR err NOT LIKE '%service_connections_one_stored_credential%' THEN
    RAISE EXCEPTION 'a row with both credentials was not refused: %', coalesce(err, 'no error');
  END IF;
  err := pg_temp.soc_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for, config)
    VALUES ('11111111-1111-1111-1111-1111111c2332', 'slack', 'slack', 'bot_token', '', 'planted-ciphertext', 'bidding_ring', '{"default_channel":"#a"}')$q$);
  IF err IS NULL OR err NOT LIKE '%service_connections_one_stored_credential%' THEN
    RAISE EXCEPTION 'an empty cf_secret_key beside a sealed login was not refused: %', coalesce(err, 'no error');
  END IF;
  INSERT INTO soc_cases VALUES ('both, or an empty Worker secret name beside a sealed login, is refused');
END
$do$;

-- ── D. Every shape a deployed writer stores ─────────────────────────────────
DO $do$
DECLARE
  err text;
BEGIN
  -- The Slack alert save (routes/api/integrations.ts saveSlackAlertConnection), then a settings change.
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for, config)
  VALUES ('11111111-1111-1111-1111-1111111c2332', 'slack', 'slack', 'bot_token', NULL, 'planted-ciphertext', 'bidding_ring', '{"default_channel":"#a"}')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET credential_enc = EXCLUDED.credential_enc, config = EXCLUDED.config;
  UPDATE public.service_connections SET config = config || '{"volume_alerts_enabled": false}'
  WHERE organization_id = '11111111-1111-1111-1111-1111111c2332' AND name = 'slack';
  -- An ops connection (routes/api/connections.ts POST /).
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc, sealed_for, credential_generation)
  VALUES ('11111111-1111-1111-1111-1111111c2332', 'anthropic', 'Lead notes', 'api_key', NULL, 'planted-envelope', 'ops_key', 1);
  -- A legacy Worker secret row (none exists in production; the shape stays legal).
  err := pg_temp.soc_error_of($q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, credential_enc)
    VALUES ('11111111-1111-1111-1111-1111111c2332', 'salesforce', 'legacy', 'oauth_client_credentials', 'CONN_PLANTED', NULL)$q$);
  IF err IS NOT NULL THEN RAISE EXCEPTION 'a legacy Worker secret row was refused: %', err; END IF;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111c2332';
  INSERT INTO soc_cases VALUES ('every shape a deployed writer stores is accepted');
END
$do$;

-- ── E. Validated ─────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.service_connections'::regclass AND conname = 'service_connections_one_stored_credential' AND convalidated
  ) THEN
    RAISE EXCEPTION 'service_connections_one_stored_credential is missing or not validated';
  END IF;
  INSERT INTO soc_cases VALUES ('the constraint is validated');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111c2332';
DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111c2332';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM soc_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_one_credential.test.sql: % cases passed', n;
END
$do$;
