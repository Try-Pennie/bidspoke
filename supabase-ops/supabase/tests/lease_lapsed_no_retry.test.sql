-- A run set not to retry is never requeued when its lease lapses (#3046).
-- Migration 20261030160000_lease_lapsed_no_retry_3046.sql.
--
-- Dan, 2026-10-30: a no-retry workflow's run (retry { mode: 'none' }, #2992)
-- whose lease lapses ends failed, as stalled, with a named reason, and pages if
-- the workflow is live. It is never requeued, whether or not it sent anything.
-- The run records the setting at its start (start_run_execution's
-- p_retry_disabled, kept in run_requests.retry_disabled), and the lease sweep
-- reads it.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. start_run_execution records the setting: true and false are kept, a
--      start that sends none (as the ops Worker deployed when this is applied
--      does) leaves what the run holds, and a run never started holds false;
--   2. a no-retry run whose lease lapses with nothing sent ends failed with
--      lease_lapsed_no_retry, refunds nothing, leaves the queue, and the sweep
--      names its workflow among the ones it ended this way;
--   3. a no-retry run whose lease lapses after an idempotent send in that
--      attempt ends failed the same way, whatever max_attempts would allow;
--   4. a no-retry run whose lease lapses after a send that cannot be repeated
--      also ends failed, lease_lapsed_no_retry (Dan, 2026-10-30), and the sweep
--      names its workflow among those whose runs may have landed a send, so the
--      page can say so; a run on the default setting in the same state still
--      waits for a person (needs_human, lease_expired_after_send);
--   5. a run on the default setting, and one started with no setting sent,
--      are requeued exactly as before; a claim of a no-retry run that never
--      started is returned to the queue unrun, as before (#3023);
--   6. the CHECK holds lease_lapsed_no_retry, and a holder cannot fail a run
--      for it: only the sweep ends a run for it (F122);
--   7. the ops Worker deployed when this is applied keeps working: one
--      definition of start_run_execution and of sweep_expired_leases, the
--      arguments it sends with every later one defaulted, the columns it
--      reads, SECURITY DEFINER with a fixed search_path, service_role alone.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE ln_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.ln_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.ln_enqueue(p_workflow uuid, p_key text, p_max_attempts integer DEFAULT 5)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000003046', p_workflow_id => p_workflow, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- Claim the one run (due now); answers the claim token. Every other queued run
-- is held back first, so one claim never takes a run a later call means to.
CREATE FUNCTION pg_temp.ln_claim(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_tok uuid;
BEGIN
  UPDATE public.run_queue SET not_before = now() + interval '1 hour' WHERE run_request_id <> p_id;
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT c.claim_token INTO v_tok FROM public.claim_run_requests('ln-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF v_tok IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  RETURN v_tok;
END
$f$;

-- Claim and start it, sending the retry setting as the Worker does (NULL: the
-- deployed Worker's start, which sends none). Answers the claim token.
CREATE FUNCTION pg_temp.ln_claim_start(p_id uuid, p_retry_disabled boolean) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_tok uuid := pg_temp.ln_claim(p_id);
  s record;
BEGIN
  IF p_retry_disabled IS NULL THEN
    SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000003046', p_id, v_tok, gen_random_uuid());
  ELSE
    SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000003046', p_id, v_tok, gen_random_uuid(),
      p_retry_disabled => p_retry_disabled);
  END IF;
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  RETURN v_tok;
END
$f$;

CREATE FUNCTION pg_temp.ln_lapse(p_id uuid) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = p_id;
$f$;

CREATE FUNCTION pg_temp.ln_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. the start records the setting ─────────────────────────────────────────
DO $do$
DECLARE
  v_on uuid;
  v_off uuid;
  v_unsent uuid;
  v_never uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.ln_reset();
  v_on := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030a1', 'on');
  v_off := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030a2', 'off');
  v_unsent := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030a3', 'unsent');
  v_never := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030a4', 'never');
  v_tok := pg_temp.ln_claim_start(v_on, true);
  PERFORM pg_temp.ln_claim_start(v_off, false);
  PERFORM pg_temp.ln_claim_start(v_unsent, NULL);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_on AND retry_disabled) THEN
    RAISE EXCEPTION 'a start sent retry disabled did not record it: %', pg_temp.ln_row(v_on);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_off AND NOT retry_disabled) THEN
    RAISE EXCEPTION 'a start sent retry enabled recorded %', pg_temp.ln_row(v_off);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_unsent AND NOT retry_disabled) THEN
    RAISE EXCEPTION 'a start that sent no setting recorded %', pg_temp.ln_row(v_unsent);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_never AND NOT retry_disabled) THEN
    RAISE EXCEPTION 'a run never started holds %', pg_temp.ln_row(v_never);
  END IF;
  -- A later start that sends no setting keeps what the run holds.
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003046', v_on, v_tok, 'suspend', p_reason => 'wake',
    p_not_before => now() - interval '1 second');
  PERFORM pg_temp.ln_claim_start(v_on, NULL);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_on AND retry_disabled AND attempts = 2) THEN
    RAISE EXCEPTION 'a later start that sent no setting changed the recorded one: %', pg_temp.ln_row(v_on);
  END IF;
  INSERT INTO ln_cases VALUES ('start_run_execution records the retry setting it is sent, and keeps it when sent none');
