-- The contract step of write_workflow (#1947, A2 of plan discussion #1945).
--
-- Migration 20261023120000 added write_workflow and moved every Worker write
-- of a workflow onto it, while the code deployed before it kept writing
-- directly. This takes the direct writes away from service_role, the Worker's
-- role, so a workflow's definition, is_active, lane, deleted_at and every
-- version snapshot can be written only through write_workflow, refused by the
-- database itself rather than by a scan of the source (L621, L96). Its owner
-- (postgres, the SQL editor, a hand repair) still writes, and the version
-- trigger still moves the version for it.
--
-- Two direct writes stay, each granted by column, so a column added later is
-- not writable by default:
--   workflows.test_payloads           PATCH /api/workflows/:id/test-payloads,
--                                     which changes nothing a lead runs;
--   workflow_versions.commit_sha      the GitHub backup's stamp on a snapshot.
-- A column privilege is checked against the columns a statement names, so the
-- updated_at and version triggers still set theirs on those updates.
--
-- CONTRACT, so the order is NOT free (ADR 0007, L640): apply this only after
-- the code that writes through write_workflow (the change that added it) is
-- deployed and live. Applied before that, every save, switch on, delete and
-- create of the code still running is refused. Nothing deployed needs it, so
-- the change carrying it can merge after it is applied.

SET LOCAL lock_timeout = '5s';

REVOKE INSERT, UPDATE, DELETE ON public.workflows FROM service_role;
GRANT UPDATE (test_payloads) ON public.workflows TO service_role;

REVOKE INSERT, UPDATE, DELETE ON public.workflow_versions FROM service_role;
GRANT UPDATE (commit_sha) ON public.workflow_versions TO service_role;
