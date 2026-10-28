-- is_sealed_envelope: one shape check for an ops connection's sealed login,
-- shared by the three bidding functions that store one (#2565).
--
-- WHY. The check (the keys v, kid, wrapped_key, iv and ct and no others,
-- version 1, each key a string, the seal's kid pattern, a non empty iv and ct,
-- at most 64 KiB) was copied inline into store_rotated_envelope
-- (20261018191000), replace_connection_envelope (20261019160000) and
-- reconnect_ops_connection (20261020200000), and the copies had already
-- drifted: store_rotated_envelope had no kid pattern, so it would store an
-- envelope the seal refuses to open (packages/connection-seal parseEnvelope)
-- and the other two refuse. One IMMUTABLE helper now holds the rule, and each
-- function calls it (L613, L370).
--
-- WHAT. One new function, public.is_sealed_envelope(jsonb), answering true or
-- false, never NULL. The three functions are redefined with identical
-- signatures, grants, comments, refusal messages and behaviour, except that
-- each asks the helper in place of its own copy, so store_rotated_envelope now
-- also refuses a kid that is not a kid. Guarded by
-- supabase/tests/sealed_envelope_shape.test.sql, which feeds all three the same
-- malformed envelopes.
--
-- THE OPS COPY'S CHECK IS LEFT AS IT IS (the issue's open question).
-- connection_copies_envelope_shape on the ops project (supabase-ops,
-- 20261017220000) is a separate database, so a helper there would be a second
-- copy of this one, not the same rule, and the drift this change ends would
-- simply move between projects. That CHECK is deliberately the looser one: it
-- holds copies of envelopes this database has already accepted through the
-- helper, written by the minute serve after the gateway contract has checked
-- each row (apps/worker/src/lib/ops-gateway-contract.ts), so the property it
-- must keep is that it never refuses an envelope accepted here, which a looser
-- check cannot break. Tightening it would only add a way for a serve to fail.
--
-- ADDITIVE (ADR 0007): a new function and three CREATE OR REPLACE with the same
-- signatures, so the code running when it is applied is unchanged, and
-- database.ts gains only the new function.
--
-- WHO CAN CALL THE HELPER: service_role (the bidding Worker, which calls
-- store_rotated_envelope and replace_connection_envelope as itself) and the
-- function owner (reconnect_ops_connection is SECURITY DEFINER). Never anon or
-- authenticated. It reads no table.

SET LOCAL lock_timeout = '5s';

