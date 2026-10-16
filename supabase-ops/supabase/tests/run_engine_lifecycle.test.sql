-- The run engine's write functions, one session at a time (#1948, #1698 section 1.3).
--
-- WHY. Every write to a run row goes through these functions (the choke point,
-- run_engine_schema.test.sql), so they ARE the run engine's crash safety: dedup,
-- fair claiming, the lease and its fencing, the send ledger, the sweeps and the
-- purge. Each is asserted on the state it leaves, never on what it printed.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   enqueue: inserts once, answers a repeat as a duplicate with the first id, and
--     refuses a key belonging to another organization;
--   claim: one workflow's flood cannot starve another (k per workflow); a
--     continuation is claimed ahead of new starts; a workflow's concurrency
--     limit counts every claim, and a sleeping run releases its permit; a queued
--     run past its expiry ends expired with no execution;
--   lease: start, extend and complete are fenced by the claim token and refuse
--     another organization; complete applied twice changes nothing;
--   sweep: an unstarted run whose lease lapsed is requeued without spending an
--     attempt, up to a cap; a run killed mid flight spends an attempt and ends
--     dead at max_attempts; one with a non idempotent send goes to needs_human;
--   ledger: an intent is fenced by claim token AND state version, so a stalled
--     holder whose run was re-claimed records nothing; a repeat intent is the
--     same row; the first result wins;
--   overlap: skip refuses a second active run of a workflow, queue holds at most
--     one waiting first start and runs one at a time; a schedule slot fires once;
--   purge: refuses a cutoff inside the last day, keeps kept runs and any run
--     whose chain is still live, leaves a dedup tombstone that still refuses the
--     key, and never touches the send ledger;
--   keep: audited with old and new values;
--   agreement: a queue row and its run that disagree are both reported.
--
-- TIME. now() is fixed inside a transaction, so time passing is simulated by
-- moving a row's own timestamps back as the table owner (the suite's injected
-- clock); no case sleeps.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE re_cases (name text PRIMARY KEY) ON COMMIT DROP;

-- Each case starts from NO run rows at all, of any organization: the claim and
-- the sweeps are lane wide, so a row left by another case, or committed by an
-- aborted run of the concurrency file, would be claimed in place of the case's
-- own (seen 2026-10-16). Inside this transaction, so the throwaway database
-- gets its rows back at the ROLLBACK.
CREATE FUNCTION pg_temp.re_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

-- Shorthand: enqueue a plain webhook run and return its id.
CREATE FUNCTION pg_temp.re_enqueue(p_workflow uuid, p_key text, p_limit integer DEFAULT NULL, p_max_attempts integer DEFAULT 3)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000001948', p_workflow_id => p_workflow, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_concurrency_limit => p_limit, p_max_attempts => p_max_attempts);
$f$;

-- ── enqueue ──────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  r2 record;
BEGIN
  PERFORM pg_temp.re_reset();
  SELECT * INTO r FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000001948', p_workflow_id => '00000000-0000-4000-8000-0000000000e1',
    p_workflow_version => 2, p_trigger_kind => 'http_webhook', p_dedup_key => 'lead-1', p_payload => '{"a": 1}');
  IF r.outcome <> 'inserted' OR r.run_status <> 'queued' THEN RAISE EXCEPTION 'first enqueue answered % %', r.outcome, r.run_status; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = r.run_request_id) THEN RAISE EXCEPTION 'no queue row'; END IF;
  IF (SELECT dedup_expires_at FROM public.run_requests WHERE id = r.run_request_id) <> now() + interval '30 days' THEN
    RAISE EXCEPTION 'dedup does not default to 30 days';
  END IF;
  IF (SELECT execution_chain_id FROM public.run_requests WHERE id = r.run_request_id) <> r.run_request_id THEN
    RAISE EXCEPTION 'a first run does not start its own chain';
  END IF;

  SELECT * INTO r2 FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000001948', p_workflow_id => '00000000-0000-4000-8000-0000000000e1',
    p_workflow_version => 2, p_trigger_kind => 'http_webhook', p_dedup_key => 'lead-1');
  IF r2.outcome <> 'duplicate' OR r2.run_request_id <> r.run_request_id THEN RAISE EXCEPTION 'a repeat answered % %', r2.outcome, r2.run_request_id; END IF;
  IF (SELECT count(*) FROM public.run_requests WHERE workflow_id = '00000000-0000-4000-8000-0000000000e1') <> 1 THEN RAISE EXCEPTION 'a repeat made a second row'; END IF;

  BEGIN
    PERFORM public.enqueue_run_request(
      p_organization_id => 'bbbbbbbb-0000-4000-8000-000000001948', p_workflow_id => '00000000-0000-4000-8000-0000000000e1',
      p_workflow_version => 2, p_trigger_kind => 'http_webhook', p_dedup_key => 'lead-1');
    RAISE EXCEPTION 'another organization''s key was answered';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- A key in another trigger namespace (a manual rerun) is a new run.
  IF (SELECT outcome FROM public.enqueue_run_request(
        p_organization_id => 'aaaaaaaa-0000-4000-8000-000000001948', p_workflow_id => '00000000-0000-4000-8000-0000000000e1',
        p_workflow_version => 2, p_trigger_kind => 'rerun', p_dedup_key => 'lead-1')) <> 'inserted' THEN
    RAISE EXCEPTION 'a rerun key was refused by the webhook key';
  END IF;
  INSERT INTO re_cases VALUES ('enqueue: once, a repeat is a duplicate of the first, another organization refused');
