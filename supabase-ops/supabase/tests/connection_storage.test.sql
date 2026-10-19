-- Ops connection storage and the ops Salesforce pool (#2334, phase 4 of #1689,
-- the first of its two deploys). Migration 20261017220000_ops_connections_2334.sql.
--
-- WHAT IT PROVES.
--   A. Every new table is under the ops rules (row level security on,
--      organization_id uuid NOT NULL, browser roles shut out, service_role read
--      only, a direct write refused); the rows that belong to a Salesforce org
--      rather than a Bidspoke organization carry the nil uuid, held there by a
--      CHECK (F117). Every new function is SECURITY DEFINER with a fixed
--      search_path, executable by service_role alone, every write one carries
--      lock_timeout, the read ones are STABLE.
--   B. claim_ops_sweep accepts every sweep its CHECK allows, the three new ones
--      included, and still refuses an unknown one.
--   C. The copies: a lower generation is refused, an equal one confirms, a
--      higher one replaces; a complete list withdraws one it omits; a copy
--      already past serve_until, or one a tombstone covers, is refused; a
--      serve_until more than 6 hours after served_at (Dan's decision 3) is
--      refused by the table; another organization's copy is refused; the read
--      names why a copy may not be used.
--   D. The tombstones: recording one removes the copy and its health, expires no
--      sooner than 7 hours after the removal, never lowers its generation, and
--      the purge deletes only expired rows.
--   E. Health, one column per writer (L53): a passing check after a refresh
--      failure still derives needs_reauth; only Reconnect clears it; each
--      writer leaves the others' columns alone.
--   F. The measured identity: recorded once per connection and generation,
--      confirmed on a repeat, a different org refused by name; a malformed org
--      id refused.
--   G. The pool (F118, F127): from tables holding only the rows an approval
--      creates (since #2335, F125, an approval also states each non step
--      purpose's share, in sf_purpose_caps), the first verify of a connection with no measured row takes the
--      bootstrap slot of its approved host; an unapproved host is refused with
--      sf_cap_unset; any other call before verify is refused with
--      sf_org_unmeasured; once verify has written the measured row, the sf_limits
--      read is granted with no reading, and the next lookup is granted from the
--      org's pool. Two connections with different declared hosts and one
--      measured org share one pool and never exceed its cap, one workflow
--      exhausts only its own share, an org with no approved cap is refused with
--      sf_cap_unset, a stale or low reading is refused by name, release is
--      idempotent by holder, a lapsed lease stops counting and is swept.
--   H. acquire_sf_lease counts under the org's advisory lock: a second session
--      holding it makes the acquire wait, then fail on lock_timeout, never grant.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). Case H uses a second session through dblink and
-- removes what it wrote; every other case runs inside one transaction rolled
-- back at the end.

\if :{?self_host}
\else
  \echo 'connection_storage.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('cs_test.self_host', :'self_host', false) AS self_host_set \gset
SELECT NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') AS cs_created_dblink \gset
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TEMP TABLE cs_cases (name text PRIMARY KEY);

-- ── H. The org pool's lock ───────────────────────────────────────────────────
DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('cs_test.self_host'));
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_conn uuid := '00000000-0000-4000-8000-0000000023a0';
  v_sf text := '00Dcs0000000000HAA';
  v_waited boolean := false;
BEGIN
  INSERT INTO public.connection_measured_identity (organization_id, connection_id, generation, sf_org_id, username)
  VALUES (v_org, v_conn, 1, v_sf, 'ops-h@example.invalid');
  INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by)
  VALUES (v_sf, 5, 5, 0, now(), 'case H');
  PERFORM dblink_connect('cs_a', conn);
  PERFORM dblink_exec('cs_a', 'BEGIN');
  PERFORM * FROM dblink('cs_a', format($q$SELECT pg_advisory_xact_lock(hashtextextended(%L, 0))::text$q$, 'sf_pool:' || v_sf)) AS t(x text);
  BEGIN
    PERFORM public.acquire_sf_lease(v_org, v_conn, 1, 'sf_limits', NULL, 'holder-h', 60);
  EXCEPTION WHEN lock_not_available THEN v_waited := true;
  END;
  PERFORM dblink_exec('cs_a', 'ROLLBACK');
  PERFORM dblink_disconnect('cs_a');
  DELETE FROM public.sf_leases WHERE holder = 'holder-h';
  DELETE FROM public.sf_pool_caps WHERE sf_org_id = v_sf;
  DELETE FROM public.connection_measured_identity WHERE connection_id = v_conn;
  IF NOT v_waited THEN RAISE EXCEPTION 'an acquire went ahead while another session held the org pool lock'; END IF;
  INSERT INTO cs_cases VALUES ('pool: an acquire waits on the org pool lock another session holds');
END
$do$;

BEGIN;

