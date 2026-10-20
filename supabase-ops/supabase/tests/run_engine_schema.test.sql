-- The run engine's tables under the ops rules, and the write choke point (#1948).
--
-- WHY. The ops Worker reaches this database as service_role, which bypasses row
-- level security, so a rule kept only in the Worker's code is a hope (L18, L27).
-- The choke point is enforced here instead: service_role may READ the run
-- engine's tables (readOpsRows) but holds no INSERT, UPDATE, DELETE or TRUNCATE
-- on any of them, so every write must go through one of the SECURITY DEFINER
-- functions this migration creates, which fence it (claim token, state version)
-- and scope it to an organization.
--
-- WHAT IT PROVES.
--   A. Each table exists with row level security on and organization_id uuid
--      NOT NULL, and the browser roles reach none of them.
--   B. service_role can SELECT each table and can write none of them, and a
--      direct write as service_role is refused by the database (the choke point,
--      seen red by granting INSERT back).
--   C. Each function is SECURITY DEFINER with a fixed search_path, executable by
--      service_role and by neither browser role; the one read function is STABLE
--      and every other is VOLATILE.
--   D. The audit table refuses a record that carries no old or no new value.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). Every case runs inside one transaction rolled back at
-- the end.

BEGIN;

CREATE TEMP TABLE re_schema_cases (name text PRIMARY KEY) ON COMMIT DROP;

-- ── A, B. Tables ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_table text;
  v_role text;
  v_priv text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.run_requests', 'public.run_queue', 'public.workflow_executions', 'public.send_ledger',
    'public.schedule_fires', 'public.run_request_dedup_tombstones', 'public.ops_audit_log'
  ] LOOP
    IF to_regclass(v_table) IS NULL THEN RAISE EXCEPTION '% does not exist', v_table; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_table::regclass) THEN
      RAISE EXCEPTION '% has row level security off', v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = v_table::regclass AND a.attname = 'organization_id' AND a.attnotnull
        AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) THEN
      RAISE EXCEPTION '% has no organization_id uuid NOT NULL column', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION '% holds a privilege on %', v_role, v_table;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'service_role cannot read %, so readOpsRows cannot', v_table;
    END IF;
    -- One privilege at a time: given a list, has_table_privilege is true when ANY is held.
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('service_role', v_table, v_priv) THEN
        RAISE EXCEPTION 'service_role holds % on %, so a write can go round the choke point', v_priv, v_table;
      END IF;
    END LOOP;
  END LOOP;
  INSERT INTO re_schema_cases VALUES ('tables: rls on, organization scoped, browser roles shut out, service_role read only');
END
$do$;

-- B. A direct write as service_role is refused by the database itself.
DO $do$
DECLARE
  v_stmt text;
  v_refused integer := 0;
BEGIN
  SET LOCAL ROLE service_role;
  FOREACH v_stmt IN ARRAY ARRAY[
    $s$INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, status, not_before, max_attempts, dedup_expires_at, execution_chain_id)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'http_webhook', 'k', 'queued', now(), 3, now(), gen_random_uuid())$s$,
    $s$UPDATE public.run_requests SET status = 'done'$s$,
    $s$DELETE FROM public.run_requests$s$,
    $s$DELETE FROM public.run_queue$s$,
    $s$DELETE FROM public.send_ledger$s$,
    $s$UPDATE public.workflow_executions SET status = 'success'$s$,
    $s$DELETE FROM public.schedule_fires$s$,
    $s$DELETE FROM public.run_request_dedup_tombstones$s$,
    $s$DELETE FROM public.ops_audit_log$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'service_role ran a direct write: %', v_stmt;
    EXCEPTION WHEN insufficient_privilege THEN
      v_refused := v_refused + 1;
    END;
  END LOOP;
  RESET ROLE;
  IF v_refused <> 9 THEN RAISE EXCEPTION 'expected 9 refused writes, got %', v_refused; END IF;
  INSERT INTO re_schema_cases VALUES ('a direct write as service_role is refused by the database');
END
$do$;

