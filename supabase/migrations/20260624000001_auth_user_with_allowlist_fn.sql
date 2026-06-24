-- ============================================================
-- One-round-trip auth lookup: user row + allowlist membership
-- ============================================================
-- The Worker's jwtAuth middleware previously ran two sequential queries per
-- authenticated request: a users lookup, then a separate user_allowlist check
-- (#326). This folds both into a single query so each signed-in request makes
-- one DB round-trip instead of two (#329).
--
-- Behavior the caller relies on (unchanged):
--   * no row returned        -> user not found        -> 401
--   * row with allowed=false -> on users, not allowed -> 403
--   * RPC error              -> real lookup failure   -> 500
--   * row with allowed=true  -> proceed
--
-- Matches the allowlist's lowercased storage convention (see
-- handle_new_auth_user). SECURITY DEFINER with a locked search_path so the
-- guarantee holds regardless of the caller's role/search_path.

CREATE OR REPLACE FUNCTION public.auth_user_with_allowlist(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  organization_id UUID,
  email TEXT,
  display_name TEXT,
  allowed BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id,
    u.organization_id,
    u.email,
    u.display_name,
    EXISTS (
      SELECT 1 FROM public.user_allowlist a
      WHERE a.email = lower(u.email)
    ) AS allowed
  FROM public.users u
  WHERE u.id = p_user_id
$$;

-- The Worker connects as service_role (bypasses RLS). Grant execute explicitly
-- so the RPC is callable even if PUBLIC execute is revoked on this schema.
GRANT EXECUTE ON FUNCTION public.auth_user_with_allowlist(UUID) TO service_role;
