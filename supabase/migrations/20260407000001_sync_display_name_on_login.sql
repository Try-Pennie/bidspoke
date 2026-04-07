-- ============================================================
-- Keep public.users.display_name fresh on every Google login
-- ============================================================
-- The insert trigger sets display_name once at signup, but if
-- raw_user_meta_data.full_name wasn't populated yet (e.g. Google
-- Workspace first-login timing), it falls back to the email prefix.
-- This trigger fires on auth.users UPDATE (i.e. every sign-in) and
-- overwrites display_name whenever a full_name is now available.

CREATE OR REPLACE FUNCTION public.handle_auth_user_updated()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.raw_user_meta_data->>'full_name' IS NOT NULL THEN
    UPDATE public.users
    SET display_name = NEW.raw_user_meta_data->>'full_name'
    WHERE id = NEW.id
      AND (display_name IS NULL OR display_name = split_part(NEW.email, '@', 1));
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_updated();

-- Backfill existing users whose display_name is currently the email prefix
UPDATE public.users u
SET display_name = au.raw_user_meta_data->>'full_name'
FROM auth.users au
WHERE u.id = au.id
  AND au.raw_user_meta_data->>'full_name' IS NOT NULL
  AND u.display_name = split_part(u.email, '@', 1);