END
$do$;

-- ── 2. a no-retry run that lapses with nothing sent ends failed ──────────────
DO $do$
DECLARE
  v_wf uuid := '00000000-0000-4000-8000-0000000030b1';
  v_id uuid;
  r record;
BEGIN
  PERFORM pg_temp.ln_reset();
  v_id := pg_temp.ln_enqueue(v_wf, 'sent-nothing');
  PERFORM pg_temp.ln_claim_start(v_id, true);
  PERFORM pg_temp.ln_lapse(v_id);
  SELECT * INTO r FROM public.sweep_expired_leases(100);
  IF r.failed <> 1 OR r.retried <> 0 OR r.requeued <> 0 OR r.dead <> 0 OR r.needs_human <> 0 OR r.more
     OR r.no_retry_workflow_ids IS DISTINCT FROM ARRAY[v_wf] OR r.no_retry_after_send_workflow_ids <> '{}'::uuid[] THEN
    RAISE EXCEPTION 'the sweep of a lapsed no-retry run that sent nothing answered %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'lease_lapsed_no_retry'
                 AND terminal_at = now() AND claim_token IS NULL AND claim_expires_at IS NULL AND lapse_refunds = 0
                 AND uncharged_attempts = 0 AND attempts = 1 AND last_error = 'lease expired') THEN
    RAISE EXCEPTION 'a lapsed no-retry run that sent nothing is %', pg_temp.ln_row(v_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'the failed no-retry run is still queued'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 1 AND status = 'failed') THEN
    RAISE EXCEPTION 'the lapsed attempt of a no-retry run was not ended failed';
  END IF;
  INSERT INTO ln_cases VALUES ('a no-retry run whose lease lapses with nothing sent ends failed, lease_lapsed_no_retry, and is named to the tick');
END
$do$;

-- ── 3. a no-retry run that lapses after an idempotent send ends failed ───────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000003046';
  v_wf uuid := '00000000-0000-4000-8000-0000000030c1';
  v_id uuid;
  v_second uuid;
  v_tok uuid;
  v_sv bigint;
  r record;
