-- The ops minute cron's state (#1949): the saved workflow copies, the observed
-- schedule slots and the sweep ownership.
--
-- WHAT IT PROVES.
--   A. The three tables are under the ops rules (row level security on,
--      organization_id uuid NOT NULL, browser roles shut out, service_role read
--      only) and a direct write as service_role is refused, so every write is
--      one of the functions; each function is SECURITY DEFINER with a fixed
--      search_path, executable by service_role alone, and the read ones STABLE.
--   B. A sweep's interval has one owner: the first claim owns it, a second in
--      the interval stands down, and one after the interval owns it again. A
--      second session holding the sweep's lock makes the claim stand down at
--      once (two concurrent ticks, one does the work, one records that it stood
--      down: #1698 1.4).
--   C. The copy's order rule: an older copy is refused, so a fetch that read the
--      workflow on and saves after a newer one that read it off cannot switch it
--      back on (decision 4, the overlapping ticks case); an equal one confirms.
--   D. The last known switch off: may_start is false for a copy not newer than it.
--   E. The floor: schedule_known_since is set on first sight, kept while the
--      timing is unchanged, moved when it changes, cleared when the trigger stops
--      being a schedule.
--   F. Withdrawal by a complete list, and an older complete list cannot undo it.
--   G. A copy of another organization's workflow is refused.
--   H. workflow_copies returns the latest served and observed slot per workflow.
--   I. An observation records once, its repeat answers already_recorded, a
--      repeat from another organization is refused, and the table refuses a
--      wrong outcome and reason pair.
--   J. due_queue_depth counts only due waiting runs.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). Case B commits nothing and uses a second session
-- through dblink, created and dropped here if the database did not have it.
-- Every other case runs inside one transaction rolled back at the end.

\if :{?self_host}
\else
  \echo 'ops_tick.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('ot_test.self_host', :'self_host', false) AS self_host_set \gset
SELECT NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') AS ot_created_dblink \gset
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TEMP TABLE ot_cases (name text PRIMARY KEY);

-- ── B (concurrent half). A second session holds the sweep's lock ─────────────
DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('ot_test.self_host'));
  v_owned boolean;
BEGIN
  PERFORM dblink_connect('ot_a', conn);
  PERFORM dblink_exec('ot_a', 'BEGIN');
  PERFORM * FROM dblink('ot_a', $q$SELECT pg_advisory_xact_lock(hashtextextended('ops_sweep:queue_agreement', 0))::text$q$) AS t(x text);
  SELECT o INTO v_owned FROM public.claim_ops_sweep('queue_agreement', 'tick-b', 60) AS c(o, n, s, w);
  PERFORM dblink_exec('ot_a', 'ROLLBACK');
  PERFORM dblink_disconnect('ot_a');
  IF v_owned THEN RAISE EXCEPTION 'a tick claimed a sweep another session was claiming'; END IF;
  IF EXISTS (SELECT 1 FROM public.ops_lane_sweeps WHERE sweep = 'queue_agreement' AND last_owner = 'tick-b') THEN
    RAISE EXCEPTION 'the tick that stood down still stamped the sweep';
  END IF;
  INSERT INTO ot_cases VALUES ('sweep: a tick arriving while another claims stands down at once');
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
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.ops_workflow_copies', 'public.schedule_fire_observations', 'public.ops_lane_sweeps'] LOOP
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
    $s$INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, row_updated_at, served_at) VALUES (gen_random_uuid(), gen_random_uuid(), true, now(), now())$s$,
    $s$UPDATE public.ops_workflow_copies SET is_active = true$s$,
    $s$DELETE FROM public.schedule_fire_observations$s$,
    $s$UPDATE public.ops_lane_sweeps SET last_started_at = NULL$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'service_role ran a direct write: %', v_stmt;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
    END;
  END LOOP;
  RESET ROLE;
  IF v_refused <> 4 THEN RAISE EXCEPTION 'expected 4 refused writes, got %', v_refused; END IF;

  FOREACH v_name IN ARRAY ARRAY['ops_now', 'claim_ops_sweep', 'save_workflow_copies', 'workflow_copies', 'record_schedule_observation', 'due_queue_depth'] LOOP
    SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'public.% does not exist', v_name; END IF;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% has no fixed search_path', v_name;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_name;
    END IF;
    IF v_name IN ('ops_now', 'workflow_copies', 'due_queue_depth') AND v_fn.provolatile <> 's' THEN RAISE EXCEPTION 'the read function % is not STABLE', v_name; END IF;
    IF v_name NOT IN ('ops_now', 'workflow_copies', 'due_queue_depth') AND v_fn.provolatile <> 'v' THEN RAISE EXCEPTION 'the write function % is not VOLATILE', v_name; END IF;
  END LOOP;
  -- The lane row cannot be read as an organization's.
  BEGIN
    INSERT INTO public.ops_lane_sweeps (sweep, organization_id) VALUES ('run_expiry', gen_random_uuid());
    RAISE EXCEPTION 'a sweep row took an organization';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO ot_cases VALUES ('tables and functions under the ops rules, every write through a function');
