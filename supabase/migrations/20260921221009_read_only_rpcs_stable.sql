-- The two read only rpcs still declared VOLATILE become STABLE (#1409, L41).
--
-- The Worker's local dev guard now refuses any rpc that is not on an explicit
-- read only list (apps/worker/src/lib/read-only-rpcs.json), and the SQL suite
-- asserts every name on that list is STABLE or IMMUTABLE in the database, so the
-- list and the database cannot disagree about which rpcs read. Measured
-- 2026-09-21: every read rpc the Worker calls was already STABLE except these
-- two, which were created without a volatility marker and so defaulted to
-- VOLATILE. Neither writes: auth_user_with_allowlist selects a user row and its
-- allowlist membership, pg_cron_health reads the cron tables.
--
-- Expand only: a planner hint on two functions, with no change to what they do.
ALTER FUNCTION public.auth_user_with_allowlist(uuid) STABLE;
ALTER FUNCTION public.pg_cron_health(integer) STABLE;
