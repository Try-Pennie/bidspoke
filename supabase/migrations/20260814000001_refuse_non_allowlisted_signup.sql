-- ============================================================
-- Refuse the credential for a non-allowlisted signup (#759)
-- ============================================================
-- Declining to PROVISION someone is not declining to AUTHENTICATE them.
--
-- 20260623000001 stopped `handle_new_auth_user` from creating an organization
-- and a `public.users` row for an address that is not on `user_allowlist`, but
-- it did so with `RETURN NEW`. The `auth.users` INSERT therefore still
-- committed, and GoTrue still issued a real `authenticated` JWT. Any Google
-- account that completed SSO ended up holding the exact session key every RLS
-- policy written against the `authenticated` role has to defend against, which
-- is what made the #729 allowlist enumeration reachable in the first place.
-- Nothing pruned those rows either, so they accumulated indefinitely.
--
-- This makes the refusal happen at the credential. The trigger is AFTER INSERT
-- ON auth.users, so raising here aborts the transaction: no auth row, no
-- session, nothing to prune, and nothing for a later policy mistake to trust.
--
-- Measured on production before applying, not assumed (2026-08-13/14):
--   * auth.users 7, public.users 7, user_allowlist 8, orphan auth rows 0.
--     So there is no backlog to clean; the prune below is preventative.
--   * One account, a pre-allowlist signup from 2026-04-07, holds a
--     `public.users` row while being off the allowlist. It is already denied by
--     the Worker (auth_user_with_allowlist returns allowed=false -> 403), so
--     this is a leftover record rather than a live hole. It is deliberately
--     NOT touched here: removing someone's access record is a decision for a
--     human, and the prune below is keyed so it can never reach that row.
--
-- Signing IN is unaffected: this trigger fires on INSERT only, so all seven
-- existing accounts keep working. A new teammate is added to `user_allowlist`
-- first (the existing flow, since provisioning already required it) and then
-- signs in.
--
-- Fail-closed by construction: an email that is NULL, or an allowlist that
-- cannot be read, both make the NOT EXISTS true and refuse the signup. An
-- empty protective list must never read as "no protection" (LESSONS L42).

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id UUID;
  email_domain TEXT;
  org_slug TEXT;
BEGIN
  -- Refuse outright rather than provisioning nothing. Matches the allowlist's
  -- lowercased storage convention.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_allowlist
    WHERE email = lower(NEW.email)
  ) THEN
    -- insufficient_privilege (42501). The message deliberately names no
    -- allowlist and echoes no address back, so a refusal reveals nothing about
    -- who does have access. GoTrue surfaces this to the caller as a failed
    -- signup; the browser gate already routes an unauthenticated visitor to
    -- /login and a denied one to /access-denied.
    RAISE EXCEPTION 'signup refused: this address is not authorized for this application'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  email_domain := split_part(NEW.email, '@', 2);
  org_slug := lower(regexp_replace(email_domain, '[^a-z0-9]', '-', 'g'));

  -- Reuse existing org if one already exists for this domain (e.g. second team member)
  SELECT id INTO new_org_id
  FROM public.organizations
  WHERE slug = org_slug
  LIMIT 1;

  IF new_org_id IS NULL THEN
    INSERT INTO public.organizations (name, slug)
    VALUES (email_domain, org_slug)
    RETURNING id INTO new_org_id;
  END IF;

  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES (
    NEW.id,
    new_org_id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ============================================================
-- Prune orphan auth.users rows
-- ============================================================
-- Belt and braces for the rows the refusal above can no longer create: an
-- `auth.users` row with no matching `public.users` record has no route into the
-- application, and holding a credential for one is pure liability.
--
-- Keyed on the ABSENCE OF THE APP RECORD, never on allowlist membership. The
-- one off-allowlist account described above holds a users row, and an
-- allowlist-keyed delete would remove a real employee's account to enforce what
-- is only a list-membership preference (LESSONS L116).
--
-- The 24 hour floor keeps it clear of any in-flight signup: the provisioning
-- INSERT above happens inside the same transaction, so a fresh row is never
-- legitimately orphaned, but a wide margin means a future auth flow that
-- provisions asynchronously cannot be raced into having its user deleted.
--
-- Returns the number of rows deleted rather than void. It is expected to find
-- nothing on almost every run, and a cleanup that reports nothing cannot be
-- told apart from one that silently stopped working (LESSONS L98).

CREATE OR REPLACE FUNCTION public.prune_orphan_auth_users()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH doomed AS (
    DELETE FROM auth.users au
    WHERE au.created_at < now() - INTERVAL '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.users u WHERE u.id = au.id
      )
    RETURNING au.id
  )
  SELECT count(*) INTO deleted_count FROM doomed;

  IF deleted_count > 0 THEN
    RAISE LOG 'prune_orphan_auth_users deleted % orphan auth.users row(s)', deleted_count;
  END IF;

  RETURN deleted_count;
END;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, so the REVOKE is the
-- line that actually does the protecting here; without it this security-definer
-- function that deletes auth rows would be callable by `anon` over the REST API
-- (LESSONS L124, and the wider sweep in #764).
REVOKE ALL ON FUNCTION public.prune_orphan_auth_users() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_orphan_auth_users() FROM anon;
REVOKE ALL ON FUNCTION public.prune_orphan_auth_users() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prune_orphan_auth_users() TO service_role;

-- Weekly is proportionate: with the refusal in place this should never find a
-- row, and it is a safety net rather than a load-bearing cleanup.
SELECT cron.unschedule('prune-orphan-auth-users')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-orphan-auth-users');

SELECT cron.schedule(
  'prune-orphan-auth-users',
  '17 4 * * 0',
  $$SELECT public.prune_orphan_auth_users()$$
);
