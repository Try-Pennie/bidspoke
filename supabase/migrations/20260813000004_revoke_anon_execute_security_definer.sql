-- ============================================================
-- Revoke anonymous EXECUTE on security-definer functions (#762)
-- ============================================================
-- Postgres grants EXECUTE to PUBLIC by default on every new function, so a
-- SECURITY DEFINER function is callable by `anon` over /rest/v1/rpc unless the
-- migration explicitly revokes it. Nothing here ever did.
--
-- Measured on prod 2026-08-13, read-only: an anonymous request carrying only
-- NEXT_PUBLIC_SUPABASE_ANON_KEY (public, it is baked into the client bundle)
-- got HTTP 200 from /rest/v1/rpc/user_org_id. The exposure path is live.
--
-- The two that matter are `finalize_unrecoverable_stranded` and
-- `reduce_finalize_stranded`: both WRITE, both run as their definer so they
-- bypass RLS, and both take a caller-supplied argument. An anonymous caller
-- could pass a zero age and mass-finalize live in-flight executions.
--
-- Safe to revoke, verified rather than assumed. Their only callers are three
-- pg_cron jobs (finalize-unrecoverable-stranded, reduce-finalize-stranded,
-- reduce-finalize-stranded-deep) running as `postgres`, which also OWNS these
-- functions, and an owner keeps EXECUTE regardless of what PUBLIC holds.
--
-- The trigger functions are not REST-callable (PostgREST does not expose a
-- function returning `trigger`), and a trigger fires without consulting the
-- invoking user's EXECUTE privilege, so revoking is tidiness rather than a fix.
--
-- DELIBERATELY NOT REVOKED: public.user_org_id(). Revoking it would break the
-- app rather than harden it, because 28 RLS policies call it and a policy whose
-- function the querying role cannot execute ERRORS rather than denying. It also
-- leaks nothing: it returns the caller's own organization derived from their own
-- JWT, and an anonymous caller measurably gets null. That exemption and its
-- reason are pinned in apps/web/src/lib/__tests__/security-definer-grants.test.ts.

-- The writers. This is the actual fix.
REVOKE ALL ON FUNCTION public.finalize_unrecoverable_stranded(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reduce_finalize_stranded(integer) FROM PUBLIC, anon, authenticated;

-- Trigger and event-trigger functions. Not REST-callable; revoked so the
-- default does not silently become the rule again.
REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_auth_user_updated() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
