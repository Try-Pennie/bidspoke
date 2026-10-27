-- How long an ops key reseal has been switched on, and what its runs last said
-- (#2486). Migration 20261027160000_ops_reseal_watch_2486.sql.
--
-- WHAT IT PROVES.
--   A. ops_reseal_state is the lane's own one row: RLS on, no browser role
--      reaches it, service_role may only read it, and its CHECKs refuse a mode
--      that is not preview or apply, a negative count, a run with no result,
--      and a finish with no run that reported one.
--   B. Both functions are SECURITY DEFINER with a fixed search_path, VOLATILE
--      (they write), executable by service_role and by no browser role, and
--      refuse a mode, a restart window, a result or a count they cannot take
--      by name.
--   C. observe_ops_reseal starts the switch's clock on its first sighting, keeps
--      it while the same mode is seen, and starts it afresh (forgetting the last
--      run) when the mode changes or the switch went unseen for the restart
--      window.
--   D. record_ops_reseal_run keeps each run's result, starts the finished clock
--      on the first run that left nothing and keeps it while later ones agree,
--      clears it on a run that left something, and creates the row itself when
--      no observation came first, so a run is never lost for want of one.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end. now()
-- is fixed in a transaction, so a later time is made by moving the stored times
-- back, as the postgres role the suite runs as.

BEGIN;

CREATE TEMP TABLE rw_cases (name text PRIMARY KEY);

-- ── A. The table ──────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_rel record;
BEGIN
  SELECT c.oid, c.relrowsecurity INTO v_rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'ops_reseal_state';
  IF v_rel.oid IS NULL THEN RAISE EXCEPTION 'public.ops_reseal_state does not exist'; END IF;
  IF NOT v_rel.relrowsecurity THEN RAISE EXCEPTION 'ops_reseal_state has RLS off'; END IF;
  IF has_table_privilege('anon', v_rel.oid, 'SELECT') OR has_table_privilege('authenticated', v_rel.oid, 'SELECT') THEN
    RAISE EXCEPTION 'a browser role can read ops_reseal_state';
  END IF;
  IF NOT has_table_privilege('service_role', v_rel.oid, 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read ops_reseal_state'; END IF;
  IF has_table_privilege('service_role', v_rel.oid, 'INSERT') OR has_table_privilege('service_role', v_rel.oid, 'UPDATE')
    OR has_table_privilege('service_role', v_rel.oid, 'DELETE') THEN
    RAISE EXCEPTION 'service_role can write ops_reseal_state other than through its functions';
  END IF;

  BEGIN
    INSERT INTO public.ops_reseal_state (organization_id, mode, mode_since, seen_at) VALUES ('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60', 'apply', now(), now());
    RAISE EXCEPTION 'ops_reseal_state took a row for an organization';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ops_reseal_state (mode, mode_since, seen_at) VALUES ('yes', now(), now());
    RAISE EXCEPTION 'ops_reseal_state took a mode that is neither preview nor apply';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ops_reseal_state (mode, mode_since, seen_at, last_run_at, last_run_nothing_left, last_run_left) VALUES ('apply', now(), now(), now(), false, -1);
    RAISE EXCEPTION 'ops_reseal_state took a negative count';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ops_reseal_state (mode, mode_since, seen_at, last_run_at) VALUES ('apply', now(), now(), now());
    RAISE EXCEPTION 'ops_reseal_state took a run with no result';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.ops_reseal_state (mode, mode_since, seen_at, nothing_left_since) VALUES ('apply', now(), now(), now());
    RAISE EXCEPTION 'ops_reseal_state took a finish with no run that reported one';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO rw_cases VALUES ('table: the lane row, RLS on, read only to service_role, its checks refuse what cannot be');
END
$do$;

-- ── B. The functions' shape ───────────────────────────────────────────────────
DO $do$
DECLARE
  v_name text;
  v_fn record;
  v_message text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['observe_ops_reseal', 'record_ops_reseal_run'] LOOP
    SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_fn.oid IS NULL THEN RAISE EXCEPTION 'public.% does not exist', v_name; END IF;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.provolatile <> 'v' THEN RAISE EXCEPTION '% writes and is not VOLATILE', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% has no fixed search_path', v_name;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_name;
    END IF;
  END LOOP;

  BEGIN
    PERFORM public.observe_ops_reseal('yes', 600);
    RAISE EXCEPTION 'observe_ops_reseal took a mode that is neither preview nor apply';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%preview or apply%' THEN RAISE EXCEPTION 'an unknown mode was refused for another reason: %', v_message; END IF;
  END;
  BEGIN
    PERFORM public.observe_ops_reseal(NULL, 600);
    RAISE EXCEPTION 'observe_ops_reseal took a null mode';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.observe_ops_reseal('apply', 59);
    RAISE EXCEPTION 'observe_ops_reseal took a restart window under a minute';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%60 to 86400 seconds%' THEN RAISE EXCEPTION 'a short window was refused for another reason: %', v_message; END IF;
  END;
  BEGIN
    PERFORM public.record_ops_reseal_run('apply', NULL, 3, 600);
    RAISE EXCEPTION 'record_ops_reseal_run took a run with no result';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_ops_reseal_run('apply', false, -1, 600);
    RAISE EXCEPTION 'record_ops_reseal_run took a negative count';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_ops_reseal_run('apply', true, 2, 600);
    RAISE EXCEPTION 'record_ops_reseal_run took a run that left nothing and 2 logins';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%left nothing%' THEN RAISE EXCEPTION 'a contradictory run was refused for another reason: %', v_message; END IF;
  END;
  BEGIN
    PERFORM public.record_ops_reseal_run('preview', false, NULL, 86401);
    RAISE EXCEPTION 'record_ops_reseal_run took a restart window over a day';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.ops_reseal_state) THEN RAISE EXCEPTION 'a refused call wrote the row'; END IF;
  INSERT INTO rw_cases VALUES ('shape: security definer, volatile, fixed search_path, service_role only, bad arguments refused by name and nothing written');
END
$do$;

-- ── C. observe_ops_reseal ─────────────────────────────────────────────────────
DO $do$
DECLARE
  v record;
BEGIN
  -- First sighting: the clock starts now, no run known.
  SELECT * INTO v FROM public.observe_ops_reseal('apply', 600);
  IF v.mode <> 'apply' OR v.mode_since <> now() OR v.db_now <> now() OR NOT v.restarted THEN RAISE EXCEPTION 'the first sighting did not start the clock: %', row_to_json(v); END IF;
  IF v.last_run_at IS NOT NULL OR v.last_run_left IS NOT NULL OR v.last_run_nothing_left IS NOT NULL OR v.nothing_left_since IS NOT NULL THEN
    RAISE EXCEPTION 'the first sighting claimed a run: %', row_to_json(v);
  END IF;

  -- Two hours on, seen every minute (seen_at a minute ago): the clock is kept.
  UPDATE public.ops_reseal_state SET mode_since = now() - interval '2 hours', seen_at = now() - interval '1 minute',
    last_run_at = now() - interval '1 minute', last_run_left = 3, last_run_nothing_left = false;
  SELECT * INTO v FROM public.observe_ops_reseal('apply', 600);
  IF v.mode_since <> now() - interval '2 hours' OR v.restarted THEN RAISE EXCEPTION 'a sighting in the same mode restarted the clock: %', row_to_json(v); END IF;
  IF v.last_run_left <> 3 OR v.last_run_nothing_left OR v.last_run_at <> now() - interval '1 minute' THEN RAISE EXCEPTION 'a sighting lost the last run: %', row_to_json(v); END IF;
  IF (SELECT seen_at FROM public.ops_reseal_state) <> now() THEN RAISE EXCEPTION 'a sighting did not stamp when it was seen'; END IF;

  -- The mode changes: the clock starts afresh and the run of the other mode is forgotten.
  SELECT * INTO v FROM public.observe_ops_reseal('preview', 600);
  IF v.mode <> 'preview' OR v.mode_since <> now() OR NOT v.restarted OR v.last_run_at IS NOT NULL OR v.last_run_left IS NOT NULL THEN
    RAISE EXCEPTION 'a change of mode kept the old clock or run: %', row_to_json(v);
  END IF;

  -- Unseen for longer than the window (the switch was off): afresh.
  UPDATE public.ops_reseal_state SET mode_since = now() - interval '30 days', seen_at = now() - interval '601 seconds',
    last_run_at = now() - interval '601 seconds', last_run_left = 0, last_run_nothing_left = true, nothing_left_since = now() - interval '29 days';
  SELECT * INTO v FROM public.observe_ops_reseal('preview', 600);
  IF v.mode_since <> now() OR NOT v.restarted OR v.nothing_left_since IS NOT NULL OR v.last_run_at IS NOT NULL THEN
    RAISE EXCEPTION 'a switch unseen past the window kept its old clock: %', row_to_json(v);
  END IF;

  -- Unseen for just inside the window: kept.
  UPDATE public.ops_reseal_state SET mode_since = now() - interval '1 hour', seen_at = now() - interval '599 seconds';
  SELECT * INTO v FROM public.observe_ops_reseal('preview', 600);
  IF v.mode_since <> now() - interval '1 hour' OR v.restarted THEN RAISE EXCEPTION 'a switch seen inside the window was restarted: %', row_to_json(v); END IF;

  IF (SELECT count(*) FROM public.ops_reseal_state) <> 1 THEN RAISE EXCEPTION 'ops_reseal_state holds more than its one row'; END IF;
  DELETE FROM public.ops_reseal_state;
  INSERT INTO rw_cases VALUES ('observe: starts the clock, keeps it in one mode, restarts it on a change of mode or past the window');
END
$do$;

-- ── D. record_ops_reseal_run ──────────────────────────────────────────────────
DO $do$
DECLARE
  v record;
BEGIN
  -- No observation came first: the run creates the row and starts the clock.
  SELECT * INTO v FROM public.record_ops_reseal_run('apply', false, 4, 600);
  IF v.mode <> 'apply' OR v.mode_since <> now() OR NOT v.restarted OR v.last_run_at <> now() OR v.last_run_left <> 4 OR v.last_run_nothing_left OR v.nothing_left_since IS NOT NULL THEN
    RAISE EXCEPTION 'a run with no row before it was not kept: %', row_to_json(v);
  END IF;

  -- A failed run: nothing known left, no count.
  UPDATE public.ops_reseal_state SET mode_since = now() - interval '90 minutes', seen_at = now() - interval '1 minute';
  SELECT * INTO v FROM public.record_ops_reseal_run('apply', false, NULL, 600);
  IF v.mode_since <> now() - interval '90 minutes' OR v.restarted OR v.last_run_left IS NOT NULL OR v.last_run_nothing_left THEN
    RAISE EXCEPTION 'a failed run was not kept as one: %', row_to_json(v);
  END IF;

  -- The first run that left nothing starts the finished clock.
  SELECT * INTO v FROM public.record_ops_reseal_run('apply', true, 0, 600);
  IF v.nothing_left_since <> now() OR NOT v.last_run_nothing_left OR v.last_run_left <> 0 THEN RAISE EXCEPTION 'the first finished run did not start the finished clock: %', row_to_json(v); END IF;

  -- A later one that agrees keeps it.
  UPDATE public.ops_reseal_state SET nothing_left_since = now() - interval '3 hours', seen_at = now() - interval '1 minute';
  SELECT * INTO v FROM public.record_ops_reseal_run('apply', true, 0, 600);
  IF v.nothing_left_since <> now() - interval '3 hours' THEN RAISE EXCEPTION 'a second finished run restarted the finished clock: %', row_to_json(v); END IF;

  -- An observation in between keeps both clocks.
  SELECT * INTO v FROM public.observe_ops_reseal('apply', 600);
  IF v.nothing_left_since <> now() - interval '3 hours' OR v.mode_since <> now() - interval '90 minutes' THEN RAISE EXCEPTION 'an observation lost a clock: %', row_to_json(v); END IF;

  -- A run that leaves something clears it.
  SELECT * INTO v FROM public.record_ops_reseal_run('apply', false, 1, 600);
  IF v.nothing_left_since IS NOT NULL OR v.last_run_left <> 1 THEN RAISE EXCEPTION 'a run that left a login kept the finished clock: %', row_to_json(v); END IF;

  -- A run in another mode restarts the switch's clock as an observation does.
  SELECT * INTO v FROM public.record_ops_reseal_run('preview', true, 0, 600);
  IF v.mode <> 'preview' OR v.mode_since <> now() OR NOT v.restarted OR v.nothing_left_since <> now() THEN
    RAISE EXCEPTION 'a run in a new mode kept the old clock: %', row_to_json(v);
  END IF;

  IF (SELECT count(*) FROM public.ops_reseal_state) <> 1 THEN RAISE EXCEPTION 'ops_reseal_state holds more than its one row'; END IF;
  INSERT INTO rw_cases VALUES ('record: keeps each run, the finished clock from the first run that left nothing, cleared by one that left something');
END
$do$;

DO $do$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM rw_cases;
  IF v_count <> 4 THEN RAISE EXCEPTION 'ops_reseal_watch: % of 4 cases ran', v_count; END IF;
  RAISE NOTICE 'ops_reseal_watch: % cases passed', v_count;
END
$do$;

ROLLBACK;
