-- ============================================================
-- Close the allowlist enumeration hole (#729, contract phase)
-- ============================================================
-- CONTRACT phase of #729. The expand phase (20260813000001 and
-- 20260813000002) added `is_allowlisted()` and moved the middleware onto it.
-- This removes the table read that the middleware no longer uses.
--
-- What was wrong: `allowlist_read` was SELECT to `authenticated` with
-- USING (true), and NEXT_PUBLIC_SUPABASE_ANON_KEY is compile-time baked into
-- the client bundle, so any Google account that completed SSO held an
-- `authenticated` JWT and could read every internal employee address from the
-- REST API. Measured 2026-08-13, signed in as a real user: 8 rows returned.
--
-- Preconditions verified before applying, not assumed:
--   * Pages deploy of e78dd6f live; GET /workflows signed out returns
--     x-bidspoke-gate: redirect-login, so the middleware is running.
--   * GET /workflows as a signed-in allowlisted employee returned
--     x-bidspoke-gate: allow, so is_allowlisted() is reachable from the
--     deployed edge runtime and the app does not depend on this policy.
--
-- Every remaining reader is exempt from RLS and from these grants:
--   * is_allowlisted() and auth_user_with_allowlist() are SECURITY DEFINER.
--   * handle_new_auth_user() is SECURITY DEFINER.
--   * the Worker's /api/access routes connect as service_role.
--
-- Not included on purpose: the leftover INSERT/UPDATE/DELETE/TRUNCATE grants
-- on this table, which are inert (RLS has no policy for those commands) and
-- are tracked with the wider sweep in #761.

DROP POLICY IF EXISTS "allowlist_read" ON public.user_allowlist;

REVOKE SELECT ON public.user_allowlist FROM authenticated;
REVOKE SELECT ON public.user_allowlist FROM anon;
