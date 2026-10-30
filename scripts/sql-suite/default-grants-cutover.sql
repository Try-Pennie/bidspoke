-- scripts/sql-suite/default-grants-cutover.sql: the platform change of
-- 2026-10-30, replayed at the point in the migration history where it happened
-- (#3097, L714).
--
-- From 2026-10-30 Supabase applies to every existing project what it calls the
-- opt out: the default privileges of postgres in public stop giving new tables
-- and sequences to anon, authenticated and service_role
-- (https://github.com/orgs/supabase/discussions/45329). Tables that already
-- exist keep their grants; a table created after it gets none, service_role's
-- included, until its migration grants it. The two statements below are the
-- platform's own, verbatim from its changelog. They leave TRUNCATE, REFERENCES,
-- TRIGGER and MAINTAIN, and the defaults of supabase_admin, as the platform's do.
--
-- Measured read only on 2026-10-30 at 11:15 AM ET: neither project had the
-- change yet. Bidding's postgres defaults in public still gave tables to anon
-- and authenticated as rxtm (#2719 had taken their writes) and to service_role
-- as arwdDxtm, and sequences to all three as rwU; ops's gave service_role
-- arwdDxtm on tables and rwU on sequences (its first migration had taken the
-- browser roles'). The suite takes the defaults away regardless, so a migration
-- that forgets its grant fails here before production changes.
--
-- WHEN IT RUNS. replay.sh applies this once, as postgres, before the first
-- migration whose version is at or after the line below, or after the last
-- migration when none is, and records it in sql_suite.default_grants_cutover.
-- So every table a migration before the cutover made keeps the grants the old
-- defaults gave it, as in production, and every later one starts with none.
-- explicit-table-grants.test.ts reads the same line, so the migrations the
-- guard holds to explicit grants are exactly the ones replayed without
-- defaults. It is part of the bootstrap's hash: changing it rebuilds every
-- container from empty.
--
-- cutover-before-migration: 20261030000000
BEGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM anon, authenticated, service_role;
-- No IF NOT EXISTS: a second application is a replay defect and fails by name.
CREATE TABLE sql_suite.default_grants_cutover (
  before_version text NOT NULL,
  next_migration text,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO sql_suite.default_grants_cutover (before_version, next_migration)
VALUES (:'before_version', NULLIF(:'next_migration', ''));
COMMIT;
