-- ============================================================
-- Allowlist membership as a boolean, not a readable table (#729)
-- ============================================================
-- EXPAND phase. `user_allowlist` carries one RLS policy, `allowlist_read`,
-- SELECT to `authenticated` with `USING (true)`. `NEXT_PUBLIC_SUPABASE_ANON_KEY`
-- is baked into the client bundle and the @trypennie.com rule lives in
-- application code, so any Google account that completes SSO holds an
-- `authenticated` JWT and can enumerate every internal employee email from the
-- REST API. That is LESSONS L18 failing today.
--
-- This is the same shape the Worker already uses for the same question
-- (auth_user_with_allowlist, 20260624000001): a security-definer function that
-- answers rather than a table that can be read. It returns only a boolean about
-- the CALLER, so there is nothing to enumerate even in principle: the caller
-- cannot ask about anybody else, because the address is taken from their own
-- verified JWT rather than from an argument.
--
-- Deliberately additive. The `allowlist_read` policy stays in place so this
-- applies safely in either order relative to the code deploy that starts using
-- it (docs/adr/0007-expand-contract-migrations.md). Revoking the SELECT is the
-- CONTRACT phase and ships in a later release, once the middleware calling this
-- function is fully live. Applying the revoke alongside this would open a
-- window where the running middleware still SELECTs, gets nothing, and sends
-- the whole team to /access-denied.

CREATE OR REPLACE FUNCTION public.is_allowlisted()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Matches the allowlist's lowercased storage convention, the same way
  -- handle_new_auth_user and auth_user_with_allowlist do.
  SELECT EXISTS (
    SELECT 1 FROM public.user_allowlist a
    WHERE a.email = lower(auth.jwt() ->> 'email')
  )
$$;

-- The browser calls this with the anon key plus the user's session, so the
-- grant is to `authenticated`. `anon` is deliberately excluded: a signed-out
-- caller has no JWT email and has no business asking.
GRANT EXECUTE ON FUNCTION public.is_allowlisted() TO authenticated;
