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
-- Mutation tried: the REVOKE on partner_configs_bump_version() left out of the
-- migration (case 1 red: PUBLIC keeps EXECUTE, so anon and authenticated have it).

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
    'public.save_partner_config(uuid, uuid, integer, jsonb, uuid, uuid, text, text)'
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
    'public.save_partner_config(uuid, uuid, integer, jsonb, uuid, uuid, text, text)'
  ] LOOP
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN bad := array_append(bad, 'service_role cannot execute ' || fn); END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'function grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('service_role executes the RPCs');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'partner_page_function_grants.test.sql: expected 2 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_page_function_grants.test.sql: % cases passed', n;
END
$do$;
