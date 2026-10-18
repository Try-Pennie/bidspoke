-- Delete one service connection by its id (#2332, phase 2 of #1689). EXPAND step.
--
-- delete_service_connection(org, service_type, actor) deletes every row of the
-- type in the organization that is not an ops_key row (migration
-- 20261017150000). While the old UNIQUE (organization_id, service_type) holds
-- there is at most one such row, so that is one row. Release 2 drops that
-- unique, after which an organization can hold two rows of one service, and the
-- Slack Disconnect or DELETE /api/connections/:service_type would remove both.
--
-- delete_service_connection_by_id(org, connection_id, actor) deletes only the
-- row whose id is named, only when it belongs to the named organization (the
-- caller's, from its verified token), and never an ops_key row, which only
-- Phase 8's own delete removes (with the reference refusal, the tombstone and
-- the revoke). Both callers already read the row they mean before deleting it,
-- so each passes that row's id. It names the actor the way the old function
-- does, so the table's audit trigger records the user (#2331).
--
-- Expand and contract (CLAUDE.md, ADR 0007): the old function stays, unchanged,
-- because the code running when this is applied (and its rollback target)
-- calls it. The code in the pull request carrying this migration calls only the
-- new one, and the deploy refuses while a merged migration is unapplied
-- (#1829), so it never runs before this exists. The CONTRACT step, recorded on
-- #2332's release 2 checklist: once that code is live and read back, a later
-- migration drops delete_service_connection(uuid, text, uuid), and its entries
-- leave read-only-rpcs.json, required-live-objects.json and the SQL tests.
-- It must land before (or with) release 2.
--
-- Who can call it: service_role only (the Worker), as for the old function.
-- Whose data: the one row named, and only within the organization named.

CREATE OR REPLACE FUNCTION public.delete_service_connection_by_id(p_organization_id uuid, p_connection_id uuid, p_actor uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Transaction local, so it names this call's delete and nothing after it.
  PERFORM set_config('bidspoke.actor_id', coalesce(p_actor::text, ''), true);
  RETURN QUERY
    DELETE FROM public.service_connections sc
    WHERE sc.id = p_connection_id
      AND sc.organization_id = p_organization_id
      AND sc.sealed_for IS DISTINCT FROM 'ops_key'
    RETURNING sc.id;
  PERFORM set_config('bidspoke.actor_id', '', true);
END
$$;

REVOKE ALL ON FUNCTION public.delete_service_connection_by_id(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_service_connection_by_id(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.delete_service_connection_by_id(uuid, uuid, uuid) IS
  'Deletes the one service_connections row named by id, only within the named organization and never an ops_key row, naming the actor for the audit trigger (#2332). Replaces delete_service_connection(uuid, text, uuid), which deletes by service type and is dropped by a later contract migration before release 2.';