END
$do$;

-- ── claim: fairness ──────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_flood uuid := '00000000-0000-4000-8000-0000000000f1';
  v_quiet uuid := '00000000-0000-4000-8000-0000000000f2';
  v_ids uuid[];
  v_quiet_id uuid;
BEGIN
  PERFORM pg_temp.re_reset();
  PERFORM pg_temp.re_enqueue(v_flood, 'flood-' || g) FROM generate_series(1, 1000) g;
  -- The quiet workflow's run arrives after all 1,000.
  v_quiet_id := pg_temp.re_enqueue(v_quiet, 'quiet-1');
  UPDATE public.run_queue SET created_at = now() + interval '1 second' WHERE run_request_id = v_quiet_id;

  SELECT array_agg(run_request_id) INTO v_ids FROM public.claim_run_requests('tick-1', 5, 2, 60);
  IF NOT (v_quiet_id = ANY (v_ids)) THEN RAISE EXCEPTION 'the quiet workflow was starved by the flood: claimed %', v_ids; END IF;
  IF (SELECT count(*) FROM public.run_requests WHERE id = ANY (v_ids) AND workflow_id = v_flood) > 2 THEN
    RAISE EXCEPTION 'one call claimed more than k runs of one workflow';
  END IF;
  INSERT INTO re_cases VALUES ('claim: a flood of one workflow does not starve another (k per workflow)');
END
$do$;

-- ── claim: continuations first ───────────────────────────────────────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000000c1';
  v_cont uuid;
  r record;
BEGIN
  PERFORM pg_temp.re_reset();
  v_cont := pg_temp.re_enqueue(v_wf, 'cont');
  -- Make it a sleeping continuation: claim, start, suspend.
  SELECT * INTO r FROM public.claim_run_requests('tick-1', 1, 1, 60);
  PERFORM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000001948', v_cont, r.claim_token, gen_random_uuid());
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001948', v_cont, r.claim_token, 'suspend', p_reason => 'wake', p_not_before => now());
  -- Two new starts, both older than the continuation's wake.
  PERFORM pg_temp.re_enqueue(v_wf, 'new-' || g) FROM generate_series(1, 2) g;
  UPDATE public.run_queue SET created_at = now() - interval '1 hour' WHERE run_request_id <> v_cont;

  SELECT * INTO r FROM public.claim_run_requests('tick-2', 1, 1, 60);
  IF r.run_request_id IS DISTINCT FROM v_cont THEN RAISE EXCEPTION 'a new start was claimed ahead of the continuation'; END IF;
  IF r.resume_reason IS DISTINCT FROM 'wake' THEN RAISE EXCEPTION 'the continuation lost its resume reason'; END IF;
  INSERT INTO re_cases VALUES ('claim: a continuation is claimed ahead of new starts');
END
$do$;

-- ── claim: concurrency limit, and a sleeper releases its permit ──────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000000d1';
  r record;
  v_round integer;
  v_running integer;
BEGIN
  PERFORM pg_temp.re_reset();
  PERFORM pg_temp.re_enqueue(v_wf, 'lim-' || g, 2) FROM generate_series(1, 4) g;
  IF (SELECT count(*) FROM public.claim_run_requests('tick-1', 10, 10, 60)) <> 2 THEN RAISE EXCEPTION 'limit 2 did not hold on the first claim'; END IF;
  IF (SELECT count(*) FROM public.claim_run_requests('tick-2', 10, 10, 60)) <> 0 THEN RAISE EXCEPTION 'a second claim went past limit 2'; END IF;

  -- Both claimed runs start and then sleep: their permits are released.
  FOR r IN SELECT id, claim_token FROM public.run_requests WHERE workflow_id = v_wf AND status = 'claimed' LOOP
    PERFORM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000001948', r.id, r.claim_token, gen_random_uuid());
    PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001948', r.id, r.claim_token, 'suspend', p_reason => 'wake', p_not_before => now());
  END LOOP;
  -- Two sleepers waking plus two new starts, claimed round after round: never more than 2 at once.
  FOR v_round IN 1..4 LOOP
    PERFORM public.claim_run_requests('tick-r' || v_round, 10, 10, 60);
    SELECT count(*) INTO v_running FROM public.run_requests WHERE workflow_id = v_wf AND status IN ('claimed', 'running');
    IF v_running > 2 THEN RAISE EXCEPTION 'round %: % runs active under limit 2', v_round, v_running; END IF;
  END LOOP;
  IF v_running <> 2 THEN RAISE EXCEPTION 'released permits were not reused: % active', v_running; END IF;
  -- The two woken sleepers took the permits, ahead of the new starts.
  IF (SELECT count(*) FROM public.run_requests WHERE workflow_id = v_wf AND status = 'claimed' AND resume_reason = 'wake') <> 2 THEN
    RAISE EXCEPTION 'the woken continuations did not take the freed permits first';
  END IF;
  INSERT INTO re_cases VALUES ('claim: the concurrency limit counts every claim and a sleeper releases its permit');
END
$do$;

-- ── claim: the row it leaves ─────────────────────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_before bigint;
  r record;