-- ── C. Functions ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_name text;
  v_fn record;
  v_count integer;
  v_names text[] := ARRAY[
    'enqueue_run_request', 'claim_run_requests', 'start_run_execution', 'extend_run_lease',
    'complete_run_request', 'sweep_expired_leases', 'expire_overdue_run_requests',
    'record_send_intent', 'record_send_result', 'record_schedule_fire',
    'purge_terminal_run_requests', 'purge_expired_dedup_tombstones', 'set_run_request_kept',
    'run_queue_disagreements'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_count <> 1 THEN RAISE EXCEPTION 'public.% has % definitions, expected exactly 1', v_name, v_count; END IF;
    SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% has no fixed search_path', v_name;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_name;
    END IF;
    IF v_name = 'run_queue_disagreements' AND v_fn.provolatile <> 's' THEN RAISE EXCEPTION 'the read function % is not STABLE', v_name; END IF;
    IF v_name <> 'run_queue_disagreements' AND v_fn.provolatile <> 'v' THEN RAISE EXCEPTION 'the write function % is not VOLATILE', v_name; END IF;
  END LOOP;
  -- No other run engine function exists unlisted (a helper a caller could reach round the list).
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND p.prokind = 'f'
    AND p.proname <> ALL (v_names)
    -- The minute cron's own functions (#1949), each held to these same rules by ops_tick.test.sql.
    AND p.proname <> ALL (ARRAY['ops_now', 'claim_ops_sweep', 'save_workflow_copies', 'workflow_copies', 'record_schedule_observation', 'due_queue_depth'])
    -- The ops connections' and Salesforce pool's (#2334), held to the same rules by connection_storage.test.sql.
    AND p.proname <> ALL (ARRAY['save_connection_copies', 'connection_copy', 'record_connection_tombstone', 'purge_expired_connection_tombstones',
      'record_connection_check', 'record_connection_needs_reauth', 'record_connection_reauth_cleared', 'connection_status',
      'record_measured_identity', 'acquire_sf_lease', 'release_sf_lease', 'sweep_sf_leases', 'record_sf_budget_reading'])
    -- The refresh streak and the Google delegation allowlist (#2335), held to the same rules by refresh_failing_and_delegation.test.sql.
    AND p.proname <> ALL (ARRAY['record_connection_refresh', 'google_delegation_check'])
    -- The lookup allowance behind OpsConnections.lookup (#2335, PR 8), held to the same rules by ops_connections_entrypoint.test.sql.
    AND p.proname <> ALL (ARRAY['take_lookup_allowance'])
    -- The sf_limits sweep's list of measured orgs (#2336), held to the same rules by sf_limits_targets.test.sql.
    AND p.proname <> ALL (ARRAY['sf_limits_targets'])
    -- The connection_check sweep's list and the tick's login states (#2340), held to the same rules by connection_check_targets.test.sql.
    AND p.proname <> ALL (ARRAY['connection_check_targets'])
    AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') IS FALSE
    AND p.proowner = 'postgres'::regrole;
  IF v_count <> 0 THEN RAISE EXCEPTION '% public function(s) executable by service_role are not on the run engine list', v_count; END IF;
  INSERT INTO re_schema_cases VALUES ('functions: security definer, fixed search_path, service_role only, read one stable');
END
$do$;

-- ── D. Audit ─────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.ops_audit_log (organization_id, action, subject_table, subject_id, old_values, new_values)
    VALUES (gen_random_uuid(), 'keep', 'run_requests', gen_random_uuid(), '{}'::jsonb, '{"kept_by": null}'::jsonb);
    RAISE EXCEPTION 'an audit record with no old value was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ops_audit_log (organization_id, action, subject_table, subject_id, old_values, new_values)
    VALUES (gen_random_uuid(), 'keep', 'run_requests', gen_random_uuid(), '{"kept_by": null}'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION 'an audit record with no new value was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO re_schema_cases VALUES ('the audit table refuses a record with no old or no new value');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM re_schema_cases);
BEGIN
  IF v_n <> 4 THEN RAISE EXCEPTION 'run_engine_schema: % of 4 cases ran', v_n; END IF;
  RAISE NOTICE 'run_engine_schema: % cases passed', v_n;
END
$do$;

ROLLBACK;
