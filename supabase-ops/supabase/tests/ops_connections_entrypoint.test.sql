-- The OpsConnections entrypoint's database needs (#2335, PR 8 of phase 5 of
-- #1689). Migration 20261019010000_ops_connections_entrypoint_2335.sql.
--
-- WHAT IT PROVES.
--   A. The new objects are under the ops rules: connection_lookup_windows has
--      row level security on, organization_id uuid NOT NULL, browser roles shut
--      out and service_role read only; take_lookup_allowance is SECURITY
--      DEFINER with a fixed search_path and a 2 second lock_timeout, and
--      service_role alone may run it.
--   B. A candidate's measurement (findings F116, F126). A verify of a
--      generation ops does not hold as its copy records what it measured; a
--      later verify of the SAME generation measuring another identity (the
--      Reconnect after one whose compare and set never ran) replaces it,
--      answering replaced, and the serve of the committed generation is still
--      saved. Once the copy holds that generation, another identity is
--      identity_changed and writes nothing, as before.
--   C. The lookup allowance: per organization, up to the stated cap in a one
--      minute window, then rate_limited with retry_at the window's end; a new
--      window starts afresh; another organization's lookups do not count; a
--      cap outside 1 to 600, the nil organization and a missing one are
--      refused.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE oc_cases (name text PRIMARY KEY);

CREATE FUNCTION pg_temp.oc_copy(p_conn uuid, p_org uuid, p_gen bigint)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('connection_id', p_conn, 'organization_id', p_org, 'service', 'salesforce', 'generation', p_gen,
    'envelope', jsonb_build_object('v', 1, 'kid', 'ops-2026-10', 'wrapped_key', 'd3JhcHBlZA', 'iv', 'aXY', 'ct', 'Y3Q'),
    'public_config', jsonb_build_object('name', 'ops salesforce'),
    'target', jsonb_build_object('instance_url', 'https://ops.my.salesforce.com', 'client_id', 'ops-app'),
    'serve_until', now() + interval '6 hours')
$f$;

-- ── A. The objects ───────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_role text;
  v_priv text;
  v_fn record;
BEGIN
  IF to_regclass('public.connection_lookup_windows') IS NULL THEN RAISE EXCEPTION 'public.connection_lookup_windows does not exist'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.connection_lookup_windows'::regclass) THEN
    RAISE EXCEPTION 'connection_lookup_windows has row level security off';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.connection_lookup_windows'::regclass AND a.attname = 'organization_id'
      AND a.attnotnull AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'connection_lookup_windows has no organization_id uuid NOT NULL column';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.connection_lookup_windows', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION '% holds a privilege on connection_lookup_windows', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.connection_lookup_windows', 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read connection_lookup_windows'; END IF;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('service_role', 'public.connection_lookup_windows', v_priv) THEN RAISE EXCEPTION 'service_role holds % on connection_lookup_windows', v_priv; END IF;
  END LOOP;

  FOR v_fn IN
    SELECT p.oid::regprocedure AS sig, p.proname, p.prosecdef, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('take_lookup_allowance', 'record_measured_identity')
  LOOP
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn.proname; END IF;
    IF NOT ('search_path=""' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn.proname; END IF;
    IF NOT ('lock_timeout=2s' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION '% has no 2 second lock_timeout', v_fn.proname; END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
      IF has_function_privilege(v_role, v_fn.sig, 'EXECUTE') THEN RAISE EXCEPTION '% may run %', v_role, v_fn.proname; END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', v_fn.sig, 'EXECUTE') THEN RAISE EXCEPTION 'service_role may not run %', v_fn.proname; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('take_lookup_allowance', 'record_measured_identity')) <> 2 THEN
    RAISE EXCEPTION 'expected one take_lookup_allowance and one record_measured_identity';
  END IF;
  INSERT INTO oc_cases VALUES ('objects: RLS, organization, privileges, definer functions');
END
$do$;

-- ── B. A candidate's measurement is replaced; a committed one never is ───────
DO $do$
DECLARE
  v_conn uuid := '00000000-0000-4000-8000-0000000023a8';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002308';
  v_saved record;
BEGIN
  -- Ops holds generation 1, measured.
  PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.oc_copy(v_conn, v_org, 1)));
  IF public.record_measured_identity(v_org, v_conn, 1, '00Dcs0000000001EAA', 'ops-one@example.invalid') <> 'recorded' THEN
    RAISE EXCEPTION 'the committed generation was not measured';
  END IF;

  -- A Reconnect's candidate at generation 2 is verified (nothing is saved to
  -- connection_copies), then bidding's compare and set never runs.
  IF public.record_measured_identity(v_org, v_conn, 2, '00Dcs0000000002EAA', 'ops-two@example.invalid') <> 'recorded' THEN
    RAISE EXCEPTION 'a candidate generation was not measured';
  END IF;
  -- The next Reconnect seals another login under generation 2 again: measured afresh, not refused.
  IF public.record_measured_identity(v_org, v_conn, 2, '00Dcs0000000003EAA', 'ops-three@example.invalid') <> 'replaced' THEN
    RAISE EXCEPTION 'a second candidate at the same generation was refused (F126: a failed Reconnect blocked the next)';
  END IF;
  IF (SELECT sf_org_id || ' ' || username FROM public.connection_measured_identity WHERE connection_id = v_conn AND generation = 2)
      <> '00Dcs0000000003EAA ops-three@example.invalid' THEN
    RAISE EXCEPTION 'the replaced measurement is not the second candidate''s';
  END IF;
  -- The committed generation's measurement is untouched.
  IF (SELECT sf_org_id FROM public.connection_measured_identity WHERE connection_id = v_conn AND generation = 1) <> '00Dcs0000000001EAA' THEN
    RAISE EXCEPTION 'a candidate''s measurement touched the committed one';
  END IF;

  -- The serve of the committed generation is still saved (the candidate wrote no copy).
  SELECT * INTO v_saved FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.oc_copy(v_conn, v_org, 1)));
  IF v_saved.refused_older <> 0 OR (v_saved.confirmed + v_saved.updated) <> 1 THEN
    RAISE EXCEPTION 'the serve of the committed generation was not saved after a candidate''s verify: %', row_to_json(v_saved);
  END IF;

  -- Once ops holds generation 2 as its copy, another identity there is identity_changed and writes nothing.
  PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.oc_copy(v_conn, v_org, 2)));
  IF public.record_measured_identity(v_org, v_conn, 2, '00Dcs0000000004EAA', 'ops-four@example.invalid') <> 'identity_changed' THEN
    RAISE EXCEPTION 'a committed generation''s measurement was overwritten';
  END IF;
  IF (SELECT sf_org_id FROM public.connection_measured_identity WHERE connection_id = v_conn AND generation = 2) <> '00Dcs0000000003EAA' THEN
    RAISE EXCEPTION 'identity_changed wrote something';
  END IF;
  IF public.record_measured_identity(v_org, v_conn, 2, '00Dcs0000000003EAA', 'ops-three@example.invalid') <> 'confirmed' THEN
    RAISE EXCEPTION 'a repeat of the committed measurement was not confirmed';
  END IF;

  -- Another organization still cannot measure it, and a removal still wins.
  BEGIN
    PERFORM public.record_measured_identity('cccccccc-0000-4000-8000-000000002308', v_conn, 3, '00Dcs0000000001EAA', 'x');
    RAISE EXCEPTION 'another organization measured this connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM public.record_connection_tombstone(v_org, v_conn, 3, now());
  IF public.record_measured_identity(v_org, v_conn, 3, '00Dcs0000000001EAA', 'ops-one@example.invalid') <> 'connection_removed' THEN
    RAISE EXCEPTION 'a removed generation was measured';
  END IF;
  INSERT INTO oc_cases VALUES ('measured identity: a candidate''s is replaced, a committed one never, the committed serve still saved');
