-- ============================================================
-- Gate auto-provisioning on the access allowlist
-- ============================================================
-- Previously handle_new_auth_user() created an organization + users row for
-- ANY Google signup. Combined with the Worker only checking that a users row
-- exists (not that the email is allowlisted), a non-allowlisted account could
-- bootstrap access. Now provisioning only happens for allowlisted emails;
-- everyone else gets an auth.users row but no app records, so the Worker's
-- allowlist check (and the browser gate) deny them.

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
  -- Only provision app records for allowlisted emails. Match the allowlist's
  -- lowercased storage convention.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_allowlist
    WHERE email = lower(NEW.email)
  ) THEN
    RETURN NEW;
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
