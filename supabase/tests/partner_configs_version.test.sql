-- Versioned partner saves (#2132): the version every writer moves, the one save
-- function, the actor named at write time, and the profile version bump.
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
-- - the audit trigger reading NEW.updated_by_name for _actor.name: case 5 red;
-- - buyer_profile_tables_bump_version not setting audit_handled for its own
--   UPDATE: case 6 red (a second direct_sql row, for buyer_profiles);
-- - the bump not restoring the previous audit_handled: case 6 red (the bump runs
--   before the detector on the same statement, so even its first row is skipped);
-- - partner_configs_bump_version written as an explicit list of versioned
--   columns, with a scratch column added to the table: case 16 red.

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

DO $do$
BEGIN
  DELETE FROM public.buyer_pricing_tiers WHERE organization_id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
  DELETE FROM public.buyer_operating_windows WHERE organization_id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
  DELETE FROM public.buyer_blackout_dates WHERE organization_id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
  DELETE FROM public.buyer_profiles WHERE organization_id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
  DELETE FROM public.partner_configs WHERE organization_id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
  DELETE FROM public.users WHERE organization_id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
  DELETE FROM public.organizations WHERE id IN ('11111111-1111-1111-1111-111111112132', '11111111-1111-1111-1111-111111112133');
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112132', 'Version Org', 'version-org-2132');
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112133', 'Other Org', 'other-org-2132');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-22222222213a', '11111111-1111-1111-1111-111111112132', 'alice@example.test', 'Alice Suite');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-22222222213b', '11111111-1111-1111-1111-111111112132', 'bob@example.test', 'Bob Suite');
-- A partner last saved by Alice, through the app's insert shape.
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, bid_comparison_source, updated_by, updated_by_email, updated_by_name)
VALUES ('33333333-3333-3333-3333-333333332132', '11111111-1111-1111-1111-111111112132', 'Version Buyer', 'version-buyer-2132', 'buyer', true, 'formula', '22222222-2222-2222-2222-22222222213a', 'alice@example.test', 'Alice Suite');
-- A partner with no dependents, whose every column the catalogue case changes.
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email)
VALUES ('33333333-3333-3333-3333-333333332133', '11111111-1111-1111-1111-111111112132', 'Column Buyer', 'column-buyer-2132', 'buyer', true, '22222222-2222-2222-2222-22222222213a', 'alice@example.test');
-- A buyer profile for the profile bump cases.
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email)
VALUES ('33333333-3333-3333-3333-333333332134', '11111111-1111-1111-1111-111111112132', 'Profile Buyer', 'profile-buyer-2132', 'buyer', true, '22222222-2222-2222-2222-22222222213a', 'alice@example.test');
DO $do$
BEGIN
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332134', 0,
    '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    '22222222-2222-2222-2222-22222222213a', 'alice@example.test');
END
$do$;

-- ── 1. A new partner starts at version 0 ─────────────────────────────────────
DO $do$
DECLARE v integer;
BEGIN
  SELECT version INTO v FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  IF v IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'a new partner should be version 0, is %', v; END IF;
  INSERT INTO suite_cases(name) VALUES ('starts at 0');
END
$do$;

-- ── 2. An audited column moves the version; last_probe_response alone does not ──
DO $do$
DECLARE v0 integer; v1 integer; v2 integer;
BEGIN
  SELECT version INTO v0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  UPDATE public.partner_configs SET last_probe_response = '{"probe":1}'::jsonb WHERE id = '33333333-3333-3333-3333-333333332132';
  SELECT version INTO v1 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  IF v1 IS DISTINCT FROM v0 THEN RAISE EXCEPTION 'a last_probe_response change moved the version from % to %', v0, v1; END IF;
  UPDATE public.partner_configs SET daily_cap = 41 WHERE id = '33333333-3333-3333-3333-333333332132';
  SELECT version INTO v2 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  IF v2 IS DISTINCT FROM v0 + 1 THEN RAISE EXCEPTION 'a daily_cap change should move the version from % to %, is %', v0, v0 + 1, v2; END IF;
  INSERT INTO suite_cases(name) VALUES ('audited column moves version');
END
$do$;

-- ── 3. A hand UPDATE moves it, and cannot set it ──────────────────────────────
DO $do$
DECLARE v0 integer; v1 integer;
BEGIN
  SELECT version INTO v0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  UPDATE public.partner_configs SET min_bid = 7, version = 999 WHERE id = '33333333-3333-3333-3333-333333332132';
  SELECT version INTO v1 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  IF v1 IS DISTINCT FROM v0 + 1 THEN RAISE EXCEPTION 'a hand UPDATE should move the version by one, from % to %, is %', v0, v0 + 1, v1; END IF;
  INSERT INTO suite_cases(name) VALUES ('hand update moves version');