BEGIN
  PERFORM pg_temp.re_reset();
  v_id := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a1', 'row');
  v_before := (SELECT state_version FROM public.run_requests WHERE id = v_id);
  SELECT * INTO r FROM public.claim_run_requests('tick-9', 1, 1, 45);
  IF r.run_request_id <> v_id OR r.claim_token IS NULL THEN RAISE EXCEPTION 'the claim returned %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'the claim left the queue row'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'claimed' AND claimed_by = 'tick-9'
      AND claim_expires_at = now() + interval '45 seconds' AND state_version = v_before + 1 AND attempts = 0) THEN
    RAISE EXCEPTION 'the claimed row is %', (SELECT row_to_json(x) FROM public.run_requests x WHERE id = v_id);
  END IF;
  BEGIN
    PERFORM public.claim_run_requests('tick-9', 1001, 1, 45);
    RAISE EXCEPTION 'a claim of more than 1000 was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.claim_run_requests('tick-9', 1, 1, 301);
    RAISE EXCEPTION 'a lease over 300 s was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO re_cases VALUES ('claim: deletes the queue row, mints a token, bumps the state version, bounds its inputs');
END
$do$;

-- ── claim: expiry ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_late uuid;
  v_late2 uuid;
  r record;
BEGIN
  PERFORM pg_temp.re_reset();
  SELECT run_request_id INTO v_late FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000001948', p_workflow_id => '00000000-0000-4000-8000-0000000000b1',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'late', p_expires_at => now() - interval '1 minute');
  IF (SELECT count(*) FROM public.claim_run_requests('tick-1', 10, 10, 60)) <> 0 THEN RAISE EXCEPTION 'an expired run was claimed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_late AND status = 'expired' AND status_reason = 'not_started_in_time' AND terminal_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the expired run was left as %', (SELECT status FROM public.run_requests WHERE id = v_late);
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_late) THEN RAISE EXCEPTION 'an expired run has an execution'; END IF;

  -- The sweep ends one the claim never reached.
  SELECT run_request_id INTO v_late2 FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000001948', p_workflow_id => '00000000-0000-4000-8000-0000000000b2',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'late2', p_expires_at => now() - interval '1 minute');
  SELECT * INTO r FROM public.expire_overdue_run_requests(100);
  IF r.expired <> 1 OR r.more THEN RAISE EXCEPTION 'the expiry sweep answered %', r; END IF;
  IF (SELECT status FROM public.run_requests WHERE id = v_late2) <> 'expired' OR EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_late2) THEN
    RAISE EXCEPTION 'the expiry sweep left the run waiting';
  END IF;
  INSERT INTO re_cases VALUES ('claim: a queued run past its expiry ends expired with no execution');
END
$do$;

-- ── lease: start, extend and complete are fenced ─────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_id uuid;
  v_exec uuid := gen_random_uuid();
  r record;
  s record;
BEGIN
  PERFORM pg_temp.re_reset();
  v_id := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a2', 'fence');
  SELECT * INTO r FROM public.claim_run_requests('tick-1', 1, 1, 60);

  IF (SELECT outcome FROM public.start_run_execution(v_org, v_id, gen_random_uuid(), v_exec)) <> 'claim_lost' THEN RAISE EXCEPTION 'a start with a wrong token ran'; END IF;
  IF (SELECT outcome FROM public.start_run_execution('bbbbbbbb-0000-4000-8000-000000001948', v_id, r.claim_token, v_exec)) <> 'claim_lost' THEN
    RAISE EXCEPTION 'a start for another organization ran';
  END IF;
  SELECT * INTO s FROM public.start_run_execution(v_org, v_id, r.claim_token, v_exec);
  IF s.outcome <> 'started' OR s.attempt <> 1 OR s.state_version <> r.state_version + 1 THEN RAISE EXCEPTION 'start answered %', s; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE id = v_exec AND status = 'running' AND attempt = 1 AND trigger_type = 'http_webhook') THEN
    RAISE EXCEPTION 'no running execution was written';
  END IF;
  IF (SELECT outcome FROM public.start_run_execution(v_org, v_id, r.claim_token, v_exec)) <> 'already_started' THEN RAISE EXCEPTION 'a repeated start was not recognised'; END IF;

  IF public.extend_run_lease(v_org, v_id, gen_random_uuid(), 60) THEN RAISE EXCEPTION 'an extend with a wrong token held'; END IF;
  IF NOT public.extend_run_lease(v_org, v_id, r.claim_token, 60) THEN RAISE EXCEPTION 'the holder could not extend'; END IF;
  -- Past the absolute ceiling (a run cannot outlive the tick that dispatched it).
  UPDATE public.run_requests SET claimed_at = now() - interval '15 minutes 1 second' WHERE id = v_id;
  IF public.extend_run_lease(v_org, v_id, r.claim_token, 60) THEN RAISE EXCEPTION 'an extend past the 15 minute ceiling held'; END IF;
  UPDATE public.run_requests SET claimed_at = now(), claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  IF public.extend_run_lease(v_org, v_id, r.claim_token, 60) THEN RAISE EXCEPTION 'an extend of a lapsed lease held'; END IF;
  UPDATE public.run_requests SET claim_expires_at = now() + interval '1 minute' WHERE id = v_id;

  IF (SELECT outcome FROM public.complete_run_request('bbbbbbbb-0000-4000-8000-000000001948', v_id, r.claim_token, 'done')) <> 'not_found' THEN
    RAISE EXCEPTION 'another organization completed the run';
  END IF;
  IF (SELECT outcome FROM public.complete_run_request(v_org, v_id, gen_random_uuid(), 'done')) <> 'claim_lost' THEN RAISE EXCEPTION 'a wrong token completed the run'; END IF;
  IF (SELECT outcome FROM public.complete_run_request(v_org, v_id, r.claim_token, 'done')) <> 'completed' THEN RAISE EXCEPTION 'the holder could not complete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'done' AND terminal_at = now() AND claim_expires_at IS NULL) THEN
    RAISE EXCEPTION 'the completed row is %', (SELECT row_to_json(x) FROM public.run_requests x WHERE id = v_id);
  END IF;
  IF (SELECT status FROM public.workflow_executions WHERE id = v_exec) <> 'success' THEN RAISE EXCEPTION 'the execution was not closed as success'; END IF;
  IF (SELECT outcome FROM public.complete_run_request(v_org, v_id, r.claim_token, 'done')) <> 'already_completed' THEN RAISE EXCEPTION 'a repeated complete was not recognised'; END IF;

  BEGIN
    PERFORM public.complete_run_request(v_org, v_id, r.claim_token, 'dead', p_reason => 'not_a_reason');
    RAISE EXCEPTION 'an unknown reason was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO re_cases VALUES ('lease: start, extend and complete are fenced by token and organization, and idempotent');
