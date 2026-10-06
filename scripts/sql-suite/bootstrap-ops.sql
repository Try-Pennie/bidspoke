-- scripts/sql-suite/bootstrap-ops.sql: make the throwaway database look like the
-- ops project before its migrations replay (#1709, L714).
--
-- Measured on the new ops project 2026-10-06, before any migration: public's ACL
-- is {pg_database_owner=UC, =U, postgres=U, anon=U, authenticated=U,
-- service_role=U}, and the default privileges of postgres in public grant anon,
-- authenticated and service_role every privilege on tables (arwdDxtm), sequences
-- (rwU) and functions (X). The image grants the browser roles USAGE only through
-- PUBLIC and its postgres defaults leave them out, so a test here would pass on a
-- migration that misses the live grants. These statements give the image the live
-- shape; the ops migrations must then take it back.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- The suite's own bookkeeping, as bootstrap.sql creates it for main.
CREATE SCHEMA IF NOT EXISTS sql_suite;
CREATE TABLE IF NOT EXISTS sql_suite.replayed (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER SCHEMA sql_suite OWNER TO postgres;
ALTER TABLE sql_suite.replayed OWNER TO postgres;
