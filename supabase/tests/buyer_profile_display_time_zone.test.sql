-- The zone a buyer profile's hours are shown in (#2143, PM-10).
--
-- buyer_profiles.display_time_zone is a closed list: the CHECK must allow
-- exactly DISPLAY_TIME_ZONES (packages/buyer-profile/src/clock.ts), which the
-- suite receives as the generated fixture display-time-zones.json (L41), and
-- both saves must refuse anything else by name, keep the stored zone when the
-- key is absent, and return it in the document.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds by replaying every migration from empty, never production. Fixed ids
-- used nowhere else, no real identity. Fixtures are deleted first so a rerun is
-- idempotent.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, each
-- counted into suite_cases; the last statement compares the count with the
-- number written there (L288). IS DISTINCT FROM, never <>.
--
-- Mutations tried (each turned its case red, then was put back):
-- - 'America/Phoenix' added to the CHECK only: case 1 red;
-- - the CASE keeping the stored zone replaced by p_profile->>'display_time_zone':
--   case 3 red (an absent key cleared the zone);
-- - America/Denver left off _apply_buyer_profile's list: case 2 red;
-- - 'display_time_zone' left out of buyer_profile_document: case 2 red.

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

DO $do$
BEGIN
  DELETE FROM public.buyer_pricing_tiers WHERE organization_id = '11111111-1111-1111-1111-000021430001';
  DELETE FROM public.buyer_operating_windows WHERE organization_id = '11111111-1111-1111-1111-000021430001';
  DELETE FROM public.buyer_blackout_dates WHERE organization_id = '11111111-1111-1111-1111-000021430001';
  DELETE FROM public.buyer_profiles WHERE organization_id = '11111111-1111-1111-1111-000021430001';
  DELETE FROM public.partner_configs WHERE organization_id = '11111111-1111-1111-1111-000021430001';
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021430001';
  DELETE FROM public.users WHERE organization_id = '11111111-1111-1111-1111-000021430001';
  DELETE FROM public.organizations WHERE id = '11111111-1111-1111-1111-000021430001';
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021430001', 'Zone Org', 'zone-org-2143');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-00002143000a', '11111111-1111-1111-1111-000021430001', 'erin@example.test', 'Erin Suite');

-- Each case has its own partner, with a saved offer profile at version 1 and no zone.
DO $do$
DECLARE
  n integer;
BEGIN
  FOR n IN 1..5 LOOP
    INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, accept_signals, updated_by, updated_by_email, updated_by_name)
    VALUES (format('33333333-3333-3333-3333-00002143000%s', n)::uuid, '11111111-1111-1111-1111-000021430001', format('Zone Buyer %s', n), format('zone-buyer-2143-%s', n),
            'buyer', true, '[{"field":"ok","equals":true}]'::jsonb, '22222222-2222-2222-2222-00002143000a', 'erin@example.test', 'Erin Suite');
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021430001', format('33333333-3333-3333-3333-00002143000%s', n)::uuid, 0,
      '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[]}'::jsonb,
      '22222222-2222-2222-2222-00002143000a', 'erin@example.test');
  END LOOP;
END
$do$;