END
$do$;

-- ── B. One owner per sweep interval ──────────────────────────────────────────
DO $do$
DECLARE
  v_owned boolean;
BEGIN
  SELECT o INTO v_owned FROM public.claim_ops_sweep('lease_expiry', 'tick-1', 50) AS c(o, n, s, w);
  IF NOT v_owned THEN RAISE EXCEPTION 'the first claim of a sweep did not own it'; END IF;
  SELECT o INTO v_owned FROM public.claim_ops_sweep('lease_expiry', 'tick-2', 50) AS c(o, n, s, w);
  IF v_owned THEN RAISE EXCEPTION 'a second claim inside the interval owned the sweep'; END IF;
  IF (SELECT last_owner FROM public.ops_lane_sweeps WHERE sweep = 'lease_expiry') <> 'tick-1' THEN RAISE EXCEPTION 'the stand down moved the owner'; END IF;
  UPDATE public.ops_lane_sweeps SET last_started_at = now() - interval '51 seconds' WHERE sweep = 'lease_expiry';
  SELECT o INTO v_owned FROM public.claim_ops_sweep('lease_expiry', 'tick-3', 50) AS c(o, n, s, w);
  IF NOT v_owned THEN RAISE EXCEPTION 'a claim after the interval did not own the sweep'; END IF;
  BEGIN
    PERFORM public.claim_ops_sweep('purge_everything', 'tick-4', 50);
    RAISE EXCEPTION 'an unknown sweep was claimed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO ot_cases VALUES ('sweep: one owner per interval, a second stands down, the next interval is owned again');
END
$do$;

