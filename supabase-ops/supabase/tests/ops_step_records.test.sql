-- Each step of an ops run, recorded (#2703). Migration 20261024150000_ops_step_records_2703.sql.
--
-- Dan decided on 2026-10-24 (recorded on #2703): each step record keeps the
-- step's output with every connection secret removed and a size cap, as step
-- test results are kept (#2762), and is kept 7 days, deleted with the run it
-- belongs to, the same as run history.
--
-- WHAT IT PROVES.
--   A. The table is under the ops rules: row level security on,
--      organization_id uuid NOT NULL, the browser roles shut out, service_role
--      read only, and a direct write as service_role refused by the database.
--   B. record_ops_step is fenced by the claim token: the holder of the running
--      attempt records; another token, another organization, an attempt that
--      has ended or a later attempt's execution answer stale and write nothing.
--   C. It records each step once, in order: a repeat of a step already recorded
--      answers already_recorded and changes nothing, a record that would leave
--      a gap or take another step's place is refused by name.
--   D. A record keeps a kept output's measured size, an output over its cap by
--      its size alone, and refuses a status outside the list, a failure with no
--      error and an output over the cap.
--   E. run_step_context answers one organization's run attempt of one workflow:
--      the run's payload, and the latest completed output of each step before
--      the step's last recorded place (or every step when the run never reached
--      it), says which outputs were not kept, says a payload held elsewhere,
--      and holds nothing back once the attempt is 7 days old by the database
--      clock.
--   F. purge_ops_step_records deletes, by the database clock, exactly the
--      records of attempts started more than 7 days ago, a page at a time, and
--      a run's purge deletes its step records with it.
--   G. The three functions are SECURITY DEFINER with a fixed search_path,
--      executable by service_role alone, the read STABLE.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE sr_cases (name text PRIMARY KEY);

CREATE TEMP TABLE sr_ids AS SELECT
  'aaaaaaaa-0000-4000-8000-000000002703'::uuid AS org,
  'aaaaaaaa-0000-4000-8000-0000000027a9'::uuid AS other_org,
  '00000000-0000-4000-8000-0000000027b0'::uuid AS wf,
  '00000000-0000-4000-8000-0000000027e1'::uuid AS exec1;

-- Every case reads runs claimed by the lane wide claim, so no run of any other
-- organization may be waiting (run_engine_lifecycle.test.sql says why).
DELETE FROM public.send_ledger;
DELETE FROM public.schedule_fires;
DELETE FROM public.run_request_dedup_tombstones;
DELETE FROM public.run_requests;

-- One run of the workflow, claimed and started as exec1. Its claim token is kept for the cases.
CREATE TEMP TABLE sr_run (run_request_id uuid, claim_token uuid);
DO $do$
DECLARE
  i sr_ids%ROWTYPE;
  v_claim record;
BEGIN
  SELECT * INTO i FROM sr_ids;
  PERFORM public.enqueue_run_request(
    p_organization_id => i.org, p_workflow_id => i.wf, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => 'lead-2703', p_payload => '{"name": "Ada", "amount": 7}');
  SELECT * INTO v_claim FROM public.claim_run_requests('tick-2703', 1, 1, 60);
  PERFORM public.start_run_execution(i.org, v_claim.run_request_id, v_claim.claim_token, i.exec1);
  INSERT INTO sr_run VALUES (v_claim.run_request_id, v_claim.claim_token);
END
$do$;

-- Shorthand: record step p_seq of exec1 as its holder.
CREATE FUNCTION pg_temp.sr_record(p_seq integer, p_node text, p_status text DEFAULT 'completed', p_output jsonb DEFAULT '{"ok": true}',
  p_output_bytes integer DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS text LANGUAGE sql AS $f$
  SELECT public.record_ops_step(
    (SELECT org FROM sr_ids), (SELECT run_request_id FROM sr_run), (SELECT claim_token FROM sr_run), (SELECT exec1 FROM sr_ids),
    p_seq, p_node, p_node, 'transform', p_status, now(), 12, p_output, p_output_bytes, p_error);
$f$;

-- ── A. The ops rules ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_wrote boolean;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ops_step_records'::regclass) THEN
    RAISE EXCEPTION 'ops_step_records has row level security off';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ops_step_records'
      AND column_name = 'organization_id' AND data_type = 'uuid' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'ops_step_records.organization_id is not uuid NOT NULL';
  END IF;
  IF has_table_privilege('anon', 'public.ops_step_records', 'SELECT') OR has_table_privilege('authenticated', 'public.ops_step_records', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role can read ops_step_records';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.ops_step_records', 'SELECT')
      OR has_table_privilege('service_role', 'public.ops_step_records', 'INSERT')
      OR has_table_privilege('service_role', 'public.ops_step_records', 'UPDATE')
      OR has_table_privilege('service_role', 'public.ops_step_records', 'DELETE')
      OR has_table_privilege('service_role', 'public.ops_step_records', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role is not read only on ops_step_records';
  END IF;
  SET LOCAL ROLE service_role;
  BEGIN
    INSERT INTO public.ops_step_records (execution_id, seq, organization_id, run_request_id, workflow_id, execution_started_at, node_id, namespace,
      step_type, status, started_at, duration_ms)
    VALUES ((SELECT exec1 FROM sr_ids), 99, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now(), 'direct', 'direct', 'transform', 'completed', now(), 1);
    v_wrote := true;
  EXCEPTION WHEN insufficient_privilege THEN
    v_wrote := false;
  END;
  RESET ROLE;
  IF v_wrote THEN RAISE EXCEPTION 'service_role wrote ops_step_records directly'; END IF;
  INSERT INTO sr_cases VALUES ('rules: row level security, organization uuid, browser roles shut out, service_role read only');
END
$do$;

-- ── B. Fenced by the claim token ─────────────────────────────────────────────
DO $do$
DECLARE
  i sr_ids%ROWTYPE;
  r sr_run%ROWTYPE;
BEGIN
  SELECT * INTO i FROM sr_ids;
  SELECT * INTO r FROM sr_run;
  IF pg_temp.sr_record(0, 'shape') <> 'recorded' THEN RAISE EXCEPTION 'the holder could not record its first step'; END IF;
  IF (SELECT public.record_ops_step(i.org, r.run_request_id, gen_random_uuid(), i.exec1, 1, 'x', 'x', 'transform', 'completed', now(), 1, '{}', NULL, NULL)) <> 'stale' THEN
    RAISE EXCEPTION 'another claim token recorded a step';
  END IF;
  IF (SELECT public.record_ops_step(i.other_org, r.run_request_id, r.claim_token, i.exec1, 1, 'x', 'x', 'transform', 'completed', now(), 1, '{}', NULL, NULL)) <> 'stale' THEN
    RAISE EXCEPTION 'another organization recorded a step';
  END IF;
  IF (SELECT public.record_ops_step(i.org, r.run_request_id, r.claim_token, gen_random_uuid(), 1, 'x', 'x', 'transform', 'completed', now(), 1, '{}', NULL, NULL)) <> 'stale' THEN
    RAISE EXCEPTION 'a step was recorded under an execution that is not the running attempt';
  END IF;
  IF (SELECT count(*) FROM public.ops_step_records WHERE execution_id = i.exec1) <> 1 THEN
    RAISE EXCEPTION 'a stale record was written';
  END IF;
  INSERT INTO sr_cases VALUES ('fence: another token, another organization or another execution answers stale and writes nothing');
END
$do$;

-- ── C. Once each, in order ───────────────────────────────────────────────────
DO $do$
DECLARE
  v_refused integer := 0;
BEGIN
  IF pg_temp.sr_record(0, 'shape', 'completed', '{"changed": true}') <> 'already_recorded' THEN
    RAISE EXCEPTION 'a repeat of a recorded step was not answered already_recorded';
  END IF;
  IF (SELECT output FROM public.ops_step_records WHERE seq = 0) <> '{"ok": true}'::jsonb THEN
    RAISE EXCEPTION 'a repeat changed the step already recorded';
  END IF;
  BEGIN
    PERFORM pg_temp.sr_record(2, 'later');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM pg_temp.sr_record(0, 'another');
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1;
  END;
  IF v_refused <> 2 THEN RAISE EXCEPTION 'refused % of a gap and a taken place', v_refused; END IF;
  INSERT INTO sr_cases VALUES ('order: a repeat changes nothing, a gap or a taken place is refused');
END
$do$;

-- ── D. Sizes and refusals ────────────────────────────────────────────────────
DO $do$
DECLARE
  v_refused integer := 0;
BEGIN
  PERFORM pg_temp.sr_record(1, 'fetch', 'completed', '{"rows": [1, 2]}', 5);
  PERFORM pg_temp.sr_record(2, 'big', 'completed', NULL, 300000);
  IF (SELECT output_bytes FROM public.ops_step_records WHERE seq = 1) IS DISTINCT FROM octet_length('{"rows": [1, 2]}'::jsonb::text) THEN
    RAISE EXCEPTION 'a kept output''s size was taken from the caller, not measured';
  END IF;
  IF (SELECT output_bytes FROM public.ops_step_records WHERE seq = 2) IS DISTINCT FROM 300000 THEN
    RAISE EXCEPTION 'an output over the cap did not keep its size';
  END IF;
  BEGIN
    PERFORM pg_temp.sr_record(3, 'x', 'running');
  EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM pg_temp.sr_record(3, 'x', 'failed', NULL);
  EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM pg_temp.sr_record(3, 'x', 'completed', jsonb_build_object('big', repeat('x', 300000)));
  EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1;
  END;
  IF v_refused <> 3 THEN RAISE EXCEPTION 'refused % of 3 malformed records', v_refused; END IF;
  INSERT INTO sr_cases VALUES ('sizes: a kept output measured, one over the cap named by its size, malformed records refused');
END
$do$;

-- ── E. A run's context for a step test ───────────────────────────────────────
DO $do$
DECLARE
  i sr_ids%ROWTYPE;
  r sr_run%ROWTYPE;
  v_c record;
  v_names text[];
BEGIN
  SELECT * INTO i FROM sr_ids;
  SELECT * INTO r FROM sr_run;
  -- The run so far: shape (0), fetch (1), big (2, not kept). Then shape again (3) and act, which failed (4).
  PERFORM pg_temp.sr_record(3, 'shape', 'completed', '{"second": true}');
  PERFORM pg_temp.sr_record(4, 'act', 'failed', NULL, NULL, 'act: the service answered 500');

  -- act was reached at 4: everything before it, each step's latest output.
  SELECT * INTO v_c FROM public.run_step_context(i.org, i.wf, i.exec1, 'act');
  IF NOT v_c.reached OR NOT v_c.within_retention OR v_c.payload IS DISTINCT FROM '{"name": "Ada", "amount": 7}'::jsonb OR v_c.payload_elsewhere THEN
    RAISE EXCEPTION 'the context of a reached step is wrong: %', v_c;
  END IF;
  SELECT array_agg(s ->> 'namespace' ORDER BY s ->> 'namespace') INTO v_names FROM jsonb_array_elements(v_c.steps) s;
  IF v_names IS DISTINCT FROM ARRAY['big', 'fetch', 'shape'] THEN RAISE EXCEPTION 'the steps before act were %', v_names; END IF;
  IF (SELECT s -> 'output' FROM jsonb_array_elements(v_c.steps) s WHERE s ->> 'namespace' = 'shape') <> '{"second": true}'::jsonb THEN
    RAISE EXCEPTION 'a step run twice did not answer its latest output';
  END IF;
  IF (SELECT (s ->> 'output_kept')::boolean FROM jsonb_array_elements(v_c.steps) s WHERE s ->> 'namespace' = 'big') THEN
    RAISE EXCEPTION 'an output over the cap was answered as kept';
  END IF;

  -- shape was last reached at 3: only what came before it.
  SELECT * INTO v_c FROM public.run_step_context(i.org, i.wf, i.exec1, 'shape');
  SELECT array_agg(s ->> 'namespace' ORDER BY s ->> 'namespace') INTO v_names FROM jsonb_array_elements(v_c.steps) s;
  IF NOT v_c.reached OR v_names IS DISTINCT FROM ARRAY['big', 'fetch', 'shape'] THEN RAISE EXCEPTION 'the steps before shape''s last place were %', v_names; END IF;
  IF (SELECT s -> 'output' FROM jsonb_array_elements(v_c.steps) s WHERE s ->> 'namespace' = 'shape') <> '{"ok": true}'::jsonb THEN
    RAISE EXCEPTION 'the context before shape''s last place answered a later output';
  END IF;

  -- A step the run never reached: every completed step, and the failed one not among them.
  SELECT * INTO v_c FROM public.run_step_context(i.org, i.wf, i.exec1, 'new_step');
  SELECT array_agg(s ->> 'namespace' ORDER BY s ->> 'namespace') INTO v_names FROM jsonb_array_elements(v_c.steps) s;
  IF v_c.reached OR v_names IS DISTINCT FROM ARRAY['big', 'fetch', 'shape'] THEN RAISE EXCEPTION 'an unreached step''s context was % (reached %)', v_names, v_c.reached; END IF;

  -- Another organization, or another workflow, finds nothing.
  IF EXISTS (SELECT 1 FROM public.run_step_context(i.other_org, i.wf, i.exec1, 'act')) THEN RAISE EXCEPTION 'another organization read the run'; END IF;
  IF EXISTS (SELECT 1 FROM public.run_step_context(i.org, gen_random_uuid(), i.exec1, 'act')) THEN RAISE EXCEPTION 'another workflow read the run'; END IF;

  -- A payload held elsewhere is named.
  UPDATE public.run_requests SET payload = NULL, payload_ref = 'r2://payloads/2703' WHERE id = r.run_request_id;
  SELECT * INTO v_c FROM public.run_step_context(i.org, i.wf, i.exec1, 'act');
  IF NOT v_c.payload_elsewhere OR v_c.payload IS NOT NULL THEN RAISE EXCEPTION 'a payload held elsewhere was not named: %', v_c; END IF;
  UPDATE public.run_requests SET payload = '{"name": "Ada", "amount": 7}', payload_ref = NULL WHERE id = r.run_request_id;

  -- 7 days old by the database clock: found, but nothing held back.
  UPDATE public.workflow_executions SET started_at = now() - interval '7 days' - interval '1 minute' WHERE id = i.exec1;
  SELECT * INTO v_c FROM public.run_step_context(i.org, i.wf, i.exec1, 'act');
  IF v_c.within_retention OR v_c.steps IS NOT NULL OR v_c.payload IS NOT NULL THEN RAISE EXCEPTION 'a run 7 days old answered its data: %', v_c; END IF;
  UPDATE public.workflow_executions SET started_at = now() WHERE id = i.exec1;

  INSERT INTO sr_cases VALUES ('context: the steps before the last place, latest outputs, not kept named, organization scoped, nothing past 7 days');
END
$do$;

-- ── F. The purge, and the run's ──────────────────────────────────────────────
DO $do$
DECLARE
  i sr_ids%ROWTYPE;
  r sr_run%ROWTYPE;
  v_p record;
BEGIN
  SELECT * INTO i FROM sr_ids;
  SELECT * INTO r FROM sr_run;
  -- exec1 holds 5 records; 3 of them made 8 days old, 2 left a minute short of 7 days.
  UPDATE public.ops_step_records SET execution_started_at = now() - interval '8 days' WHERE execution_id = i.exec1 AND seq < 3;
  UPDATE public.ops_step_records SET execution_started_at = now() - interval '7 days' + interval '1 minute' WHERE execution_id = i.exec1 AND seq >= 3;
  SELECT * INTO v_p FROM public.purge_ops_step_records(2);
  IF v_p.purged <> 2 OR NOT v_p.more THEN RAISE EXCEPTION 'the first page purged % (more %), not 2 with more to come', v_p.purged, v_p.more; END IF;
  SELECT * INTO v_p FROM public.purge_ops_step_records(2);
  IF v_p.purged <> 1 OR v_p.more THEN RAISE EXCEPTION 'the second page purged % (more %), not the last 1', v_p.purged, v_p.more; END IF;
  IF (SELECT array_agg(seq ORDER BY seq) FROM public.ops_step_records WHERE execution_id = i.exec1) IS DISTINCT FROM ARRAY[3, 4] THEN
    RAISE EXCEPTION 'the purge left %, not the records under 7 days old', (SELECT array_agg(seq ORDER BY seq) FROM public.ops_step_records WHERE execution_id = i.exec1);
  END IF;
  BEGIN
    PERFORM public.purge_ops_step_records(0);
    RAISE EXCEPTION 'a purge page of 0 was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- The run ends and is purged: its records go with it.
  PERFORM public.complete_run_request(i.org, r.run_request_id, r.claim_token, 'failed', p_error => 'act: the service answered 500');
  IF pg_temp.sr_record(5, 'after_end') <> 'stale' THEN RAISE EXCEPTION 'a step was recorded after its run ended'; END IF;
  UPDATE public.run_requests SET terminal_at = now() - interval '9 days' WHERE id = r.run_request_id;
  PERFORM public.purge_terminal_run_requests(now() - interval '8 days', 10);
  IF EXISTS (SELECT 1 FROM public.ops_step_records WHERE execution_id = i.exec1) THEN RAISE EXCEPTION 'a purged run left its step records'; END IF;
  INSERT INTO sr_cases VALUES ('purge: exactly the records of attempts over 7 days old, a page at a time; an ended run records nothing; a purged run takes its records');
END
$do$;

-- ── G. Privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('record_ops_step', 'run_step_context', 'purge_ops_step_records') LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE proname = 'run_step_context') <> 's' THEN RAISE EXCEPTION 'run_step_context is not STABLE'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('record_ops_step', 'run_step_context', 'purge_ops_step_records')) <> 3 THEN
    RAISE EXCEPTION 'the three step record functions are not each defined once';
  END IF;
  INSERT INTO sr_cases VALUES ('privileges: definer, fixed search_path, service_role alone, the read STABLE');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM sr_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'ops_step_records: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'ops_step_records: % cases passed', v_n;
END
$do$;

ROLLBACK;