-- ── A. Tables and functions ──────────────────────────────────────────────────
DO $do$
DECLARE
  v_table text;
  v_role text;
  v_priv text;
  v_name text;
  v_fn record;
  v_stmt text;
  v_refused integer := 0;
  v_reads text[] := ARRAY['connection_copy', 'connection_status'];
  v_names text[] := ARRAY[
    'save_connection_copies', 'connection_copy', 'record_connection_tombstone', 'purge_expired_connection_tombstones',
    'record_connection_check', 'record_connection_needs_reauth', 'record_connection_reauth_cleared', 'connection_status',
    'record_measured_identity', 'acquire_sf_lease', 'release_sf_lease', 'sweep_sf_leases', 'record_sf_budget_reading'];
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.connection_copies', 'public.connection_tombstones_ops', 'public.connection_health',
    'public.connection_measured_identity', 'public.sf_pool_caps', 'public.sf_bootstrap_caps', 'public.sf_budget_readings', 'public.sf_leases'] LOOP
    IF to_regclass(v_table) IS NULL THEN RAISE EXCEPTION '% does not exist', v_table; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_table::regclass) THEN RAISE EXCEPTION '% has row level security off', v_table; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_table::regclass AND a.attname = 'organization_id' AND a.attnotnull
        AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) THEN
      RAISE EXCEPTION '% has no organization_id uuid NOT NULL column', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION '% holds a privilege on %', v_role, v_table;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', v_table, 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read %', v_table; END IF;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('service_role', v_table, v_priv) THEN RAISE EXCEPTION 'service_role holds % on %', v_priv, v_table; END IF;
    END LOOP;
  END LOOP;

  SET LOCAL ROLE service_role;
  FOREACH v_stmt IN ARRAY ARRAY[
    $s$DELETE FROM public.connection_copies$s$,
    $s$DELETE FROM public.connection_tombstones_ops$s$,
    $s$UPDATE public.connection_health SET reauth_cleared_at = now()$s$,
    $s$DELETE FROM public.connection_measured_identity$s$,
    -- A cap is set only by an approval migration, never by the Worker (L72).
    $s$INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES ('00Dcs0000000000AAA', 50, 50, 0, now(), 'worker')$s$,
    $s$INSERT INTO public.sf_bootstrap_caps (instance_host, cap, approved_at, approved_by) VALUES ('x.my.salesforce.com', 1, now(), 'worker')$s$,
    $s$DELETE FROM public.sf_budget_readings$s$,
    $s$DELETE FROM public.sf_leases$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'service_role ran a direct write: %', v_stmt;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
    END;
  END LOOP;
  RESET ROLE;
  IF v_refused <> 8 THEN RAISE EXCEPTION 'expected 8 refused writes, got %', v_refused; END IF;

  FOREACH v_name IN ARRAY v_names LOOP
    SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'public.% does not exist', v_name; END IF;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT ('search_path=""' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION '% has no empty fixed search_path: %', v_name, v_fn.proconfig; END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_name;
    END IF;
    IF v_name = ANY (v_reads) AND v_fn.provolatile <> 's' THEN RAISE EXCEPTION 'the read function % is not STABLE', v_name; END IF;
    IF NOT v_name = ANY (v_reads) THEN
      IF v_fn.provolatile <> 'v' THEN RAISE EXCEPTION 'the write function % is not VOLATILE', v_name; END IF;
      IF NOT ('lock_timeout=2s' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION 'the write function % has no 2s lock_timeout', v_name; END IF;
    END IF;
  END LOOP;

  -- Salesforce org rows are lane rows: they cannot be read as an organization's.
  FOREACH v_stmt IN ARRAY ARRAY[
    $s$INSERT INTO public.sf_pool_caps (sf_org_id, organization_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES ('00Dcs0000000000AAA', gen_random_uuid(), 5, 5, 0, now(), 'x')$s$,
    $s$INSERT INTO public.sf_bootstrap_caps (instance_host, organization_id, cap, approved_at, approved_by) VALUES ('x.my.salesforce.com', gen_random_uuid(), 1, now(), 'x')$s$,
    $s$INSERT INTO public.sf_budget_readings (sf_org_id, organization_id, daily_api_max, daily_api_remaining, source, measured_at) VALUES ('00Dcs0000000000AAA', gen_random_uuid(), 10, 5, 'limits', now())$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'a Salesforce org row took an organization: %', v_stmt;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  -- A cap is a stated number: no default, a share no larger than the pool, a bootstrap cap of 1, a Salesforce host.
  FOREACH v_stmt IN ARRAY ARRAY[
    $s$INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES ('00Dcs0000000000AAA', 5, 6, 0, now(), 'x')$s$,
    $s$INSERT INTO public.sf_bootstrap_caps (instance_host, cap, approved_at, approved_by) VALUES ('x.my.salesforce.com', 2, now(), 'x')$s$,
    $s$INSERT INTO public.sf_bootstrap_caps (instance_host, cap, approved_at, approved_by) VALUES ('evil.example.com', 1, now(), 'x')$s$,
    $s$INSERT INTO public.sf_bootstrap_caps (instance_host, cap, approved_at, approved_by) VALUES ('https://x.my.salesforce.com', 1, now(), 'x')$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'a cap outside its rules was stored: %', v_stmt;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    INSERT INTO public.sf_pool_caps (sf_org_id, workflow_share, budget_floor, approved_at, approved_by) VALUES ('00Dcs0000000000AAA', 1, 0, now(), 'x');
    RAISE EXCEPTION 'a cap was stored with no number';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  INSERT INTO cs_cases VALUES ('tables and functions under the ops rules, Salesforce org rows on the nil uuid, caps only as stated');
END
$do$;

-- ── B. The widened sweeps ────────────────────────────────────────────────────
DO $do$
DECLARE
  v_sweep text;
  v_owned boolean;
BEGIN
  FOREACH v_sweep IN ARRAY ARRAY['lease_expiry', 'run_expiry', 'queue_agreement', 'tombstone_expiry', 'connection_check', 'sf_limits'] LOOP
    DELETE FROM public.ops_lane_sweeps WHERE sweep = v_sweep;
    SELECT o INTO v_owned FROM public.claim_ops_sweep(v_sweep, 'tick-cs', 60) AS c(o, n, s, w);
    IF NOT v_owned THEN RAISE EXCEPTION 'the sweep % could not be claimed', v_sweep; END IF;
  END LOOP;
  BEGIN
    PERFORM public.claim_ops_sweep('purge_everything', 'tick-cs', 60);
    RAISE EXCEPTION 'an unknown sweep was claimed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ops_lane_sweeps (sweep) VALUES ('purge_everything');
    RAISE EXCEPTION 'the sweep CHECK took an unknown sweep';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO cs_cases VALUES ('sweeps: tombstone_expiry, connection_check and sf_limits are claimable, an unknown one is not');
END
$do$;

-- One copy as the bidding Worker serves it. Fixed instants where the order matters.
CREATE FUNCTION pg_temp.cs_copy(p_conn uuid, p_org uuid, p_gen bigint, p_serve_until timestamptz, p_kid text DEFAULT 'ops-2026-10')
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('connection_id', p_conn, 'organization_id', p_org, 'service', 'salesforce', 'generation', p_gen,
    'envelope', jsonb_build_object('v', 1, 'kid', p_kid, 'wrapped_key', 'd3JhcHBlZA', 'iv', 'aXY', 'ct', 'Y3Q'),
    'public_config', jsonb_build_object('name', 'trypennie'),
    'target', jsonb_build_object('instance_url', 'https://trypennie.my.salesforce.com', 'client_id', '3MVG-ops'),
    'serve_until', p_serve_until)
$f$;

-- ── C. Copies ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_conn uuid := '00000000-0000-4000-8000-0000000023c1';
  v_gone uuid := '00000000-0000-4000-8000-0000000023c2';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_c record;
  v_r record;
BEGIN
  SELECT * INTO v_c FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 2, now() + interval '6 hours')));
  IF v_c.inserted <> 1 THEN RAISE EXCEPTION 'a new copy was not inserted: %', v_c; END IF;
  SELECT * INTO v_c FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 2, now() + interval '6 hours')));
  IF v_c.confirmed <> 1 THEN RAISE EXCEPTION 'an equal generation did not confirm: %', v_c; END IF;
  SELECT * INTO v_c FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 1, now() + interval '6 hours', 'ops-old')));
  IF v_c.refused_older <> 1 THEN RAISE EXCEPTION 'a lower generation was not refused: %', v_c; END IF;
  IF (SELECT generation FROM public.connection_copies WHERE connection_id = v_conn) <> 2 THEN RAISE EXCEPTION 'a lower generation replaced the copy'; END IF;
  SELECT * INTO v_c FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 3, now() + interval '6 hours', 'ops-new')));
  IF v_c.updated <> 1 OR (SELECT envelope->>'kid' FROM public.connection_copies WHERE connection_id = v_conn) <> 'ops-new' THEN
    RAISE EXCEPTION 'a higher generation did not replace the copy: %', v_c;
  END IF;

  SELECT * INTO v_r FROM public.connection_copy(v_org, v_conn);
  IF v_r.state <> 'usable' OR v_r.generation <> 3 OR v_r.envelope->>'kid' <> 'ops-new' THEN RAISE EXCEPTION 'a fresh copy reads as %', v_r; END IF;

  -- Past serve_until: refused by the read, by name (an outage longer than the window).
  UPDATE public.connection_copies SET served_at = now() - interval '7 hours', serve_until = now() - interval '1 hour' WHERE connection_id = v_conn;
  SELECT * INTO v_r FROM public.connection_copy(v_org, v_conn);
  IF v_r.state <> 'connection_copy_expired' THEN RAISE EXCEPTION 'a copy past serve_until reads as %', v_r.state; END IF;
  -- A list served long ago arrives late: already past serve_until, it is refused, not stored.
  SELECT * INTO v_c FROM public.save_connection_copies(now() - interval '7 hours', false,
    jsonb_build_array(pg_temp.cs_copy(v_gone, v_org, 1, now() - interval '1 hour')));
  IF v_c.refused_expired <> 1 OR EXISTS (SELECT 1 FROM public.connection_copies WHERE connection_id = v_gone) THEN
    RAISE EXCEPTION 'a copy already past serve_until was stored: %', v_c;
  END IF;

  -- Decision 3: a copy may be served for at most 6 hours.
  BEGIN
    PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_gone, v_org, 1, now() + interval '6 hours 1 second')));
    RAISE EXCEPTION 'a copy served for more than 6 hours was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A complete list withdraws a connection it no longer names, and only a newer list brings it back.
  PERFORM public.save_connection_copies(now() - interval '2 minutes', false, jsonb_build_array(pg_temp.cs_copy(v_gone, v_org, 1, now() + interval '5 hours')));
  SELECT * INTO v_c FROM public.save_connection_copies(now() - interval '1 minute', true, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 3, now() + interval '5 hours')));
  IF v_c.withdrawn <> 1 THEN RAISE EXCEPTION 'a complete list did not withdraw the connection it omitted: %', v_c; END IF;
  SELECT * INTO v_r FROM public.connection_copy(v_org, v_gone);
  IF v_r.state <> 'connection_withdrawn' THEN RAISE EXCEPTION 'a withdrawn copy reads as %', v_r.state; END IF;
  PERFORM public.save_connection_copies(now() - interval '90 seconds', false, jsonb_build_array(pg_temp.cs_copy(v_gone, v_org, 1, now() + interval '5 hours')));
  SELECT * INTO v_r FROM public.connection_copy(v_org, v_gone);
  IF v_r.state <> 'connection_withdrawn' THEN RAISE EXCEPTION 'an older list brought a withdrawn copy back'; END IF;

  -- Another organization's connection is refused, on save and on read.
  BEGIN
    PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, 'cccccccc-0000-4000-8000-000000002334', 4, now() + interval '1 hour')));
    RAISE EXCEPTION 'a copy under another organization was saved';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.connection_copy('cccccccc-0000-4000-8000-000000002334', v_conn);
    RAISE EXCEPTION 'another organization read a copy';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT * INTO v_r FROM public.connection_copy(v_org, '00000000-0000-4000-8000-0000000023cf');
  IF v_r.state <> 'not_found' OR v_r.envelope IS NOT NULL THEN RAISE EXCEPTION 'an unknown connection reads as %', v_r; END IF;

  -- An envelope that is not the seal's shape is refused by the table.
  BEGIN
    PERFORM public.save_connection_copies(now(), false, jsonb_build_array(
      pg_temp.cs_copy(gen_random_uuid(), v_org, 1, now() + interval '1 hour') || jsonb_build_object('envelope', jsonb_build_object('v', 1, 'kid', 'k', 'plaintext', 'x'))));
    RAISE EXCEPTION 'an envelope of the wrong shape was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.save_connection_copies(now(), false, (SELECT jsonb_agg(pg_temp.cs_copy(gen_random_uuid(), v_org, 1, now() + interval '1 hour')) FROM generate_series(1, 1001)));
    RAISE EXCEPTION 'a list of 1001 copies was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO cs_cases VALUES ('copies: generation order, withdrawal, the 6 hour window, organization, envelope shape, and the read names why');
