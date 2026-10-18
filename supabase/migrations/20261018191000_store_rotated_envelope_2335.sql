-- store_rotated_envelope: hand a person bound connection's rotated login back to
-- its declared home (#2335, PR 5 of phase 5 of #1689; plan: discussion #2329,
-- part 2; Dan's decision 1 of 2026-10-17, build person bound logins now).
--
-- WHY. A person bound connection (an OAuth user login) is refreshed on the ops
-- Worker by its ConnectionTokenObject. A provider that rotates refresh tokens
-- makes the old one dead the moment it answers, so the object writes the
-- rotated login, sealed to the ops key, to its OWN storage before it returns the
-- new access token (L33, L561), and only then hands it back here, the one home
-- of the credential (service_connections.credential_enc, L83), retrying from an
-- alarm while this database or the bidding Worker is down. The handover is
-- stated: while the object holds a generation ahead of the row, the object is
-- authoritative; once this lands, the row is again.
--
-- WHAT. One compare and set: the row is written only when it is the named
-- organization's person bound ops_key row AND it still holds the generation the
-- object last knew. A Reconnect or a removal in the meantime is never
-- overwritten. The answer says which happened:
--   stored          written now
--   already_stored  the row already holds this generation and this envelope (a
--                   repeat after an answer lost on the way back); not written
--   moved           the row holds another generation; not written. The answer
--                   names it and its envelope's iv, which is how the object
--                   tells its own earlier write (whose answer it never got) from
--                   a Reconnect: each seal draws a fresh random iv
--   not_found       no such row: removed, another organization's, a bidding_ring
--                   row, or a shared (not person bound) ops row
-- A new generation not above the expected one, or an envelope not of the seal's
-- shape (the same rule as the ops copy's CHECK), is refused by name
-- (rotated_envelope_refused: ...), ERRCODE 22023. The bidding Worker cannot open
-- the envelope and does not try: it holds only the ops public key.
--
-- THE AUDIT. The table's audit trigger labels a write with no actor as
-- direct_sql, which a rotation is not (L11). So the trigger function is replaced
-- to read a transaction local source, bidspoke.sc_source, which this function
-- sets to ops_token_rotation for its one UPDATE and clears straight after; with
-- no source set the label stays direct_sql, exactly as before. Nothing else in
-- the trigger changes: credential_enc is still recorded only as changed, never
-- its value.
--
-- WHO CAN CALL IT: service_role only (the bidding Worker), reached from the ops
-- Worker only through the OpsGateway entrypoint's storeRotatedEnvelope, over the
-- ops Worker's OPS_GATEWAY service binding; there is no public route to it.
-- WHOSE DATA: the one row named, within the organization named, and only its
-- credential_enc, credential_generation and updated_at.
--
-- Additive (ADR 0007): a new function, and the audit trigger function replaced
-- with the same behaviour when the new setting is unset, so the code running
-- when this is applied is unchanged. Nothing calls it until a person bound
-- service has rules on the ops Worker (Phase 7). Guarded by
-- supabase/tests/store_rotated_envelope.test.sql and the existing
-- service_connections_audit.test.sql.

SET LOCAL lock_timeout = '5s';

-- ── The audit trigger, with a named source for a write that has no actor ─────

CREATE OR REPLACE FUNCTION public.service_connections_audit()
RETURNS trigger
LANGUAGE plpgsql
SET lock_timeout = '2s'
AS $$
DECLARE
  -- Recorded separately below (config, bot_token, credential_enc) or not at all.
  v_excluded text[] := ARRAY['updated_at', 'updated_by', 'updated_by_email', 'schema_cache', 'config', 'credential_enc'];
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_old_config jsonb := v_old -> 'config';
  v_new_config jsonb := v_new -> 'config';
  v_old_token text;
  v_new_token text;
  v_changes jsonb;
  v_actor uuid;
BEGIN
  SELECT coalesce(jsonb_object_agg(keys.k, jsonb_build_object('old', v_old -> keys.k, 'new', v_new -> keys.k)), '{}'::jsonb)
  INTO v_changes
  FROM (
    SELECT DISTINCT x.k FROM (
      SELECT jsonb_object_keys(coalesce(v_old, '{}'::jsonb)) AS k
      UNION ALL
      SELECT jsonb_object_keys(coalesce(v_new, '{}'::jsonb))
    ) x
  ) keys
  WHERE keys.k <> ALL (v_excluded)
    AND coalesce(v_old -> keys.k, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new -> keys.k, 'null'::jsonb);

  -- The token, read only to say whether it is there and whether it changed.
  v_old_token := CASE WHEN jsonb_typeof(v_old_config) = 'object' THEN v_old_config ->> 'bot_token' END;
  v_new_token := CASE WHEN jsonb_typeof(v_new_config) = 'object' THEN v_new_config ->> 'bot_token' END;
  IF jsonb_typeof(v_old_config) = 'object' THEN v_old_config := v_old_config - 'bot_token'; END IF;
  IF jsonb_typeof(v_new_config) = 'object' THEN v_new_config := v_new_config - 'bot_token'; END IF;

  IF coalesce(v_old_config, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new_config, 'null'::jsonb) THEN
    v_changes := v_changes || jsonb_build_object('config', jsonb_build_object('old', v_old_config, 'new', v_new_config));
  END IF;
  IF v_old_token IS DISTINCT FROM v_new_token THEN
    v_changes := v_changes || jsonb_build_object('bot_token', jsonb_build_object(
      'changed', true, 'old_present', v_old_token IS NOT NULL, 'new_present', v_new_token IS NOT NULL));
  END IF;
  IF (v_old ->> 'credential_enc') IS DISTINCT FROM (v_new ->> 'credential_enc') THEN
    v_changes := v_changes || jsonb_build_object('credential_enc', jsonb_build_object(
      'changed', true, 'old_present', (v_old ->> 'credential_enc') IS NOT NULL, 'new_present', (v_new ->> 'credential_enc') IS NOT NULL));
  END IF;

  IF v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_actor := nullif(current_setting('bidspoke.actor_id', true), '')::uuid;
  IF v_actor IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_actor := NEW.updated_by;
    ELSIF TG_OP = 'UPDATE' THEN
      v_actor := nullif(current_setting('bidspoke.sc_updated_by_actor', true), '')::uuid;
    END IF;
  END IF;
  IF v_actor IS NULL THEN
    -- A system writer names itself (store_rotated_envelope sets ops_token_rotation
    -- for its one UPDATE, #2335); anything else is a direct write, as before.
    v_changes := v_changes || jsonb_build_object('_source', coalesce(nullif(current_setting('bidspoke.sc_source', true), ''), 'direct_sql'));
  END IF;

  BEGIN
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
    VALUES (
      coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid,
      'service_connection',
      coalesce(v_new ->> 'id', v_old ->> 'id')::uuid,
      CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
      v_actor,
      v_changes
    );
  EXCEPTION WHEN OTHERS THEN
    -- The reason only: SQLERRM of a failed insert names a lock, a constraint or
    -- a missing relation, never a value from this row.
    RAISE EXCEPTION 'connection_audit_failed' USING ERRCODE = 'BP503', DETAIL = SQLSTATE || ': ' || SQLERRM;
  END;

  RETURN NULL;
END
$$;

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
  -- The seal's envelope and nothing else, as connection_copies_envelope_shape holds it on ops.
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object'
     OR NOT (p_envelope ?& ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'])
     OR p_envelope - ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'] <> '{}'::jsonb
     OR p_envelope -> 'v' <> '1'::jsonb
     OR jsonb_typeof(p_envelope -> 'kid') <> 'string' OR jsonb_typeof(p_envelope -> 'wrapped_key') <> 'string'
     OR jsonb_typeof(p_envelope -> 'iv') <> 'string' OR jsonb_typeof(p_envelope -> 'ct') <> 'string'
     OR p_envelope ->> 'iv' = '' OR p_envelope ->> 'ct' = ''
     OR octet_length(p_envelope::text) > 65536 THEN
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

COMMENT ON FUNCTION public.store_rotated_envelope(uuid, uuid, bigint, bigint, jsonb) IS
  'Compare and set of a person bound ops connection''s rotated login (#2335): writes credential_enc and credential_generation only when the named organization''s person bound ops_key row still holds the expected generation, and answers stored, already_stored, moved (with the row''s generation and iv) or not_found. Called only by the OpsGateway entrypoint''s storeRotatedEnvelope, for the ops ConnectionTokenObject. service_role only.';
