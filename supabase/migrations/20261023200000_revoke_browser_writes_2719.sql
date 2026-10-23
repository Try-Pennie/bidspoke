-- ============================================================
-- The browser roles write no table in public (#2719)
-- ============================================================
-- Measured on production, read only, 2026-10-23: anon and authenticated held
-- INSERT, UPDATE and DELETE on 30 tables in public and on all 98 of their
-- partitions, from the platform's default grants. Most of those tables carry a
-- FOR ALL organization policy (organization_id = user_org_id()), so any signed
-- in employee could write their organization's rows straight through the Data
-- API with the publishable key, past the Worker's validation, its encryption
-- of secret values and its audit log: a hand written environment_variables row
-- would be stored unencrypted, and a users row could be edited by its owner.
--
-- No browser code writes any table. apps/web reaches the database directly in
-- three ways only: the middleware calls is_allowlisted() (SECURITY DEFINER),
-- the e2e setup reads organizations, and the test run panel subscribes to
-- execution_steps inserts over realtime, which needs SELECT. Every other read
-- and every write goes through the Worker as service_role, which this does not
-- touch. The file by file list is on the pull request.
--
-- What this does:
--   1. Revokes INSERT, UPDATE and DELETE from anon and authenticated on every
--      table, partition and view in public, except workflows and
--      workflow_versions, which #2717's migration revokes on its own.
--   2. Stops a table created later getting them back. Partitions are created
--      every day by functions owned by postgres, so without this each new
--      partition would arrive with the grants again.
--
-- SELECT is left exactly as it is, as are REFERENCES and TRIGGER, which no
-- request path can use.
--
-- Expand only, safe while today's code runs (L640): nothing deployed writes as
-- either role, and a policy needs only SELECT on the tables it reads.
--
-- Guarded by supabase/tests/browser_roles_no_writes.test.sql and by the live
-- privilege check (.github/scripts/db-privilege-check.mjs), which fails naming
-- any table either role can write again.

DO $$
DECLARE
  rel record;
  revoked integer := 0;
BEGIN
  FOR rel IN
    SELECT c.oid::regclass AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND c.relname NOT IN ('workflows', 'workflow_versions')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE %s FROM anon, authenticated', rel.name);
    revoked := revoked + 1;
  END LOOP;

  -- Revoking from nothing would read as a clean apply (L98).
  IF revoked = 0 THEN
    RAISE EXCEPTION 'revoked browser writes on 0 relations, so this migration asserted nothing';
  END IF;
  RAISE NOTICE 'revoked browser role writes on % relation(s)', revoked;
END
$$;

-- Tables created later by postgres, which owns every table and partition here.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated;
