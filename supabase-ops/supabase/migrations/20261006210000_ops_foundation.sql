-- The ops project's first migration (#1709, plan 0.E, decision D8).
--
-- The ops project ("Bidspoke Ops", zwihpjxouklvkvngkvmw, created 2026-10-06) holds
-- the run data of the workflows ported off Pipedream, apart from the bidding
-- database. It serves no browser: only the ops Worker reads and writes it, as the
-- service role. So the browser roles get nothing here.
--
-- Measured on the new project 2026-10-06, before this migration: anon and
-- authenticated held USAGE on public, and the default privileges of postgres in
-- public granted them every privilege on each new table (TRUNCATE and MAINTAIN
-- included), sequence and function: 26 grants in all, which
-- .github/scripts/db-privilege-check.mjs listed. A platform default grant gives
-- away what no migration granted (L124, L541), so they are taken back here, before
-- any table exists. The service role keeps its own default grants.
--
-- Every table added later must carry organization_id uuid NOT NULL and enable row
-- level security; the live check fails on any that does not.

-- USAGE on public reaches the browser roles twice, directly and through PUBLIC
-- (every role is a member), so both go. postgres and service_role keep their own.
REVOKE USAGE ON SCHEMA public FROM anon, authenticated, PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Functions are executable by PUBLIC unless revoked, and the browser roles are
-- members of PUBLIC. The service role keeps EXECUTE through its grant above.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
