-- A buyer profile's collections cap (#2111).
--
-- buyer_profiles.collections_max_percent is a whole percent of debt, 1 to 100,
-- NULL meaning not judged. Both saves must store and return it, refuse anything
-- else by name, and KEEP the stored cap when a save does not send the key: the
-- cap is set through the API before the partners page has a control for it
-- (#2268), so a save from that page must never blank it. A later rewrite of
-- _apply_buyer_profile that loses the cap turns case 2 red.
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
-- Mutations tried (each turned its case red, then was put back, replayed with
-- --reset because the replay is incremental):
-- - the ELSE keeping the stored cap replaced by v_cap := NULL: case 2 red ("a
--   page save without the key left null").

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

DO $do$
BEGIN
  DELETE FROM public.buyer_pricing_tiers WHERE organization_id = '11111111-1111-1111-1111-000021110001';
  DELETE FROM public.buyer_operating_windows WHERE organization_id = '11111111-1111-1111-1111-000021110001';
  DELETE FROM public.buyer_blackout_dates WHERE organization_id = '11111111-1111-1111-1111-000021110001';
  DELETE FROM public.buyer_profiles WHERE organization_id = '11111111-1111-1111-1111-000021110001';
  DELETE FROM public.partner_configs WHERE organization_id = '11111111-1111-1111-1111-000021110001';
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021110001';
  DELETE FROM public.users WHERE organization_id = '11111111-1111-1111-1111-000021110001';
  DELETE FROM public.organizations WHERE id = '11111111-1111-1111-1111-000021110001';
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021110001', 'Cap Org', 'cap-org-2111');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-00002111000a', '11111111-1111-1111-1111-000021110001', 'erin@example.test', 'Erin Suite');

-- Each case has its own partner, with a saved offer profile at version 1 and no cap.
DO $do$
DECLARE
  n integer;
BEGIN
  FOR n IN 1..5 LOOP
    INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, accept_signals, updated_by, updated_by_email, updated_by_name)
    VALUES (format('33333333-3333-3333-3333-00002111000%s', n)::uuid, '11111111-1111-1111-1111-000021110001', format('Cap Buyer %s', n), format('cap-buyer-2111-%s', n),
            'buyer', true, '[{"field":"ok","equals":true}]'::jsonb, '22222222-2222-2222-2222-00002111000a', 'erin@example.test', 'Erin Suite');
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021110001', format('33333333-3333-3333-3333-00002111000%s', n)::uuid, 0,
      '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[]}'::jsonb,
      '22222222-2222-2222-2222-00002111000a', 'erin@example.test');
  END LOOP;
END
$do$;

