-- ============================================================
-- Restrict auth_user_with_allowlist to the Worker (service_role)
-- ============================================================
-- 20260624000001 created the function with `CREATE OR REPLACE`, which grants
-- EXECUTE to PUBLIC by default in Postgres/Supabase. That left this
-- SECURITY DEFINER function callable by the `anon` and `authenticated` roles via
-- PostgREST's `/rpc/auth_user_with_allowlist` endpoint — so an unauthenticated
-- caller who knows a user's UUID could read that user's email, organization, and
-- allowlist status. Only the Worker (which connects as service_role) needs it.
-- Revoke the implicit PUBLIC/anon/authenticated grants; the explicit service_role
-- grant from the prior migration remains.

REVOKE EXECUTE ON FUNCTION public.auth_user_with_allowlist(UUID) FROM PUBLIC, anon, authenticated;
