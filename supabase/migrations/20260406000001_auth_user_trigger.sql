-- ============================================================
-- Auto-create org + user records on new Supabase Auth signup
-- ============================================================

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

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
