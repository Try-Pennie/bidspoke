-- The browser roles write no table in public (#2719).
--
-- WHY. Every write the product makes goes through the Worker as service_role,
-- which validates it, encrypts secret values and writes the audit log. The
-- hosted platform's default grants nevertheless gave anon and authenticated
-- INSERT, UPDATE and DELETE on every table, and most tables carry a FOR ALL
-- organization policy, so any signed in employee could write their
-- organization's rows straight through the Data API with the publishable key
-- (measured on production 2026-10-23: 30 tables and 98 partitions). No browser
-- code writes any of them (the list is on the pull request).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds by replaying every migration from empty. Its bootstrap reproduces the
-- platform's default grants (L714), so before the migration every case below
-- is red.
--
-- WHAT IT PROVES.
--   A. Neither role holds INSERT, UPDATE or DELETE on any table, partition or
--      view in public, at table level or on any column. workflows and
--      workflow_versions are revoked by #2717's migration, so they are left out
--      only while that migration's public.write_workflow does not exist; once
--      it does they are held here like every other table.
--   B. A table created later does not get those privileges back: the default
--      privileges of postgres in public grant neither role a write, measured by
--      creating a table and reading its privileges.
--   C. The refusal is the privilege, not row level security: as authenticated,
--      an UPDATE and a DELETE that match no row and an INSERT are each refused
--      with "permission denied".
--   D. SELECT stays where the browser reads: organizations (the e2e tenant
--      check), execution_steps (the test run panel's realtime feed) and users.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS brw_cases (name text PRIMARY KEY);
DELETE FROM brw_cases;
DO $do$ BEGIN
  PERFORM set_config('brw.refused_by_privilege', 'no', false);
END $do$;

-- ── A. No write privilege on any relation in public ─────────────────────────
DO $do$
DECLARE
  rel record;
  r text;
  p text;
  found text[] := ARRAY[]::text[];
  inspected int := 0;
  pending boolean := NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'write_workflow' AND pronamespace = 'public'::regnamespace);
BEGIN
  FOR rel IN
    SELECT c.oid, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
      AND NOT (pending AND c.relname IN ('workflows', 'workflow_versions'))
  LOOP
    inspected := inspected + 1;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(r, rel.oid, p) THEN
          found := found || format('%s holds %s on %s', r, p, rel.relname);
        END IF;
      END LOOP;
      IF has_any_column_privilege(r, rel.oid, 'INSERT, UPDATE') THEN
        found := found || format('%s holds a column INSERT or UPDATE on %s', r, rel.relname);
      END IF;
    END LOOP;
  END LOOP;
  -- A loop over nothing proves nothing (L98): the replayed schema has dozens of
  -- tables, and the ones the issue named must be among those inspected.
  IF inspected < 40 THEN
    RAISE EXCEPTION 'inspected only % relations in public, so the check measured nothing', inspected;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.environment_variables'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.users'::regclass) THEN
    RAISE EXCEPTION 'environment_variables or users is missing from the replayed schema';
  END IF;
  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION '% browser write privilege(s) remain: %', cardinality(found), array_to_string(found[1:12], '; ');
  END IF;
  INSERT INTO brw_cases VALUES ('neither browser role holds a write on any relation in public');
END
$do$;

-- ── B. A table created later does not get a browser write ───────────────────
BEGIN;
CREATE TABLE public.brw_later_table (id int);
DO $do$
DECLARE
  r text;
  p text;
  d record;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(r, 'public.brw_later_table', p) THEN
        RAISE EXCEPTION 'a table created after the migration gives % %', r, p;
      END IF;
    END LOOP;
  END LOOP;
  FOR d IN
    SELECT pg_get_userbyid(e.grantee) AS grantee, e.privilege_type
    FROM pg_default_acl a, aclexplode(a.defaclacl) e
    WHERE a.defaclrole = 'postgres'::regrole AND a.defaclnamespace = 'public'::regnamespace
      AND a.defaclobjtype = 'r' AND pg_get_userbyid(e.grantee) IN ('anon', 'authenticated')
      AND e.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION 'the default privileges of postgres in public still grant % %', d.grantee, d.privilege_type;
  END LOOP;
  INSERT INTO brw_cases VALUES ('a table created later gives neither browser role a write');
END
$do$;
DROP TABLE public.brw_later_table;
COMMIT;

-- ── C. The refusal is the privilege, not row level security ─────────────────
-- Before the migration the UPDATE and DELETE below succeed on zero rows (the
-- policy filters, it does not refuse), so only a revoked privilege makes them
-- raise. Each runs in its own subtransaction, so a refusal leaves nothing.
BEGIN;
SET LOCAL ROLE authenticated;
DO $do$
DECLARE
  attempts text[] := ARRAY[
    'UPDATE public.users SET email = email WHERE false',
    'DELETE FROM public.environment_variables WHERE false',
    'UPDATE public.organizations SET name = name WHERE false',
    'INSERT INTO public.api_sources DEFAULT VALUES'
  ];
  s text;
  refused int := 0;
BEGIN
  FOREACH s IN ARRAY attempts LOOP
    BEGIN
      EXECUTE s;
      RAISE EXCEPTION 'authenticated was allowed: %', s USING ERRCODE = 'P0001';
    EXCEPTION
      WHEN insufficient_privilege THEN
        IF SQLERRM NOT LIKE 'permission denied for table%' THEN
          RAISE EXCEPTION 'authenticated was refused by something other than the privilege (%): %', SQLERRM, s;
        END IF;
        refused := refused + 1;
    END;
  END LOOP;
  IF refused <> cardinality(attempts) THEN
    RAISE EXCEPTION 'expected % refusals, saw %', cardinality(attempts), refused;
  END IF;
  -- The case table belongs to postgres, so the result is carried out of the
  -- authenticated block in a session setting and recorded after it.
  PERFORM set_config('brw.refused_by_privilege', 'yes', false);
END
$do$;
COMMIT;
DO $do$
BEGIN
  IF current_setting('brw.refused_by_privilege') <> 'yes' THEN
    RAISE EXCEPTION 'the authenticated block did not record its refusals';
  END IF;
  INSERT INTO brw_cases VALUES ('authenticated is refused a write by the privilege itself');
END
$do$;

-- ── D. SELECT stays where the browser reads ─────────────────────────────────
DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.organizations', 'public.execution_steps', 'public.users'] LOOP
    IF NOT has_table_privilege('authenticated', t, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated lost SELECT on %, which the browser reads', t;
    END IF;
  END LOOP;
  INSERT INTO brw_cases VALUES ('authenticated keeps SELECT where the browser reads');
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM brw_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE 'browser_roles_no_writes.test.sql: % cases passed', n;
END
$do$;