BEGIN
  PERFORM pg_temp.ln_reset();
  v_id := pg_temp.ln_enqueue(v_wf, 'sent-idempotent', 5);
  v_second := pg_temp.ln_enqueue(v_wf, 'sent-nothing-too', 5);
  v_tok := pg_temp.ln_claim_start(v_id, true);
  v_sv := (SELECT state_version FROM public.run_requests WHERE id = v_id);
  PERFORM public.record_send_intent(v_org, v_id, v_tok, v_sv, 'upsert', 1, 'PUT', 'partner.example', true, 'derived-key-1');
  PERFORM pg_temp.ln_claim_start(v_second, true);
  PERFORM pg_temp.ln_lapse(v_id);
  PERFORM pg_temp.ln_lapse(v_second);
  SELECT * INTO r FROM public.sweep_expired_leases(100);
  IF r.failed <> 2 OR r.retried <> 0 OR r.dead <> 0 OR r.needs_human <> 0
     OR r.no_retry_workflow_ids IS DISTINCT FROM ARRAY[v_wf, v_wf] OR r.no_retry_after_send_workflow_ids <> '{}'::uuid[] THEN
    RAISE EXCEPTION 'the sweep of two lapsed no-retry runs of one workflow answered %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'lease_lapsed_no_retry'
                 AND terminal_at = now() AND attempts = 1 AND max_attempts = 5) THEN
    RAISE EXCEPTION 'a lapsed no-retry run that made an idempotent send is %', pg_temp.ln_row(v_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'the no-retry run that sent is still queued'; END IF;
  INSERT INTO ln_cases VALUES ('a no-retry run whose lease lapses after an idempotent send ends failed, whatever max_attempts allows');
END
$do$;

-- ── 4. a no-retry run that lapses after a send that cannot be repeated ───────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000003046';
  v_wf uuid := '00000000-0000-4000-8000-0000000030d1';
  v_id uuid;
  v_default uuid;
  v_tok uuid;
  v_sv bigint;
  r record;
BEGIN
  PERFORM pg_temp.ln_reset();
  v_id := pg_temp.ln_enqueue(v_wf, 'sent-once-only');
  v_default := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030d2', 'sent-once-only-default');
  v_tok := pg_temp.ln_claim_start(v_id, true);
  v_sv := (SELECT state_version FROM public.run_requests WHERE id = v_id);
  PERFORM public.record_send_intent(v_org, v_id, v_tok, v_sv, 'post_lead', 1, 'POST', 'partner.example', false, NULL);
  v_tok := pg_temp.ln_claim_start(v_default, false);
  v_sv := (SELECT state_version FROM public.run_requests WHERE id = v_default);
  PERFORM public.record_send_intent(v_org, v_default, v_tok, v_sv, 'post_lead', 1, 'POST', 'partner.example', false, NULL);
  PERFORM pg_temp.ln_lapse(v_id);
  PERFORM pg_temp.ln_lapse(v_default);
  SELECT * INTO r FROM public.sweep_expired_leases(100);
  IF r.failed <> 1 OR r.needs_human <> 1 OR r.retried <> 0 OR r.dead <> 0
     OR r.no_retry_workflow_ids IS DISTINCT FROM ARRAY[v_wf] OR r.no_retry_after_send_workflow_ids IS DISTINCT FROM ARRAY[v_wf] THEN
    RAISE EXCEPTION 'the sweep of runs lapsed after a send that cannot be repeated answered %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'lease_lapsed_no_retry'
                 AND terminal_at = now() AND claim_token IS NULL) THEN
    RAISE EXCEPTION 'a no-retry run lapsed after a send that cannot be repeated is %', pg_temp.ln_row(v_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'the no-retry run that sent once only is still queued'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_default AND status = 'needs_human' AND status_reason = 'lease_expired_after_send') THEN
    RAISE EXCEPTION 'a run on the default setting lapsed after a send that cannot be repeated is %', pg_temp.ln_row(v_default);
  END IF;
  INSERT INTO ln_cases VALUES ('a no-retry run lapsed after a send that cannot be repeated ends failed and is named as one that may have sent; the default still waits for a person');
END
$do$;

-- ── 5. the default setting, a start with none, and an unstarted claim ────────
DO $do$
DECLARE
  v_default uuid;
  v_unsent uuid;
  v_sent uuid;
  v_unstarted uuid;
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000003046';
  v_tok uuid;
  v_sv bigint;
  r record;
BEGIN
  PERFORM pg_temp.ln_reset();
  v_default := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030e1', 'default');
  v_unsent := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030e2', 'unsent');
  v_sent := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030e3', 'default-sent', 3);
  v_unstarted := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030e4', 'unstarted');
  PERFORM pg_temp.ln_claim_start(v_default, false);
  PERFORM pg_temp.ln_claim_start(v_unsent, NULL);
  v_tok := pg_temp.ln_claim_start(v_sent, false);
  v_sv := (SELECT state_version FROM public.run_requests WHERE id = v_sent);
  PERFORM public.record_send_intent(v_org, v_sent, v_tok, v_sv, 'upsert', 1, 'PUT', 'partner.example', true, 'derived-key-e3');
  PERFORM pg_temp.ln_claim(v_unstarted);
  -- As the table owner: a claim of a run that holds the setting (a no-retry run
  -- claimed again after a wait) whose start never came.
  UPDATE public.run_requests SET retry_disabled = true WHERE id = v_unstarted;
  PERFORM pg_temp.ln_lapse(v_default);
  PERFORM pg_temp.ln_lapse(v_unsent);
  PERFORM pg_temp.ln_lapse(v_sent);
  PERFORM pg_temp.ln_lapse(v_unstarted);
  SELECT * INTO r FROM public.sweep_expired_leases(100);
  IF r.retried <> 3 OR r.requeued <> 1 OR r.failed <> 0 OR r.dead <> 0 OR r.no_retry_workflow_ids <> '{}'::uuid[]
     OR r.no_retry_after_send_workflow_ids <> '{}'::uuid[] THEN
    RAISE EXCEPTION 'the sweep of runs on the default setting answered %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_default AND status = 'queued' AND lapse_refunds = 1 AND resume_reason = 'retry') THEN
    RAISE EXCEPTION 'a lapsed run on the default setting that sent nothing is %', pg_temp.ln_row(v_default);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_unsent AND status = 'queued' AND lapse_refunds = 1) THEN
    RAISE EXCEPTION 'a lapsed run started with no setting sent is %', pg_temp.ln_row(v_unsent);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_sent AND status = 'queued' AND lapse_refunds = 0 AND attempts = 1) THEN
    RAISE EXCEPTION 'a lapsed run on the default setting that sent is %', pg_temp.ln_row(v_sent);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_unstarted AND status = 'queued' AND lease_requeues = 1 AND attempts = 0) THEN
    RAISE EXCEPTION 'an unstarted claim of a no-retry run is %', pg_temp.ln_row(v_unstarted);
  END IF;
  IF (SELECT count(*) FROM public.run_queue WHERE run_request_id IN (v_default, v_unsent, v_sent, v_unstarted)) <> 4 THEN
    RAISE EXCEPTION 'the requeued runs are not all in the queue';
  END IF;
  INSERT INTO ln_cases VALUES ('runs on the default setting are requeued as before, and an unstarted claim goes back unrun');
