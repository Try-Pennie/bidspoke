-- service_connections release 3: the auth_type CHECK refuses the legacy values
-- (#2332, phase 2 of #1689; the item from #2481).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The token below is
-- a planted placeholder, not a credential.
--
-- WHAT IT PROVES:
--   A. A row of either legacy value, oauth or credentials, is refused by
--      service_connections_auth_type_check, on insert and on update.
--   B. Every kind the catalogue stores (AUTH_TYPE_OF in
--      apps/worker/src/lib/connection-create.ts) and the Slack alert row's
--      bot_token are still accepted.
--   C. The Slack alert save exactly as routes/api/integrations.ts sends it since
--      #2693 (auth_type bot_token, named slack, sealed for the ring) inserts,
--      and a second save updates the same row.
--   D. The rollback floor: the save as it was before #2693 (auth_type oauth) is
--      now refused.

CREATE TEMP TABLE IF NOT EXISTS atn_cases (name text PRIMARY KEY);
DELETE FROM atn_cases;

CREATE OR REPLACE FUNCTION pg_temp.atn_error_of(p_sql text) RETURNS text
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
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-1111111e2332', 'ATN Org', 'atn-org-2332') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111e2332';
END
$do$;

-- ── A. The legacy values are refused ────────────────────────────────────────
DO $do$
DECLARE
  v text;
  err text;
BEGIN
  FOREACH v IN ARRAY ARRAY['oauth', 'credentials'] LOOP
    err := pg_temp.atn_error_of(format(
      $q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, config)
         VALUES ('11111111-1111-1111-1111-1111111e2332', 'slack', 'slack', %L, '{"bot_token":"planted-2332"}')$q$, v));
    IF err IS NULL OR err NOT LIKE '%service_connections_auth_type_check%' THEN
      RAISE EXCEPTION 'an insert with auth_type % was not refused by the CHECK: %', v, coalesce(err, 'no error');
    END IF;
  END LOOP;

  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, config)
  VALUES ('11111111-1111-1111-1111-1111111e2332', 'slack', 'slack', 'bot_token', '{"bot_token":"planted-2332"}');
  FOREACH v IN ARRAY ARRAY['oauth', 'credentials'] LOOP
    err := pg_temp.atn_error_of(format(
      $q$UPDATE public.service_connections SET auth_type = %L WHERE organization_id = '11111111-1111-1111-1111-1111111e2332'$q$, v));
    IF err IS NULL OR err NOT LIKE '%service_connections_auth_type_check%' THEN
      RAISE EXCEPTION 'an update to auth_type % was not refused by the CHECK: %', v, coalesce(err, 'no error');
    END IF;
  END LOOP;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111e2332';
  INSERT INTO atn_cases VALUES ('oauth and credentials are refused on insert and on update');
END
$do$;

-- ── B. Every kind in use is accepted ────────────────────────────────────────
DO $do$
DECLARE
  k text;
  err text;
BEGIN
  FOREACH k IN ARRAY ARRAY['service_account', 'bot_token', 'oauth_client_credentials', 'oauth_user', 'key_pair', 'api_key'] LOOP
    err := pg_temp.atn_error_of(format(
      $q$INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, credential_enc, sealed_for)
         VALUES ('11111111-1111-1111-1111-1111111e2332', 'anthropic', %L, %L, 'planted', 'ops_key')$q$, 'kind ' || k, k));
    IF err IS NOT NULL THEN RAISE EXCEPTION 'auth_type % was refused: %', k, err; END IF;
  END LOOP;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111e2332';
  INSERT INTO atn_cases VALUES ('every catalogue kind is accepted');
END
$do$;

-- ── C. Today's Slack alert save ─────────────────────────────────────────────
DO $do$
DECLARE
  n int;
BEGIN
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for)
  VALUES ('11111111-1111-1111-1111-1111111e2332', 'slack', 'slack', 'bot_token', NULL, '{"bot_token":"planted-2332"}', 'planted-ciphertext', 'bidding_ring')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET auth_type = EXCLUDED.auth_type, config = EXCLUDED.config, credential_enc = EXCLUDED.credential_enc, sealed_for = EXCLUDED.sealed_for;
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for)
  VALUES ('11111111-1111-1111-1111-1111111e2332', 'slack', 'slack', 'bot_token', NULL, '{"bot_token":"planted-2332-b"}', 'planted-ciphertext-b', 'bidding_ring')
  ON CONFLICT (organization_id, service_type, name) DO UPDATE SET auth_type = EXCLUDED.auth_type, config = EXCLUDED.config, credential_enc = EXCLUDED.credential_enc, sealed_for = EXCLUDED.sealed_for;
  SELECT count(*) INTO n FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111e2332';
  IF n <> 1 THEN RAISE EXCEPTION 'two saves left % rows', n; END IF;
  IF (SELECT credential_enc FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111e2332') <> 'planted-ciphertext-b' THEN
    RAISE EXCEPTION 'the second save did not update the row';
  END IF;
  INSERT INTO atn_cases VALUES ('the Slack alert save as bot_token inserts, then updates the same row');
END
$do$;

-- ── D. The save from before #2693 is refused ────────────────────────────────
DO $do$
DECLARE
  err text;
BEGIN
  err := pg_temp.atn_error_of($q$
    INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for)
    VALUES ('11111111-1111-1111-1111-1111111e2332', 'slack', 'slack', 'oauth', NULL, '{"bot_token":"planted-2332-c"}', 'planted-ciphertext-c', 'bidding_ring')
    ON CONFLICT (organization_id, service_type, name) DO UPDATE SET auth_type = EXCLUDED.auth_type, config = EXCLUDED.config$q$);
  IF err IS NULL OR err NOT LIKE '%service_connections_auth_type_check%' THEN
    RAISE EXCEPTION 'the save from before #2693 was not refused: %', coalesce(err, 'no error');
  END IF;
  IF (SELECT auth_type FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111e2332') <> 'bot_token' THEN
    RAISE EXCEPTION 'the refused save changed the row';
  END IF;
  INSERT INTO atn_cases VALUES ('the rollback floor: the save from before #2693 is refused and changes nothing');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-1111111e2332';
DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-1111111e2332';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM atn_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_auth_type_narrow.test.sql: % cases passed', n;
END
$do$;