END
$do$;

-- ── 4 and 5. A rename moves the version and names ITS actor, never the last editor ──
DO $do$
DECLARE v0 integer; v1 integer; v_actor jsonb;
BEGIN
  SELECT version INTO v0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  PERFORM public.rename_partner_step_namespace('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332132',
    '{"bid_formula":"steps.renamed.output.x * 2"}'::jsonb, '22222222-2222-2222-2222-22222222213b', 'bob@example.test', '{"reason":"step_id_renamed"}'::jsonb);
  SELECT version INTO v1 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  IF v1 IS DISTINCT FROM v0 + 1 THEN RAISE EXCEPTION 'a rename should move the version from % to %, is %', v0, v0 + 1, v1; END IF;
  INSERT INTO suite_cases(name) VALUES ('rename moves version');

  SELECT changes -> '_actor' INTO v_actor FROM public.audit_log
  WHERE entity_id = '33333333-3333-3333-3333-333333332132' AND changes ? 'bid_formula'
  ORDER BY changed_at DESC, id DESC LIMIT 1;
  IF v_actor ->> 'name' IS DISTINCT FROM 'Bob Suite' THEN RAISE EXCEPTION 'a rename by Bob on a partner last saved by Alice stamped _actor %', v_actor; END IF;
  IF v_actor ->> 'email' IS DISTINCT FROM 'bob@example.test' THEN RAISE EXCEPTION 'the rename stamped _actor email %', v_actor; END IF;
  INSERT INTO suite_cases(name) VALUES ('rename stamps its own actor');
END
$do$;

-- ── 6. A hand UPDATE of a pricing tier: one profile version bump, one direct_sql row ──
DO $do$
DECLARE v0 integer; v1 integer; n integer;
BEGIN
  DELETE FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-333333332134';
  SELECT version INTO v0 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  UPDATE public.buyer_pricing_tiers SET multiplier = 0.02 WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  SELECT version INTO v1 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  IF v1 IS DISTINCT FROM v0 + 1 THEN RAISE EXCEPTION 'a hand tier UPDATE should move the profile version from % to %, is %', v0, v0 + 1, v1; END IF;
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-333333332134' AND changes ->> '_source' = 'direct_sql';
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'a hand tier UPDATE should write one direct_sql row, wrote %', n; END IF;
  INSERT INTO suite_cases(name) VALUES ('hand tier update bumps once');
END
$do$;

-- ── 7. Two hand statements in one transaction: two rows, the setting kept ─────
DO $do$
DECLARE v0 integer; v1 integer; n integer; before_setting text; after_setting text;
BEGIN
  DELETE FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-333333332134';
  before_setting := coalesce(current_setting('bidspoke.audit_handled', true), '');
  SELECT version INTO v0 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  UPDATE public.buyer_pricing_tiers SET multiplier = 0.03 WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  INSERT INTO public.buyer_blackout_dates (partner_id, organization_id, blackout_date, note)
  VALUES ('33333333-3333-3333-3333-333333332134', '11111111-1111-1111-1111-111111112132', '2030-01-01', 'suite');
  after_setting := coalesce(current_setting('bidspoke.audit_handled', true), '');
  SELECT version INTO v1 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-333333332134' AND changes ->> '_source' = 'direct_sql';
  IF n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'two hand statements in one transaction should write two direct_sql rows, wrote %', n; END IF;
  IF v1 IS DISTINCT FROM v0 + 2 THEN RAISE EXCEPTION 'two hand statements should move the profile version twice, from % to %', v0, v1; END IF;
  IF after_setting IS DISTINCT FROM before_setting THEN RAISE EXCEPTION 'bidspoke.audit_handled was % before and % after', before_setting, after_setting; END IF;
  INSERT INTO suite_cases(name) VALUES ('two hand statements, setting kept');
END
$do$;

-- ── 8. save_buyer_profile still moves its own version exactly once ────────────
DO $do$
DECLARE v0 integer; v1 integer;
BEGIN
  SELECT version INTO v0 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332134', v0,
    '{"sold_on":"offer","is_enabled":false,"priority":2,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    '22222222-2222-2222-2222-22222222213a', 'alice@example.test');
  SELECT version INTO v1 FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-333333332134';
  IF v1 IS DISTINCT FROM v0 + 1 THEN RAISE EXCEPTION 'save_buyer_profile should move the version from % to %, is %', v0, v0 + 1, v1; END IF;
  INSERT INTO suite_cases(name) VALUES ('profile save bumps once');