END
$do$;

-- ── lease: retry, and dead at max_attempts ───────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_id uuid;
  r record;
  v_i integer;
BEGIN
  PERFORM pg_temp.re_reset();
  v_id := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a3', 'retry', NULL, 2);
  FOR v_i IN 1..2 LOOP
    SELECT * INTO r FROM public.claim_run_requests('tick-' || v_i, 1, 1, 60);
    IF r.run_request_id IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'attempt %: the retry was not claimable', v_i; END IF;
    PERFORM public.start_run_execution(v_org, v_id, r.claim_token, gen_random_uuid());
    PERFORM public.complete_run_request(v_org, v_id, r.claim_token, 'retry', p_error => 'partner 503', p_not_before => now());
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'dead' AND status_reason = 'max_attempts' AND attempts = 2 AND last_error = 'partner 503') THEN
    RAISE EXCEPTION 'a run out of attempts was left as %', (SELECT row_to_json(x) FROM public.run_requests x WHERE id = v_id);
  END IF;
  IF (SELECT count(*) FROM public.workflow_executions WHERE run_request_id = v_id AND status = 'failed') <> 2 THEN RAISE EXCEPTION 'the two attempts were not recorded as failed'; END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a dead run is still queued'; END IF;
  INSERT INTO re_cases VALUES ('lease: a retry is requeued and a run out of attempts ends dead');
END
$do$;

-- ── sweep ────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_unstarted uuid;
  v_killed uuid;
  v_sent uuid;
  v_idem uuid;
  r record;
  s record;
  v_i integer;
BEGIN
  PERFORM pg_temp.re_reset();
  -- Claimed, never started, lease lapses: requeued without spending an attempt, up to 3 times.
  v_unstarted := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a4', 'unstarted');
  FOR v_i IN 1..4 LOOP
    PERFORM public.claim_run_requests('tick-' || v_i, 1, 1, 60);
    UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_unstarted;
    PERFORM public.sweep_expired_leases(100);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_unstarted AND status = 'dead' AND status_reason = 'lease_requeue_cap' AND attempts = 0 AND lease_requeues = 3) THEN
    RAISE EXCEPTION 'an unstarted run whose lease lapsed 4 times is %', (SELECT row_to_json(x) FROM public.run_requests x WHERE id = v_unstarted);
  END IF;

  -- Killed mid run three times (max_attempts 3): dead with three attempts.
  v_killed := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a5', 'killed');
  FOR v_i IN 1..3 LOOP
    SELECT * INTO r FROM public.claim_run_requests('tick-' || v_i, 1, 1, 60);
    IF r.run_request_id IS DISTINCT FROM v_killed THEN RAISE EXCEPTION 'kill %: the run was not claimable', v_i; END IF;
    PERFORM public.start_run_execution(v_org, v_killed, r.claim_token, gen_random_uuid());
    UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_killed;
    PERFORM public.sweep_expired_leases(100);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_killed AND status = 'dead' AND status_reason = 'max_attempts' AND attempts = 3) THEN
    RAISE EXCEPTION 'a run killed three times is %', (SELECT row_to_json(x) FROM public.run_requests x WHERE id = v_killed);
  END IF;
  IF (SELECT count(*) FROM public.workflow_executions WHERE run_request_id = v_killed AND status = 'failed') <> 3 THEN RAISE EXCEPTION 'three killed attempts were not three failed executions'; END IF;

  -- Killed after a non idempotent send: needs_human, never re-run.
  v_sent := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a6', 'sent');
  SELECT * INTO r FROM public.claim_run_requests('tick-s', 1, 1, 60);
  SELECT * INTO s FROM public.start_run_execution(v_org, v_sent, r.claim_token, gen_random_uuid());
  PERFORM public.record_send_intent(v_org, v_sent, r.claim_token, s.state_version, 'post_lead', 1, 'POST', 'partner.example', false, NULL);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_sent;
  SELECT * INTO r FROM public.sweep_expired_leases(100);
  IF r.needs_human <> 1 THEN RAISE EXCEPTION 'the sweep answered %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_sent AND status = 'needs_human' AND status_reason = 'lease_expired_after_send') THEN
    RAISE EXCEPTION 'a run killed after a send is %', (SELECT status FROM public.run_requests WHERE id = v_sent);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_sent) THEN RAISE EXCEPTION 'a run killed after a send was requeued'; END IF;

  -- Killed after only an idempotent send: retried.
  v_idem := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a7', 'idem');
  SELECT * INTO r FROM public.claim_run_requests('tick-i', 1, 1, 60);
  SELECT * INTO s FROM public.start_run_execution(v_org, v_idem, r.claim_token, gen_random_uuid());
  PERFORM public.record_send_intent(v_org, v_idem, r.claim_token, s.state_version, 'upsert', 1, 'PUT', 'partner.example', true, 'derived-key-1');
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_idem;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_idem AND status = 'queued' AND resume_reason = 'retry')
     OR NOT EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_idem) THEN
    RAISE EXCEPTION 'a run killed after an idempotent send was not retried';
  END IF;

  -- The sweep pages: limit 1 over two lapsed leases says there is more.
  PERFORM pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a8', 'page-' || g) FROM generate_series(1, 2) g;
  PERFORM public.claim_run_requests('tick-p', 10, 10, 60);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE workflow_id = '00000000-0000-4000-8000-0000000000a8';
  SELECT * INTO r FROM public.sweep_expired_leases(1);
  IF r.requeued <> 1 OR NOT r.more THEN RAISE EXCEPTION 'a sweep of limit 1 over two lapsed leases answered %', r; END IF;
  INSERT INTO re_cases VALUES ('sweep: unstarted requeued to a cap, killed spends attempts, a send goes to needs_human, it pages');