END
$do$;

-- ── D. Tombstones ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_conn uuid := '00000000-0000-4000-8000-0000000023d1';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_t record;
  v_c record;
  v_r record;
  v_p record;
BEGIN
  PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 4, now() + interval '6 hours')));
  PERFORM public.record_connection_check(v_org, v_conn, true, NULL);
  SELECT * INTO v_t FROM public.record_connection_tombstone(v_org, v_conn, 4, now());
  IF v_t.outcome <> 'recorded' OR v_t.copies_removed <> 1 THEN RAISE EXCEPTION 'a tombstone did not remove the copy: %', v_t; END IF;
  IF EXISTS (SELECT 1 FROM public.connection_copies WHERE connection_id = v_conn) THEN RAISE EXCEPTION 'the copy outlived its tombstone'; END IF;
  IF EXISTS (SELECT 1 FROM public.connection_health WHERE connection_id = v_conn) THEN RAISE EXCEPTION 'health outlived the connection'; END IF;
  IF (SELECT expires_at FROM public.connection_tombstones_ops WHERE connection_id = v_conn) < now() + interval '7 hours' THEN
    RAISE EXCEPTION 'a tombstone expires before every copy served before the removal has';
  END IF;
  SELECT * INTO v_r FROM public.connection_copy(v_org, v_conn);
  IF v_r.state <> 'connection_removed' THEN RAISE EXCEPTION 'a removed connection reads as %', v_r.state; END IF;

  -- A late list that still names the removed generation cannot bring it back (L625).
  SELECT * INTO v_c FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 4, now() + interval '6 hours')));
  IF v_c.refused_removed <> 1 OR EXISTS (SELECT 1 FROM public.connection_copies WHERE connection_id = v_conn) THEN
    RAISE EXCEPTION 'a removed connection came back from a late list: %', v_c;
  END IF;
  -- Health is not recreated for a removed connection.
  IF public.record_connection_check(v_org, v_conn, true, NULL) <> 'connection_removed' THEN RAISE EXCEPTION 'health was written for a removed connection'; END IF;

  -- A repeat with a lower generation never lowers it.
  SELECT * INTO v_t FROM public.record_connection_tombstone(v_org, v_conn, 2, now());
  IF v_t.outcome <> 'already_recorded' OR (SELECT generation FROM public.connection_tombstones_ops WHERE connection_id = v_conn) <> 4 THEN
    RAISE EXCEPTION 'a repeat lowered the tombstone: %', v_t;
  END IF;
  BEGIN
    PERFORM public.record_connection_tombstone('cccccccc-0000-4000-8000-000000002334', v_conn, 5, now());
    RAISE EXCEPTION 'another organization moved a tombstone';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.connection_tombstones_ops (organization_id, connection_id, generation, removed_at, expires_at)
    VALUES (v_org, gen_random_uuid(), 1, now(), now() + interval '6 hours');
    RAISE EXCEPTION 'a tombstone shorter than the serve window was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The purge deletes only expired tombstones.
  PERFORM public.record_connection_tombstone(v_org, '00000000-0000-4000-8000-0000000023d2', 1, now() - interval '8 hours');
  SELECT * INTO v_p FROM public.purge_expired_connection_tombstones(1000);
  IF v_p.purged <> 1 OR v_p.more THEN RAISE EXCEPTION 'the purge took % (more %), expected the one expired tombstone', v_p.purged, v_p.more; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.connection_tombstones_ops WHERE connection_id = v_conn) THEN RAISE EXCEPTION 'the purge took a live tombstone'; END IF;
  INSERT INTO cs_cases VALUES ('tombstones: remove the copy and health, outlive the serve window, never lower, purge only expired');
