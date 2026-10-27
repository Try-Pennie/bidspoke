-- service_connections.schema_cache and schema_synced_at are dropped (#2567).
-- Migration 20261027220000_drop_schema_cache_columns_2567.sql.
--
-- WHAT IT PROVES.
--   A. After every migration neither column exists on service_connections.
--   B. No function or view in the public schema still names either column, the
--      audit trigger's list of columns it leaves unrecorded included, so no
--      body is left describing a column that is gone.
--   C. The audit trigger still records a change to an ordinary column and
--      still leaves its bookkeeping columns unrecorded.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds, inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE dsc_cases (name text PRIMARY KEY);

-- ── A. Both columns are gone ─────────────────────────────────────────────────
DO $do$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(attname, ', ' ORDER BY attname) INTO v_left
  FROM pg_attribute
  WHERE attrelid = 'public.service_connections'::regclass
    AND attname IN ('schema_cache', 'schema_synced_at')
    AND attnum > 0 AND NOT attisdropped;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'service_connections still has %', v_left;
  END IF;
  INSERT INTO dsc_cases VALUES ('gone: service_connections has neither schema_cache nor schema_synced_at');
END
$do$;

-- ── B. Named by no function or view ──────────────────────────────────────────
DO $do$
DECLARE
  v_named text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_named
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosrc ~ 'schema_(cache|synced_at)';
  IF v_named IS NOT NULL THEN
    RAISE EXCEPTION 'a function still names a dropped schema cache column: %', v_named;
  END IF;
  SELECT string_agg(viewname, ', ' ORDER BY viewname) INTO v_named
  FROM pg_views WHERE schemaname = 'public' AND definition ~ 'schema_(cache|synced_at)';
  IF v_named IS NOT NULL THEN
    RAISE EXCEPTION 'a view still names a dropped schema cache column: %', v_named;
  END IF;
  INSERT INTO dsc_cases VALUES ('named by nothing: no function or view names either column');
END
$do$;

-- ── C. The audit trigger still records what it did ───────────────────────────
DO $do$
DECLARE
  v_org uuid := '11111111-1111-1111-1111-111111112567';
  v_user uuid := '22222222-2222-2222-2222-222222222567';
  v_changes jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES (v_org, 'Schema cache drop org', 'schema-cache-drop-2567');
  INSERT INTO public.users (id, organization_id, email, display_name) VALUES (v_user, v_org, 'dsc2567@example.test', 'DSC User');
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, config, updated_by)
  VALUES (v_org, 'salesforce', 'salesforce', 'oauth_client_credentials', 'CONN_TEST_2567', '{}', v_user);
  DELETE FROM public.audit_log WHERE organization_id = v_org;

  UPDATE public.service_connections SET acts_as = 'integration@example.com', updated_by = v_user WHERE organization_id = v_org;
  SELECT changes INTO v_changes FROM public.audit_log WHERE organization_id = v_org AND entity_type = 'service_connection';
  IF v_changes IS NULL THEN RAISE EXCEPTION 'a change to acts_as wrote no audit row'; END IF;
  IF NOT v_changes ? 'acts_as' THEN RAISE EXCEPTION 'the audit row did not record acts_as: %', v_changes; END IF;
  IF v_changes ?| ARRAY['updated_at', 'updated_by', 'updated_by_email'] THEN
    RAISE EXCEPTION 'the audit row recorded a bookkeeping column: %', v_changes;
  END IF;
  INSERT INTO dsc_cases VALUES ('audited: an ordinary column is recorded, the bookkeeping columns are not');
END
$do$;

DO $do$
DECLARE
  v_count integer := (SELECT count(*) FROM dsc_cases);
BEGIN
  IF v_count <> 3 THEN RAISE EXCEPTION 'drop_schema_cache_columns.test.sql: only % of 3 cases ran', v_count; END IF;
  RAISE NOTICE 'drop_schema_cache_columns.test.sql: % cases passed', v_count;
END
$do$;

ROLLBACK;