END
$do$;

-- ── sweep: the holder it swept cannot complete ───────────────────────────────
-- A swept run's claim is gone even before anyone re-claims it, so its old holder
-- must hear claim_lost, never already_completed (which would tell it the run it
-- lost had finished). Found by the lessons review of #1948.
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_retried uuid;
  v_human uuid;
  r record;
  s record;
BEGIN
  PERFORM pg_temp.re_reset();
  v_retried := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000ac', 'swept-retry');
  SELECT * INTO r FROM public.claim_run_requests('tick-1', 1, 1, 60);
  PERFORM public.start_run_execution(v_org, v_retried, r.claim_token, gen_random_uuid());
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_retried;
  PERFORM public.sweep_expired_leases(100);
  IF (SELECT status FROM public.run_requests WHERE id = v_retried) <> 'queued' THEN RAISE EXCEPTION 'setup: the swept run was not requeued'; END IF;
  IF (SELECT outcome FROM public.complete_run_request(v_org, v_retried, r.claim_token, 'done')) <> 'claim_lost' THEN
    RAISE EXCEPTION 'the holder of a swept run was told its complete succeeded';
  END IF;
  IF (SELECT status FROM public.run_requests WHERE id = v_retried) <> 'queued' THEN RAISE EXCEPTION 'the swept holder''s complete changed the run'; END IF;
  -- A missing token never matches the swept run's absent one.
  BEGIN
    PERFORM public.complete_run_request(v_org, v_retried, NULL, 'done');
    RAISE EXCEPTION 'a complete with no claim token was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- Likewise after the sweep sends it to a person (from no rows again: the
  -- requeued run above would be claimed first).
  PERFORM pg_temp.re_reset();
  v_human :=pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000ad', 'swept-human');
  SELECT * INTO r FROM public.claim_run_requests('tick-2', 1, 1, 60);
  SELECT * INTO s FROM public.start_run_execution(v_org, v_human, r.claim_token, gen_random_uuid());
  PERFORM public.record_send_intent(v_org, v_human, r.claim_token, s.state_version, 'n', 1, 'POST', 'h', false, NULL);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_human;
  PERFORM public.sweep_expired_leases(100);
  IF (SELECT outcome FROM public.complete_run_request(v_org, v_human, r.claim_token, 'done')) <> 'claim_lost' THEN
    RAISE EXCEPTION 'the holder of a run swept to needs_human was told its complete succeeded';
  END IF;
  IF (SELECT status FROM public.run_requests WHERE id = v_human) <> 'needs_human' THEN RAISE EXCEPTION 'the swept holder''s complete changed a needs_human run'; END IF;
  INSERT INTO re_cases VALUES ('sweep: the holder of a swept run hears claim_lost, never already_completed');
END
$do$;

-- ── ledger: fenced intents, and the stalled holder (D2) ──────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_id uuid;
  a record;
  a_start record;
  b record;
  i1 record;
  i2 record;
