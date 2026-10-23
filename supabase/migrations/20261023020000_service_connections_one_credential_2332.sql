-- service_connections holds exactly one stored credential per row (#2332,
-- phase 2 of #1689): num_nonnulls(cf_secret_key, credential_enc) = 1. Applied
-- to the bidding project.
--
-- A row's login is either sealed into credential_enc or, the legacy form, named
-- as a Worker secret in cf_secret_key, never both and never neither. Neither
-- would be a connection that cannot log in but reads as one; both would be two
-- logins for one connection with no rule for which wins.
--
-- The plan (#2332) adds the CHECK NOT VALID in one step and VALIDATEs it in a
-- later one, because a row could still hold '' in cf_secret_key from a save made
-- between release 1's migration and its code (num_nonnulls counts '' as set),
-- and the alert row was not yet sealed. Both have since settled, measured read
-- only on the bidding project on 2026-10-22 at 11 PM ET: two rows, the Slack
-- alert row (sealed 2026-10-22 10:05 PM ET) and an ops Slack row, each with
-- cf_secret_key NULL and credential_enc set, so num_nonnulls is 1 for every row
-- and none holds ''. Every deployed writer stores exactly one: the Slack save
-- and the ops insert send cf_secret_key NULL with a sealed login, and every
-- other write (the envelope reseal and rotation functions, the key rotation
-- re-lock) replaces credential_enc with another non-null value; nothing clears
-- it. So both steps run here, in order, in one transaction:
--
-- 1. Any cf_secret_key '' is normalised to NULL, reporting the count (0 today).
-- 2. The CHECK is added NOT VALID, so it binds every write from here on.
-- 3. It is VALIDATEd, which scans the existing rows and fails by name on any
--    that breaks it, rather than leaving an unenforced promise.
--
-- Additive for the code: every row the deployed code or its rollback target
-- writes satisfies it. Proven in supabase/tests/service_connections_one_credential.test.sql.

DO $do$
DECLARE
  v_normalised bigint;
BEGIN
  UPDATE public.service_connections SET cf_secret_key = NULL WHERE cf_secret_key = '';
  GET DIAGNOSTICS v_normalised = ROW_COUNT;
  RAISE NOTICE 'service_connections: % row(s) had an empty cf_secret_key normalised to NULL', v_normalised;
END
$do$;

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_one_stored_credential
  CHECK (num_nonnulls(cf_secret_key, credential_enc) = 1) NOT VALID;

ALTER TABLE public.service_connections
  VALIDATE CONSTRAINT service_connections_one_stored_credential;

COMMENT ON CONSTRAINT service_connections_one_stored_credential ON public.service_connections IS
  'Exactly one stored credential per row (#2332): the sealed login in credential_enc, or the legacy Worker secret name in cf_secret_key. An empty cf_secret_key counts as set.';