END
$do$;

-- ── E. Health, one column per writer ─────────────────────────────────────────
DO $do$
DECLARE
  v_conn uuid := '00000000-0000-4000-8000-0000000023e1';
  v_new uuid := '00000000-0000-4000-8000-0000000023e2';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_s record;
  v_reauth timestamptz;
BEGIN
  PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 1, now() + interval '6 hours'),
    pg_temp.cs_copy(v_new, v_org, 1, now() + interval '6 hours')));
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_new;
  IF v_s.status <> 'unchecked' THEN RAISE EXCEPTION 'a connection never checked reads as %', v_s.status; END IF;

  PERFORM public.record_connection_check(v_org, v_conn, true, NULL);
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'healthy' THEN RAISE EXCEPTION 'a passing check reads as %', v_s.status; END IF;

  -- A refresh failure, then a passing check: still needs_reauth (L53).
  PERFORM public.record_connection_needs_reauth(v_org, v_conn, 'invalid_grant');
  PERFORM public.record_connection_check(v_org, v_conn, true, NULL);
  SELECT needs_reauth_at INTO v_reauth FROM public.connection_health WHERE connection_id = v_conn;
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'needs_reauth' THEN RAISE EXCEPTION 'a passing check after a refresh failure reads as %, not needs_reauth', v_s.status; END IF;
  IF v_s.last_check_ok_at < v_reauth THEN RAISE EXCEPTION 'the case did not put the passing check after the failure'; END IF;
  IF v_s.needs_reauth_cause <> 'invalid_grant' THEN RAISE EXCEPTION 'the cause was lost: %', v_s.needs_reauth_cause; END IF;
  -- The check writer left the reauth columns alone.
  IF (SELECT needs_reauth_at FROM public.connection_health WHERE connection_id = v_conn) IS DISTINCT FROM v_reauth THEN
    RAISE EXCEPTION 'the check writer moved needs_reauth_at';
  END IF;

  -- Only Reconnect clears it.
  PERFORM public.record_connection_reauth_cleared(v_org, v_conn);
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'healthy' THEN RAISE EXCEPTION 'after Reconnect the connection reads as %', v_s.status; END IF;

  -- A failing check after a pass.
  PERFORM public.record_connection_check(v_org, v_conn, false, 'userinfo answered 503');
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'check_failing' OR v_s.last_check_cause <> 'userinfo answered 503' THEN RAISE EXCEPTION 'a failing check reads as %', v_s; END IF;

  BEGIN
    PERFORM public.record_connection_check(v_org, v_conn, false, NULL);
    RAISE EXCEPTION 'a failed check with no cause was recorded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_connection_check(v_org, v_conn, true, 'fine');
    RAISE EXCEPTION 'a passing check with a cause was recorded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_connection_needs_reauth('cccccccc-0000-4000-8000-000000002334', v_conn, 'invalid_client');
    RAISE EXCEPTION 'another organization wrote this connection''s health';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.connection_status('cccccccc-0000-4000-8000-000000002334', 1000)) THEN
    RAISE EXCEPTION 'another organization read this connection''s status';
  END IF;
  INSERT INTO cs_cases VALUES ('health: a passing check after a refresh failure still needs reauth, only Reconnect clears it');