-- A page save of one profile document, at the versions now stored.
CREATE OR REPLACE FUNCTION pg_temp.page_save(p_partner uuid, p_profile jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE pv integer; bv integer;
BEGIN
  SELECT version INTO pv FROM public.partner_configs WHERE id = p_partner;
  SELECT version INTO bv FROM public.buyer_profiles WHERE partner_id = p_partner;
  RETURN public.save_partner_page('11111111-1111-1111-1111-000021430001', p_partner, pv, '{}'::jsonb, bv, p_profile, gen_random_uuid(),
    '22222222-2222-2222-2222-00002143000a', 'erin@example.test', 'Erin Suite');
END
$$;

-- ── 1. The CHECK allows exactly the constant's zones ─────────────────────────
DO $do$
DECLARE
  v_def text;
  v_check text[];
  v_constant text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.buyer_profiles'::regclass AND c.conname = 'buyer_profiles_display_time_zone_check';
  IF v_def IS NULL THEN RAISE EXCEPTION 'case 1: buyer_profiles has no display_time_zone CHECK'; END IF;
  SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") INTO v_check FROM regexp_matches(v_def, '''([^'']+)''', 'g') m;
  SELECT array_agg(z ORDER BY z COLLATE "C") INTO v_constant
  FROM jsonb_array_elements_text(pg_read_file('/sql-suite-fixtures/buyer-profile/display-time-zones.json')::jsonb -> 'zones') z;
  IF coalesce(array_length(v_constant, 1), 0) < 4 THEN RAISE EXCEPTION 'case 1: the fixture holds % zones', coalesce(array_length(v_constant, 1), 0); END IF;
  IF v_check IS DISTINCT FROM v_constant THEN
    RAISE EXCEPTION 'case 1: the CHECK allows % but DISPLAY_TIME_ZONES is %', v_check, v_constant;
  END IF;
  INSERT INTO suite_cases(name) VALUES ('CHECK equals DISPLAY_TIME_ZONES');
END
$do$;

-- ── 2. Every zone saves through the page save and reads back, audited ────────
DO $do$
DECLARE
  z text;
  out jsonb;
  v_before integer;
  v_after integer;
  v_audits integer;
BEGIN
  FOR z IN SELECT jsonb_array_elements_text(pg_read_file('/sql-suite-fixtures/buyer-profile/display-time-zones.json')::jsonb -> 'zones') LOOP
    SELECT version INTO v_before FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021430001';
    out := pg_temp.page_save('33333333-3333-3333-3333-000021430001',
      jsonb_build_object('sold_on', 'offer', 'is_enabled', false, 'priority', 1, 'allowed_states', '["CA"]'::jsonb,
        'windows', '[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}]'::jsonb, 'blackout_dates', '[]'::jsonb, 'tiers', '[]'::jsonb,
        'display_time_zone', z));
    IF out -> 'profile' ->> 'display_time_zone' IS DISTINCT FROM z THEN
      RAISE EXCEPTION 'case 2: saving % returned %', z, out -> 'profile' -> 'display_time_zone';
    END IF;
    IF public.buyer_profile_document('33333333-3333-3333-3333-000021430001') ->> 'display_time_zone' IS DISTINCT FROM z THEN
      RAISE EXCEPTION 'case 2: % did not read back from buyer_profile_document', z;
    END IF;
    SELECT version INTO v_after FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021430001';
    IF v_after IS DISTINCT FROM v_before + 1 THEN RAISE EXCEPTION 'case 2: saving % moved the version from % to %', z, v_before, v_after; END IF;
    SELECT count(*) INTO v_audits FROM public.audit_log
    WHERE organization_id = '11111111-1111-1111-1111-000021430001' AND entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-000021430001'
      AND changes -> 'display_time_zone' ->> 'new' = z;
    IF v_audits IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'case 2: % audit rows record the zone becoming %', v_audits, z;
    END IF;
  END LOOP;
  INSERT INTO suite_cases(name) VALUES ('every zone saves, reads back and is audited');
END
$do$;

-- ── 3. An absent key keeps the stored zone, through both saves ───────────────
DO $do$
DECLARE
  out jsonb;
  v_version integer;
BEGIN
  UPDATE public.buyer_profiles SET display_time_zone = 'America/Denver' WHERE partner_id = '33333333-3333-3333-3333-000021430002';
  out := pg_temp.page_save('33333333-3333-3333-3333-000021430002',
    '{"sold_on":"offer","is_enabled":false,"priority":2,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[]}'::jsonb);
  IF out -> 'profile' ->> 'display_time_zone' IS DISTINCT FROM 'America/Denver' THEN
    RAISE EXCEPTION 'case 3: a page save without the key left %', out -> 'profile' -> 'display_time_zone';
  END IF;
  SELECT version INTO v_version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021430002';
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021430001', '33333333-3333-3333-3333-000021430002', v_version,
    '{"sold_on":"offer","is_enabled":false,"priority":3,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[]}'::jsonb,
    '22222222-2222-2222-2222-00002143000a', 'erin@example.test');
  IF (SELECT display_time_zone FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021430002') IS DISTINCT FROM 'America/Denver' THEN
    RAISE EXCEPTION 'case 3: the legacy save without the key cleared the zone';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('absent key keeps the stored zone');
END
$do$;

-- ── 4. Null clears it back to never chosen ───────────────────────────────────
DO $do$
DECLARE
  out jsonb;
BEGIN
  UPDATE public.buyer_profiles SET display_time_zone = 'America/Chicago' WHERE partner_id = '33333333-3333-3333-3333-000021430003';
  out := pg_temp.page_save('33333333-3333-3333-3333-000021430003',
    '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[],"display_time_zone":null}'::jsonb);
  IF (out -> 'profile') ? 'display_time_zone' IS NOT TRUE OR out -> 'profile' -> 'display_time_zone' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'case 4: a null zone left %', out -> 'profile';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('null clears the zone');
END
$do$;

-- ── 5. A zone outside the list is refused by name, and nothing is written ────
DO $do$
DECLARE
  v_state text;
  v_message text;
  v_detail text;
  v_version integer;
  v_after integer;
BEGIN
  SELECT version INTO v_version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021430004';
  BEGIN
    PERFORM pg_temp.page_save('33333333-3333-3333-3333-000021430004',
      '{"sold_on":"offer","is_enabled":false,"priority":4,"allowed_states":["CA"],"windows":[],"blackout_dates":[],"tiers":[],"display_time_zone":"America/Phoenix"}'::jsonb);
    RAISE EXCEPTION 'case 5: America/Phoenix was saved';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF v_message IS DISTINCT FROM 'display_time_zone_invalid' OR v_detail IS DISTINCT FROM 'America/Phoenix' THEN
    RAISE EXCEPTION 'case 5: refused as % (%), expected display_time_zone_invalid (America/Phoenix)', v_message, v_detail;
  END IF;
  SELECT version INTO v_after FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021430004';
  IF v_after IS DISTINCT FROM v_version OR (SELECT priority FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021430004') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'case 5: the refused save wrote something';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('outside the list refused by name');
END
$do$;

-- ── 6. A hand write outside the list meets the CHECK ─────────────────────────
DO $do$
BEGIN
  BEGIN
    UPDATE public.buyer_profiles SET display_time_zone = 'Eastern' WHERE partner_id = '33333333-3333-3333-3333-000021430005';
    RAISE EXCEPTION 'case 6: the CHECK let Eastern through';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO suite_cases(name) VALUES ('CHECK refuses a hand write');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 6 THEN RAISE EXCEPTION 'buyer_profile_display_time_zone.test.sql: expected 6 cases, % ran', n; END IF;
  RAISE NOTICE 'buyer_profile_display_time_zone.test.sql: % cases passed', n;
END
$do$;