-- Saves one copy. Fixed instants, so nothing depends on the clock.
CREATE FUNCTION pg_temp.ot_copy(p_wf uuid, p_org uuid, p_active boolean, p_updated text, p_trigger jsonb, p_deleted text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('workflow_id', p_wf, 'organization_id', p_org, 'is_active', p_active, 'deleted_at', p_deleted,
    'row_updated_at', p_updated, 'version_number', 3, 'trigger', p_trigger)
$f$;

-- ── C, D. Order and the last known switch off ────────────────────────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000019a1';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001949';
  v_sched jsonb := '{"type":"schedule","config":{"cron":"0 9 * * MON","timezone":"America/New_York","overlap":"skip","catch_up":"none","jitter_max_seconds":0}}';
  v_c record;
  v_r record;
BEGIN
  SELECT * INTO v_c FROM public.save_workflow_copies('2026-10-17T10:00:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T09:00:00Z', v_sched)));
  IF v_c.inserted <> 1 THEN RAISE EXCEPTION 'a new copy was not inserted: %', v_c; END IF;
  SELECT * INTO v_c FROM public.save_workflow_copies('2026-10-17T10:01:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T09:00:00Z', v_sched)));
  IF v_c.confirmed <> 1 THEN RAISE EXCEPTION 'an equal copy did not confirm: %', v_c; END IF;

  -- Tick B fetched after the switch off and saves first ...
  SELECT * INTO v_c FROM public.save_workflow_copies('2026-10-17T10:03:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, false, '2026-10-17T10:02:00Z', v_sched)));
  IF v_c.updated <> 1 THEN RAISE EXCEPTION 'the switch off was not saved: %', v_c; END IF;
  -- ... then tick A, whose fetch read it on before the switch off, saves.
  SELECT * INTO v_c FROM public.save_workflow_copies('2026-10-17T10:02:30Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T09:00:00Z', v_sched)));
  IF v_c.refused_older <> 1 THEN RAISE EXCEPTION 'an older copy was not refused: %', v_c; END IF;
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.is_active OR v_r.may_start THEN RAISE EXCEPTION 'the older on copy switched the workflow back on'; END IF;
  IF v_r.switched_off_at <> '2026-10-17T10:02:00Z'::timestamptz THEN RAISE EXCEPTION 'the switch off was not recorded: %', v_r.switched_off_at; END IF;

  -- Switched back on later: a newer copy may start again.
  PERFORM public.save_workflow_copies('2026-10-17T11:01:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T11:00:00Z', v_sched)));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF NOT v_r.may_start THEN RAISE EXCEPTION 'a copy newer than the switch off may not start'; END IF;
  IF v_r.switched_off_at <> '2026-10-17T10:02:00Z'::timestamptz THEN RAISE EXCEPTION 'switching on moved the last known switch off'; END IF;

  -- D. A copy not newer than the last known switch off never starts, whatever it says.
  UPDATE public.ops_workflow_copies SET switched_off_at = '2026-10-17T11:00:00Z' WHERE workflow_id = v_wf;
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.may_start THEN RAISE EXCEPTION 'a copy as old as the last known switch off may start'; END IF;

  -- A deleted copy never starts.
  PERFORM public.save_workflow_copies('2026-10-17T12:01:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T12:00:00Z', v_sched, '2026-10-17T12:00:00Z')));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.may_start THEN RAISE EXCEPTION 'a deleted copy may start'; END IF;
  IF v_r.switched_off_at <> '2026-10-17T12:00:00Z'::timestamptz THEN RAISE EXCEPTION 'a delete is not a switch off: %', v_r.switched_off_at; END IF;
  INSERT INTO ot_cases VALUES ('copy: an older copy is refused, the switch off holds, a later switch on starts again, a deleted copy never starts');
END
$do$;

-- ── E. The floor ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000019a2';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001949';
  v_a jsonb := '{"type":"schedule","config":{"cron":"0 9 * * MON","timezone":"America/New_York","overlap":"skip","catch_up":"none","jitter_max_seconds":0}}';
  v_a2 jsonb := '{"type":"schedule","config":{"cron":"0 9 * * MON","timezone":"America/New_York","overlap":"queue","catch_up":"none","jitter_max_seconds":30}}';
  v_b jsonb := '{"type":"schedule","config":{"cron":"0 10 * * MON","timezone":"America/New_York","overlap":"skip","catch_up":"none","jitter_max_seconds":0}}';
  v_hook jsonb := '{"type":"http_webhook","config":{"method":"POST","auth_method":"api_key"}}';
  v_since timestamptz;
BEGIN
  PERFORM public.save_workflow_copies('2026-10-17T10:00:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T09:00:00Z', v_a)));
  SELECT schedule_known_since INTO v_since FROM public.ops_workflow_copies WHERE workflow_id = v_wf;
  IF v_since IS DISTINCT FROM now() THEN RAISE EXCEPTION 'a new schedule was not known from now: %', v_since; END IF;
  UPDATE public.ops_workflow_copies SET schedule_known_since = '2026-10-01T00:00:00Z' WHERE workflow_id = v_wf;
  -- Same timing, other settings changed: the floor stays.
  PERFORM public.save_workflow_copies('2026-10-17T10:10:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T10:05:00Z', v_a2)));
  SELECT schedule_known_since INTO v_since FROM public.ops_workflow_copies WHERE workflow_id = v_wf;
  IF v_since <> '2026-10-01T00:00:00Z'::timestamptz THEN RAISE EXCEPTION 'an unchanged timing moved the floor to %', v_since; END IF;
  -- The cron changed: the floor moves to now, so no slot of the new cron before the edit is caught up.
  PERFORM public.save_workflow_copies('2026-10-17T10:20:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T10:15:00Z', v_b)));
  SELECT schedule_known_since INTO v_since FROM public.ops_workflow_copies WHERE workflow_id = v_wf;
  IF v_since IS DISTINCT FROM now() THEN RAISE EXCEPTION 'a changed timing kept the old floor %', v_since; END IF;
  -- Not a schedule any more: no floor.
  PERFORM public.save_workflow_copies('2026-10-17T10:30:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T10:25:00Z', v_hook)));
  SELECT schedule_known_since INTO v_since FROM public.ops_workflow_copies WHERE workflow_id = v_wf;
  IF v_since IS NOT NULL THEN RAISE EXCEPTION 'a webhook trigger kept a schedule floor'; END IF;
  INSERT INTO ot_cases VALUES ('floor: set on first sight, kept for the same timing, moved by a changed one, cleared off a schedule');