END
$do$;

-- ── F. The measured identity ─────────────────────────────────────────────────
DO $do$
DECLARE
  v_conn uuid := '00000000-0000-4000-8000-0000000023f1';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
BEGIN
  -- Ops holds generation 1 as its copy, so its measurement is the committed
  -- credential's. A generation the copy does not hold yet is a candidate's,
  -- measured afresh (#2335, PR 8: ops_connections_entrypoint.test.sql).
  PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.cs_copy(v_conn, v_org, 1, now() + interval '6 hours')));
  IF public.record_measured_identity(v_org, v_conn, 1, '00Dcs0000000001EAA', 'ops@trypennie.example') <> 'recorded' THEN RAISE EXCEPTION 'a first measurement was not recorded'; END IF;
  IF public.record_measured_identity(v_org, v_conn, 1, '00Dcs0000000001EAA', 'ops@trypennie.example') <> 'confirmed' THEN RAISE EXCEPTION 'a repeat was not a confirmation'; END IF;
  IF public.record_measured_identity(v_org, v_conn, 1, '00Dcs0000000002EAA', 'ops@trypennie.example') <> 'identity_changed' THEN
    RAISE EXCEPTION 'a different org for the same generation was not refused by name';
  END IF;
  IF (SELECT sf_org_id FROM public.connection_measured_identity WHERE connection_id = v_conn AND generation = 1) <> '00Dcs0000000001EAA' THEN
    RAISE EXCEPTION 'a changed identity overwrote the measured one';
  END IF;
  -- A new generation is measured afresh.
  IF public.record_measured_identity(v_org, v_conn, 2, '00Dcs0000000002EAA', 'ops@trypennie.example') <> 'recorded' THEN RAISE EXCEPTION 'a new generation was not measured'; END IF;
  BEGIN
    PERFORM public.record_measured_identity(v_org, gen_random_uuid(), 1, '00Dcs00000000', 'ops@trypennie.example');
    RAISE EXCEPTION 'a 15 character org id was stored';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_measured_identity('cccccccc-0000-4000-8000-000000002334', v_conn, 1, '00Dcs0000000001EAA', 'x');
    RAISE EXCEPTION 'another organization measured this connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO cs_cases VALUES ('measured identity: once per generation, a changed org refused by name, a malformed one refused');
