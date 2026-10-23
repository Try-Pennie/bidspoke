-- Strip the plaintext Slack token and refuse it from now on (#2331's contract
-- release, phase 1 of #1689). Applied to the bidding project.
--
-- CONTRACT STEP. Apply only AFTER #2723 is merged, deployed and read back.
-- That pull request makes every reader take the token from credential_enc
-- only, and makes the Slack save stop writing config.bot_token (L640). Code
-- from before it saves config.bot_token, which the CHECK below refuses. So
-- once this is applied, the Worker must not be rolled back past #2723.
--
-- Until #2331 the alert bot's token sat in config.bot_token in plain text. It
-- has been sealed into credential_enc since 2026-10-22 10:05 PM ET (read back:
-- sealed_for bidding_ring, credential_enc set), and #2723 reads only that. The
-- plaintext copy is now a second, unencrypted home for a live credential that
-- nothing reads.
--
-- 1. Refuse to strip a row whose sealed copy is missing (L5): a row holding
--    config.bot_token and no credential_enc stops the migration by name rather
--    than losing its only copy of the token. None exists (measured 2026-10-22
--    11:24 PM ET: two rows, both with credential_enc set).
-- 2. Remove bot_token from every row's config, reporting the count (1 today,
--    the Slack alert row). The audit trigger records each change, without the
--    token's value, labelled as this migration.
-- 3. Add CHECK (NOT (config ? 'bot_token')), so no write can bring it back,
--    and VALIDATE it.
--
-- Proven in supabase/tests/service_connections_no_plaintext.test.sql.

DO $do$
DECLARE
  v_unsealed bigint;
  v_stripped bigint;
BEGIN
  SELECT count(*) INTO v_unsealed
  FROM public.service_connections
  WHERE jsonb_typeof(config) = 'object' AND config ? 'bot_token' AND credential_enc IS NULL;
  IF v_unsealed > 0 THEN
    RAISE EXCEPTION 'plaintext strip refused: % row(s) hold config.bot_token with no credential_enc, so the plaintext is their only copy of the token; seal them first', v_unsealed;
  END IF;

  PERFORM set_config('bidspoke.sc_source', 'migration_20261023030000', true);
  UPDATE public.service_connections
  SET config = config - 'bot_token'
  WHERE jsonb_typeof(config) = 'object' AND config ? 'bot_token';
  GET DIAGNOSTICS v_stripped = ROW_COUNT;
  PERFORM set_config('bidspoke.sc_source', '', true);
  RAISE NOTICE 'service_connections: config.bot_token removed from % row(s)', v_stripped;
END
$do$;

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_no_plaintext_token
  CHECK (NOT coalesce(config ? 'bot_token', false)) NOT VALID;

ALTER TABLE public.service_connections
  VALIDATE CONSTRAINT service_connections_no_plaintext_token;

COMMENT ON CONSTRAINT service_connections_no_plaintext_token ON public.service_connections IS
  'No plaintext token in config (#2331): a Slack bot token lives only in credential_enc, sealed with the Worker''s key ring.';