END
$do$;

-- ── F, G. Withdrawal, and another organization's workflow ────────────────────
DO $do$
DECLARE
  v_kept uuid := '00000000-0000-4000-8000-0000000019b1';
  v_gone uuid := '00000000-0000-4000-8000-0000000019b2';
  v_org uuid := 'bbbbbbbb-0000-4000-8000-000000001949';
  v_hook jsonb := '{"type":"http_webhook","config":{}}';
  v_c record;
  v_r record;
BEGIN
  PERFORM public.save_workflow_copies('2026-10-17T10:00:00Z', true, jsonb_build_array(
    pg_temp.ot_copy(v_kept, v_org, true, '2026-10-17T09:00:00Z', v_hook), pg_temp.ot_copy(v_gone, v_org, true, '2026-10-17T09:00:00Z', v_hook)));
  -- A later complete list names only one: the other is withdrawn.
  SELECT * INTO v_c FROM public.save_workflow_copies('2026-10-17T10:05:00Z', true, jsonb_build_array(pg_temp.ot_copy(v_kept, v_org, true, '2026-10-17T09:00:00Z', v_hook)));
  IF v_c.withdrawn < 1 THEN RAISE EXCEPTION 'a workflow a complete list omitted was not withdrawn: %', v_c; END IF;
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_gone;
  IF v_r.withdrawn_at IS NULL OR v_r.may_start THEN RAISE EXCEPTION 'a withdrawn workflow may start'; END IF;
  -- An older complete list that still named it cannot bring it back.
  PERFORM public.save_workflow_copies('2026-10-17T10:04:00Z', true, jsonb_build_array(pg_temp.ot_copy(v_gone, v_org, true, '2026-10-17T09:00:00Z', v_hook)));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_gone;
  IF v_r.withdrawn_at IS NULL THEN RAISE EXCEPTION 'an older list un-withdrew a workflow'; END IF;
  -- A newer one does.
  PERFORM public.save_workflow_copies('2026-10-17T10:06:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_gone, v_org, true, '2026-10-17T09:00:00Z', v_hook)));
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_gone;
  IF v_r.withdrawn_at IS NOT NULL OR NOT v_r.may_start THEN RAISE EXCEPTION 'a newer list did not bring a withdrawn workflow back'; END IF;

  -- G. The same workflow under another organization is refused.
  BEGIN
    PERFORM public.save_workflow_copies('2026-10-17T10:07:00Z', false, jsonb_build_array(
      pg_temp.ot_copy(v_kept, 'cccccccc-0000-4000-8000-000000001949', true, '2026-10-17T10:07:00Z', v_hook)));
    RAISE EXCEPTION 'a copy under another organization was saved';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- More than 1,000 in one call is refused, never truncated.
  BEGIN
    PERFORM public.save_workflow_copies('2026-10-17T10:08:00Z', false,
      (SELECT jsonb_agg(pg_temp.ot_copy(gen_random_uuid(), v_org, true, '2026-10-17T10:00:00Z', v_hook)) FROM generate_series(1, 1001)));
    RAISE EXCEPTION 'a list of 1001 copies was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO ot_cases VALUES ('withdrawal by a newer complete list only, another organization refused, an oversized list refused');
END
$do$;

-- ── H, I. Slots served and observed ──────────────────────────────────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000019c1';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001949';
  v_sched jsonb := '{"type":"schedule","config":{"interval_seconds":300,"timezone":"UTC","overlap":"skip","catch_up":"none","jitter_max_seconds":0}}';
  v_o record;
  v_r record;
BEGIN
  PERFORM public.save_workflow_copies('2026-10-17T10:00:00Z', false, jsonb_build_array(pg_temp.ot_copy(v_wf, v_org, true, '2026-10-17T09:00:00Z', v_sched)));
  SELECT * INTO v_o FROM public.record_schedule_observation(v_org, v_wf, 3, '2026-10-17T10:00:00Z', 'would_fire', 'due', '2026-10-17T10:00:00Z', NULL, 'tick-1');
  IF v_o.outcome <> 'recorded' THEN RAISE EXCEPTION 'a first observation was not recorded'; END IF;
  SELECT * INTO v_o FROM public.record_schedule_observation(v_org, v_wf, 3, '2026-10-17T10:00:00Z', 'would_fire', 'due', '2026-10-17T10:00:00Z', NULL, 'tick-2');
  IF v_o.outcome <> 'already_recorded' THEN RAISE EXCEPTION 'a repeated observation was recorded twice'; END IF;
  PERFORM public.record_schedule_observation(v_org, v_wf, 3, '2026-10-17T09:30:00Z', 'missed', 'catch_up_none', NULL, NULL, 'tick-1');
  BEGIN
    PERFORM public.record_schedule_observation('cccccccc-0000-4000-8000-000000001949', v_wf, 3, '2026-10-17T10:00:00Z', 'would_fire', 'due', now(), NULL, 'tick-3');
    RAISE EXCEPTION 'another organization read a slot as its own';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.record_schedule_observation(v_org, v_wf, 3, '2026-10-17T10:05:00Z', 'would_fire', 'catch_up_none', now(), NULL, 'tick-4');
    RAISE EXCEPTION 'a fire with a miss reason was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- A served slot, as live mode will record it.
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for) VALUES (v_org, v_wf, '2026-10-17T09:55:00Z');
  SELECT * INTO v_r FROM public.workflow_copies(1000) w WHERE w.workflow_id = v_wf;
  IF v_r.last_observed <> '2026-10-17T10:00:00Z'::timestamptz THEN RAISE EXCEPTION 'last observed is %', v_r.last_observed; END IF;
  IF v_r.last_served <> '2026-10-17T09:55:00Z'::timestamptz THEN RAISE EXCEPTION 'last served is %', v_r.last_served; END IF;
  IF v_r.db_now <> now() THEN RAISE EXCEPTION 'workflow_copies does not carry the database clock'; END IF;
  IF public.ops_now() <> now() THEN RAISE EXCEPTION 'ops_now is not the database clock'; END IF;
  INSERT INTO ot_cases VALUES ('observations record once per slot, never across organizations, and the copies carry the last served and observed slot');
