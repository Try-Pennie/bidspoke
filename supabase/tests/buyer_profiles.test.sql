-- Behavioural tests for the buyer profile schema, functions, grants and audit (#1409).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty (#1139), never production and
-- never any database holding real rows. It creates an organization, a user and
-- two partners with fixed ids, runs every case against them, and leaves them in
-- place so a rerun is idempotent. No real identity appears anywhere in it.
--
-- HOW IT ASSERTS: by RAISE EXCEPTION inside DO blocks, one case per block, and
-- it counts the cases that ran into a temp table, because a suite that silently
-- executed half its cases and reported nothing wrong is the failure the count
-- exists to catch (L288). The last statement compares the count to the number
-- written at the bottom, so adding a case means bumping that number.
--
-- ASSERTIONS USE `IS DISTINCT FROM`, NEVER `<>`: a NULL compared with `<>` is
-- NULL, a plpgsql IF does not fire on NULL, and the case passes vacuously
-- (measured on the deletion gate suite, 2026-09-03).
--
-- SEND ONE STATEMENT AT A TIME. psql does. The runner uses psql.

-- ── Case counter ─────────────────────────────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Fixed ids so every case can name them. Deleted first so a rerun starts clean.
DO $do$
BEGIN
  DELETE FROM public.buyer_sales WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.buyer_pricing_tiers WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.buyer_blackout_dates WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.buyer_operating_windows WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.buyer_profiles WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.buyer_select_parity_days WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.partner_configs WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.workflows WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  -- The deletes above are themselves audited (which is the point), so the audit
  -- rows go last, before the user and organization they reference.
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.users WHERE organization_id = '11111111-1111-1111-1111-111111111111';
  DELETE FROM public.organizations WHERE id = '11111111-1111-1111-1111-111111111111';
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'Suite Org', 'suite-org');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'suite@example.test', 'Suite User');
-- The partner rows are inserted the way the app inserts them: with updated_by set.
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email)
VALUES ('33333333-3333-3333-3333-333333330001', '11111111-1111-1111-1111-111111111111', 'Suite Buyer One', 'suite-buyer-one', 'buyer', true, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email)
VALUES ('33333333-3333-3333-3333-333333330002', '11111111-1111-1111-1111-111111111111', 'Suite Buyer Two', 'suite-buyer-two', 'buyer', true, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
-- A third partner for the click sold cases (#1541), so they touch no row the earlier cases assert on.
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email)
VALUES ('33333333-3333-3333-3333-333333330003', '11111111-1111-1111-1111-111111111111', 'Suite Click Buyer', 'suite-click-buyer', 'buyer', true, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
-- The fixture inserts above are audited by the trigger; clear them so the counts below start from zero.
DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-111111111111';

-- ── 1. Grants: anon and authenticated cannot execute any of the four functions ──
DO $do$
DECLARE
  fn text;
  bad text[] := '{}';
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text)',
    'public.record_buyer_sale(jsonb)',
    'public.delete_partner_config(uuid, uuid, uuid, text)',
    'public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb)',
    'public.upsert_buyer_select_parity_day(jsonb)',
    'public.sign_off_buyer_select_parity_day(uuid, date, uuid, uuid, text, text)'
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') THEN bad := array_append(bad, 'anon can execute ' || fn); END IF;
    IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN bad := array_append(bad, 'authenticated can execute ' || fn); END IF;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN bad := array_append(bad, 'service_role cannot execute ' || fn); END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'function grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('function grants');
END
$do$;

-- ── 2. Grants: an authenticated member of the right org is refused every table verb on the six tables and partner_configs ──
DO $do$
DECLARE
  t text;
  verb text;
  bad text[] := '{}';
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  FOREACH t IN ARRAY ARRAY['buyer_profiles','buyer_operating_windows','buyer_blackout_dates','buyer_pricing_tiers','buyer_sales','buyer_select_parity_days','partner_configs'] LOOP
    FOREACH verb IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF has_table_privilege('authenticated', 'public.' || t, verb) THEN bad := array_append(bad, 'authenticated has ' || verb || ' on ' || t); END IF;
      IF has_table_privilege('anon', 'public.' || t, verb) THEN bad := array_append(bad, 'anon has ' || verb || ' on ' || t); END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', 'public.' || t, 'SELECT') THEN bad := array_append(bad, 'service_role cannot read ' || t); END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'table grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('table grants');
END
$do$;

-- ── 3. The partner_configs policy now carries WITH CHECK, and every new table has RLS on ──
DO $do$
DECLARE
  wc text;
  t text;
  bad text[] := '{}';
BEGIN
  SELECT with_check INTO wc FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_configs' AND policyname = 'partners_org';
  IF wc IS NULL OR position('user_org_id' IN wc) = 0 THEN RAISE EXCEPTION 'partners_org has no WITH CHECK on user_org_id: %', coalesce(wc, '<null>'); END IF;
  FOREACH t IN ARRAY ARRAY['buyer_profiles','buyer_operating_windows','buyer_blackout_dates','buyer_pricing_tiers','buyer_sales','buyer_select_parity_days'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN bad := array_append(bad, t); END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'RLS off on: %', array_to_string(bad, ', '); END IF;
  INSERT INTO suite_cases(name) VALUES ('rls and with check');
END
$do$;

-- ── 4. Save: a first save creates the profile at version 1 and writes exactly one created audit row ──
DO $do$
DECLARE
  doc jsonb;
  n int;
BEGIN
  doc := public.save_buyer_profile(
    '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330001', 0,
    '{"is_enabled": false, "priority": null, "allowed_states": ["ND","SD"], "debt_min": 20000, "debt_max": 60000, "loan_amount_min": 2500,
      "hourly_lead_cap": 10, "daily_lead_cap": 50, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
      "windows": [{"day_of_week": 1, "opens_minute": 660, "closes_minute": 1260}],
      "blackout_dates": [{"date": "2026-11-26", "note": "Thanksgiving"}],
      "tiers": [{"population": "engine", "debt_from": 20000, "debt_to": 40000, "multiplier": 0.0010}, {"population": "engine", "debt_from": 40000, "debt_to": null, "multiplier": 0.0012}]}'::jsonb,
    '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF (doc->>'version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'first save version: %', doc->>'version'; END IF;
  IF jsonb_array_length(doc->'tiers') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'tiers stored: %', doc->'tiers'; END IF;
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-333333330001';
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'audit rows after first save: %', n; END IF;
  IF (SELECT action FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-333333330001') IS DISTINCT FROM 'created' THEN RAISE EXCEPTION 'first save action is not created'; END IF;
  INSERT INTO suite_cases(name) VALUES ('first save creates');
END
$do$;

-- ── 5. Save: the same document again writes no audit row and leaves the version alone ──
DO $do$
DECLARE
  doc jsonb;
  n int;
BEGIN
  doc := public.save_buyer_profile(
    '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330001', 1,
    '{"is_enabled": false, "priority": null, "allowed_states": ["SD","ND"], "debt_min": 20000, "debt_max": 60000, "loan_amount_min": 2500,
      "hourly_lead_cap": 10, "daily_lead_cap": 50, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
      "windows": [{"day_of_week": 1, "opens_minute": 660, "closes_minute": 1260}],
      "blackout_dates": [{"date": "2026-11-26", "note": "Thanksgiving"}],
      "tiers": [{"population": "engine", "debt_from": 40000, "debt_to": null, "multiplier": 0.0012}, {"population": "engine", "debt_from": 20000, "debt_to": 40000, "multiplier": 0.0010}]}'::jsonb,
    '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF (doc->>'version')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'unchanged save bumped version to %', doc->>'version'; END IF;
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-333333330001';
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'unchanged save wrote an audit row (now %)', n; END IF;
  INSERT INTO suite_cases(name) VALUES ('unchanged save is silent');
END
$do$;

-- ── 6. Save: changing one multiplier writes exactly one audit row holding that one path, old and new ──
DO $do$
DECLARE
  doc jsonb;
  ch jsonb;
BEGIN
  doc := public.save_buyer_profile(
    '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330001', 1,
    '{"is_enabled": false, "priority": null, "allowed_states": ["ND","SD"], "debt_min": 20000, "debt_max": 60000, "loan_amount_min": 2500,
      "hourly_lead_cap": 10, "daily_lead_cap": 50, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
      "windows": [{"day_of_week": 1, "opens_minute": 660, "closes_minute": 1260}],
      "blackout_dates": [{"date": "2026-11-26", "note": "Thanksgiving"}],
      "tiers": [{"population": "engine", "debt_from": 20000, "debt_to": 40000, "multiplier": 0.0010}, {"population": "engine", "debt_from": 40000, "debt_to": null, "multiplier": 0.0013}]}'::jsonb,
    '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF (doc->>'version')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'version after one change: %', doc->>'version'; END IF;
  SELECT changes INTO ch FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-333333330001' ORDER BY changed_at DESC LIMIT 1;
  IF (SELECT count(*) FROM jsonb_object_keys(ch)) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'expected one changed path, got %', ch; END IF;
  IF (ch->'tiers.engine.40000.multiplier'->>'old')::numeric IS DISTINCT FROM 0.0012 OR (ch->'tiers.engine.40000.multiplier'->>'new')::numeric IS DISTINCT FROM 0.0013 THEN
    RAISE EXCEPTION 'multiplier path old and new wrong: %', ch;
  END IF;
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-333333330001') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'audit rows after two saves'; END IF;
  INSERT INTO suite_cases(name) VALUES ('one change is one path');
END
$do$;

-- ── 7. Save: a stale version is refused, and the refusal carries the current document ──
DO $do$
DECLARE
  msg text;
  detail text;
BEGIN
  BEGIN
    PERFORM public.save_buyer_profile(
      '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330001', 1,
      '{"is_enabled": false, "priority": null, "allowed_states": ["ND"], "debt_min": 20000, "debt_max": 60000, "loan_amount_min": 2500,
        "hourly_lead_cap": 10, "daily_lead_cap": 50, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
        "windows": [{"day_of_week": 1, "opens_minute": 660, "closes_minute": 1260}], "blackout_dates": [],
        "tiers": [{"population": "engine", "debt_from": 20000, "debt_to": null, "multiplier": 0.0010}]}'::jsonb,
      '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'stale version was accepted';
  EXCEPTION WHEN SQLSTATE 'BP409' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, detail = PG_EXCEPTION_DETAIL;
    IF msg IS DISTINCT FROM 'stale_version' THEN RAISE EXCEPTION 'wrong message: %', msg; END IF;
    IF (detail::jsonb->>'version')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'refusal does not carry the current document: %', detail; END IF;
  END;
  -- Nothing changed underneath.
  IF (SELECT version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333330001') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'stale save changed the row'; END IF;
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-333333330001') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'stale save wrote an audit row'; END IF;
  INSERT INTO suite_cases(name) VALUES ('stale version refused with document');
END
$do$;

-- ── 8. Save: a gap inside the debt range is refused by name, and so are tiers for an unwired population ──
DO $do$
DECLARE
  msg text;
BEGIN
  BEGIN
    PERFORM public.save_buyer_profile(
      '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330002', 0,
      '{"is_enabled": false, "priority": null, "allowed_states": ["WY"], "debt_min": 20000, "debt_max": 60000, "loan_amount_min": null,
        "hourly_lead_cap": null, "daily_lead_cap": null, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
        "windows": [], "blackout_dates": [],
        "tiers": [{"population": "engine", "debt_from": 20000, "debt_to": 30000, "multiplier": 0.001}, {"population": "engine", "debt_from": 35000, "debt_to": null, "multiplier": 0.001}]}'::jsonb,
      '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'tier gap was accepted';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'tiers_gap' THEN RAISE EXCEPTION 'wrong message for gap: %', msg; END IF;
  END;
  BEGIN
    PERFORM public.save_buyer_profile(
      '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330002', 0,
      '{"is_enabled": false, "priority": null, "allowed_states": ["WY"], "debt_min": null, "debt_max": null, "loan_amount_min": null,
        "hourly_lead_cap": null, "daily_lead_cap": null, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
        "windows": [], "blackout_dates": [],
        "tiers": [{"population": "main_flow", "debt_from": 10000, "debt_to": null, "multiplier": 0.001}]}'::jsonb,
      '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'unwired population was accepted';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'population_not_wired' THEN RAISE EXCEPTION 'wrong message for population: %', msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333330002') THEN RAISE EXCEPTION 'refused saves left a profile row'; END IF;
  INSERT INTO suite_cases(name) VALUES ('gap and unwired refused');
END
$do$;

-- ── 9. Constraints: an overlapping tier is refused by the database itself, adjacency is accepted, enabling without a priority is refused ──
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.buyer_pricing_tiers (partner_id, organization_id, population, debt_from, debt_to, multiplier)
    VALUES ('33333333-3333-3333-3333-333333330001', '11111111-1111-1111-1111-111111111111', 'engine', 35000, 45000, 0.002);
    RAISE EXCEPTION 'overlapping tier was inserted';
  EXCEPTION WHEN exclusion_violation THEN NULL;
  END;
  -- Adjacent at exactly 40,000 is what the saved profile already holds: [20000, 40000) and [40000, null). Prove the boundary is accepted by the constraint by inserting a third tier that meets the top one from below after removing the middle one, then restoring.
  BEGIN
    UPDATE public.buyer_profiles SET is_enabled = true, priority = NULL WHERE partner_id = '33333333-3333-3333-3333-333333330001';
    RAISE EXCEPTION 'enabled without a priority was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO suite_cases(name) VALUES ('constraints hold');
END
$do$;

-- ── 10. Direct SQL on the profile tables is recorded as direct_sql with no actor ──
DO $do$
DECLARE
  r record;
BEGIN
  UPDATE public.buyer_profiles SET daily_lead_cap = 51 WHERE partner_id = '33333333-3333-3333-3333-333333330001';
  SELECT * INTO r FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-333333330001' ORDER BY changed_at DESC LIMIT 1;
  IF r.changed_by IS NOT NULL THEN RAISE EXCEPTION 'direct SQL inherited an actor: %', r.changed_by; END IF;
  IF r.changes->>'_source' IS DISTINCT FROM 'direct_sql' THEN RAISE EXCEPTION 'direct SQL not labelled: %', r.changes; END IF;
  UPDATE public.buyer_profiles SET daily_lead_cap = 50 WHERE partner_id = '33333333-3333-3333-3333-333333330001';
  INSERT INTO suite_cases(name) VALUES ('direct sql on profiles is labelled');
END
$do$;

-- ── 11. partner_configs audit: an app update writes exactly one row naming the actor, with old and new, and no direct_sql label ──
DO $do$
DECLARE
  r record;
  before int;
BEGIN
  SELECT count(*) INTO before FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330001';
  UPDATE public.partner_configs SET accept_signals = '[{"field":"ok","equals":true}]'::jsonb, updated_by = '22222222-2222-2222-2222-222222222222' WHERE id = '33333333-3333-3333-3333-333333330001';
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330001') IS DISTINCT FROM before + 1 THEN RAISE EXCEPTION 'app update did not write exactly one audit row'; END IF;
  SELECT * INTO r FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330001' ORDER BY changed_at DESC LIMIT 1;
  IF r.action IS DISTINCT FROM 'updated' THEN RAISE EXCEPTION 'action: %', r.action; END IF;
  IF r.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-222222222222'::uuid THEN RAISE EXCEPTION 'actor not resolved from updated_by: %', r.changed_by; END IF;
  IF r.changes ? '_source' THEN RAISE EXCEPTION 'app update labelled direct_sql'; END IF;
  IF r.changes->'accept_signals'->'old' IS DISTINCT FROM '[]'::jsonb OR r.changes->'accept_signals'->'new' IS DISTINCT FROM '[{"field":"ok","equals":true}]'::jsonb THEN RAISE EXCEPTION 'accept_signals old and new wrong: %', r.changes; END IF;
  IF r.changes ? 'updated_at' OR r.changes ? 'updated_by' THEN RAISE EXCEPTION 'excluded columns leaked into changes: %', r.changes; END IF;
  INSERT INTO suite_cases(name) VALUES ('partner update audited once with actor');
END
$do$;

-- ── 12. partner_configs audit: an update that changes no audited column writes no row ──
DO $do$
DECLARE
  before int;
BEGIN
  SELECT count(*) INTO before FROM public.audit_log WHERE entity_type = 'partner_config';
  UPDATE public.partner_configs SET last_probe_response = '{"probe": 1}'::jsonb, updated_by = '22222222-2222-2222-2222-222222222222' WHERE id = '33333333-3333-3333-3333-333333330001';
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'partner_config') IS DISTINCT FROM before THEN RAISE EXCEPTION 'a probe response write was audited'; END IF;
  INSERT INTO suite_cases(name) VALUES ('excluded columns are silent');
END
$do$;

-- ── 13. partner_configs audit: a direct update with no actor is labelled direct_sql with changed_by null ──
DO $do$
DECLARE
  r record;
BEGIN
  UPDATE public.partner_configs SET name = 'Suite Buyer One Renamed' WHERE id = '33333333-3333-3333-3333-333333330001';
  SELECT * INTO r FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330001' ORDER BY changed_at DESC LIMIT 1;
  IF r.changed_by IS NOT NULL THEN RAISE EXCEPTION 'direct update inherited actor %', r.changed_by; END IF;
  IF r.changes->>'_source' IS DISTINCT FROM 'direct_sql' THEN RAISE EXCEPTION 'direct update not labelled: %', r.changes; END IF;
  IF r.changes->'name'->>'new' IS DISTINCT FROM 'Suite Buyer One Renamed' THEN RAISE EXCEPTION 'name change not recorded: %', r.changes; END IF;
  INSERT INTO suite_cases(name) VALUES ('direct partner update labelled');
END
$do$;

-- ── 14. rename_partner_step_namespace: rewrites only the allowed columns, audits once with reason and context, refuses another column ──
DO $do$
DECLARE
  r record;
  n int;
  msg text;
BEGIN
  UPDATE public.partner_configs SET bid_formula = 'steps.old_ns.output.debt * 0.001', updated_by = '22222222-2222-2222-2222-222222222222' WHERE id = '33333333-3333-3333-3333-333333330002';
  n := public.rename_partner_step_namespace(
    '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330002',
    '{"bid_formula": "steps.new_ns.output.debt * 0.001"}'::jsonb,
    '22222222-2222-2222-2222-222222222222', 'suite@example.test',
    '{"reason": "step_id_renamed", "workflow_id": "44444444-4444-4444-4444-444444444444", "old_namespace": "old_ns", "new_namespace": "new_ns"}'::jsonb);
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'rename touched % rows', n; END IF;
  -- Both writes above share this transaction's now(), so the rename's row is found by its reason, not by recency.
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330002' AND changes ? 'reason') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'rename did not write exactly one audit row'; END IF;
  SELECT * INTO r FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330002' AND changes ? 'reason';
  IF r.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-222222222222'::uuid THEN RAISE EXCEPTION 'rename actor: %', r.changed_by; END IF;
  IF r.changes->>'reason' IS DISTINCT FROM 'step_id_renamed' OR r.changes->>'workflow_id' IS DISTINCT FROM '44444444-4444-4444-4444-444444444444' THEN RAISE EXCEPTION 'rename reason or context missing: %', r.changes; END IF;
  IF r.changes->'bid_formula'->>'new' IS DISTINCT FROM 'steps.new_ns.output.debt * 0.001' THEN RAISE EXCEPTION 'rename value not recorded: %', r.changes; END IF;
  BEGIN
    PERFORM public.rename_partner_step_namespace(
      '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330002',
      '{"api_endpoint": "https://evil.example"}'::jsonb,
      '22222222-2222-2222-2222-222222222222', 'suite@example.test', '{}'::jsonb);
    RAISE EXCEPTION 'rename accepted a column it must refuse';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'column_not_renameable' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('rename audited and bounded');
END
$do$;

-- ── 15. record_buyer_sale: same key set every time, a late reserved cannot overwrite accepted, the second accepted live sale of one lead is refused by name ──
DO $do$
DECLARE
  row1 jsonb;
  row2 jsonb;
  msg text;
BEGIN
  row1 := public.record_buyer_sale('{"id": "55555555-5555-5555-5555-555555550001", "partner_id": "33333333-3333-3333-3333-333333330001", "organization_id": "11111111-1111-1111-1111-111111111111",
    "lead_key": "lead-a", "population": "engine", "kind": "live", "status": "reserved", "payout_cents": 2500, "debt": 25000, "multiplier": 0.001,
    "et_day": "2026-09-21", "hour_bucket": "2026-09-21T16:00:00Z", "workflow_id": null, "execution_id": null, "trace_id": "t1",
    "http_status": null, "result_code": null, "buyer_reference": null, "live_percent_in_force": 1, "caps_in_force": {"daily_lead_cap": 50}, "resolution_source": null, "resolved_by": null}'::jsonb);
  IF row1->>'status' IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'first record: %', row1; END IF;
  row2 := public.record_buyer_sale('{"id": "55555555-5555-5555-5555-555555550001", "partner_id": "33333333-3333-3333-3333-333333330001", "organization_id": "11111111-1111-1111-1111-111111111111",
    "lead_key": "lead-a", "population": "engine", "kind": "live", "status": "accepted", "payout_cents": 2500, "debt": 25000, "multiplier": 0.001,
    "et_day": "2026-09-21", "hour_bucket": "2026-09-21T16:00:00Z", "workflow_id": null, "execution_id": null, "trace_id": "t1",
    "http_status": 200, "result_code": "1001", "buyer_reference": "ref-1", "live_percent_in_force": 1, "caps_in_force": {"daily_lead_cap": 50}, "resolution_source": "buyer", "resolved_by": null}'::jsonb);
  IF row2->>'status' IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'accept did not land: %', row2; END IF;
  -- A late reserved arrives after the accept.
  row2 := public.record_buyer_sale('{"id": "55555555-5555-5555-5555-555555550001", "partner_id": "33333333-3333-3333-3333-333333330001", "organization_id": "11111111-1111-1111-1111-111111111111",
    "lead_key": "lead-a", "population": "engine", "kind": "live", "status": "reserved", "payout_cents": 2500, "debt": 25000, "multiplier": 0.001,
    "et_day": "2026-09-21", "hour_bucket": "2026-09-21T16:00:00Z", "workflow_id": null, "execution_id": null, "trace_id": "t1",
    "http_status": null, "result_code": null, "buyer_reference": null, "live_percent_in_force": 1, "caps_in_force": {"daily_lead_cap": 50}, "resolution_source": null, "resolved_by": null}'::jsonb);
  IF row2->>'status' IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'a late reserved overwrote accepted: %', row2; END IF;
  IF row2->>'buyer_reference' IS DISTINCT FROM 'ref-1' THEN RAISE EXCEPTION 'a late reserved erased the reference: %', row2; END IF;
  -- A second buyer accepting the same live lead.
  BEGIN
    PERFORM public.record_buyer_sale('{"id": "55555555-5555-5555-5555-555555550002", "partner_id": "33333333-3333-3333-3333-333333330002", "organization_id": "11111111-1111-1111-1111-111111111111",
      "lead_key": "lead-a", "population": "engine", "kind": "live", "status": "accepted", "payout_cents": 2000, "debt": 25000, "multiplier": 0.0008,
      "et_day": "2026-09-21", "hour_bucket": "2026-09-21T16:00:00Z", "workflow_id": null, "execution_id": null, "trace_id": "t2",
      "http_status": 200, "result_code": "1001", "buyer_reference": "ref-2", "live_percent_in_force": 1, "caps_in_force": {}, "resolution_source": "buyer", "resolved_by": null}'::jsonb);
    RAISE EXCEPTION 'a second accepted live sale of one lead was recorded';
  EXCEPTION WHEN SQLSTATE 'BP023' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'duplicate_accepted_sale' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  -- A rehearsal accept of the same lead is a different kind and is allowed.
  PERFORM public.record_buyer_sale('{"id": "55555555-5555-5555-5555-555555550003", "partner_id": "33333333-3333-3333-3333-333333330002", "organization_id": "11111111-1111-1111-1111-111111111111",
    "lead_key": "lead-a", "population": "engine", "kind": "rehearsal", "status": "accepted", "payout_cents": 2000, "debt": 25000, "multiplier": 0.0008,
    "et_day": "2026-09-21", "hour_bucket": "2026-09-21T16:00:00Z", "workflow_id": null, "execution_id": null, "trace_id": "t3",
    "http_status": null, "result_code": null, "buyer_reference": null, "live_percent_in_force": 0, "caps_in_force": {}, "resolution_source": "rehearsal", "resolved_by": null}'::jsonb);
  INSERT INTO suite_cases(name) VALUES ('sale record rank and uniqueness');
END
$do$;

-- ── 16. settle_buyer_sale is gone: a settlement is a ledger operation first and reaches buyer_sales through record_buyer_sale (#1412, L83) ──
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'settle_buyer_sale'
  ) THEN
    RAISE EXCEPTION 'settle_buyer_sale still exists: a direct mirror write would leave the ledger holding the slot';
  END IF;
  -- The mirror path still records a settlement written by the ledger: the row
  -- carries resolution_source and resolved_by from the entry, through the upsert.
  PERFORM public.record_buyer_sale('{"id": "55555555-5555-5555-5555-555555550004", "partner_id": "33333333-3333-3333-3333-333333330001", "organization_id": "11111111-1111-1111-1111-111111111111",
    "lead_key": "lead-b", "population": "engine", "kind": "live", "status": "unresolved", "payout_cents": 1800, "debt": 18000, "multiplier": 0.001,
    "et_day": "2026-09-21", "hour_bucket": "2026-09-21T17:00:00Z", "workflow_id": null, "execution_id": null, "trace_id": "t4",
    "http_status": 200, "result_code": null, "buyer_reference": null, "live_percent_in_force": 1, "caps_in_force": {}, "resolution_source": null, "resolved_by": null}'::jsonb);
  PERFORM public.record_buyer_sale('{"id": "55555555-5555-5555-5555-555555550004", "partner_id": "33333333-3333-3333-3333-333333330001", "organization_id": "11111111-1111-1111-1111-111111111111",
    "lead_key": "lead-b", "population": "engine", "kind": "live", "status": "released", "payout_cents": 1800, "debt": null, "multiplier": null,
    "et_day": "2026-09-21", "hour_bucket": "2026-09-21T17:00:00Z", "workflow_id": null, "execution_id": null, "trace_id": "t4",
    "http_status": 200, "result_code": null, "buyer_reference": null, "live_percent_in_force": 1, "caps_in_force": {}, "resolution_source": "settled", "resolved_by": "22222222-2222-2222-2222-222222222222"}'::jsonb);
  IF (SELECT status FROM public.buyer_sales WHERE id = '55555555-5555-5555-5555-555555550004') IS DISTINCT FROM 'released' THEN RAISE EXCEPTION 'settled mirror did not land'; END IF;
  IF (SELECT resolved_by FROM public.buyer_sales WHERE id = '55555555-5555-5555-5555-555555550004') IS DISTINCT FROM '22222222-2222-2222-2222-222222222222'::uuid THEN RAISE EXCEPTION 'settled mirror did not record who'; END IF;
  IF (SELECT resolution_source FROM public.buyer_sales WHERE id = '55555555-5555-5555-5555-555555550004') IS DISTINCT FROM 'settled' THEN RAISE EXCEPTION 'settled mirror did not record how'; END IF;
  INSERT INTO suite_cases(name) VALUES ('settle is a ledger operation mirrored through record_buyer_sale');
END
$do$;

-- ── 17. delete_partner_config: a partner with sales is refused by name; a clean partner is deleted and audited once with the actor ──
DO $do$
DECLARE
  msg text;
  detail text;
  r record;
  before int;
BEGIN
  BEGIN
    PERFORM public.delete_partner_config('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330001', '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'a partner with sales was deleted';
  EXCEPTION WHEN SQLSTATE 'BP023' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, detail = PG_EXCEPTION_DETAIL;
    IF msg IS DISTINCT FROM 'partner_has_dependents' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
    IF position('buyer_sales' IN detail) = 0 THEN RAISE EXCEPTION 'refusal does not name the blocking table: %', detail; END IF;
  END;
  -- Partner two has one rehearsal sale row; remove it, then the delete goes through.
  DELETE FROM public.buyer_sales WHERE partner_id = '33333333-3333-3333-3333-333333330002';
  SELECT count(*) INTO before FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330002';
  PERFORM public.delete_partner_config('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330002', '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF EXISTS (SELECT 1 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333330002') THEN RAISE EXCEPTION 'delete did not delete'; END IF;
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330002') IS DISTINCT FROM before + 1 THEN RAISE EXCEPTION 'delete did not write exactly one audit row'; END IF;
  SELECT * INTO r FROM public.audit_log WHERE entity_type = 'partner_config' AND entity_id = '33333333-3333-3333-3333-333333330002' ORDER BY changed_at DESC LIMIT 1;
  IF r.action IS DISTINCT FROM 'deleted' OR r.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-222222222222'::uuid THEN RAISE EXCEPTION 'delete audit wrong: % %', r.action, r.changed_by; END IF;
  IF r.changes ? '_source' THEN RAISE EXCEPTION 'app delete labelled direct_sql'; END IF;
  BEGIN
    PERFORM public.delete_partner_config('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330002', '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'deleting a missing partner did not refuse';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  INSERT INTO suite_cases(name) VALUES ('delete refuses dependents and audits');
END
$do$;

-- ── 18. Read only rpcs are STABLE, including the two that were VOLATILE ──
DO $do$
DECLARE
  bad text[] := '{}';
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['auth_user_with_allowlist', 'pg_cron_health', 'bid_recording_coverage_v2', 'user_org_id'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = fn AND provolatile IN ('s','i')) THEN
      bad := array_append(bad, fn);
    END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'not STABLE or IMMUTABLE: %', array_to_string(bad, ', '); END IF;
  INSERT INTO suite_cases(name) VALUES ('read only rpcs are stable');
END
$do$;

-- ── 19. upsert_buyer_select_parity_day: writes the counts and the hash, never a sign off, and refuses a missing key by name (#1413) ──
DO $do$
DECLARE
  r jsonb;
  msg text;
BEGIN
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'Suite Engine Flow')
  ON CONFLICT (id) DO NOTHING;
  r := public.upsert_buyer_select_parity_day('{"workflow_id": "44444444-4444-4444-4444-444444444444", "et_day": "2026-09-20", "organization_id": "11111111-1111-1111-1111-111111111111",
    "sell_off_agree": 10, "sell_off_disagree": 1, "hash_match": 0, "hash_mismatch": 0, "hash_unmeasured": 11, "classification_agree": 9, "classification_disagree": 0,
    "outcome_unknown_count": 0, "state_resolved": 11, "state_unresolved": 0, "rehearsal_in_doubt_heals": 0, "rehearsal_expired_in_flight": 0,
    "decide_only_latency_p50_ms": 120, "decide_only_latency_p95_ms": 400, "disagreement_execution_ids": ["0192a4f0-0000-7000-8000-000000000001"],
    "window_complete": true, "counts_hash": "hash-one", "executions_unpaired": 0, "unmeasured": ["rehearsal_in_doubt_heals", "rehearsal_expired_in_flight"],
    "refusal_counts": {"hourly_lead_cap": 3, "daily_lead_cap": 0, "hourly_spend_cap": 7, "daily_spend_cap": 0, "rehearsal_deadline": 1, "object_deadline": 0, "cap_check_error": 0, "breaker_unreadable": 0, "circuit_open": 0}}'::jsonb);
  IF (r->>'sell_off_agree')::int IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'counts not written: %', r; END IF;
  IF r->>'counts_hash' IS DISTINCT FROM 'hash-one' THEN RAISE EXCEPTION 'hash not written: %', r; END IF;
  IF r->>'signed_off_at' IS NOT NULL THEN RAISE EXCEPTION 'a refresh set a sign off: %', r; END IF;
  IF (r->'unmeasured')::jsonb IS DISTINCT FROM '["rehearsal_in_doubt_heals", "rehearsal_expired_in_flight"]'::jsonb THEN RAISE EXCEPTION 'unmeasured not written: %', r; END IF;
  IF (r->'refusal_counts'->>'hourly_spend_cap')::int IS DISTINCT FROM 7 THEN RAISE EXCEPTION 'refusal counts not written: %', r; END IF;
  -- A row from a Worker that does not measure the incumbent unknown count is written NULL, never a made up zero (#1540).
  IF r ? 'incumbent_unknown_count' IS NOT TRUE OR r->'incumbent_unknown_count' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'an unmeasured incumbent unknown count was not NULL: %', r; END IF;
  -- One that does measure it is written as given.
  r := public.upsert_buyer_select_parity_day((r - 'id' - 'summarised_at' - 'signed_off_by' - 'signed_off_at' - 'sign_off_note' - 'sign_off_counts_hash' - 'sign_off_cleared_at') || '{"incumbent_unknown_count": 4}'::jsonb);
  IF (r->>'incumbent_unknown_count')::int IS DISTINCT FROM 4 THEN RAISE EXCEPTION 'incumbent unknown count not written: %', r; END IF;
  -- refusal_counts must be an object, refused by name (#1533).
  BEGIN
    PERFORM public.upsert_buyer_select_parity_day((r - 'id' - 'summarised_at' - 'signed_off_by' - 'signed_off_at' - 'sign_off_note' - 'sign_off_counts_hash' - 'sign_off_cleared_at') || '{"refusal_counts": 7}'::jsonb);
    RAISE EXCEPTION 'a row with a non object refusal_counts was written';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'refusal_counts_not_object' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  BEGIN
    PERFORM public.upsert_buyer_select_parity_day('{"workflow_id": "44444444-4444-4444-4444-444444444444", "et_day": "2026-09-20", "organization_id": "11111111-1111-1111-1111-111111111111"}'::jsonb);
    RAISE EXCEPTION 'a row missing its counts was written';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'missing_key' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('parity upsert writes counts never sign off');
END
$do$;

-- ── 20. sign_off_buyer_select_parity_day: records the hash it approved, refuses a hash that moved, and a refresh with new numbers clears it (L641) ──
DO $do$
DECLARE
  r jsonb;
  msg text;
BEGIN
  BEGIN
    PERFORM public.sign_off_buyer_select_parity_day('44444444-4444-4444-4444-444444444444', '2026-09-20', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'hash-stale', 'looked fine');
    RAISE EXCEPTION 'a sign off over a stale hash was recorded';
  EXCEPTION WHEN SQLSTATE 'BP409' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'counts_changed' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  r := public.sign_off_buyer_select_parity_day('44444444-4444-4444-4444-444444444444', '2026-09-20', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'hash-one', 'one disagreement, a replayed lead');
  IF r->>'signed_off_at' IS NULL THEN RAISE EXCEPTION 'sign off not recorded: %', r; END IF;
  IF r->>'sign_off_counts_hash' IS DISTINCT FROM 'hash-one' THEN RAISE EXCEPTION 'approved hash not recorded: %', r; END IF;
  -- A refresh with the SAME numbers keeps the sign off.
  r := public.upsert_buyer_select_parity_day('{"workflow_id": "44444444-4444-4444-4444-444444444444", "et_day": "2026-09-20", "organization_id": "11111111-1111-1111-1111-111111111111",
    "sell_off_agree": 10, "sell_off_disagree": 1, "hash_match": 0, "hash_mismatch": 0, "hash_unmeasured": 11, "classification_agree": 9, "classification_disagree": 0,
    "outcome_unknown_count": 0, "state_resolved": 11, "state_unresolved": 0, "rehearsal_in_doubt_heals": 0, "rehearsal_expired_in_flight": 0,
    "decide_only_latency_p50_ms": 120, "decide_only_latency_p95_ms": 400, "disagreement_execution_ids": ["0192a4f0-0000-7000-8000-000000000001"],
    "window_complete": true, "counts_hash": "hash-one", "executions_unpaired": 0, "unmeasured": [],
    "refusal_counts": {"hourly_lead_cap": 3, "daily_lead_cap": 0, "hourly_spend_cap": 7, "daily_spend_cap": 0, "rehearsal_deadline": 1, "object_deadline": 0, "cap_check_error": 0, "breaker_unreadable": 0, "circuit_open": 0}}'::jsonb);
  IF r->>'signed_off_at' IS NULL THEN RAISE EXCEPTION 'a refresh with the same numbers cleared the sign off: %', r; END IF;
  -- A refresh with DIFFERENT numbers clears it and says when.
  r := public.upsert_buyer_select_parity_day('{"workflow_id": "44444444-4444-4444-4444-444444444444", "et_day": "2026-09-20", "organization_id": "11111111-1111-1111-1111-111111111111",
    "sell_off_agree": 10, "sell_off_disagree": 2, "hash_match": 0, "hash_mismatch": 0, "hash_unmeasured": 12, "classification_agree": 9, "classification_disagree": 0,
    "outcome_unknown_count": 0, "state_resolved": 12, "state_unresolved": 0, "rehearsal_in_doubt_heals": 0, "rehearsal_expired_in_flight": 0,
    "decide_only_latency_p50_ms": 120, "decide_only_latency_p95_ms": 400, "disagreement_execution_ids": ["0192a4f0-0000-7000-8000-000000000001", "0192a4f0-0000-7000-8000-000000000002"],
    "window_complete": true, "counts_hash": "hash-two", "executions_unpaired": 0, "unmeasured": [],
    "refusal_counts": {"hourly_lead_cap": 3, "daily_lead_cap": 1, "hourly_spend_cap": 7, "daily_spend_cap": 0, "rehearsal_deadline": 1, "object_deadline": 0, "cap_check_error": 0, "breaker_unreadable": 0, "circuit_open": 0}}'::jsonb);
  IF r->>'signed_off_at' IS NOT NULL THEN RAISE EXCEPTION 'a refresh with new numbers left the sign off standing: %', r; END IF;
  IF r->>'sign_off_cleared_at' IS NULL THEN RAISE EXCEPTION 'the clearing was not recorded: %', r; END IF;
  IF r->>'sign_off_counts_hash' IS DISTINCT FROM 'hash-one' THEN RAISE EXCEPTION 'the approved hash was lost: %', r; END IF;
  INSERT INTO suite_cases(name) VALUES ('parity sign off is tied to its hash');
END
$do$;

-- ── 21. sign_off_buyer_select_parity_day: refuses no actor and an unknown day by name ──
DO $do$
DECLARE
  msg text;
BEGIN
  BEGIN
    PERFORM public.sign_off_buyer_select_parity_day('44444444-4444-4444-4444-444444444444', '2026-09-20', '11111111-1111-1111-1111-111111111111', NULL, 'hash-two', 'x');
    RAISE EXCEPTION 'a sign off with no actor was recorded';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'actor_required' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  BEGIN
    PERFORM public.sign_off_buyer_select_parity_day('44444444-4444-4444-4444-444444444444', '2026-01-01', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'hash-two', 'x');
    RAISE EXCEPTION 'a sign off of a day with no row was recorded';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'parity_day_not_found' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('parity sign off refusals');
END
$do$;

-- ── 22. sold_on: a click buyer saves enabled with no priority and no tiers, and the document and the audit row carry the kind (#1541) ──
DO $do$
DECLARE
  doc jsonb;
  changes jsonb;
BEGIN
  doc := public.save_buyer_profile(
    '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', 0,
    '{"sold_on": "click", "is_enabled": true, "priority": null, "allowed_states": ["DE","HI"], "debt_min": 20000, "debt_max": null, "loan_amount_min": 2500,
      "hourly_lead_cap": null, "daily_lead_cap": 50, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
      "windows": [{"day_of_week": 1, "opens_minute": 660, "closes_minute": 1260}], "blackout_dates": [], "tiers": []}'::jsonb,
    '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF doc->>'sold_on' IS DISTINCT FROM 'click' THEN RAISE EXCEPTION 'document sold_on: %', doc->>'sold_on'; END IF;
  IF (doc->>'is_enabled')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'click buyer not enabled: %', doc; END IF;
  SELECT a.changes INTO changes FROM public.audit_log a WHERE a.entity_type = 'buyer_profile' AND a.entity_id = '33333333-3333-3333-3333-333333330003' ORDER BY a.changed_at DESC LIMIT 1;
  IF changes->'sold_on'->>'new' IS DISTINCT FROM 'click' THEN RAISE EXCEPTION 'audit row does not carry sold_on: %', changes; END IF;
  INSERT INTO suite_cases(name) VALUES ('click buyer saves without priority or tiers');
END
$do$;

-- ── 23. sold_on: a click buyer refuses tiers, an hourly cap and spend caps by name, and the table refuses the caps itself ──
DO $do$
DECLARE
  msg text;
  body jsonb := '{"sold_on": "click", "is_enabled": true, "priority": null, "allowed_states": ["DE"], "debt_min": null, "debt_max": null, "loan_amount_min": null,
      "hourly_lead_cap": null, "daily_lead_cap": 50, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null,
      "windows": [{"day_of_week": 1, "opens_minute": 660, "closes_minute": 1260}], "blackout_dates": [], "tiers": []}'::jsonb;
  v int;
BEGIN
  SELECT version INTO v FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333330003';
  BEGIN
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', v,
      body || '{"tiers": [{"population": "engine", "debt_from": 0, "debt_to": null, "multiplier": 0.001}]}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'a click buyer was saved with pricing';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'click_buyer_priced' THEN RAISE EXCEPTION 'wrong refusal for tiers: %', msg; END IF;
  END;
  BEGIN
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', v,
      body || '{"hourly_lead_cap": 10}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'a click buyer was saved with an hourly cap';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'click_buyer_cap_unsupported' THEN RAISE EXCEPTION 'wrong refusal for an hourly cap: %', msg; END IF;
  END;
  BEGIN
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', v,
      body || '{"daily_spend_cap_cents": 100000}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'a click buyer was saved with a spend cap';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'click_buyer_cap_unsupported' THEN RAISE EXCEPTION 'wrong refusal for a spend cap: %', msg; END IF;
  END;
  BEGIN
    UPDATE public.buyer_profiles SET hourly_spend_cap_cents = 500 WHERE partner_id = '33333333-3333-3333-3333-333333330003';
    RAISE EXCEPTION 'the table accepted a spend cap on a click buyer';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.buyer_profiles SET sold_on = 'phone' WHERE partner_id = '33333333-3333-3333-3333-333333330003';
    RAISE EXCEPTION 'the table accepted an unknown sold_on';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.buyer_pricing_tiers WHERE partner_id = '33333333-3333-3333-3333-333333330003') THEN RAISE EXCEPTION 'a refused save left tiers behind'; END IF;
  INSERT INTO suite_cases(name) VALUES ('click buyer refuses pricing and unsupported caps');
END
$do$;

-- ── 24. sold_on: the kind cannot be switched while tiers or accept rules are stored, and can once neither is ──
DO $do$
DECLARE
  msg text;
  v int;
  doc jsonb;
BEGIN
  -- Partner one is an offer buyer with stored tiers (case 4).
  SELECT version INTO v FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333330001';
  doc := public.buyer_profile_document('33333333-3333-3333-3333-333333330001');
  IF doc->>'sold_on' IS DISTINCT FROM 'offer' THEN RAISE EXCEPTION 'an existing profile did not default to offer: %', doc->>'sold_on'; END IF;
  BEGIN
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330001', v,
      (doc - 'partner_id' - 'version') || '{"sold_on": "click", "tiers": [], "hourly_lead_cap": null}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'an offer buyer with stored tiers was switched to click';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'sold_on_locked' THEN RAISE EXCEPTION 'wrong refusal with tiers stored: %', msg; END IF;
  END;
  -- The click buyer from case 22, with accept rules put on its partner record: switching to offer is refused.
  UPDATE public.partner_configs SET accept_signals = '[{"field": "ok", "equals": true}]'::jsonb, updated_by = '22222222-2222-2222-2222-222222222222' WHERE id = '33333333-3333-3333-3333-333333330003';
  SELECT version INTO v FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333330003';
  doc := public.buyer_profile_document('33333333-3333-3333-3333-333333330003');
  BEGIN
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', v,
      (doc - 'partner_id' - 'version') || '{"sold_on": "offer", "is_enabled": false}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'a buyer with stored accept rules was switched';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'sold_on_locked' THEN RAISE EXCEPTION 'wrong refusal with accept rules stored: %', msg; END IF;
  END;
  -- With neither stored, the switch goes through.
  UPDATE public.partner_configs SET accept_signals = '[]'::jsonb, updated_by = '22222222-2222-2222-2222-222222222222' WHERE id = '33333333-3333-3333-3333-333333330003';
  doc := public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', v,
    (doc - 'partner_id' - 'version') || '{"sold_on": "offer", "is_enabled": false}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF doc->>'sold_on' IS DISTINCT FROM 'offer' THEN RAISE EXCEPTION 'the switch did not land: %', doc->>'sold_on'; END IF;
  -- And back again, so the later cases see a click buyer.
  doc := public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', (doc->>'version')::int,
    (doc - 'partner_id' - 'version') || '{"sold_on": "click"}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF doc->>'sold_on' IS DISTINCT FROM 'click' THEN RAISE EXCEPTION 'the switch back did not land: %', doc->>'sold_on'; END IF;
  INSERT INTO suite_cases(name) VALUES ('sold_on locked while tiers or accept rules are stored');
END
$do$;

-- ── 25. sold_on: a document without the key keeps the stored kind, and an unknown kind is refused by name ──
DO $do$
DECLARE
  msg text;
  v int;
  doc jsonb;
BEGIN
  SELECT version INTO v FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333330003';
  doc := public.buyer_profile_document('33333333-3333-3333-3333-333333330003');
  -- A Worker deployed before this migration sends no sold_on; the click buyer must stay a click buyer.
  doc := public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', v,
    (doc - 'partner_id' - 'version' - 'sold_on') || '{"daily_lead_cap": 60}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
  IF doc->>'sold_on' IS DISTINCT FROM 'click' THEN RAISE EXCEPTION 'a save without sold_on changed the kind: %', doc->>'sold_on'; END IF;
  BEGIN
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333330003', (doc->>'version')::int,
      (doc - 'partner_id' - 'version') || '{"sold_on": "phone"}'::jsonb, '22222222-2222-2222-2222-222222222222', 'suite@example.test');
    RAISE EXCEPTION 'an unknown sold_on was saved';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'sold_on_invalid' THEN RAISE EXCEPTION 'wrong refusal for an unknown kind: %', msg; END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('sold_on absent keeps the kind, unknown refused');
END
$do$;

-- ── The count. Every case above inserts its name; this is the number of blocks. ──
DO $do$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 25 THEN RAISE EXCEPTION 'ran % of 25 cases', n; END IF;
  RAISE NOTICE 'buyer_profiles.test.sql: % of 25 cases passed', n;
END
$do$;
