-- Function grants for the partners page migrations (#2114 plan, Rules: Function
-- grants, L124, #762).
--
-- Every function the partners page migrations create or replace is listed here,
-- and anon and authenticated must not be able to execute any of them. The RPCs
-- the Worker calls must be executable by service_role. Each later PR of #2114
-- adds its functions to the lists.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.
--
-- Mutations tried: the REVOKE on partner_configs_bump_version() left out of the
-- migration (case 1 red: PUBLIC keeps EXECUTE, so anon and authenticated have it);
-- the REVOKE on _apply_buyer_profile left out (#2133, case 1 red); the REVOKE
-- from service_role on it left out (case 3 red: the default privileges grant it);
-- #2143 replaced _apply_buyer_profile and buyer_profile_document and lists the
-- second here.

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

-- ── 1. anon and authenticated execute none of them ───────────────────────────
DO $do$
DECLARE
  fn text;
  bad text[] := '{}';
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    -- PR1 (#2132)
    'public.partner_configs_unversioned_columns()',
    'public.partner_configs_bump_version()',
    'public.partner_configs_audit()',
    'public.buyer_profile_tables_direct_sql_audit()',
    'public.buyer_profile_tables_bump_version()',
    'public.save_partner_config(uuid, uuid, integer, jsonb, uuid, uuid, text, text)',
    -- PR2 (#2133)
    'public._apply_buyer_profile(uuid, uuid, jsonb, uuid, text, jsonb)',
    'public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text)',
    'public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text)',
    -- #2151
    'public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb)',
    -- PR4 (#2135)
    'public.partner_page_notice_tables()',
    'public.notify_partner_page(uuid, uuid, text, text[], boolean, uuid, uuid)',
    'public.partner_configs_capture_actor()',
    'public.partner_configs_page_notice()',
    'public.buyer_profile_tables_page_notice()',
    'public.partner_uuid_map_page_notice()',
    'public.partner_uuid_map_page_notice_one_side()',
    'public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, uuid, text, text)',
    'public.change_partner_uuid(uuid, text, text, text, uuid, text, text)',
    'public.monitor_partner_page_ping(uuid, uuid)',
    -- PR12 (#2143): _apply_buyer_profile is listed above
    'public.buyer_profile_document(uuid)',
    -- PR9 (#2140); change_partner_uuid is listed above
    'public.partner_delete_dependents()',
    'public.partner_delete_counts(uuid, uuid, boolean)',
    'public.partner_delete_check(uuid, uuid)',
    'public._delete_partner_config(uuid, uuid, uuid, text, jsonb)',
    'public.delete_partner_config(uuid, uuid, uuid, text, jsonb)',
    'public.delete_partner_config(uuid, uuid, uuid, text)'
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') THEN bad := array_append(bad, 'anon can execute ' || fn); END IF;
    IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN bad := array_append(bad, 'authenticated can execute ' || fn); END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'function grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('anon and authenticated refused');
END
$do$;

-- ── 2. The Worker's RPCs are executable by service_role ──────────────────────
DO $do$
DECLARE
  fn text;
  bad text[] := '{}';
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.save_partner_config(uuid, uuid, integer, jsonb, uuid, uuid, text, text)',
    'public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text)',
    'public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text)',
    'public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb)',
    -- PR4 (#2135)
    'public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, uuid, text, text)',
    'public.change_partner_uuid(uuid, text, text, text, uuid, text, text)',
    'public.monitor_partner_page_ping(uuid, uuid)',
    -- #2143: GET /partners/:id/buyer-profile reads the document through it
    'public.buyer_profile_document(uuid)',
    -- PR9 (#2140): the delete check and the reviewed delete
    'public.partner_delete_check(uuid, uuid)',
    'public.delete_partner_config(uuid, uuid, uuid, text, jsonb)'
  ] LOOP
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN bad := array_append(bad, 'service_role cannot execute ' || fn); END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'function grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('service_role executes the RPCs');
END
$do$;

-- ── 3. An internal function is executable by nobody but its owner ─────────────
-- The platform's default privileges grant every new function in public to
-- service_role, so a REVOKE from PUBLIC, anon and authenticated still leaves the
-- Worker able to call it directly. _apply_buyer_profile skips the locks and the
-- version comparison its two callers make, so the Worker must reach it only
-- through them (#2133, found on the production read back of 20261016000000).
DO $do$
DECLARE
  fn text;
BEGIN
  IF has_function_privilege('service_role', 'public._apply_buyer_profile(uuid, uuid, jsonb, uuid, text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'function grants wrong: service_role can execute public._apply_buyer_profile, which skips the locks and the version check';
  END IF;
  -- PR4 (#2135): the sender and the trigger functions. A Worker calling
  -- notify_partner_page directly could send to any organization's topic.
  FOREACH fn IN ARRAY ARRAY[
    'public.partner_page_notice_tables()',
    'public.notify_partner_page(uuid, uuid, text, text[], boolean, uuid, uuid)',
    'public.partner_configs_page_notice()',
    'public.buyer_profile_tables_page_notice()',
    'public.partner_uuid_map_page_notice()',
    'public.partner_uuid_map_page_notice_one_side()',
    -- PR9 (#2140): the dependency walk, the counter, and the shared delete body,
    -- which skips the fingerprint when handed none.
    'public.partner_delete_dependents()',
    'public.partner_delete_counts(uuid, uuid, boolean)',
    'public._delete_partner_config(uuid, uuid, uuid, text, jsonb)'
  ] LOOP
    IF has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'function grants wrong: service_role can execute %, which is internal', fn;
    END IF;
  END LOOP;
  INSERT INTO suite_cases(name) VALUES ('internal function not callable by service_role');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'partner_page_function_grants.test.sql: expected 3 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_page_function_grants.test.sql: % cases passed', n;
END
$do$;