END
$do$;

-- ── 9, 10, 11. save_partner_config writes only what it names, records the save, stamps the actor ──
DO $do$
DECLARE v0 integer; v_out jsonb; v_row public.partner_configs%ROWTYPE; v_audit jsonb;
BEGIN
  SELECT version INTO v0 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  v_out := public.save_partner_config('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332132', v0,
    '{"name":"Version Buyer Renamed","daily_cap":null}'::jsonb, '44444444-4444-4444-4444-444444442132',
    '22222222-2222-2222-2222-22222222213b', 'bob@example.test', 'Bob Suite');
  SELECT * INTO v_row FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  IF v_row.name IS DISTINCT FROM 'Version Buyer Renamed' THEN RAISE EXCEPTION 'name not saved: %', v_row.name; END IF;
  IF v_row.daily_cap IS NOT NULL THEN RAISE EXCEPTION 'a JSON null should clear daily_cap, is %', v_row.daily_cap; END IF;
  IF v_row.bid_comparison_source IS DISTINCT FROM 'formula' THEN RAISE EXCEPTION 'a save that omits bid_comparison_source changed it to %', v_row.bid_comparison_source; END IF;
  IF v_row.min_bid IS DISTINCT FROM 7 THEN RAISE EXCEPTION 'a save that omits min_bid changed it to %', v_row.min_bid; END IF;
  IF v_row.version IS DISTINCT FROM v0 + 1 THEN RAISE EXCEPTION 'the save should move the version to %, is %', v0 + 1, v_row.version; END IF;
  IF (v_out ->> 'version')::integer IS DISTINCT FROM v0 + 1 THEN RAISE EXCEPTION 'the save should return the new version, returned %', v_out ->> 'version'; END IF;
  INSERT INTO suite_cases(name) VALUES ('save writes only named keys');

  IF v_row.last_save_id IS DISTINCT FROM '44444444-4444-4444-4444-444444442132' THEN RAISE EXCEPTION 'last_save_id not recorded: %', v_row.last_save_id; END IF;
  IF v_row.updated_by_name IS DISTINCT FROM 'Bob Suite' THEN RAISE EXCEPTION 'updated_by_name not set: %', v_row.updated_by_name; END IF;
  INSERT INTO suite_cases(name) VALUES ('save records save id');

  SELECT changes INTO v_audit FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-333333332132' AND changes ? 'name' ORDER BY changed_at DESC, id DESC LIMIT 1;
  IF v_audit -> '_actor' ->> 'name' IS DISTINCT FROM 'Bob Suite' THEN RAISE EXCEPTION 'the API save audit row carries _actor %', v_audit -> '_actor'; END IF;
  IF v_audit ? 'version' OR v_audit ? 'last_save_id' THEN RAISE EXCEPTION 'bookkeeping columns were audited: %', v_audit; END IF;
  INSERT INTO suite_cases(name) VALUES ('save audit names actor');
END
$do$;

-- ── 12. A stale version is refused with the current row, its save id and its editor ──
DO $do$
DECLARE v_detail text; v_state text; d jsonb; refused boolean := false; v_cap integer;
BEGIN
  BEGIN
    PERFORM public.save_partner_config('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332132', 0,
      '{"daily_cap":5}'::jsonb, '44444444-4444-4444-4444-444444442133', '22222222-2222-2222-2222-22222222213a', 'alice@example.test', 'Alice Suite');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a stale save was not refused'; END IF;
  IF v_state IS DISTINCT FROM 'BP409' THEN RAISE EXCEPTION 'a stale save raised % not BP409', v_state; END IF;
  d := v_detail::jsonb;
  IF d -> 'current' ->> 'name' IS DISTINCT FROM 'Version Buyer Renamed' THEN RAISE EXCEPTION 'the refusal carries current %', d -> 'current'; END IF;
  IF d ->> 'last_save_id' IS DISTINCT FROM '44444444-4444-4444-4444-444444442132' THEN RAISE EXCEPTION 'the refusal carries last_save_id %', d ->> 'last_save_id'; END IF;
  IF d ->> 'changed_by_name' IS DISTINCT FROM 'Bob Suite' THEN RAISE EXCEPTION 'the refusal names the last editor %', d ->> 'changed_by_name'; END IF;
  IF d ->> 'changed_at' IS NULL THEN RAISE EXCEPTION 'the refusal has no changed_at'; END IF;
  SELECT daily_cap INTO v_cap FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  IF v_cap IS NOT NULL THEN RAISE EXCEPTION 'a refused save wrote daily_cap %', v_cap; END IF;
  INSERT INTO suite_cases(name) VALUES ('stale version refused');