END
$do$;

-- ── C. The lookup allowance ──────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002318';
  v_other uuid := 'bbbbbbbb-0000-4000-8000-000000002318';
  v_r record;
  i integer;
BEGIN
  FOR i IN 1..3 LOOP
    SELECT * INTO v_r FROM public.take_lookup_allowance(v_org, 3);
    IF v_r.outcome <> 'allowed' OR v_r.used <> i OR v_r.retry_at IS NOT NULL THEN RAISE EXCEPTION 'lookup % of 3 was not allowed: %', i, row_to_json(v_r); END IF;
  END LOOP;
  SELECT * INTO v_r FROM public.take_lookup_allowance(v_org, 3);
  IF v_r.outcome <> 'rate_limited' OR v_r.used <> 3 THEN RAISE EXCEPTION 'the fourth lookup in a minute was not refused: %', row_to_json(v_r); END IF;
  IF v_r.retry_at <> (SELECT window_start + interval '1 minute' FROM public.connection_lookup_windows WHERE organization_id = v_org) THEN
    RAISE EXCEPTION 'retry_at is not the window''s end';
  END IF;
  -- A refused lookup takes nothing.
  IF (SELECT used FROM public.connection_lookup_windows WHERE organization_id = v_org) <> 3 THEN RAISE EXCEPTION 'a refused lookup was counted'; END IF;

  -- Another organization has its own allowance.
  SELECT * INTO v_r FROM public.take_lookup_allowance(v_other, 3);
  IF v_r.outcome <> 'allowed' OR v_r.used <> 1 THEN RAISE EXCEPTION 'another organization''s lookups counted against this one: %', row_to_json(v_r); END IF;

  -- A window that has ended starts afresh.
  UPDATE public.connection_lookup_windows SET window_start = now() - interval '61 seconds' WHERE organization_id = v_org;
  SELECT * INTO v_r FROM public.take_lookup_allowance(v_org, 3);
  IF v_r.outcome <> 'allowed' OR v_r.used <> 1 THEN RAISE EXCEPTION 'a new window did not start afresh: %', row_to_json(v_r); END IF;
  -- And one that has not, does not.
  UPDATE public.connection_lookup_windows SET window_start = now() - interval '59 seconds', used = 3 WHERE organization_id = v_org;
  SELECT * INTO v_r FROM public.take_lookup_allowance(v_org, 3);
  IF v_r.outcome <> 'rate_limited' THEN RAISE EXCEPTION 'a window with a second left was reset'; END IF;

  BEGIN
    PERFORM public.take_lookup_allowance(v_org, 0);
    RAISE EXCEPTION 'a cap of 0 answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.take_lookup_allowance(v_org, 601);
    RAISE EXCEPTION 'a cap of 601 answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.take_lookup_allowance('00000000-0000-0000-0000-000000000000', 3);
    RAISE EXCEPTION 'the nil organization took an allowance';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.take_lookup_allowance(NULL, 3);
    RAISE EXCEPTION 'no organization took an allowance';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO oc_cases VALUES ('lookup allowance: the cap per organization per minute, refusals by name');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM oc_cases);
BEGIN
  IF v_n <> 3 THEN RAISE EXCEPTION 'ops_connections_entrypoint: % of 3 cases ran', v_n; END IF;
  RAISE NOTICE 'ops_connections_entrypoint: % cases passed', v_n;
END
$do$;

ROLLBACK;