BEGIN
  PERFORM pg_temp.re_reset();
  v_id := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000a9', 'ledger');
  SELECT * INTO a FROM public.claim_run_requests('holder-a', 1, 1, 60);
  SELECT * INTO a_start FROM public.start_run_execution(v_org, v_id, a.claim_token, gen_random_uuid());

  IF (SELECT outcome FROM public.record_send_intent(v_org, v_id, a.claim_token, a_start.state_version - 1, 'n1', 1, 'POST', 'h', false, NULL)) <> 'stale' THEN
    RAISE EXCEPTION 'an intent with a stale state version was recorded';
  END IF;
  SELECT * INTO i1 FROM public.record_send_intent(v_org, v_id, a.claim_token, a_start.state_version, 'n1', 1, 'POST', 'h', false, NULL);
  SELECT * INTO i2 FROM public.record_send_intent(v_org, v_id, a.claim_token, a_start.state_version, 'n1', 1, 'POST', 'h', false, NULL);
  IF i1.outcome <> 'recorded' OR i2.outcome <> 'duplicate' OR i2.ledger_id <> i1.ledger_id THEN RAISE EXCEPTION 'intents answered % and %', i1, i2; END IF;
  IF (SELECT outcome FROM public.record_send_result(v_org, i1.ledger_id, 'forwarded', 200, NULL)) <> 'recorded' THEN RAISE EXCEPTION 'the result was not recorded'; END IF;
  IF (SELECT outcome FROM public.record_send_result(v_org, i1.ledger_id, 'failed', 500, NULL)) <> 'already_recorded' THEN RAISE EXCEPTION 'a second result overwrote the first'; END IF;
  IF (SELECT status FROM public.send_ledger WHERE id = i1.ledger_id) <> 'forwarded' THEN RAISE EXCEPTION 'the first result did not win'; END IF;
  IF (SELECT outcome FROM public.record_send_result('bbbbbbbb-0000-4000-8000-000000001948', i1.ledger_id, 'failed', 500, NULL)) <> 'not_found' THEN
    RAISE EXCEPTION 'another organization wrote a result';
  END IF;

  -- Holder A stalls; its lease lapses; the run (idempotent send only here, so
  -- marked so) is swept and re-claimed by B. A's next intent is refused.
  UPDATE public.send_ledger SET idempotent = true WHERE id = i1.ledger_id;
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  PERFORM public.sweep_expired_leases(100);
  SELECT * INTO b FROM public.claim_run_requests('holder-b', 1, 1, 60);
  IF b.run_request_id IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'B did not re-claim the run'; END IF;
  IF (SELECT outcome FROM public.record_send_intent(v_org, v_id, a.claim_token, a_start.state_version, 'n2', 1, 'POST', 'h', false, NULL)) <> 'stale' THEN
    RAISE EXCEPTION 'the stalled holder recorded an intent after the run was re-claimed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.send_ledger WHERE run_request_id = v_id AND node_id = 'n2') THEN RAISE EXCEPTION 'a ledger row of the stalled holder exists'; END IF;
  IF (SELECT outcome FROM public.complete_run_request(v_org, v_id, a.claim_token, 'done')) <> 'claim_lost' THEN RAISE EXCEPTION 'the stalled holder completed the re-claimed run'; END IF;
  INSERT INTO re_cases VALUES ('ledger: intents fenced by token and state version, a stalled holder records nothing, first result wins');
END
$do$;

-- ── overlap ──────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_skip uuid := '00000000-0000-4000-8000-00000000005a';
  v_queue uuid := '00000000-0000-4000-8000-00000000005b';
  r record;
  c record;
BEGIN
  PERFORM pg_temp.re_reset();
  -- skip: a second fire while the first is waiting or running is recorded skipped.
  SELECT * INTO r FROM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_skip, p_workflow_version => 1,
    p_trigger_kind => 'schedule', p_dedup_key => 's1', p_overlap => 'skip');
  IF r.outcome <> 'inserted' THEN RAISE EXCEPTION 'the first skip fire answered %', r.outcome; END IF;
  SELECT * INTO r FROM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_skip, p_workflow_version => 1,
    p_trigger_kind => 'schedule', p_dedup_key => 's2', p_overlap => 'skip');
  IF r.outcome <> 'skipped' OR NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = r.run_request_id AND status = 'skipped' AND status_reason = 'overlap') THEN
    RAISE EXCEPTION 'a second skip fire answered %', r;
  END IF;
  SELECT * INTO c FROM public.claim_run_requests('t', 10, 10, 60);
  PERFORM public.start_run_execution(v_org, c.run_request_id, c.claim_token, gen_random_uuid());
  IF (SELECT outcome FROM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_skip, p_workflow_version => 1,
        p_trigger_kind => 'schedule', p_dedup_key => 's3', p_overlap => 'skip')) <> 'skipped' THEN
    RAISE EXCEPTION 'a fire while the run was running was not skipped';
  END IF;
  PERFORM public.complete_run_request(v_org, c.run_request_id, c.claim_token, 'done');
  IF (SELECT outcome FROM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_skip, p_workflow_version => 1,
        p_trigger_kind => 'schedule', p_dedup_key => 's4', p_overlap => 'skip')) <> 'inserted' THEN
    RAISE EXCEPTION 'a fire after the run finished was refused';
  END IF;

  -- queue: at most one waiting first start, and they run one at a time.
  PERFORM pg_temp.re_reset();
  PERFORM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_queue, p_workflow_version => 1,
    p_trigger_kind => 'schedule', p_dedup_key => 'q1', p_overlap => 'queue');
  IF (SELECT outcome FROM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_queue, p_workflow_version => 1,
        p_trigger_kind => 'schedule', p_dedup_key => 'q2', p_overlap => 'queue')) <> 'skipped' THEN
    RAISE EXCEPTION 'a second waiting first start of a queue schedule was accepted';
  END IF;
  SELECT * INTO c FROM public.claim_run_requests('t', 10, 10, 60);
  IF (SELECT outcome FROM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_queue, p_workflow_version => 1,
        p_trigger_kind => 'schedule', p_dedup_key => 'q3', p_overlap => 'queue')) <> 'inserted' THEN
    RAISE EXCEPTION 'a fire queued behind a running queue schedule was refused';
  END IF;
  IF (SELECT count(*) FROM public.claim_run_requests('t2', 10, 10, 60)) <> 0 THEN RAISE EXCEPTION 'a queue schedule ran two at once'; END IF;

  -- The claimed run's lease lapses before it starts while a later fire holds the
  -- one waiting slot: the sweep must requeue it without tripping the overlap
  -- index, or one such row fails every sweep after it (found by the lessons review).
  -- now() is one instant in this transaction, so the first run is dated a minute
  -- earlier, as it would be: otherwise the order falls to a random id tie break.
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second', created_at = now() - interval '1 minute' WHERE id = c.run_request_id;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = c.run_request_id AND status = 'queued' AND resume_reason = 'retry') THEN
    RAISE EXCEPTION 'the lapsed queue run was left as %', (SELECT row_to_json(x) FROM public.run_requests x WHERE id = c.run_request_id);
  END IF;
  -- And it goes first, still one at a time.
  SELECT * INTO r FROM public.claim_run_requests('t3', 10, 10, 60);
  IF r.run_request_id IS DISTINCT FROM c.run_request_id THEN RAISE EXCEPTION 'the requeued first run lost its place to the later fire'; END IF;
  IF (SELECT count(*) FROM public.run_requests WHERE workflow_id = v_queue AND status IN ('claimed', 'running')) <> 1 THEN
    RAISE EXCEPTION 'a queue schedule had two runs in flight after a requeue';
  END IF;
  INSERT INTO re_cases VALUES ('overlap: skip refuses a second active run, queue holds one waiting and runs one at a time');