-- A page save of one profile document, at the versions now stored.
CREATE OR REPLACE FUNCTION pg_temp.page_save(p_partner uuid, p_profile jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE pv integer; bv integer;
BEGIN
  SELECT version INTO pv FROM public.partner_configs WHERE id = p_partner;
  SELECT version INTO bv FROM public.buyer_profiles WHERE partner_id = p_partner;
  RETURN public.save_partner_page('11111111-1111-1111-1111-000021110001', p_partner, pv, '{}'::jsonb, bv, p_profile, gen_random_uuid(),
    '22222222-2222-2222-2222-00002111000a', 'erin@example.test', 'Erin Suite');
END
$$;

-- ── 1. A cap saves through the page save, reads back, and is audited ─────────
DO $do$
DECLARE
  out jsonb;
  v_before integer;
  v_after integer;
  v_audits integer;
BEGIN
  SELECT version INTO v_before FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110001';
  out := pg_temp.page_save('33333333-3333-3333-3333-000021110001', '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[],"collections_max_percent":75}'::jsonb);
  IF out -> 'profile' -> 'collections_max_percent' IS DISTINCT FROM '75'::jsonb THEN
    RAISE EXCEPTION 'case 1: saving 75 returned %', out -> 'profile' -> 'collections_max_percent';
  END IF;
  IF public.buyer_profile_document('33333333-3333-3333-3333-000021110001') -> 'collections_max_percent' IS DISTINCT FROM '75'::jsonb THEN
    RAISE EXCEPTION 'case 1: 75 did not read back from buyer_profile_document';
  END IF;
  SELECT version INTO v_after FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110001';
  IF v_after IS DISTINCT FROM v_before + 1 THEN RAISE EXCEPTION 'case 1: the version moved from % to %', v_before, v_after; END IF;
  SELECT count(*) INTO v_audits FROM public.audit_log
  WHERE organization_id = '11111111-1111-1111-1111-000021110001' AND entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-000021110001'
    AND changes -> 'collections_max_percent' -> 'new' = '75'::jsonb;
  IF v_audits IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'case 1: % audit rows record the cap becoming 75', v_audits; END IF;
  INSERT INTO suite_cases(name) VALUES ('a cap saves, reads back and is audited');
END
$do$;

-- ── 2. An absent key keeps the stored cap, through both saves ────────────────
DO $do$
DECLARE
  out jsonb;
  v_version integer;
BEGIN
  UPDATE public.buyer_profiles SET collections_max_percent = 75 WHERE partner_id = '33333333-3333-3333-3333-000021110002';
  out := pg_temp.page_save('33333333-3333-3333-3333-000021110002', '{"sold_on":"offer","is_enabled":false,"priority":2,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[]}'::jsonb);
  IF out -> 'profile' -> 'collections_max_percent' IS DISTINCT FROM '75'::jsonb THEN
    RAISE EXCEPTION 'case 2: a page save without the key left %', out -> 'profile' -> 'collections_max_percent';
  END IF;
  SELECT version INTO v_version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110002';
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021110001', '33333333-3333-3333-3333-000021110002', v_version,
    '{"sold_on":"offer","is_enabled":false,"priority":3,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[]}'::jsonb, '22222222-2222-2222-2222-00002111000a', 'erin@example.test');
  IF (SELECT collections_max_percent FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110002') IS DISTINCT FROM 75 THEN
    RAISE EXCEPTION 'case 2: the legacy save without the key cleared the cap';
  END IF;
  IF (SELECT priority FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110002') IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'case 2: the legacy save did not write its own change';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('absent key keeps the stored cap');
END
$do$;

-- ── 3. Null clears it ────────────────────────────────────────────────────────
DO $do$
DECLARE
  out jsonb;
BEGIN
  UPDATE public.buyer_profiles SET collections_max_percent = 60 WHERE partner_id = '33333333-3333-3333-3333-000021110003';
  out := pg_temp.page_save('33333333-3333-3333-3333-000021110003', '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[],"collections_max_percent":null}'::jsonb);
  IF (out -> 'profile') ? 'collections_max_percent' IS NOT TRUE OR out -> 'profile' -> 'collections_max_percent' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'case 3: a null cap left %', out -> 'profile';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('null clears the cap');
END
$do$;

-- ── 4. Anything but a whole number 1 to 100 is refused by name, writing nothing
DO $do$
DECLARE
  bad jsonb;
  v_message text;
  v_detail text;
  v_version integer;
  v_after integer;
BEGIN
  SELECT version INTO v_version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110004';
  FOREACH bad IN ARRAY ARRAY['0', '101', '-5', '75.5', '"75"', 'true']::jsonb[] LOOP
    v_message := NULL;
    BEGIN
      PERFORM pg_temp.page_save('33333333-3333-3333-3333-000021110004', '{"sold_on":"offer","is_enabled":false,"priority":9,"allowed_states":["CA"],"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[]}'::jsonb || jsonb_build_object('collections_max_percent', bad));
      RAISE EXCEPTION 'case 4: % was saved', bad;
    EXCEPTION WHEN SQLSTATE 'BP422' THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    END;
    IF v_message IS DISTINCT FROM 'collections_max_percent_invalid' OR v_detail IS DISTINCT FROM bad::text THEN
      RAISE EXCEPTION 'case 4: % refused as % (%), expected collections_max_percent_invalid', bad, v_message, v_detail;
    END IF;
  END LOOP;
  SELECT version INTO v_after FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110004';
  IF v_after IS DISTINCT FROM v_version OR (SELECT priority FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021110004') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'case 4: a refused save wrote something';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('outside the range refused by name');
END
$do$;

-- ── 5. A hand write outside the range meets the CHECK ────────────────────────
DO $do$
BEGIN
  BEGIN
    UPDATE public.buyer_profiles SET collections_max_percent = 0 WHERE partner_id = '33333333-3333-3333-3333-000021110005';
    RAISE EXCEPTION 'case 5: the CHECK let 0 through';
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
  IF n IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'buyer_profile_collections_cap.test.sql: expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'buyer_profile_collections_cap.test.sql: % cases passed', n;
END
$do$;