END
$do$;

-- ── 6. the CHECK holds the reason; a holder cannot fail a run for it ────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_refused boolean := false;
BEGIN
  PERFORM pg_temp.ln_reset();
  v_id := pg_temp.ln_enqueue('00000000-0000-4000-8000-0000000030f1', 'holder');
  v_tok := pg_temp.ln_claim_start(v_id, true);
  BEGIN
    PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003046', v_id, v_tok, 'failed', p_reason => 'lease_lapsed_no_retry', p_error => 'boom');
  EXCEPTION WHEN invalid_parameter_value THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a holder failed a run for lease_lapsed_no_retry: %', pg_temp.ln_row(v_id); END IF;
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003046', v_id, v_tok, 'failed', p_reason => 'retry_disabled', p_error => 'boom');
  -- As the table owner, straight to the row: the CHECK alone decides.
  UPDATE public.run_requests SET status_reason = 'lease_lapsed_no_retry' WHERE id = v_id;
  v_refused := false;
  BEGIN
    UPDATE public.run_requests SET status_reason = 'lease_lapsed_no_retries' WHERE id = v_id;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'the status reason CHECK took a reason it does not name'; END IF;
  INSERT INTO ln_cases VALUES ('the CHECK holds lease_lapsed_no_retry, and only the sweep ends a run for it');
END
$do$;

-- ── 7. the Worker deployed when this is applied keeps working ────────────────
-- What apps/worker/src/ops/ops-writes.ts on main at f041892d4 (the code running
-- when this migration is applied) sends and reads, copied from it.
DO $do$
DECLARE
  v_spec record;
  v_fn record;
  v_proc regprocedure;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('start_run_execution', ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_execution_id', 'p_variables'],
        ARRAY['outcome', 'state_version', 'attempt', 'continuations', 'run_variables']),
      ('sweep_expired_leases', ARRAY['p_limit'], ARRAY['requeued', 'retried', 'needs_human', 'dead', 'failed', 'more'])
    ) AS s(name, sent, read)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name) <> 1 THEN
      RAISE EXCEPTION '% does not have exactly one definition, so PostgREST cannot resolve the deployed call', v_spec.name;
    END IF;
    SELECT p.oid::regprocedure AS oid, p.proargnames, p.pronargs, p.pronargdefaults INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name;
    IF v_fn.proargnames[1:array_length(v_spec.sent, 1)] <> v_spec.sent OR v_fn.pronargs - array_length(v_spec.sent, 1) > v_fn.pronargdefaults THEN
      RAISE EXCEPTION '% takes % (% defaulted), the deployed Worker sends %', v_spec.name, v_fn.proargnames[1:v_fn.pronargs], v_fn.pronargdefaults, v_spec.sent;
    END IF;
    IF NOT (v_fn.proargnames[v_fn.pronargs + 1:] @> v_spec.read) THEN
      RAISE EXCEPTION '% answers %, the deployed Worker reads %', v_spec.name, v_fn.proargnames[v_fn.pronargs + 1:], v_spec.read;
    END IF;
    v_proc := v_fn.oid;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_proc) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_proc; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_proc AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_proc; END IF;
    IF NOT has_function_privilege('service_role', v_proc, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_proc; END IF;
    IF has_function_privilege('anon', v_proc, 'EXECUTE') OR has_function_privilege('authenticated', v_proc, 'EXECUTE') OR has_function_privilege('public', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_proc;
    END IF;
  END LOOP;
  INSERT INTO ln_cases VALUES ('start_run_execution and sweep_expired_leases keep one definition, the deployed Worker''s arguments and answer, and service_role alone');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM ln_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'lease_lapsed_no_retry: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'lease_lapsed_no_retry: % cases passed', v_n;
END
$do$;

ROLLBACK;
