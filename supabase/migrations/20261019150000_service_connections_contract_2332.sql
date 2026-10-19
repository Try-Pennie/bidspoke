-- service_connections release 2 (#2332, phase 2 of #1689): the CONTRACT step
-- after release 1 (20261017150000, step a, and PR #2368, #2374) and the delete
-- by id (20261018150000, PR #2387), per docs/adr/0007-expand-contract-migrations.md.
--
-- It removes three things release 1 kept only for the code running then and its
-- rollback target:
--
-- 1. UNIQUE (organization_id, service_type), the old one row per service
--    constraint. UNIQUE (organization_id, service_type, name) stays, and is
--    the conflict target of the one upsert (integrations.ts POST /slack, since
--    #2368). From here an organization may hold several rows of one service,
--    each under its own name. Every Slack alert reader and writer reads only the
--    alert row, by name 'slack' (#2374), and the partial unique index
--    service_connections_one_alert_row still allows one sealed alert row per
--    organization.
-- 2. The BEFORE INSERT trigger service_connections_default_name and its
--    function. It named a row saved with no name after its service_type, for
--    the upsert deployed before #2368, which sent none. Every writer sends a
--    name now: the only insert is that upsert, which sends name 'slack'
--    (apps/web/src/lib/__guards__/worker/service-connections-release-2.test.ts
--    enumerates every insert and upsert on the table and fails on one without
--    a name; no database function inserts into it). A row saved with no name
--    now fails NOT NULL.
-- 3. The delete by service type, delete_service_connection(uuid, text, uuid).
--    Every Worker deployed since #2387 calls only
--    delete_service_connection_by_id (the Slack Disconnect and DELETE
--    /api/connections/:service_type, each with the id of the row it read).
--    Once the old unique is gone a delete by service type would remove every
--    non ops row of the type, so it goes in the same migration.
--
-- Read from production before this was written (read only, 2026-10-19): both
-- earlier migrations applied; the live Worker reports version 312410bf, which
-- contains #2387; no database function's source calls the old delete; nothing
-- depends on the old unique; the table holds one row, the Slack alert row,
-- named 'slack'.
--
-- THE ROLLBACK FLOOR. Code from before #2368 upserts with ON CONFLICT
-- (organization_id, service_type) and no name, which fails once this is applied
-- (no constraint matches that target; proven in
-- supabase/tests/service_connections_contract.test.sql case D), and code from
-- before #2387 calls the dropped delete. So after this is applied the Worker
-- must not be rolled back past #2387 (merged 2026-10-18).
--
-- Who can reach what this changes: nothing new. No data changes: this removes a
-- constraint, a trigger, and two functions, not a row.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.service_connections
  DROP CONSTRAINT IF EXISTS service_connections_org_type_unique;

DROP TRIGGER IF EXISTS service_connections_default_name ON public.service_connections;
DROP FUNCTION IF EXISTS public.service_connections_default_name();

DROP FUNCTION IF EXISTS public.delete_service_connection(uuid, text, uuid);

COMMENT ON COLUMN public.service_connections.name IS
  'The connection''s name, unique per organization and service (#2332). Every writer names it; there is no default (release 2 dropped the trigger that gave one). The Slack alert row is named slack, a name no ops_key slack row may take. For display and for the upsert''s conflict target only: a workflow step refers to a connection by id, never by name.';

COMMENT ON FUNCTION public.delete_service_connection_by_id(uuid, uuid, uuid) IS
  'Deletes the one service_connections row named by id, only within the named organization and never an ops_key row, naming the actor for the audit trigger (#2332). The only delete of the table a route calls: the delete by service type it replaced was dropped in release 2 (20261019150000).';