END
$do$;

-- ── J. What a claim would find ───────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001949';
  v_d record;
BEGIN
  PERFORM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => '00000000-0000-4000-8000-0000000019d1',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'ot-due-1', p_not_before => now() - interval '1 minute');
  PERFORM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => '00000000-0000-4000-8000-0000000019d1',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'ot-due-2', p_not_before => now() - interval '2 minute');
  PERFORM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => '00000000-0000-4000-8000-0000000019d2',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'ot-later', p_not_before => now() + interval '1 hour');
  SELECT * INTO v_d FROM public.due_queue_depth();
  IF v_d.due_runs <> 2 OR v_d.due_workflows <> 1 THEN RAISE EXCEPTION 'due_queue_depth read % runs of % workflows, expected 2 of 1', v_d.due_runs, v_d.due_workflows; END IF;
  INSERT INTO ot_cases VALUES ('due_queue_depth counts only due waiting runs');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM ot_cases);
BEGIN
  IF v_n <> 8 THEN RAISE EXCEPTION 'ops_tick: % of 8 cases ran', v_n; END IF;
  RAISE NOTICE 'ops_tick: % cases passed', v_n;
END
$do$;

ROLLBACK;

\if :ot_created_dblink
  DROP EXTENSION dblink;
\endif