END
$do$;

-- ── G. The pool ──────────────────────────────────────────────────────────────
-- Exactly the rows an approval creates (Decision 11): one approved host for the
-- bootstrap slot, one approved org cap, and the shares of the purposes used
-- here (#2335, F125). No measured identity, no reading.
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_first uuid := '00000000-0000-4000-8000-0000000023a1';
  v_second uuid := '00000000-0000-4000-8000-0000000023a2';
  v_sf text := '00Dcs0000000003EAA';
  v_a record;
BEGIN
  INSERT INTO public.sf_bootstrap_caps (instance_host, cap, approved_at, approved_by) VALUES ('trypennie.my.salesforce.com', 1, now(), 'Dan (test)');
  INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES (v_sf, 3, 2, 100, now(), 'Dan (test)');
  INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES
    (v_sf, 'lookup', 2, now(), 'Dan (test)'), (v_sf, 'verify', 1, now(), 'Dan (test)'), (v_sf, 'sf_limits', 1, now(), 'Dan (test)');

  -- Before verify, a lookup is refused: nothing measured to key on.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 1, 'lookup', NULL, 'g-lookup-0', 30);
  IF v_a.outcome <> 'sf_org_unmeasured' OR v_a.lease_id IS NOT NULL THEN RAISE EXCEPTION 'a lookup before verify was answered %', v_a.outcome; END IF;
  -- Verify with no host given is refused the same way.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 1, 'verify', NULL, 'g-verify-0', 30);
  IF v_a.outcome <> 'sf_org_unmeasured' THEN RAISE EXCEPTION 'a verify with no declared host was answered %', v_a.outcome; END IF;
  -- An unapproved host: refused by name, never read as no limit.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_second, 1, 'verify', NULL, 'g-verify-x', 30, 'unapproved.my.salesforce.com');
  IF v_a.outcome <> 'sf_cap_unset' THEN RAISE EXCEPTION 'a verify against an unapproved host was answered %', v_a.outcome; END IF;

  -- The first verify takes the approved host's bootstrap slot (case is the host's, not the caller's).
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 1, 'verify', NULL, 'g-verify-1', 30, 'TryPennie.my.salesforce.com');
  IF v_a.outcome <> 'granted' OR v_a.pool <> 'bootstrap' OR v_a.lease_id IS NULL THEN RAISE EXCEPTION 'the first verify was answered %', v_a; END IF;
  -- The slot is one: a second connection's first verify on that host waits for it.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_second, 1, 'verify', NULL, 'g-verify-2', 30, 'trypennie.my.salesforce.com');
  IF v_a.outcome <> 'pool_full' OR v_a.retry_at IS NULL THEN RAISE EXCEPTION 'a second bootstrap verify was answered %', v_a; END IF;

  -- Verify measures the org, writes the row and releases.
  IF public.record_measured_identity(v_org, v_first, 1, v_sf, 'ops@trypennie.example') <> 'recorded' THEN RAISE EXCEPTION 'verify could not record'; END IF;
  IF public.release_sf_lease(v_org, 'g-verify-1') <> 'released' THEN RAISE EXCEPTION 'the verify lease was not released'; END IF;
  IF public.release_sf_lease(v_org, 'g-verify-1') <> 'not_held' THEN RAISE EXCEPTION 'a second release was not idempotent'; END IF;

  -- Measured, but no reading yet: a lookup is refused by name, and the sf_limits read is not (L665).
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 1, 'lookup', NULL, 'g-lookup-1', 30);
  IF v_a.outcome <> 'sf_budget_unmeasured' THEN RAISE EXCEPTION 'a lookup with no reading was answered %', v_a.outcome; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 1, 'sf_limits', NULL, 'g-limits-1', 30);
  IF v_a.outcome <> 'granted' OR v_a.pool <> 'org' THEN RAISE EXCEPTION 'the sf_limits read was answered %', v_a.outcome; END IF;
  IF public.record_sf_budget_reading(v_sf, 15000, 14000, 'limits') <> 'recorded' THEN RAISE EXCEPTION 'the reading was not recorded'; END IF;
  PERFORM public.release_sf_lease(v_org, 'g-limits-1');

  -- The next lookup is granted from the org's pool.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 1, 'lookup', NULL, 'g-lookup-2', 30);
  IF v_a.outcome <> 'granted' OR v_a.pool <> 'org' THEN RAISE EXCEPTION 'a lookup after verify and a reading was answered %', v_a; END IF;
  -- Repeating an acquire by the same holder returns the same lease (assume it runs twice).
  IF (SELECT lease_id FROM public.acquire_sf_lease(v_org, v_first, 1, 'lookup', NULL, 'g-lookup-2', 30)) <> v_a.lease_id THEN
    RAISE EXCEPTION 'a repeated acquire took a second lease';
  END IF;
  IF (SELECT count(*) FROM public.sf_leases WHERE holder = 'g-lookup-2') <> 1 THEN RAISE EXCEPTION 'a holder holds two leases'; END IF;
  PERFORM public.release_sf_lease(v_org, 'g-lookup-2');
  -- Verify again after it is measured goes through the org's pool, not the bootstrap slot.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 1, 'verify', NULL, 'g-verify-3', 30, 'trypennie.my.salesforce.com');
  IF v_a.pool <> 'org' THEN RAISE EXCEPTION 'a measured connection''s verify used the bootstrap slot'; END IF;
  PERFORM public.release_sf_lease(v_org, 'g-verify-3');
  -- A new generation is unmeasured until its own verify.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_first, 2, 'lookup', NULL, 'g-lookup-3', 30);
  IF v_a.outcome <> 'sf_org_unmeasured' THEN RAISE EXCEPTION 'a new generation borrowed the old measurement: %', v_a.outcome; END IF;
  INSERT INTO cs_cases VALUES ('pool: from approval rows only, the first verify takes the bootstrap slot, then lookups are granted from the org pool');