END
$do$;

-- ── schedule fires ───────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  f1 record;
  f2 record;
BEGIN
  PERFORM pg_temp.re_reset();
  SELECT * INTO f1 FROM public.record_schedule_fire(v_org, '00000000-0000-4000-8000-0000000005c1', 3, '2026-10-16T13:00:00Z', '2026-10-16T12:00:00Z');
  SELECT * INTO f2 FROM public.record_schedule_fire(v_org, '00000000-0000-4000-8000-0000000005c1', 3, '2026-10-16T13:00:00Z', '2026-10-16T12:00:00Z');
  IF f1.outcome <> 'enqueued' OR f2.outcome <> 'already_recorded' OR f2.run_request_id <> f1.run_request_id THEN RAISE EXCEPTION 'fires answered % and %', f1, f2; END IF;
  IF (SELECT count(*) FROM public.run_requests WHERE workflow_id = '00000000-0000-4000-8000-0000000005c1') <> 1 THEN RAISE EXCEPTION 'one slot made two runs'; END IF;
  IF (SELECT payload->>'scheduled_for' FROM public.run_requests WHERE id = f1.run_request_id) <> '2026-10-16T13:00:00Z'
     OR (SELECT payload->>'previous_scheduled_for' FROM public.run_requests WHERE id = f1.run_request_id) <> '2026-10-16T12:00:00Z'
     OR (SELECT trigger_kind FROM public.run_requests WHERE id = f1.run_request_id) <> 'schedule' THEN
    RAISE EXCEPTION 'the scheduled run does not carry its slot: %', (SELECT payload FROM public.run_requests WHERE id = f1.run_request_id);
  END IF;
  IF (SELECT run_request_id FROM public.schedule_fires WHERE id = f1.fire_id) <> f1.run_request_id THEN RAISE EXCEPTION 'the fire does not name its run'; END IF;
  INSERT INTO re_cases VALUES ('schedule: a slot is recorded and enqueued once, with its slot and the previous one');
END
$do$;

-- ── purge ────────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_wf uuid := '00000000-0000-4000-8000-0000000000e9';
  v_old uuid;
  v_kept uuid;
  v_chain_old uuid;
  v_live uuid;
  r record;
  c record;
BEGIN
  PERFORM pg_temp.re_reset();
  BEGIN
    PERFORM public.purge_terminal_run_requests(now() - interval '23 hours', 100);
    RAISE EXCEPTION 'a purge cutoff inside the last day was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  v_old := pg_temp.re_enqueue(v_wf, 'old');
  v_kept := pg_temp.re_enqueue(v_wf, 'kept');
  v_chain_old := pg_temp.re_enqueue(v_wf, 'chain');
  FOR c IN SELECT * FROM public.claim_run_requests('t', 10, 10, 60) LOOP
    PERFORM public.start_run_execution(v_org, c.run_request_id, c.claim_token, gen_random_uuid());
    IF c.run_request_id = v_old THEN
      PERFORM public.record_send_intent(v_org, v_old, c.claim_token, c.state_version + 1, 'n', 1, 'POST', 'h', false, NULL);
    END IF;
    PERFORM public.complete_run_request(v_org, c.run_request_id, c.claim_token, 'done');
  END LOOP;
  PERFORM public.set_run_request_kept(v_org, v_kept, true, '00000000-0000-4000-8000-00000000babe', 'ops@example.test');
  -- A live run on the same chain as v_chain_old (a continuation's successor).
  v_live := pg_temp.re_enqueue(v_wf, 'live');
  UPDATE public.run_requests SET execution_chain_id = v_chain_old WHERE id = v_live;
  UPDATE public.run_requests SET terminal_at = now() - interval '31 days' WHERE id IN (v_old, v_kept, v_chain_old);

  SELECT * INTO r FROM public.purge_terminal_run_requests(now() - interval '30 days', 100);
  IF r.purged <> 1 OR r.tombstoned <> 1 OR r.more THEN RAISE EXCEPTION 'the purge answered %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_old) THEN RAISE EXCEPTION 'the old run was not purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_kept) THEN RAISE EXCEPTION 'a kept run was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_chain_old) THEN RAISE EXCEPTION 'a run whose chain is live was purged'; END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_old) THEN RAISE EXCEPTION 'the purged run left its execution'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.send_ledger WHERE run_request_id = v_old) THEN RAISE EXCEPTION 'the purge took the send ledger with it'; END IF;

  -- The key still deduplicates after its row is gone.
  SELECT * INTO r FROM public.enqueue_run_request(p_organization_id => v_org, p_workflow_id => v_wf, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => 'old');
  IF r.outcome <> 'duplicate' OR r.run_request_id <> v_old OR r.run_status <> 'purged' THEN RAISE EXCEPTION 'a purged key answered %', r; END IF;

  -- Tombstones past their window go.
  UPDATE public.run_request_dedup_tombstones SET dedup_expires_at = now() - interval '1 second' WHERE run_request_id = v_old;
  SELECT * INTO r FROM public.purge_expired_dedup_tombstones(100);
  IF r.purged <> 1 THEN RAISE EXCEPTION 'the tombstone purge answered %', r; END IF;
  INSERT INTO re_cases VALUES ('purge: refuses a recent cutoff, keeps kept and live chains, tombstones the key, spares the ledger');
