-- The ops project's first migration (#1709, plan 0.E): the browser roles reach
-- nothing, and every table must carry organization_id uuid NOT NULL.
--
-- WHY. The ops project serves no browser. Supabase grants anon and authenticated
-- USAGE on public and, through the default privileges of postgres, every
-- privilege on each new table, sequence and function (measured on the new project
-- 2026-10-06: 26 such grants). A platform default grant gives away what no
-- migration granted (L124, L541), so the first migration takes them back.
--
-- HOW. Catalogue checks on the schema and default privileges, then probe objects
-- created the way a migration creates them, inside a rolled back transaction: a
-- table, a sequence and a function, each asserted unreachable by the browser
-- roles. The organization_id rule is the one .github/scripts/db-privilege-check.mjs
-- applies to the live project; here it is seen to flag a table that lacks it.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops).

BEGIN;

DO $$
DECLARE
  v_role text;
  v_count int;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_schema_privilege(v_role, 'public', 'USAGE') THEN
      RAISE EXCEPTION '% holds USAGE on schema public', v_role;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count
  FROM pg_default_acl d, aclexplode(d.defaclacl) e
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
    AND (e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated'));
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'the default privileges of postgres in public still grant the browser roles % privilege(s)', v_count;
  END IF;

  CREATE TABLE public.ops_probe_ok (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
  CREATE TABLE public.ops_probe_no_org (id uuid PRIMARY KEY);
  CREATE SEQUENCE public.ops_probe_seq;
  CREATE FUNCTION public.ops_probe_fn() RETURNS int LANGUAGE sql AS 'select 1';

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.ops_probe_ok', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION '% holds a privilege on a new table', v_role;
    END IF;
    IF has_sequence_privilege(v_role, 'public.ops_probe_seq', 'SELECT,USAGE,UPDATE') THEN
      RAISE EXCEPTION '% holds a privilege on a new sequence', v_role;
    END IF;
    IF has_function_privilege(v_role, 'public.ops_probe_fn()', 'EXECUTE') THEN
      RAISE EXCEPTION '% can execute a new function', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.ops_probe_ok', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'service_role lacks a privilege on a new table';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ops_probe_fn()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute a new function';
  END IF;

  -- The organization_id rule flags the table without it, and only that one.
  SELECT count(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'ops_probe%'
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnotnull
        AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'the organization_id rule flagged % probe table(s), expected exactly the one without it', v_count;
  END IF;

  RAISE NOTICE 'ops_foundation: 6 cases passed';
END $$;

ROLLBACK;
