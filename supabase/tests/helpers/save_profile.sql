-- pg_temp.save_profile: a buyer profile saved the way the partners page saves
-- it, through save_partner_page (#2133), for the suites that drove profile
-- saves through save_buyer_profile until it was dropped (#2187).
--
-- Same arguments and answer as the old function: the profile is compared at
-- p_expected_version and the saved profile document is returned. The partner
-- half is an empty patch at the partner's current version, so a case compares
-- only the profile, as it did. A refusal raises save_partner_page's own error
-- (BP409 stale_version carries the page's DETAIL, not the bare document).
--
-- Loaded by a suite with: \i /sql-suite-fixtures/tests/save_profile.sql
-- (the runner copies supabase/tests/helpers there, scripts/sql-suite/project.sh).
-- pg_temp lasts the suite's one psql session, so every call names the schema.
CREATE OR REPLACE FUNCTION pg_temp.save_profile(
  p_org uuid, p_partner uuid, p_expected_version integer, p_profile jsonb, p_actor uuid, p_actor_email text
) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.save_partner_page(
    p_org, p_partner,
    coalesce((SELECT version FROM public.partner_configs WHERE id = p_partner AND organization_id = p_org), 0),
    '{}'::jsonb, p_expected_version, p_profile, gen_random_uuid(), NULL, p_actor, p_actor_email, ''
  ) -> 'profile'
$$;