END
$do$;

-- ── keep is audited ──────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001948';
  v_id uuid;
  a record;
BEGIN
  PERFORM pg_temp.re_reset();
  DELETE FROM public.ops_audit_log WHERE organization_id = v_org;
  v_id := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000ea', 'k');
  IF (SELECT outcome FROM public.set_run_request_kept(v_org, v_id, true, '00000000-0000-4000-8000-00000000babe', 'ops@example.test')) <> 'changed' THEN
    RAISE EXCEPTION 'keep did not change the run';
  END IF;
  IF (SELECT outcome FROM public.set_run_request_kept(v_org, v_id, true, '00000000-0000-4000-8000-00000000babe', 'ops@example.test')) <> 'unchanged' THEN
    RAISE EXCEPTION 'a repeated keep changed the run';
  END IF;
  IF (SELECT outcome FROM public.set_run_request_kept('bbbbbbbb-0000-4000-8000-000000001948', v_id, false, '00000000-0000-4000-8000-00000000babe', 'x@example.test')) <> 'not_found' THEN
    RAISE EXCEPTION 'another organization un-kept the run';
  END IF;
  IF (SELECT count(*) FROM public.ops_audit_log WHERE organization_id = v_org AND subject_id = v_id) <> 1 THEN RAISE EXCEPTION 'keep was not audited exactly once'; END IF;
  SELECT * INTO a FROM public.ops_audit_log WHERE organization_id = v_org AND subject_id = v_id;
  IF a.old_values <> '{"kept_by": null}'::jsonb OR a.new_values->>'kept_by' <> '00000000-0000-4000-8000-00000000babe' OR a.actor_email <> 'ops@example.test' THEN
    RAISE EXCEPTION 'the keep audit is %', row_to_json(a);
  END IF;
  INSERT INTO re_cases VALUES ('keep: audited once with old and new values, another organization refused');
END
$do$;

-- ── agreement between the queue and the runs ─────────────────────────────────
DO $do$
DECLARE
  v_lost uuid;
  v_stuck uuid;
BEGIN
  PERFORM pg_temp.re_reset();
  IF EXISTS (SELECT 1 FROM public.run_queue_disagreements(100)) THEN RAISE EXCEPTION 'disagreements reported on a clean state'; END IF;
  v_lost := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000eb', 'lost');
  v_stuck := pg_temp.re_enqueue('00000000-0000-4000-8000-0000000000eb', 'stuck');
  -- Broken by hand as the table owner, which no function ever does.
  DELETE FROM public.run_queue WHERE run_request_id = v_lost;
  UPDATE public.run_requests SET status = 'done', terminal_at = now() WHERE id = v_stuck;
  IF NOT EXISTS (SELECT 1 FROM public.run_queue_disagreements(100) WHERE kind = 'waiting_run_without_queue_row' AND run_request_id = v_lost) THEN
    RAISE EXCEPTION 'a waiting run with no queue row was not reported';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_queue_disagreements(100) WHERE kind = 'queue_row_without_waiting_run' AND run_request_id = v_stuck) THEN
    RAISE EXCEPTION 'a queue row of a finished run was not reported';
  END IF;
  INSERT INTO re_cases VALUES ('agreement: a run and a queue row that disagree are both reported');
END
$do$;

-- ── the vocabulary is enforced by the table, not only the functions ──────────
DO $do$
BEGIN
  BEGIN
    INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, status, not_before, max_attempts, dedup_expires_at, execution_chain_id)
    VALUES (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000001948', gen_random_uuid(), 1, 'http_webhook', 'v', 'paused', now(), 3, now(), gen_random_uuid());
    RAISE EXCEPTION 'an unknown status was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, status, status_reason, not_before, max_attempts, dedup_expires_at, execution_chain_id, terminal_at)
    VALUES (gen_random_uuid(), 'aaaaaaaa-0000-4000-8000-000000001948', gen_random_uuid(), 1, 'http_webhook', 'v', 'dead', NULL, now(), 3, now(), gen_random_uuid(), now());
    RAISE EXCEPTION 'a dead run with no reason was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO re_cases VALUES ('vocabulary: the table refuses an unknown status and a dead run with no reason');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM re_cases);
BEGIN
  IF v_n <> 17 THEN RAISE EXCEPTION 'run_engine_lifecycle: % of 17 cases ran', v_n; END IF;
  RAISE NOTICE 'run_engine_lifecycle: % cases passed', v_n;
END
$do$;

ROLLBACK;