-- ── is_sealed_envelope ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_sealed_envelope(p_envelope jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object' THEN false
    ELSE coalesce(
      p_envelope ?& ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct']
      AND p_envelope - ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'] = '{}'::jsonb
      AND p_envelope -> 'v' = '1'::jsonb
      AND jsonb_typeof(p_envelope -> 'kid') = 'string' AND jsonb_typeof(p_envelope -> 'wrapped_key') = 'string'
      AND jsonb_typeof(p_envelope -> 'iv') = 'string' AND jsonb_typeof(p_envelope -> 'ct') = 'string'
      -- The seal's kid pattern (packages/connection-seal KID_PATTERN).
      AND p_envelope ->> 'kid' ~ '^[a-z0-9][a-z0-9-]{0,62}$'
      AND p_envelope ->> 'iv' <> '' AND p_envelope ->> 'ct' <> ''
      AND octet_length(p_envelope::text) <= 65536,
      false)
  END
$$;

REVOKE ALL ON FUNCTION public.is_sealed_envelope(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_sealed_envelope(jsonb) TO service_role;

COMMENT ON FUNCTION public.is_sealed_envelope(jsonb) IS
  'Whether a value is of the shape of an ops connection''s sealed login (#2565): exactly the keys v, kid, wrapped_key, iv and ct, version 1, each a string, the seal''s kid pattern, a non empty iv and ct, at most 64 KiB. Answers true or false, never NULL. The one copy of the rule store_rotated_envelope, replace_connection_envelope and reconnect_ops_connection refuse an envelope by. service_role only.';

-- ── store_rotated_envelope ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.store_rotated_envelope(
  p_organization_id uuid,
  p_connection_id uuid,
  p_expected_generation bigint,
  p_new_generation bigint,
  p_envelope jsonb
)
RETURNS TABLE (outcome text, current_generation bigint, current_iv text)
LANGUAGE plpgsql
SET lock_timeout = '2s'
AS $$
DECLARE
  v_generation bigint;
  v_credential text;
  v_iv text;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL THEN
    RAISE EXCEPTION 'rotated_envelope_refused: the organization and the connection are required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_generation IS NULL OR p_expected_generation < 1 THEN
    RAISE EXCEPTION 'rotated_envelope_refused: the expected generation is below 1' USING ERRCODE = '22023';
  END IF;
  IF p_new_generation IS NULL OR p_new_generation <= p_expected_generation THEN
    RAISE EXCEPTION 'rotated_envelope_refused: the new generation is not above the expected one' USING ERRCODE = '22023';
  END IF;
  -- The seal's envelope and nothing else, by the one shared check (#2565).
  IF NOT public.is_sealed_envelope(p_envelope) THEN
    RAISE EXCEPTION 'rotated_envelope_refused: the envelope is not of the seal''s shape' USING ERRCODE = '22023';
  END IF;

  -- Transaction local, set for this one UPDATE and cleared straight after, so
  -- the audit names the rotation and nothing after it in the transaction.
  PERFORM set_config('bidspoke.sc_source', 'ops_token_rotation', true);
  UPDATE public.service_connections sc
  SET credential_enc = p_envelope::text,
      credential_generation = p_new_generation,
      updated_at = now()
  WHERE sc.id = p_connection_id
    AND sc.organization_id = p_organization_id
    AND sc.sealed_for = 'ops_key'
    AND sc.person_bound
    AND sc.credential_generation = p_expected_generation;
  IF FOUND THEN
    PERFORM set_config('bidspoke.sc_source', '', true);
    RETURN QUERY SELECT 'stored'::text, p_new_generation, p_envelope ->> 'iv';
    RETURN;
  END IF;
  PERFORM set_config('bidspoke.sc_source', '', true);

  SELECT sc.credential_generation, sc.credential_enc INTO v_generation, v_credential
  FROM public.service_connections sc
  WHERE sc.id = p_connection_id
    AND sc.organization_id = p_organization_id
    AND sc.sealed_for = 'ops_key'
    AND sc.person_bound;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  -- The iv only: a credential that is not JSON is answered with none.
  BEGIN
    v_iv := v_credential::jsonb ->> 'iv';
  EXCEPTION WHEN invalid_text_representation THEN
    v_iv := NULL;
  END;

  IF v_generation = p_new_generation AND v_iv IS NOT DISTINCT FROM (p_envelope ->> 'iv') THEN
    RETURN QUERY SELECT 'already_stored'::text, v_generation, v_iv;
  ELSE
    RETURN QUERY SELECT 'moved'::text, v_generation, v_iv;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.store_rotated_envelope(uuid, uuid, bigint, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_rotated_envelope(uuid, uuid, bigint, bigint, jsonb) TO service_role;

-- ── replace_connection_envelope ──────────────────────────────────────────────

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
  -- The seal's envelope and nothing else, by the one shared check (#2565).
  IF NOT public.is_sealed_envelope(p_envelope) THEN
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

-- ── reconnect_ops_connection ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reconnect_ops_connection(
  p_organization_id uuid,
  p_connection_id uuid,
  p_expected_generation bigint,
  p_new_generation bigint,
  p_envelope jsonb,
  p_acts_as text,
  p_actor uuid,
  p_actor_email text
)
RETURNS TABLE (outcome text, current_generation bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_sealed_for text;
  v_generation bigint;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'reconnect_refused: the actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_generation IS NULL OR p_expected_generation < 1 THEN
    RAISE EXCEPTION 'reconnect_refused: the expected generation is below 1' USING ERRCODE = '22023';
  END IF;
  IF p_new_generation IS NULL OR p_new_generation <= p_expected_generation THEN
    RAISE EXCEPTION 'reconnect_refused: the new generation is not above the expected one' USING ERRCODE = '22023';
  END IF;
  -- The seal's envelope and nothing else, by the one shared check (#2565).
  IF NOT public.is_sealed_envelope(p_envelope) THEN
    RAISE EXCEPTION 'reconnect_refused: the envelope is not of the seal''s shape' USING ERRCODE = '22023';
  END IF;

  SELECT sc.sealed_for, sc.credential_generation INTO v_sealed_for, v_generation
  FROM public.service_connections sc
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sealed_for IS DISTINCT FROM 'ops_key' THEN
    RAISE EXCEPTION 'connection_not_ops_key' USING ERRCODE = 'BP422';
  END IF;
  IF v_generation <> p_expected_generation THEN
    RETURN QUERY SELECT 'stale_generation'::text, v_generation;
    RETURN;
  END IF;

  -- updated_by names the actor for the audit (service_connections_capture_actor).
  UPDATE public.service_connections sc
  SET credential_enc = p_envelope::text,
      credential_generation = p_new_generation,
      acts_as = p_acts_as,
      updated_by = p_actor,
      updated_by_email = p_actor_email,
      updated_at = now()
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id;

  RETURN QUERY SELECT 'reconnected'::text, p_new_generation;
END
$$;

REVOKE ALL ON FUNCTION public.reconnect_ops_connection(uuid, uuid, bigint, bigint, jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconnect_ops_connection(uuid, uuid, bigint, bigint, jsonb, text, uuid, text) TO service_role;
