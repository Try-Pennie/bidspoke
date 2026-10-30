-- The ops database has the platform's default grants as they are from
-- 2026-10-30 (#3097). The cases and why are in the shared check this loads.
--
-- run_requests was created before the cutover and granted to service_role by
-- its own migration, which is how every ops table is granted.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds (SQL_SUITE_PROJECT=ops).
\set kept_table public.run_requests
\i /sql-suite-fixtures/sql-suite/default_grants_cutover.sql
