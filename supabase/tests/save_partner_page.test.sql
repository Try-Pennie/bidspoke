-- One transaction for the whole page save (#2133, part of #2114).
--
-- save_partner_page writes the partner patch and the buyer profile together or
-- not at all, at the pair of versions the page was edited from. Before it, the
-- page saved the partner and then the profile in two calls, so a refused
-- profile left the partner half saved ("Partner saved. The buyer profile was
-- not saved").
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
-- - the wrapper's set_config('bidspoke.audit_handled', 'save_buyer_profile')
--   moved into _apply_buyer_profile: case 5 red (the setting reads
--   save_buyer_profile after a page save);
-- - 'save_partner_page' left off the child table detector's skip list: case 5
--   red (direct_sql rows for the windows and tiers the save rewrote);
-- - save_buyer_profile checking the partner with a plain EXISTS instead of
--   locking its row first: case 9 red (deadlock detected);
-- - the profile version compared only when the partner version matches: case 3
--   red;
-- - last_save_id not set on the profile row: case 1 red.

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

-- run.sh hands over the container's own address (self_host) for the
-- concurrency case's second and third sessions. Checked before anything is
-- created, so a refusal leaves nothing behind.
\if :{?self_host}
\else
  \echo 'save_partner_page.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('spp_test.self_host', :'self_host', false) AS self_host_set \gset

DO $do$
BEGIN
  DELETE FROM public.buyer_pricing_tiers WHERE organization_id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
  DELETE FROM public.buyer_operating_windows WHERE organization_id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
  DELETE FROM public.buyer_blackout_dates WHERE organization_id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
  DELETE FROM public.buyer_profiles WHERE organization_id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
  DELETE FROM public.partner_configs WHERE organization_id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
  DELETE FROM public.users WHERE organization_id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
  DELETE FROM public.organizations WHERE id IN ('11111111-1111-1111-1111-000021330001', '11111111-1111-1111-1111-000021330002');
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021330001', 'Page Org', 'page-org-2133');
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021330002', 'Other Page Org', 'other-page-org-2133');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-00002133000a', '11111111-1111-1111-1111-000021330001', 'carol@example.test', 'Carol Suite');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-00002133000b', '11111111-1111-1111-1111-000021330001', 'dave@example.test', 'Dave Suite');

-- The fixture partners. Each case uses its own, so a case's writes cannot make
-- another case's versions stale.
DO $do$
DECLARE
  n integer;
BEGIN
  FOR n IN 1..9 LOOP
    INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, accept_signals, updated_by, updated_by_email, updated_by_name)
    VALUES (format('33333333-3333-3333-3333-00002133000%s', n)::uuid, '11111111-1111-1111-1111-000021330001', format('Page Buyer %s', n), format('page-buyer-2133-%s', n),
            'buyer', true, '[{"field":"ok","equals":true}]'::jsonb, '22222222-2222-2222-2222-00002133000a', 'carol@example.test', 'Carol Suite');
  END LOOP;
  -- Every fixture but 6 and 9 starts with a saved offer profile at version 1.
  FOR n IN 1..8 LOOP
    CONTINUE WHEN n = 6;
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021330001', format('33333333-3333-3333-3333-00002133000%s', n)::uuid, 0,
      '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
      '22222222-2222-2222-2222-00002133000a', 'carol@example.test');
  END LOOP;
END
$do$;

-- ── 1. One save writes both halves, records the press on both rows ───────────
DO $do$
DECLARE
  out jsonb;
  pv0 integer;