END
$do$;

-- ── 13. Another organization's partner is not found ───────────────────────────
DO $do$
DECLARE v_state text; refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.save_partner_config('11111111-1111-1111-1111-111111112133', '33333333-3333-3333-3333-333333332132', 0,
      '{"daily_cap":5}'::jsonb, NULL, '22222222-2222-2222-2222-22222222213a', 'alice@example.test', 'Alice Suite');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    refused := true;
  END;
  IF NOT refused OR v_state IS DISTINCT FROM 'P0002' THEN RAISE EXCEPTION 'another org''s partner should raise P0002, raised % (refused %)', v_state, refused; END IF;
  INSERT INTO suite_cases(name) VALUES ('other org not found');
END
$do$;

-- ── 14. A key outside the editable list is refused by name ────────────────────
DO $do$
DECLARE v_state text; v_detail text; v integer; refused boolean := false;
BEGIN
  SELECT version INTO v FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  BEGIN
    PERFORM public.save_partner_config('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332132', v,
      '{"slug":"stolen"}'::jsonb, NULL, '22222222-2222-2222-2222-22222222213a', 'alice@example.test', 'Alice Suite');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
    refused := true;
  END;
  IF NOT refused OR v_state IS DISTINCT FROM 'BP422' OR v_detail IS DISTINCT FROM 'slug' THEN
    RAISE EXCEPTION 'a slug patch should be refused BP422 naming slug, got % % (refused %)', v_state, v_detail, refused;
  END IF;
  INSERT INTO suite_cases(name) VALUES ('uneditable key refused');
END
$do$;

-- ── 14b. The dropped bid_mode is refused by name, not as a missing column (#2182) ──
-- A stale client naming the column after its drop gets field_not_editable
-- (BP422) rather than undefined_column (42703).
DO $do$
DECLARE v_state text; v_detail text; v integer; refused boolean := false;
BEGIN
  SELECT version INTO v FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  BEGIN
    PERFORM public.save_partner_config('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332132', v,
      '{"bid_mode":"commit"}'::jsonb, NULL, '22222222-2222-2222-2222-22222222213a', 'alice@example.test', 'Alice Suite');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
    refused := true;
  END;
  IF NOT refused OR v_state IS DISTINCT FROM 'BP422' OR v_detail IS DISTINCT FROM 'bid_mode' THEN
    RAISE EXCEPTION 'a bid_mode patch should be refused BP422 naming bid_mode, got % % (refused %)', v_state, v_detail, refused;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'partner_configs' AND column_name = 'bid_mode') THEN
    RAISE EXCEPTION 'partner_configs.bid_mode should be dropped (#2182)';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('retired bid_mode refused');
END
$do$;

-- ── 15. The Worker's role writes with every trigger firing as it ────────────
-- POST inserts and the save function update as service_role; the trigger
-- functions are revoked from PUBLIC and the helper they call is granted to it.
DO $do$
DECLARE v integer; v_out jsonb; v_inserted integer;
BEGIN
  EXECUTE 'SET ROLE service_role';
  INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, updated_by, updated_by_email)
  VALUES ('33333333-3333-3333-3333-333333332135', '11111111-1111-1111-1111-111111112132', 'Role Buyer', 'role-buyer-2132', 'buyer', '22222222-2222-2222-2222-22222222213a', 'alice@example.test');
  UPDATE public.partner_configs SET daily_cap = 9, updated_by = '22222222-2222-2222-2222-22222222213a' WHERE id = '33333333-3333-3333-3333-333333332135';
  SELECT version INTO v_inserted FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332135';
  SELECT version INTO v FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  v_out := public.save_partner_config('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332132', v,
    '{"priority":3}'::jsonb, NULL, '22222222-2222-2222-2222-22222222213a', 'alice@example.test', 'Alice Suite');
  EXECUTE 'RESET ROLE';
  IF v_inserted IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'a service_role insert then update should be version 1, is %', v_inserted; END IF;
  IF (v_out ->> 'priority')::integer IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'service_role save returned %', v_out ->> 'priority'; END IF;
  INSERT INTO suite_cases(name) VALUES ('service role writes');
END
$do$;

-- ── 16. Every column is versioned or listed ──────────────────────────────────
-- For each column of partner_configs: changing it alone moves the version unless
-- it is on partner_configs_unversioned_columns(), and then it does not. Each
-- change is made in a sub block that is rolled back, so the row stays as it was.
DO $do$
DECLARE
  c record;
  v_unversioned text[] := public.partner_configs_unversioned_columns();
  v_expr text;
  v_before integer;
  v_after integer;
  bad text[] := '{}';
  checked integer := 0;
