-- ============================================================
-- Lock is_allowlisted() to signed-in callers only (#729)
-- ============================================================
-- Corrects a defect in 20260813000001. That migration granted EXECUTE to
-- `authenticated` and its comment claimed `anon` was deliberately excluded, but
-- Postgres grants EXECUTE to PUBLIC by default on a new function, so the grant
-- was redundant and the exclusion never took effect. Measured after applying:
-- has_function_privilege('anon', ...) came back true.
--
-- Not a data leak (a caller with no JWT has no email, so the function returns
-- false, verified), but a security-definer function reachable by `anon` over
-- /rest/v1/rpc is a standing invitation, and a comment describing protection
-- that is not there is worse than no comment.
--
-- Safe in any order relative to the code deploy: the middleware calls this as
-- `authenticated`, which keeps its grant, and nothing else calls it.

REVOKE ALL ON FUNCTION public.is_allowlisted() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_allowlisted() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_allowlisted() TO authenticated;
