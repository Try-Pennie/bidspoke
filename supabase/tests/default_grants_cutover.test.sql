-- The bidding database has the platform's default grants as they are from
-- 2026-10-30 (#3097). The cases and why are in the shared check this loads.
--
-- organizations was created long before the cutover with no GRANT of its own,
-- so service_role reads it only through the old default grants: it must keep
-- them after the replay takes the defaults away.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.
\set kept_table public.organizations
\i /sql-suite-fixtures/sql-suite/default_grants_cutover.sql