BEGIN
  FOR c IN
    SELECT column_name, udt_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'partner_configs' ORDER BY ordinal_position
  LOOP
    v_expr := CASE
      WHEN c.column_name = 'organization_id' THEN quote_literal('11111111-1111-1111-1111-111111112133')
      WHEN c.column_name = 'updated_by' THEN quote_literal('22222222-2222-2222-2222-22222222213b')
      WHEN c.column_name = 'partner_type' THEN quote_literal('source')
      WHEN c.column_name = 'bid_resolver_type' THEN quote_literal('formula')
      WHEN c.column_name = 'bid_comparison_source' THEN quote_literal('api')
      WHEN c.column_name = 'version' THEN 'version + 5'
      WHEN c.udt_name = 'text' THEN format('coalesce(%I, '''') || ''x''', c.column_name)
      WHEN c.udt_name IN ('int2', 'int4', 'int8', 'numeric') THEN format('coalesce(%I, 0) + 1', c.column_name)
      WHEN c.udt_name = 'bool' THEN format('NOT coalesce(%I, false)', c.column_name)
      WHEN c.udt_name = 'jsonb' THEN quote_literal('{"suite_column_check": true}') || '::jsonb'
      WHEN c.udt_name = 'uuid' THEN 'gen_random_uuid()'
      WHEN c.udt_name = 'timestamptz' THEN format('coalesce(%I, now()) - interval ''1 day''', c.column_name)
      ELSE NULL
    END;
    IF v_expr IS NULL THEN
      bad := array_append(bad, format('%s (%s): the case cannot change a column of this type; add it here', c.column_name, c.udt_name));
      CONTINUE;
    END IF;
    BEGIN
      SELECT version INTO v_before FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332133';
      EXECUTE format('UPDATE public.partner_configs SET %I = %s WHERE id = %L', c.column_name, v_expr, '33333333-3333-3333-3333-333333332133');
      -- The row may have moved id; read it back by the column's own change.
      SELECT version INTO v_after FROM public.partner_configs WHERE slug LIKE 'column-buyer-2132%' OR name LIKE 'Column Buyer%' ORDER BY version DESC LIMIT 1;
      RAISE EXCEPTION USING ERRCODE = 'SUITE', MESSAGE = 'roll back';
    EXCEPTION WHEN SQLSTATE 'SUITE' THEN
      NULL;
    END;
    checked := checked + 1;
    IF c.column_name = ANY (v_unversioned) THEN
      IF v_after IS DISTINCT FROM v_before THEN bad := array_append(bad, format('%s is listed as unversioned but moved the version', c.column_name)); END IF;
    ELSE
      IF v_after IS DISTINCT FROM v_before + 1 THEN bad := array_append(bad, format('%s changed but the version went from %s to %s', c.column_name, v_before, v_after)); END IF;
    END IF;
  END LOOP;
  IF checked < 40 THEN RAISE EXCEPTION 'only % columns were checked', checked; END IF;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'columns neither versioned nor listed: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('every column versioned or listed');
END
$do$;

-- ── 17. A users row with no display name falls back to the name the save carried ──
DO $do$
DECLARE v integer; v_actor jsonb;
BEGIN
  INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-22222222213c', '11111111-1111-1111-1111-111111112132', 'carol@example.test', NULL)
  ON CONFLICT (id) DO UPDATE SET display_name = NULL;
  SELECT version INTO v FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-333333332132';
  PERFORM public.save_partner_config('11111111-1111-1111-1111-111111112132', '33333333-3333-3333-3333-333333332132', v,
    '{"min_bid":8}'::jsonb, NULL, '22222222-2222-2222-2222-22222222213c', 'carol@example.test', 'Carol From Token');
  SELECT changes -> '_actor' INTO v_actor FROM public.audit_log
  WHERE entity_id = '33333333-3333-3333-3333-333333332132' AND changes ? 'min_bid' ORDER BY changed_at DESC, id DESC LIMIT 1;
  IF v_actor ->> 'name' IS DISTINCT FROM 'Carol From Token' THEN RAISE EXCEPTION 'a users row with no display name stamped _actor %', v_actor; END IF;
  INSERT INTO suite_cases(name) VALUES ('blank display name falls back');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 18 THEN RAISE EXCEPTION 'partner_configs_version.test.sql: expected 18 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_configs_version.test.sql: % cases passed', n;
END
$do$;
