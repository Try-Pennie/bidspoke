-- scripts/sql-suite/checks/default_grants_cutover.sql: the throwaway database
-- has the platform's default grants as they are from 2026-10-30 (#3097, L714).
--
-- Shared by both projects' suites, which load it with \i from
-- /sql-suite-fixtures/sql-suite/ (scripts/sql-suite/project.sh copies this
-- folder in), after setting the psql variable kept_table to a table the
-- project created before the cutover that service_role must still read.
--
-- WHY. From 2026-10-30 Supabase stops giving a new public table or sequence to
-- anon, authenticated and service_role through the default privileges of
-- postgres (https://github.com/orgs/supabase/discussions/45329). A table that
-- existed before keeps its grants. replay.sh reproduces that history: it applies
-- scripts/sql-suite/default-grants-cutover.sql before the first migration at or
-- after the cutover version, or after the last migration when none is. A
-- migration that creates a table without granting it then leaves service_role
-- unable to read it here exactly as in production, and a test touching it fails.
--
-- WHAT IT PROVES.
--   1. The default privileges of postgres in public give none of the three roles
--      SELECT, INSERT, UPDATE or DELETE on tables, or USAGE or SELECT on
--      sequences.
--   2. A table and a sequence created now, the way a migration creates them,
--      are unreachable by all three roles.
--   3. A table created before the cutover keeps service_role's SELECT, so the
--      replay did not take the old defaults away from the tables made under them.
--   4. The cutover ran exactly once, and before every migration at or after its
--      version.
BEGIN;
SET LOCAL sql_suite.kept_table = :'kept_table';

DO $$
DECLARE
  v_count int;
  v_role text;
  v_kept text := current_setting('sql_suite.kept_table');
  v_cut record;
BEGIN
  -- 1. The default privileges.
  SELECT count(*) INTO v_count
  FROM pg_default_acl d, aclexplode(d.defaclacl) e
  WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
    AND pg_get_userbyid(e.grantee) IN ('anon', 'authenticated', 'service_role')
    AND ((d.defaclobjtype = 'r' AND e.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))
      OR (d.defaclobjtype = 'S' AND e.privilege_type IN ('USAGE', 'SELECT')));
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'the default privileges of postgres in public still grant % table or sequence privilege(s) to anon, authenticated or service_role', v_count;
  END IF;

  -- 2. A table and a sequence created now.
  CREATE TABLE public.sql_suite_cutover_probe (id int);
  CREATE SEQUENCE public.sql_suite_cutover_probe_seq;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.sql_suite_cutover_probe', 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION '% holds a privilege on a table created after the cutover', v_role;
    END IF;
    IF has_sequence_privilege(v_role, 'public.sql_suite_cutover_probe_seq', 'USAGE,SELECT') THEN
      RAISE EXCEPTION '% holds a privilege on a sequence created after the cutover', v_role;
    END IF;
  END LOOP;

  -- 3. A table made before the cutover keeps its grant.
  IF to_regclass(v_kept) IS NULL THEN
    RAISE EXCEPTION 'kept_table % does not exist, so nothing was measured', v_kept;
  END IF;
  IF NOT has_table_privilege('service_role', v_kept, 'SELECT') THEN
    RAISE EXCEPTION 'service_role lost SELECT on %, a table created before the cutover', v_kept;
  END IF;

  -- 4. The cutover ran once, before every migration at or after its version.
  SELECT count(*) INTO v_count FROM sql_suite.default_grants_cutover;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'the default grants cutover is recorded % times, expected once', v_count;
  END IF;
  SELECT * INTO v_cut FROM sql_suite.default_grants_cutover;
  SELECT count(*) INTO v_count FROM sql_suite.replayed r
  WHERE r.version >= v_cut.before_version AND r.applied_at < v_cut.applied_at;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '% migration(s) at or after % replayed before the cutover', v_count, v_cut.before_version;
  END IF;

  RAISE NOTICE 'default_grants_cutover: 4 cases passed';
END $$;

ROLLBACK;