BEGIN
  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330001';
  out := public.save_partner_page(
    '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330001', pv0, '{"daily_cap": 77}'::jsonb,
    1, '{"sold_on":"offer","is_enabled":false,"priority":2,"allowed_states":["CA","TX"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    'aaaaaaaa-0000-4000-8000-000000002131', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
  IF (out->'partner'->>'daily_cap')::int IS DISTINCT FROM 77 THEN RAISE EXCEPTION 'the partner half was not written: %', out->'partner'; END IF;
  IF (out->>'partner_version')::int IS DISTINCT FROM pv0 + 1 THEN RAISE EXCEPTION 'partner_version should be %, is %', pv0 + 1, out->>'partner_version'; END IF;
  IF (out->'profile'->>'priority')::int IS DISTINCT FROM 2 OR out->'profile'->'allowed_states' IS DISTINCT FROM '["CA","TX"]'::jsonb THEN
    RAISE EXCEPTION 'the profile half was not written: %', out->'profile';
  END IF;
  -- Moved once: the page's own audit_handled keeps the bump trigger out of it.
  IF (out->>'profile_version')::int IS DISTINCT FROM 2 OR (out->'profile'->>'version')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'the profile version should move once, to 2: %', out;
  END IF;
  IF (SELECT last_save_id FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330001') IS DISTINCT FROM 'aaaaaaaa-0000-4000-8000-000000002131'::uuid
     OR (SELECT last_save_id FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021330001') IS DISTINCT FROM 'aaaaaaaa-0000-4000-8000-000000002131'::uuid THEN
    RAISE EXCEPTION 'last_save_id is not on both rows';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('writes both halves');
END
$do$;

-- ── 2. A stale partner half writes neither half ──────────────────────────────
DO $do$
DECLARE
  pv0 integer;
  v_detail text;
  d jsonb;
BEGIN
  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330002';
  BEGIN
    PERFORM public.save_partner_page(
      '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330002', pv0 + 5, '{"daily_cap": 5}'::jsonb,
      1, '{"sold_on":"offer","is_enabled":false,"priority":9,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
      'aaaaaaaa-0000-4000-8000-000000002132', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
    RAISE EXCEPTION 'a stale partner version was accepted';
  EXCEPTION WHEN SQLSTATE 'BP409' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  d := v_detail::jsonb;
  IF NOT (d ? 'partner' AND d ? 'profile' AND d ? 'partner_version' AND d ? 'profile_version' AND d ? 'last_save_id' AND d ? 'changed_by_name' AND d ? 'changed_at') THEN
    RAISE EXCEPTION 'the refusal does not carry both halves: %', d;
  END IF;
  IF (d->>'partner_version')::int IS DISTINCT FROM pv0 OR (d->>'profile_version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'the refusal names the wrong versions: %', d; END IF;
  IF (d->'profile'->>'priority')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'the refusal profile is not the stored one: %', d->'profile'; END IF;
  IF d->>'changed_by_name' IS DISTINCT FROM 'Carol Suite' THEN RAISE EXCEPTION 'the last editor should be Carol Suite, is %', d->>'changed_by_name'; END IF;
  IF (SELECT daily_cap FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330002') IS NOT NULL THEN RAISE EXCEPTION 'the partner half was written'; END IF;
  IF (SELECT priority FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021330002') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'the profile half was written'; END IF;
  INSERT INTO suite_cases(name) VALUES ('stale partner writes neither');
END
$do$;

-- ── 3. A stale profile half writes neither half ──────────────────────────────
DO $do$
DECLARE
  pv0 integer;
  v_detail text;
BEGIN
  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330003';
  BEGIN
    PERFORM public.save_partner_page(
      '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330003', pv0, '{"daily_cap": 5}'::jsonb,
      0, '{"sold_on":"offer","is_enabled":false,"priority":9,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
      'aaaaaaaa-0000-4000-8000-000000002133', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
    RAISE EXCEPTION 'a stale profile version was accepted';
  EXCEPTION WHEN SQLSTATE 'BP409' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF (v_detail::jsonb->>'profile_version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'the refusal names the wrong profile version: %', v_detail; END IF;
  IF (SELECT daily_cap FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330003') IS NOT NULL THEN RAISE EXCEPTION 'the partner half was written'; END IF;
  IF (SELECT version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330003') IS DISTINCT FROM pv0 THEN RAISE EXCEPTION 'the partner version moved'; END IF;
  IF (SELECT priority FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021330003') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'the profile half was written'; END IF;
  INSERT INTO suite_cases(name) VALUES ('stale profile writes neither');
END
$do$;

-- ── 4. A profile refusal rolls back the partner patch ────────────────────────
DO $do$
DECLARE
  pv0 integer;
  v_msg text;
BEGIN
  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330004';
  BEGIN
    -- The only tier starts above the debt minimum: tiers_gap.
    PERFORM public.save_partner_page(
      '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330004', pv0, '{"daily_cap": 5}'::jsonb,
      1, '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":20000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
      'aaaaaaaa-0000-4000-8000-000000002134', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
    RAISE EXCEPTION 'a profile with a tier gap was accepted';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
  END;
  IF v_msg IS DISTINCT FROM 'tiers_gap' THEN RAISE EXCEPTION 'expected tiers_gap, got %', v_msg; END IF;
  IF (SELECT daily_cap FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330004') IS NOT NULL THEN RAISE EXCEPTION 'the partner patch survived the profile refusal'; END IF;
  IF (SELECT last_save_id FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330004') IS NOT NULL THEN RAISE EXCEPTION 'the press was recorded on a refused save'; END IF;
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-000021330004' AND changes ? 'daily_cap') IS DISTINCT FROM 0::bigint THEN
    RAISE EXCEPTION 'the refused save left a partner audit row';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('profile refusal rolls back the partner');
END
$do$;

-- ── 5. Audit rows carry the actor, and audit_handled is the page's throughout ──
DO $do$
DECLARE
  pv0 integer;
  before_n bigint;
  p jsonb;
  bp record;
BEGIN
  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330005';
  SELECT count(*) INTO before_n FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021330001';
  PERFORM public.save_partner_page(
    '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330005', pv0, '{"name": "Page Buyer 5 renamed"}'::jsonb,
    1, '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":2,"opens_minute":600,"closes_minute":1000}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.02}]}'::jsonb,
    'aaaaaaaa-0000-4000-8000-000000002135', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
  -- Still inside the save's transaction: the setting the page set is the one left.
  IF current_setting('bidspoke.audit_handled', true) IS DISTINCT FROM 'save_partner_page' THEN
    RAISE EXCEPTION 'audit_handled after a page save is %, not save_partner_page', current_setting('bidspoke.audit_handled', true);
  END IF;
  -- Exactly two rows: the partner's and the profile's. A direct_sql row would mean
  -- the child table detector did not recognise the page save.
  IF (SELECT count(*) FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021330001') - before_n IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'expected 2 audit rows, got %: %', (SELECT count(*) FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021330001') - before_n,
      (SELECT jsonb_agg(changes) FROM (SELECT changes FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021330001' ORDER BY changed_at DESC LIMIT 6) x);
  END IF;
  SELECT changes INTO p FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-000021330005' ORDER BY changed_at DESC LIMIT 1;
  IF p->'_actor' IS DISTINCT FROM '{"name": "Dave Suite", "email": "dave@example.test"}'::jsonb THEN RAISE EXCEPTION 'partner audit row actor: %', p; END IF;
  SELECT changed_by, changes INTO bp FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-000021330005' ORDER BY changed_at DESC LIMIT 1;
  IF bp.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-00002133000b'::uuid THEN RAISE EXCEPTION 'profile audit row changed_by: %', bp.changed_by; END IF;
  IF bp.changes->'_actor' IS DISTINCT FROM '{"name": "Dave Suite", "email": "dave@example.test"}'::jsonb THEN RAISE EXCEPTION 'profile audit row actor: %', bp.changes; END IF;
  IF bp.changes ? '_route' THEN RAISE EXCEPTION 'a page save was tagged as the legacy route: %', bp.changes; END IF;
  IF NOT (bp.changes ? 'tiers.engine.10000.multiplier') THEN RAISE EXCEPTION 'profile audit row lost its paths: %', bp.changes; END IF;
  INSERT INTO suite_cases(name) VALUES ('audit rows carry the actor');
END
$do$;

-- ── 6. A partner with no profile: a save naming no profile leaves it alone ───
DO $do$
DECLARE
  out jsonb;
  pv0 integer;
BEGIN
  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330006';
  out := public.save_partner_page(
    '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330006', pv0, '{"daily_cap": 6}'::jsonb,
    NULL, NULL, 'aaaaaaaa-0000-4000-8000-000000002136', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
  IF (out->'partner'->>'daily_cap')::int IS DISTINCT FROM 6 THEN RAISE EXCEPTION 'the partner half was not written: %', out; END IF;
  IF out->'profile' IS DISTINCT FROM 'null'::jsonb OR (out->>'profile_version')::int IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'a save with no profile made one: %', out; END IF;
  IF EXISTS (SELECT 1 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021330006') THEN RAISE EXCEPTION 'a profile row was created'; END IF;
  -- A profile document without the version it was edited from is refused.
  BEGIN
    PERFORM public.save_partner_page(
      '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330006', pv0 + 1, '{}'::jsonb,
      NULL, '{"sold_on":"offer","is_enabled":false}'::jsonb, 'aaaaaaaa-0000-4000-8000-000000002137', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
    RAISE EXCEPTION 'a profile with no expected version was accepted';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN NULL;
  END;
  INSERT INTO suite_cases(name) VALUES ('no profile named, none touched');
END
$do$;

-- ── 7. A resent press after its answer was lost is told its own save landed ──
DO $do$
DECLARE
  pv0 integer;
  v_detail text;
  call text;
BEGIN
  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330007';
  PERFORM public.save_partner_page(
    '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330007', pv0, '{}'::jsonb,
    1, '{"sold_on":"offer","is_enabled":false,"priority":4,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    'aaaaaaaa-0000-4000-8000-000000002138', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
  -- The same press again: the profile version it names has moved (its own save).
  BEGIN
    PERFORM public.save_partner_page(
      '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330007', pv0, '{}'::jsonb,
      1, '{"sold_on":"offer","is_enabled":false,"priority":4,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
      'aaaaaaaa-0000-4000-8000-000000002138', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
    RAISE EXCEPTION 'a resent press at a moved version was accepted';
  EXCEPTION WHEN SQLSTATE 'BP409' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  END;
  IF v_detail::jsonb->>'last_save_id' IS DISTINCT FROM 'aaaaaaaa-0000-4000-8000-000000002138' THEN RAISE EXCEPTION 'the refusal does not name the landed press: %', v_detail; END IF;
  IF v_detail::jsonb->>'changed_by_name' IS DISTINCT FROM 'Dave Suite' THEN RAISE EXCEPTION 'the last editor across both halves should be Dave Suite: %', v_detail; END IF;
  -- A save that changes nothing moves neither version.
  PERFORM public.save_partner_page(
    '11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330007', pv0, '{}'::jsonb,
    2, '{"sold_on":"offer","is_enabled":false,"priority":4,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    'aaaaaaaa-0000-4000-8000-000000002139', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
  IF (SELECT version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021330007') IS DISTINCT FROM 2
     OR (SELECT version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330007') IS DISTINCT FROM pv0 THEN
    RAISE EXCEPTION 'a save that changed nothing moved a version';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('a resent press recognises its own save');
END
$do$;

-- ── 8. Another org's partner, and the legacy wrapper ─────────────────────────
DO $do$
DECLARE
  doc jsonb;
  ch jsonb;
BEGIN
  BEGIN
    PERFORM public.save_partner_page(
      '11111111-1111-1111-1111-000021330002', '33333333-3333-3333-3333-000021330008', 0, '{"daily_cap": 1}'::jsonb,
      NULL, NULL, 'aaaaaaaa-0000-4000-8000-00000000213a', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite');
    RAISE EXCEPTION 'another org reached the partner';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  -- save_buyer_profile keeps its signature and behaviour, and tags its row as the legacy route's.
  doc := public.save_buyer_profile('11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330008', 1,
    '{"sold_on":"offer","is_enabled":false,"priority":3,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    '22222222-2222-2222-2222-00002133000a', 'carol@example.test');
  IF (doc->>'version')::int IS DISTINCT FROM 2 OR (doc->>'priority')::int IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'the wrapper did not save: %', doc; END IF;
  IF current_setting('bidspoke.audit_handled', true) IS DISTINCT FROM 'save_buyer_profile' THEN RAISE EXCEPTION 'the wrapper did not announce itself'; END IF;
  SELECT changes INTO ch FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-000021330008' ORDER BY changed_at DESC LIMIT 1;
  IF ch->>'_route' IS DISTINCT FROM 'legacy_buyer_profile' THEN RAISE EXCEPTION 'the legacy route row is not tagged: %', ch; END IF;
  IF ch ? '_actor' THEN RAISE EXCEPTION 'the legacy row changed shape beyond its tag: %', ch; END IF;
  INSERT INTO suite_cases(name) VALUES ('org scoping and the legacy wrapper');
END
$do$;

-- ── 9. A concurrent save_buyer_profile does not deadlock with a page save ────
-- Session A's page save holds the partner row and is held asleep inside its
-- partner UPDATE by a trigger this case adds; session B's save_buyer_profile
-- starts while A sleeps. Both create the same new profile. If B did not lock
-- the partner row first, B would insert the profile and then wait on A's
-- partner lock for its foreign key check while A waited on B's profile row:
-- deadlock. Locked in the same order, B waits on A, then finds the version A
-- produced and is refused as stale.
--
-- The trigger is created and dropped by statements of their own, committed:
-- created inside the case's block it would be invisible to the other sessions,
-- and its lock on partner_configs would hold session A, while this session
-- waited on A's answer, for ever. It sleeps only in a session that asks.
CREATE OR REPLACE FUNCTION public.spp_test_sleep() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF current_setting('spp_test.sleep', true) = 'on' THEN PERFORM pg_sleep(1.5); END IF;
  RETURN NEW;
END
$f$;
DROP TRIGGER IF EXISTS spp_test_sleep ON public.partner_configs;
CREATE TRIGGER spp_test_sleep BEFORE UPDATE ON public.partner_configs FOR EACH ROW EXECUTE FUNCTION public.spp_test_sleep();

DO $do$
DECLARE
  created boolean := NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink');
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('spp_test.self_host'));
  doc text := '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}';
  call_a text;
  call_b text;
  a_err text;
  b_err text;
  pv0 integer;
BEGIN
  IF created THEN
    CREATE EXTENSION dblink;
  END IF;

  SELECT version INTO pv0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021330009';
  call_a := format($q$SELECT public.save_partner_page('11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330009', %s, '{"daily_cap": 9}'::jsonb, 0, %L::jsonb, 'aaaaaaaa-0000-4000-8000-00000000213b', '22222222-2222-2222-2222-00002133000b', 'dave@example.test', 'Dave Suite')::text$q$, pv0, doc);
  call_b := format($q$SELECT public.save_buyer_profile('11111111-1111-1111-1111-000021330001', '33333333-3333-3333-3333-000021330009', 0, %L::jsonb, '22222222-2222-2222-2222-00002133000a', 'carol@example.test')::text$q$, doc);

  PERFORM dblink_connect('spp_a', conn);
  PERFORM dblink_connect('spp_b', conn);
  PERFORM dblink_exec('spp_a', $q$SET spp_test.sleep = 'on'$q$);
  PERFORM dblink_exec('spp_a', $q$SET deadlock_timeout = '200ms'$q$);
  PERFORM dblink_exec('spp_b', $q$SET deadlock_timeout = '200ms'$q$);
  PERFORM dblink_send_query('spp_a', call_a);
  PERFORM pg_sleep(0.5);
  PERFORM dblink_send_query('spp_b', call_b);
  PERFORM * FROM dblink_get_result('spp_a', false) AS t(r text);
  a_err := dblink_error_message('spp_a');
  PERFORM * FROM dblink_get_result('spp_a', false) AS t(r text);
  PERFORM * FROM dblink_get_result('spp_b', false) AS t(r text);
  b_err := dblink_error_message('spp_b');
  PERFORM * FROM dblink_get_result('spp_b', false) AS t(r text);
  PERFORM dblink_disconnect('spp_a');
  PERFORM dblink_disconnect('spp_b');
  IF created THEN
    DROP EXTENSION dblink;
  END IF;

  IF a_err IS DISTINCT FROM 'OK' THEN RAISE EXCEPTION 'the page save failed: %', a_err; END IF;
  IF b_err ILIKE '%deadlock%' THEN RAISE EXCEPTION 'the two saves deadlocked: %', b_err; END IF;
  IF b_err NOT ILIKE '%stale_version%' THEN RAISE EXCEPTION 'the profile save should be refused as stale after the page save, got: %', b_err; END IF;
  IF (SELECT version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021330009') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'the profile was written twice'; END IF;
  INSERT INTO suite_cases(name) VALUES ('no deadlock with save_buyer_profile');
END
$do$;

DROP TRIGGER IF EXISTS spp_test_sleep ON public.partner_configs;
DROP FUNCTION IF EXISTS public.spp_test_sleep();

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 9 THEN RAISE EXCEPTION 'save_partner_page.test.sql: expected 9 cases, % ran', n; END IF;
  RAISE NOTICE 'save_partner_page.test.sql: % cases passed', n;
END
$do$;
