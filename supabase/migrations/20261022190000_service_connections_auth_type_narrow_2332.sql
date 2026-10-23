-- service_connections release 3 (#2332, phase 2 of #1689; the item from
-- #2481): the auth_type CHECK stops accepting the legacy oauth and credentials.
-- Applied to the bidding project.
--
-- CONTRACT STEP. Apply only AFTER #2693 is merged, deployed and read back: that
-- pull request makes the Slack alert save, the one writer of these values,
-- send bot_token. Code from before it sends oauth, which this CHECK refuses, so
-- once this is applied the rollback floor for the Slack save is #2693.
--
-- Release 1 (20261017150000) widened the CHECK to the catalogue's kinds and
-- kept oauth and credentials only because the live Slack row and the code then
-- running wrote them. Measured read only on 2026-10-22 16:00 ET: one row holds
-- a legacy value, the Slack alert row, auth_type oauth; the ops Slack row holds
-- api_key. No salesforce, supabase or snowflake row has ever existed.
--
-- 1. Every Slack row holding oauth or credentials is moved to bot_token, which
--    is what a Slack bot is (the token an alert posts with). The count moved is
--    reported. The audit trigger records the change, labelled as this
--    migration rather than as an anonymous hand run.
-- 2. Any row still holding a legacy value (some other service) stops the
--    migration by name rather than being guessed at: none exists today.
-- 3. The CHECK is replaced by the catalogue's kinds alone.
--
-- Proven in supabase/tests/service_connections_auth_type_narrow.test.sql.

DO $do$
DECLARE
  v_moved bigint;
  v_left bigint;
BEGIN
  PERFORM set_config('bidspoke.sc_source', 'migration_20261022190000', true);
  UPDATE public.service_connections
  SET auth_type = 'bot_token'
  WHERE service_type = 'slack' AND auth_type IN ('oauth', 'credentials');
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  PERFORM set_config('bidspoke.sc_source', '', true);
  RAISE NOTICE 'service_connections release 3: % Slack row(s) moved from a legacy auth_type to bot_token', v_moved;

  SELECT count(*) INTO v_left FROM public.service_connections WHERE auth_type IN ('oauth', 'credentials');
  IF v_left > 0 THEN
    RAISE EXCEPTION 'service_connections release 3 refused: % row(s) of a service other than slack still hold oauth or credentials; move them to a catalogue kind first', v_left;
  END IF;
END
$do$;

ALTER TABLE public.service_connections
  DROP CONSTRAINT IF EXISTS service_connections_auth_type_check;
ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_auth_type_check
  CHECK (auth_type IN ('service_account', 'bot_token', 'oauth_client_credentials', 'oauth_user', 'key_pair', 'api_key'));

COMMENT ON CONSTRAINT service_connections_auth_type_check ON public.service_connections IS
  'The catalogue''s auth kinds as stored (AUTH_TYPE_OF in apps/worker/src/lib/connection-create.ts) and bot_token for the Slack alert row (#2332). The legacy oauth and credentials were refused from release 3 (20261022190000).';
