-- A person's own account connection carries its owner on its ops copy (#2339).
--
-- Dan decided on 2026-10-23 (recorded on #2338) that a person's own account may
-- be used only by its owner, so no workflow can send email as someone else. The
-- ops executor allows an app_action step bound to such a connection only when
-- the step was bound by the connection's owner. Who bound the step is stamped on
-- the step by the bidding Worker's save (boundBy); who owns the connection is
-- service_connections.user_id of a person bound connection, which the bidding
-- Worker now serves with each connection (owner_user_id, null for a company
-- connection). This keeps it on the copy and answers it with the copy.
--
-- Expand only (ADR 0007), safe in either deploy order:
--  - a new nullable column;
--  - save_connection_copies keeps its signature and reads owner_user_id from
--    each copy, null when the key is absent, so an ops Worker older than this
--    change saves as before and one newer than the bidding Worker saves no owner;
--  - connection_copy answers one more column at the end. Its return type
--    changes, so it is dropped and created again with the same grants; a reader
--    older than this change reads the columns by name and ignores the new one.
-- A copy with no owner is refused for an own account step by the executor
-- (own_account_owner_unrecorded), so a missing owner fails closed.
--
-- Guarded by supabase-ops/supabase/tests/connection_copy_owner.test.sql.

SET lock_timeout = '5s';

ALTER TABLE public.connection_copies ADD COLUMN owner_user_id uuid;
COMMENT ON COLUMN public.connection_copies.owner_user_id IS
  'The users.id of the person a person bound connection acts as (service_connections.user_id on bidding), as the bidding Worker served it; null for a company connection or a copy served before #2339. The ops executor runs an own account step only when this equals the step''s boundBy.';

-- ── save_connection_copies ────────────────────────────────────────────────────
-- As 20261017220000_ops_connections_2334.sql wrote it, and each copy's
-- owner_user_id kept with the rest of the copy.
CREATE OR REPLACE FUNCTION public.save_connection_copies(p_served_at timestamptz, p_complete boolean, p_copies jsonb)
RETURNS TABLE (inserted integer, updated integer, confirmed integer, refused_older integer, refused_expired integer,
  refused_removed integer, withdrawn integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_copy record;
  v_old public.connection_copies%ROWTYPE;
  v_tomb public.connection_tombstones_ops%ROWTYPE;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_confirmed integer := 0;
  v_older integer := 0;
  v_expired integer := 0;
  v_removed integer := 0;
  v_withdrawn integer := 0;
  v_ids uuid[];
BEGIN
  IF p_served_at IS NULL OR p_complete IS NULL THEN
    RAISE EXCEPTION 'save_connection_copies: served_at and complete are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_copies IS NULL OR jsonb_typeof(p_copies) <> 'array' THEN
    RAISE EXCEPTION 'save_connection_copies: the copies must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_copies) > 1000 THEN
    RAISE EXCEPTION 'save_connection_copies: at most 1000 copies in one call, not %', jsonb_array_length(p_copies) USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_copy IN
    SELECT (e->>'connection_id')::uuid AS connection_id, (e->>'organization_id')::uuid AS organization_id, e->>'service' AS service,
      (e->>'generation')::bigint AS generation, e->'envelope' AS envelope, e->'public_config' AS public_config,
      CASE WHEN jsonb_typeof(e->'target') = 'object' THEN e->'target' END AS target, (e->>'serve_until')::timestamptz AS serve_until,
      (e->>'owner_user_id')::uuid AS owner_user_id
    FROM jsonb_array_elements(p_copies) e
    ORDER BY (e->>'connection_id')::uuid
  LOOP
    IF v_copy.connection_id IS NULL OR v_copy.organization_id IS NULL OR v_copy.service IS NULL OR v_copy.generation IS NULL
        OR v_copy.envelope IS NULL OR v_copy.public_config IS NULL OR v_copy.serve_until IS NULL THEN
      RAISE EXCEPTION 'save_connection_copies: a copy needs its connection, organization, service, generation, envelope, public config and serve_until'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_ids := v_ids || v_copy.connection_id;

    SELECT * INTO v_tomb FROM public.connection_tombstones_ops t WHERE t.connection_id = v_copy.connection_id;
    IF FOUND THEN
      IF v_tomb.organization_id <> v_copy.organization_id THEN
        RAISE EXCEPTION 'save_connection_copies: connection % belongs to another organization', v_copy.connection_id USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF v_tomb.generation >= v_copy.generation THEN
        v_removed := v_removed + 1;
        CONTINUE;
      END IF;
    END IF;
    IF v_copy.serve_until <= v_now THEN
      v_expired := v_expired + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_old FROM public.connection_copies c WHERE c.connection_id = v_copy.connection_id FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.connection_copies (connection_id, organization_id, service, generation, envelope, public_config, target,
        owner_user_id, served_at, serve_until, received_at, confirmed_at)
      VALUES (v_copy.connection_id, v_copy.organization_id, v_copy.service, v_copy.generation, v_copy.envelope, v_copy.public_config,
        v_copy.target, v_copy.owner_user_id, p_served_at, v_copy.serve_until, v_now, v_now)
      ON CONFLICT (connection_id) DO NOTHING;
      IF FOUND THEN
        v_inserted := v_inserted + 1;
        CONTINUE;
      END IF;
      -- Another save inserted it between the read and the insert: take it as it now is.
      SELECT * INTO v_old FROM public.connection_copies c WHERE c.connection_id = v_copy.connection_id FOR UPDATE;
    END IF;

    IF v_old.organization_id <> v_copy.organization_id THEN
      RAISE EXCEPTION 'save_connection_copies: connection % belongs to another organization', v_copy.connection_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_old.service <> v_copy.service THEN
      RAISE EXCEPTION 'save_connection_copies: connection % is a % connection, not %', v_copy.connection_id, v_old.service, v_copy.service
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_copy.generation > v_old.generation
        OR (v_copy.generation = v_old.generation AND p_served_at > v_old.served_at) THEN
      UPDATE public.connection_copies c
      SET generation = v_copy.generation, envelope = v_copy.envelope, public_config = v_copy.public_config, target = v_copy.target,
          owner_user_id = v_copy.owner_user_id, served_at = p_served_at, serve_until = v_copy.serve_until,
          withdrawn_at = CASE WHEN v_old.withdrawn_at IS NOT NULL AND p_served_at <= v_old.withdrawn_at THEN v_old.withdrawn_at END,
          received_at = CASE WHEN v_copy.generation > v_old.generation THEN v_now ELSE v_old.received_at END,
          confirmed_at = v_now
      WHERE c.connection_id = v_copy.connection_id;
      IF v_copy.generation > v_old.generation THEN v_updated := v_updated + 1; ELSE v_confirmed := v_confirmed + 1; END IF;
    ELSIF v_copy.generation = v_old.generation THEN
      UPDATE public.connection_copies c SET confirmed_at = v_now WHERE c.connection_id = v_copy.connection_id;
      v_confirmed := v_confirmed + 1;
    ELSE
      v_older := v_older + 1;
    END IF;
  END LOOP;

  IF p_complete THEN
    -- Bounded: the copies are the ops connections.
    WITH gone AS (
      SELECT c.connection_id FROM public.connection_copies c
      WHERE c.withdrawn_at IS NULL AND c.served_at < p_served_at AND c.connection_id <> ALL (coalesce(v_ids, ARRAY[]::uuid[]))
      ORDER BY c.connection_id
      LIMIT 1000
      FOR UPDATE
    )
    UPDATE public.connection_copies c SET withdrawn_at = p_served_at
    FROM gone WHERE c.connection_id = gone.connection_id;
    GET DIAGNOSTICS v_withdrawn = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_inserted, v_updated, v_confirmed, v_older, v_expired, v_removed, v_withdrawn;
END
$fn$;

-- ── connection_copy ───────────────────────────────────────────────────────────
-- As 20261017220000_ops_connections_2334.sql wrote it, answering the owner last.
DROP FUNCTION public.connection_copy(uuid, uuid);
CREATE FUNCTION public.connection_copy(p_organization_id uuid, p_connection_id uuid)
RETURNS TABLE (state text, connection_id uuid, service text, generation bigint, envelope jsonb, public_config jsonb, target jsonb,
  served_at timestamptz, serve_until timestamptz, db_now timestamptz, owner_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_copy public.connection_copies%ROWTYPE;
  v_tomb public.connection_tombstones_ops%ROWTYPE;
  v_state text;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL THEN
    RAISE EXCEPTION 'connection_copy: organization and connection are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_tomb FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id;
  SELECT * INTO v_copy FROM public.connection_copies c WHERE c.connection_id = p_connection_id;
  IF coalesce(v_copy.organization_id, v_tomb.organization_id, p_organization_id) <> p_organization_id
      OR coalesce(v_tomb.organization_id, p_organization_id) <> p_organization_id THEN
    RAISE EXCEPTION 'connection_copy: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_state := CASE
    WHEN v_tomb.connection_id IS NOT NULL AND (v_copy.connection_id IS NULL OR v_tomb.generation >= v_copy.generation) THEN 'connection_removed'
    WHEN v_copy.connection_id IS NULL THEN 'not_found'
    WHEN v_copy.withdrawn_at IS NOT NULL THEN 'connection_withdrawn'
    WHEN v_copy.serve_until <= now() THEN 'connection_copy_expired'
    ELSE 'usable' END;
  RETURN QUERY SELECT v_state, p_connection_id, v_copy.service, v_copy.generation,
    CASE WHEN v_state = 'usable' THEN v_copy.envelope END, v_copy.public_config, v_copy.target, v_copy.served_at, v_copy.serve_until, now(),
    v_copy.owner_user_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.save_connection_copies(timestamptz, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_connection_copies(timestamptz, boolean, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.connection_copy(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connection_copy(uuid, uuid) TO service_role;

RESET lock_timeout;
