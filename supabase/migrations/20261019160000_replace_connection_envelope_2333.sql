-- replace_connection_envelope: the compare and set that moves one ops
-- connection's sealed login to the current ops key during a rotation of that
-- key (#2333, phase 3 of #1689, the reseal; plan: discussion #2329, phase 3).
--
-- WHY. Every ops connection login is sealed to an ops public key, named by the
-- envelope's kid, and opens only with that kid's private key. Rotating the key
-- (docs/disaster-recovery.md, rotating the ops private key, step 3) moves new
-- seals to the new kid, and then every stored envelope still naming the old kid
-- must be resealed to the new one before the old key can go. The ops Worker
-- does that (resealConnections, apps/worker/src/ops/reseal.ts): it opens each
-- such envelope with the old key, seals the same login to the new kid at the
-- SAME generation (the generation names the login, and the login is unchanged),
-- and hands the new envelope back here, to the one home of the credential
-- (service_connections.credential_enc, L83). The bidding Worker cannot open
-- either envelope: it holds only the public keys.
--
-- WHAT. One compare and set. The row is written only when it is the named
-- organization's ops_key row, still at the expected generation, and its stored
-- envelope still names the expected kid. A Reconnect, a rotated person bound
-- login, a removal or another reseal in the meantime is never overwritten. The
-- answer says which happened:
--   replaced          written now
--   already_replaced  the row already holds this very envelope (a repeat after an
--                     answer lost on the way back: each seal draws a fresh
--                     random iv, so the iv and kid together name it); not written
--   moved             the row is at another generation or names another kid; not
--                     written. The answer names the row's generation and kid
--   not_found         no such ops_key row in that organization: removed,
--                     another organization's, or a bidding_ring row
-- A new envelope that is not of the seal's shape, or that names the expected
-- kid (a reseal must change it), or an expected kid or generation that cannot
-- be one, is refused by name (envelope_replace_refused: ...), ERRCODE 22023.
--
-- THE ROW IS LOCKED, THEN READ. The stored credential is text, and an ops_key
-- row whose text is not JSON must answer moved rather than raise, so the row
-- is selected FOR UPDATE by its id first and its kid read inside an exception
-- block, never inside the UPDATE's WHERE, whose predicates Postgres may
-- evaluate in any order.
--
-- THE AUDIT. The table's audit trigger labels a write with no actor by the
-- transaction local bidspoke.sc_source (20261018191000), set here to
-- ops_key_reseal for the one UPDATE and cleared straight after, so a reseal is
-- recorded as one, never as direct_sql. credential_enc is recorded only as
-- changed, never its value. The trigger is not changed by this migration.
--
-- WHO CAN CALL IT: service_role only (the bidding Worker), reached from the ops
-- Worker only through the OpsGateway entrypoint's replaceConnectionEnvelope,
-- over the ops Worker's OPS_GATEWAY service binding; there is no public route.
-- WHOSE DATA: the one ops_key row named, within the organization named, and
-- only its credential_enc and updated_at (never its generation).
--
-- Additive (ADR 0007): one new function and nothing else, so the code running
-- when it is applied is unchanged. Nothing calls it until a rotation of the ops
-- key sets OPS_RESEAL on the ops Worker. Guarded by
-- supabase/tests/replace_connection_envelope.test.sql.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.replace_connection_envelope(
  p_organization_id uuid,
  p_connection_id uuid,
  p_expected_kid text,
  p_expected_generation bigint,
  p_envelope jsonb
)
RETURNS TABLE (outcome text, current_generation bigint, current_kid text)
LANGUAGE plpgsql
SET lock_timeout = '2s'
AS $$
DECLARE
  v_generation bigint;
  v_credential text;
  v_kid text;
  v_iv text;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL THEN
    RAISE EXCEPTION 'envelope_replace_refused: the organization and the connection are required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_generation IS NULL OR p_expected_generation < 1 THEN
    RAISE EXCEPTION 'envelope_replace_refused: the expected generation is below 1' USING ERRCODE = '22023';
  END IF;
  -- The seal's kid pattern (packages/connection-seal KID_PATTERN).
  IF p_expected_kid IS NULL OR p_expected_kid !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
    RAISE EXCEPTION 'envelope_replace_refused: the expected kid is not a kid' USING ERRCODE = '22023';
  END IF;
  -- The seal's envelope and nothing else, as store_rotated_envelope and the ops copy's CHECK hold it.
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object'
     OR NOT (p_envelope ?& ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'])
     OR p_envelope - ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'] <> '{}'::jsonb
     OR p_envelope -> 'v' <> '1'::jsonb
     OR jsonb_typeof(p_envelope -> 'kid') <> 'string' OR jsonb_typeof(p_envelope -> 'wrapped_key') <> 'string'
     OR jsonb_typeof(p_envelope -> 'iv') <> 'string' OR jsonb_typeof(p_envelope -> 'ct') <> 'string'
     OR p_envelope ->> 'kid' !~ '^[a-z0-9][a-z0-9-]{0,62}$'
     OR p_envelope ->> 'iv' = '' OR p_envelope ->> 'ct' = ''
     OR octet_length(p_envelope::text) > 65536 THEN
    RAISE EXCEPTION 'envelope_replace_refused: the envelope is not of the seal''s shape' USING ERRCODE = '22023';
  END IF;
  IF p_envelope ->> 'kid' = p_expected_kid THEN
    RAISE EXCEPTION 'envelope_replace_refused: the new envelope names the kid it replaces' USING ERRCODE = '22023';
  END IF;

  SELECT sc.credential_generation, sc.credential_enc INTO v_generation, v_credential
  FROM public.service_connections sc
  WHERE sc.id = p_connection_id
    AND sc.organization_id = p_organization_id
    AND sc.sealed_for = 'ops_key'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  -- The kid and iv only: a credential that is not JSON names neither.
  BEGIN
    v_kid := v_credential::jsonb ->> 'kid';
    v_iv := v_credential::jsonb ->> 'iv';
  EXCEPTION WHEN invalid_text_representation THEN
    v_kid := NULL;
    v_iv := NULL;
  END;

  IF v_generation = p_expected_generation AND v_kid IS NOT DISTINCT FROM (p_envelope ->> 'kid') AND v_iv IS NOT DISTINCT FROM (p_envelope ->> 'iv') THEN
    RETURN QUERY SELECT 'already_replaced'::text, v_generation, v_kid;
    RETURN;
  END IF;
  IF v_generation <> p_expected_generation OR v_kid IS DISTINCT FROM p_expected_kid THEN
    RETURN QUERY SELECT 'moved'::text, v_generation, v_kid;
    RETURN;
  END IF;

  -- Transaction local, set for this one UPDATE and cleared straight after, so
  -- the audit names the reseal and nothing after it in the transaction.
  PERFORM set_config('bidspoke.sc_source', 'ops_key_reseal', true);
  UPDATE public.service_connections sc
  SET credential_enc = p_envelope::text,
      updated_at = now()
  WHERE sc.id = p_connection_id;
  PERFORM set_config('bidspoke.sc_source', '', true);
  RETURN QUERY SELECT 'replaced'::text, v_generation, p_envelope ->> 'kid';
END
$$;

REVOKE ALL ON FUNCTION public.replace_connection_envelope(uuid, uuid, text, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_connection_envelope(uuid, uuid, text, bigint, jsonb) TO service_role;

COMMENT ON FUNCTION public.replace_connection_envelope(uuid, uuid, text, bigint, jsonb) IS
  'Compare and set of one ops connection''s sealed login during a rotation of the ops key (#2333): writes credential_enc only when the named organization''s ops_key row is still at the expected generation and its envelope still names the expected kid, never its generation, and answers replaced, already_replaced, moved (with the row''s generation and kid) or not_found. Called only by the OpsGateway entrypoint''s replaceConnectionEnvelope, for the ops Worker''s resealConnections. service_role only.';