END
$do$;

DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_other_org uuid := 'bbbbbbbb-0000-4000-8000-000000002334';
  v_one uuid := '00000000-0000-4000-8000-0000000023b1';
  v_two uuid := '00000000-0000-4000-8000-0000000023b2';
  v_nocap uuid := '00000000-0000-4000-8000-0000000023b3';
  v_sf text := '00Dcs0000000004EAA';
  v_wf_a uuid := '00000000-0000-4000-8000-00000000a001';
  v_wf_b uuid := '00000000-0000-4000-8000-00000000b001';
  v_wf_c uuid := '00000000-0000-4000-8000-00000000c001';
  v_a record;
  v_s record;
BEGIN
  INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES (v_sf, 3, 2, 100, now(), 'Dan (test)');
  INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES
    (v_sf, 'lookup', 2, now(), 'Dan (test)'), (v_sf, 'sf_limits', 1, now(), 'Dan (test)');
  -- Two connections, declared against different hosts and owned by two organizations, measured to one org (L66, L1005).
  PERFORM public.record_measured_identity(v_org, v_one, 1, v_sf, 'ops-one@example.invalid');
  PERFORM public.record_measured_identity(v_other_org, v_two, 1, v_sf, 'ops-two@example.invalid');
  PERFORM public.record_sf_budget_reading(v_sf, 15000, 14000, 'sforce_limit_info');

  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'step', v_wf_a, 'p-a1', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'p-a1: %', v_a.outcome; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'step', v_wf_a, 'p-a2', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'p-a2: %', v_a.outcome; END IF;
  -- The runaway workflow exhausts only its own share, from either connection.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_other_org, v_two, 1, 'step', v_wf_a, 'p-a3', 60);
  IF v_a.outcome <> 'workflow_share_full' THEN RAISE EXCEPTION 'a third lease for one workflow was answered %', v_a.outcome; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_other_org, v_two, 1, 'step', v_wf_b, 'p-b1', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'another workflow was refused while the pool had room: %', v_a.outcome; END IF;
  -- The pool is full across both connections.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'step', v_wf_c, 'p-c1', 60);
  IF v_a.outcome <> 'pool_full' OR v_a.retry_at IS NULL THEN RAISE EXCEPTION 'a fourth lease on a pool of 3 was answered %', v_a; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_other_org, v_two, 1, 'lookup', NULL, 'p-l1', 60);
  IF v_a.outcome <> 'pool_full' THEN RAISE EXCEPTION 'a lookup on the full pool was answered %', v_a.outcome; END IF;
  IF (SELECT count(*) FROM public.sf_leases WHERE sf_org_id = v_sf AND expires_at > now()) <> 3 THEN RAISE EXCEPTION 'the shared pool holds more than its cap'; END IF;

  -- A lease whose holder died lapses: it stops counting, and the sweep reclaims it (L409).
  UPDATE public.sf_leases SET acquired_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' WHERE holder = 'p-a1';
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'step', v_wf_c, 'p-c1', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'a lapsed lease still counted: %', v_a.outcome; END IF;
  SELECT * INTO v_s FROM public.sweep_sf_leases(1000);
  IF v_s.swept <> 1 OR v_s.more THEN RAISE EXCEPTION 'the sweep took % lapsed leases, expected 1', v_s.swept; END IF;
  IF EXISTS (SELECT 1 FROM public.sf_leases WHERE holder = 'p-a1') THEN RAISE EXCEPTION 'the lapsed lease was not swept'; END IF;
  -- A release by another organization releases nothing of this one's.
  BEGIN
    PERFORM public.release_sf_lease(v_other_org, 'p-a2');
    RAISE EXCEPTION 'another organization released a lease';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Budget: below the floor, and a stale reading, are refused by their own names (L567).
  UPDATE public.sf_leases SET acquired_at = now() - interval '2 minutes', expires_at = now() - interval '1 second' WHERE sf_org_id = v_sf;
  PERFORM public.record_sf_budget_reading(v_sf, 15000, 99, 'sforce_limit_info');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'step', v_wf_a, 'p-floor', 60);
  IF v_a.outcome <> 'sf_budget_floor' OR v_a.retry_at IS NULL THEN RAISE EXCEPTION 'a reading under the floor was answered %', v_a; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'sf_limits', NULL, 'p-floor-limits', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'the sf_limits read was held to the floor: %', v_a.outcome; END IF;
  UPDATE public.sf_budget_readings SET daily_api_remaining = 14000, measured_at = now() - interval '16 minutes' WHERE sf_org_id = v_sf;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'step', v_wf_a, 'p-stale', 60);
  IF v_a.outcome <> 'sf_budget_unmeasured' THEN RAISE EXCEPTION 'a stale reading was answered %, not sf_budget_unmeasured', v_a.outcome; END IF;

  -- Measured, but the org has no approved cap: refused by name, never read as no limit (L72).
  PERFORM public.record_measured_identity(v_org, v_nocap, 1, '00Dcs0000000005EAA', 'ops@example.invalid');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_nocap, 1, 'sf_limits', NULL, 'p-nocap', 60);
  IF v_a.outcome <> 'sf_cap_unset' THEN RAISE EXCEPTION 'an org with no approved cap was answered %', v_a.outcome; END IF;

  -- The caller cannot reach another organization's measured connection.
  BEGIN
    PERFORM public.acquire_sf_lease(v_other_org, v_one, 1, 'lookup', NULL, 'p-x', 60);
    RAISE EXCEPTION 'another organization took a lease on this connection';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A step names its workflow, nothing else does, and only verify takes a host.
  BEGIN
    PERFORM public.acquire_sf_lease(v_org, v_one, 1, 'step', NULL, 'p-y', 60);
    RAISE EXCEPTION 'a step with no workflow took a lease';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.acquire_sf_lease(v_org, v_one, 1, 'lookup', NULL, 'p-z', 60, 'trypennie.my.salesforce.com');
    RAISE EXCEPTION 'a lookup took the bootstrap path';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO cs_cases VALUES ('pool: one measured org is one pool across connections and organizations, shares, lapses, budget and cap refusals by name');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM cs_cases);
BEGIN
  IF v_n <> 9 THEN RAISE EXCEPTION 'connection_storage: % of 9 cases ran', v_n; END IF;
  RAISE NOTICE 'connection_storage: % cases passed', v_n;
END
$do$;

ROLLBACK;

\if :cs_created_dblink
  DROP EXTENSION dblink;
\endif
