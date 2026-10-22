-- Audit every change of connection_tombstones (#2331, phase 1 of #1689,
-- constraint k: every change of a connection is audited at the store, whoever
-- made it). Applied to the bidding project.
--
-- A tombstone is what tells the ops Worker a connection was removed (L625), so
-- a hand run DELETE of one would let a removed login come back on ops with no
-- record of who did it. service_connections has had its own store level audit
-- since 20261017120000; the plan gives connection_tombstones its OWN trigger
-- function, because service_connections_audit reads columns (config,
-- credential_enc) a tombstone does not have.
--
-- 1. connection_tombstones_audit(): AFTER INSERT, UPDATE or DELETE, one
--    audit_log row per changed row: entity_type 'connection_tombstone',
--    entity_id the connection's id, action created, updated or deleted, the
--    changed columns as {old, new}. The actor is bidspoke.actor_id, set by the
--    function that writes the tombstone; with none it is labelled direct_sql
--    (or the writer's bidspoke.sc_source), as service_connections_audit does.
--    A failed audit insert fails the write by name (connection_audit_failed)
--    within lock_timeout, as for service_connections.
-- 2. remove_ops_connection sets the remover as bidspoke.actor_id BEFORE its
--    tombstone insert instead of after it, so the tombstone's audit names the
--    remover. It is cleared straight after the DELETE as before, so nothing
--    later in the transaction is named. The body is otherwise unchanged from
--    20261020200000.
--
-- Additive (CLAUDE.md, ADR 0007): a new function, a new trigger, and the same
-- function signature with one statement moved. The code running when this is
-- applied, and its rollback target, call remove_ops_connection exactly as
-- before. Proven in supabase/tests/connection_tombstones_audit.test.sql.

-- ── 1. The audit function and its trigger ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.connection_tombstones_audit()
RETURNS trigger
LANGUAGE plpgsql
SET lock_timeout = '2s'
AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
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
  WHERE coalesce(v_old -> keys.k, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new -> keys.k, 'null'::jsonb);

  IF v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_actor := nullif(current_setting('bidspoke.actor_id', true), '')::uuid;
  IF v_actor IS NULL THEN
    v_changes := v_changes || jsonb_build_object('_source', coalesce(nullif(current_setting('bidspoke.sc_source', true), ''), 'direct_sql'));
  END IF;

  BEGIN
    INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
    VALUES (
      coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid,
      'connection_tombstone',
      coalesce(v_new ->> 'connection_id', v_old ->> 'connection_id')::uuid,
      CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
      v_actor,
      v_changes
    );
  EXCEPTION WHEN OTHERS THEN
    -- The reason only: SQLERRM of a failed insert names a lock, a constraint or
    -- a missing relation, never a credential (a tombstone holds none).
    RAISE EXCEPTION 'connection_audit_failed' USING ERRCODE = 'BP503', DETAIL = SQLSTATE || ': ' || SQLERRM;
  END;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.connection_tombstones_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS connection_tombstones_audit ON public.connection_tombstones;
CREATE TRIGGER connection_tombstones_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.connection_tombstones
  FOR EACH ROW EXECUTE FUNCTION public.connection_tombstones_audit();

-- ── 2. remove_ops_connection names its remover on the tombstone too ──────────

CREATE OR REPLACE FUNCTION public.remove_ops_connection(p_organization_id uuid, p_connection_id uuid, p_actor uuid)
RETURNS TABLE (outcome text, removed_generation bigint, workflows jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_sealed_for text;
  v_generation bigint;
  v_using jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'remove_refused: the actor is required' USING ERRCODE = '22023';
  END IF;

  SELECT sc.sealed_for, sc.credential_generation INTO v_sealed_for, v_generation
  FROM public.service_connections sc
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_sealed_for IS DISTINCT FROM 'ops_key' THEN
    -- The Slack alert row is removed by the Slack Disconnect, never here.
    RAISE EXCEPTION 'connection_not_ops_key' USING ERRCODE = 'BP422';
  END IF;

  -- The one predicate the Used by tab also reads.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.workflow_id, 'name', r.name, 'deleted', r.deleted)
                            ORDER BY r.deleted, r.name, r.workflow_id), '[]'::jsonb)
  INTO v_using
  FROM public.connection_references(p_organization_id, p_connection_id) r;
  IF v_using <> '[]'::jsonb THEN
    RETURN QUERY SELECT 'connection_in_use'::text, NULL::bigint, v_using;
    RETURN;
  END IF;

  -- Transaction local, set for the tombstone and the DELETE and cleared
  -- straight after, so both audits name this removal's actor and nothing after
  -- it (#2331).
  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  INSERT INTO public.connection_tombstones (organization_id, connection_id, generation)
  VALUES (p_organization_id, p_connection_id, v_generation);
  DELETE FROM public.service_connections sc
  WHERE sc.id = p_connection_id AND sc.organization_id = p_organization_id;
  PERFORM set_config('bidspoke.actor_id', '', true);

  RETURN QUERY SELECT 'removed'::text, v_generation, '[]'::jsonb;
END
$$;

REVOKE ALL ON FUNCTION public.remove_ops_connection(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_ops_connection(uuid, uuid, uuid) TO service_role;
