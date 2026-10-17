-- The run engine's resource wait, its charged attempts and the lapse refund
-- (#2334 deploy 2, plan: discussion #2329, Phase 4a P54 and Phase 6 P101,
-- finding F122).
--
-- WHY. A run refused a Salesforce slot (or whose acquire errors) suspends with
-- resource_wait and tries again later. attempts is also each execution's
-- identity (workflow_executions_attempt_key, the send ledger's key), so it
-- keeps rising on every start; what changes is what is CHARGED against
-- max_attempts: attempts - uncharged_attempts. A wait cannot last for ever
-- (L110), so a run waiting past 24 hours ends failed with
-- resource_wait_exceeded. A run whose isolate dies before any send is refunded
-- that attempt, three times at most, and on the fourth such lapse ends failed
-- with lease_lapsed_repeatedly. That failure must set terminal_at, or
-- run_requests_terminal_at_check refuses it and the whole sweep page aborts
-- (F122). Each case asserts the state the functions leave.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a suspend, claim and start cycle inserts a NEW execution row one attempt
--      higher, and the charged count is unchanged;
--   2. a run at max_attempts - 1 charged attempts that waits several times is
--      not sent dead, and its next charged retry still is;
--   3. a run waiting past the maximum ends failed with resource_wait_exceeded,
--      naming what it waited on, not suspended again;
--   4. any other outcome clears the wait;
--   5. a resource_wait suspend must name its cause and its wake time, and a
--      holder can fail a run with neither engine only reason (F122);
--   6. F122: a fourth lapse with no send ends failed with terminal_at set, and
--      the same sweep page still requeues the other lapsed run beside it;
--   7. only a lapse with no send in THAT attempt is refunded; a send not
--      declared idempotent in any attempt still goes to needs_human first;
--   8. a lapse of an attempt that was already uncharged (a resource_wait start)
--      counts against the lapse cap but is not refunded twice;
--   9. the ops Worker deployed before this migration keeps working: each
--      function it calls has the one definition, the argument names and the
--      result columns that Worker sends and reads, and its outcomes leave no
--      charge, refund or wait behind.
--
-- TIME. now() is fixed inside a transaction, so time passing is simulated by
-- moving a row's own timestamps back as the table owner; no case sleeps.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE rw_cases (name text PRIMARY KEY) ON COMMIT DROP;

-- Each case starts from no run rows at all: the claim and the sweep are lane wide.
CREATE FUNCTION pg_temp.rw_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.rw_enqueue(p_workflow uuid, p_key text, p_max_attempts integer DEFAULT 3)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000002334', p_workflow_id => p_workflow, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- Claim the one due run of a workflow and start it. Returns the claim token.
CREATE FUNCTION pg_temp.rw_claim_start(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  r record;
  s record;
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT * INTO r FROM public.claim_run_requests('rw-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF r.run_request_id IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000002334', p_id, r.claim_token, gen_random_uuid());
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  RETURN r.claim_token;
END
$f$;

CREATE FUNCTION pg_temp.rw_wait(p_id uuid, p_token uuid, p_cause text DEFAULT 'pool_full') RETURNS text LANGUAGE sql AS $f$
  SELECT run_status FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000002334', p_id, p_token, 'suspend',
    p_reason => 'resource_wait', p_error => p_cause, p_not_before => now());
$f$;

CREATE FUNCTION pg_temp.rw_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. the cycle inserts a new execution, and charges nothing ────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.rw_reset();
  v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a1', 'cycle');
  v_tok := pg_temp.rw_claim_start(v_id);
  IF pg_temp.rw_wait(v_id, v_tok) <> 'suspended' THEN RAISE EXCEPTION 'a resource_wait suspend left %', pg_temp.rw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'suspended' AND resume_reason = 'resource_wait'
                 AND resource_wait_since = now() AND resource_wait_cause = 'pool_full' AND claim_expires_at IS NULL) THEN
    RAISE EXCEPTION 'the waiting run is %', pg_temp.rw_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a waiting run is not queued'; END IF;
  v_tok := pg_temp.rw_claim_start(v_id);
  IF (SELECT count(*) FROM public.workflow_executions WHERE run_request_id = v_id) <> 2 THEN RAISE EXCEPTION 'the resumed start wrote no new execution'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 2 AND status = 'running' AND resume_reason = 'resource_wait') THEN
    RAISE EXCEPTION 'the resumed execution is not attempt 2 resumed by resource_wait';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 2 AND uncharged_attempts = 1) THEN
    RAISE EXCEPTION 'the charged count moved: %', pg_temp.rw_row(v_id);
  END IF;
  INSERT INTO rw_cases VALUES ('a wait, claim and start inserts a new execution and charges nothing');
END
$do$;

-- ── 2. waiting at max_attempts - 1 is not dead ───────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_id uuid;
  v_tok uuid;
  v_i integer;
BEGIN
  PERFORM pg_temp.rw_reset();
  v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a2', 'patient', 2);
  v_tok := pg_temp.rw_claim_start(v_id);  -- charged 1, max_attempts - 1
  FOR v_i IN 1..5 LOOP
    PERFORM pg_temp.rw_wait(v_id, v_tok, 'sf_budget_floor');
    v_tok := pg_temp.rw_claim_start(v_id);
  END LOOP;
  -- Six starts, one charged: a retry now is the run's second charged attempt, not its seventh.
  IF (SELECT run_status FROM public.complete_run_request(v_org, v_id, v_tok, 'retry', p_error => 'partner 503')) <> 'queued' THEN
    RAISE EXCEPTION 'a run that waited at max_attempts - 1 was ended: %', pg_temp.rw_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 6 AND uncharged_attempts = 5) THEN
    RAISE EXCEPTION 'the counts after five waits are %', pg_temp.rw_row(v_id);
  END IF;
  v_tok := pg_temp.rw_claim_start(v_id);  -- a retry start is charged: 2 of 2
  IF (SELECT run_status FROM public.complete_run_request(v_org, v_id, v_tok, 'retry', p_error => 'partner 503')) <> 'dead' THEN
    RAISE EXCEPTION 'a run out of charged attempts was not ended: %', pg_temp.rw_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status_reason = 'max_attempts' AND terminal_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the dead run is %', pg_temp.rw_row(v_id);
  END IF;
  INSERT INTO rw_cases VALUES ('waiting at max_attempts - 1 is not dead, and the next charged retry is');
END
$do$;

-- ── 3. a wait past the maximum ends failed ───────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.rw_reset();
  v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a3', 'too-long');
  v_tok := pg_temp.rw_claim_start(v_id);
  PERFORM pg_temp.rw_wait(v_id, v_tok, 'pool_full');
  v_tok := pg_temp.rw_claim_start(v_id);
  -- Exactly 24 hours is not past it.
  UPDATE public.run_requests SET resource_wait_since = now() - interval '24 hours' WHERE id = v_id;
  IF pg_temp.rw_wait(v_id, v_tok, 'sf_cap_unset') <> 'suspended' THEN RAISE EXCEPTION 'a wait of exactly 24 hours was ended: %', pg_temp.rw_row(v_id); END IF;
  IF (SELECT resource_wait_since FROM public.run_requests WHERE id = v_id) <> now() - interval '24 hours' THEN
    RAISE EXCEPTION 'a later suspend restarted the wait: %', pg_temp.rw_row(v_id);
  END IF;
  v_tok := pg_temp.rw_claim_start(v_id);
  UPDATE public.run_requests SET resource_wait_since = now() - interval '24 hours 1 second' WHERE id = v_id;
  IF pg_temp.rw_wait(v_id, v_tok, 'sf_cap_unset') <> 'failed' THEN RAISE EXCEPTION 'a wait past 24 hours was not ended: %', pg_temp.rw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'resource_wait_exceeded'
                 AND resource_wait_cause = 'sf_cap_unset' AND last_error = 'sf_cap_unset' AND terminal_at = now() AND claim_expires_at IS NULL) THEN
    RAISE EXCEPTION 'the run that waited too long is %', pg_temp.rw_row(v_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a run that waited too long is still queued'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 3 AND status = 'failed' AND error = 'sf_cap_unset') THEN
    RAISE EXCEPTION 'the last execution of a run that waited too long was not ended failed with its cause';
  END IF;
  INSERT INTO rw_cases VALUES ('a wait past 24 hours ends failed with resource_wait_exceeded and names its cause');
END
$do$;

-- ── 4. any other outcome clears the wait ─────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_id uuid;
  v_tok uuid;
  v_outcome text;
BEGIN
  FOREACH v_outcome IN ARRAY ARRAY['done', 'continue', 'retry', 'failed'] LOOP
    PERFORM pg_temp.rw_reset();
    v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a4', 'clear-' || v_outcome);
    v_tok := pg_temp.rw_claim_start(v_id);
    PERFORM pg_temp.rw_wait(v_id, v_tok);
    v_tok := pg_temp.rw_claim_start(v_id);
    IF v_outcome = 'continue' THEN
      PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'continue', p_not_before => now());
    ELSE
      PERFORM public.complete_run_request(v_org, v_id, v_tok, v_outcome);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND resource_wait_since IS NULL AND resource_wait_cause IS NULL) THEN
      RAISE EXCEPTION 'outcome % left the wait: %', v_outcome, pg_temp.rw_row(v_id);
    END IF;
  END LOOP;
  INSERT INTO rw_cases VALUES ('done, a continuation, a retry and a failure each clear the wait');
END
$do$;

-- ── 5. what a holder may and may not say ─────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_id uuid;
  v_tok uuid;
  v_reason text;
BEGIN
  PERFORM pg_temp.rw_reset();
  v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a5', 'refusals');
  v_tok := pg_temp.rw_claim_start(v_id);
  BEGIN
    PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'resource_wait', p_not_before => now());
    RAISE EXCEPTION 'a resource_wait suspend with no cause was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'resource_wait', p_error => 'the pool looked busy', p_not_before => now());
    RAISE EXCEPTION 'a resource_wait suspend with a cause outside the list was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'resource_wait', p_error => 'pool_full');
    RAISE EXCEPTION 'a resource_wait suspend with no wake time was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- F122: the engine alone ends a run for these; a holder that says so is refused.
  FOREACH v_reason IN ARRAY ARRAY['lease_lapsed_repeatedly', 'resource_wait_exceeded'] LOOP
    BEGIN
      PERFORM public.complete_run_request(v_org, v_id, v_tok, 'failed', p_reason => v_reason);
      RAISE EXCEPTION 'a holder failed a run with the engine only reason %', v_reason;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'running') THEN
    RAISE EXCEPTION 'a refused complete changed the run: %', pg_temp.rw_row(v_id);
  END IF;
  -- Every cause the list names is accepted (the vocabulary test holds the list to run-vocabulary.ts).
  IF pg_temp.rw_wait(v_id, v_tok, 'acquire_error') <> 'suspended' THEN RAISE EXCEPTION 'an acquire error could not be waited on'; END IF;
  INSERT INTO rw_cases VALUES ('a resource_wait suspend names its cause and wake time, and engine only reasons are refused to a holder');
END
$do$;

-- ── 6. F122: the fourth lapse with no send ends failed, and the page goes on ──
DO $do$
DECLARE
  v_repeat uuid;
  v_other uuid;
  r record;
  v_i integer;
BEGIN
  PERFORM pg_temp.rw_reset();
  v_repeat := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a6', 'dies-early');
  FOR v_i IN 1..3 LOOP
    PERFORM pg_temp.rw_claim_start(v_repeat);
    UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_repeat;
    SELECT * INTO r FROM public.sweep_expired_leases(100);
    IF r.retried <> 1 THEN RAISE EXCEPTION 'lapse %: the sweep answered %', v_i, r; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_repeat AND status = 'queued' AND resume_reason = 'retry'
                   AND attempts = v_i AND uncharged_attempts = v_i AND lapse_refunds = v_i) THEN
      RAISE EXCEPTION 'after lapse % with no send the run is %', v_i, pg_temp.rw_row(v_repeat);
    END IF;
  END LOOP;
  -- The fourth lapse, in the same page as another run's first.
  PERFORM pg_temp.rw_claim_start(v_repeat);
  v_other := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a7', 'beside-it');
  PERFORM pg_temp.rw_claim_start(v_other);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id IN (v_repeat, v_other);
  SELECT * INTO r FROM public.sweep_expired_leases(100);
  IF r.failed <> 1 OR r.retried <> 1 OR r.dead <> 0 OR r.needs_human <> 0 OR r.more THEN RAISE EXCEPTION 'the fourth lapse''s sweep answered %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_repeat AND status = 'failed' AND status_reason = 'lease_lapsed_repeatedly'
                 AND terminal_at = now() AND claim_token IS NULL AND claim_expires_at IS NULL AND lapse_refunds = 3 AND attempts = 4) THEN
    RAISE EXCEPTION 'a run whose lease lapsed four times with no send is %', pg_temp.rw_row(v_repeat);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_repeat) THEN RAISE EXCEPTION 'the failed run is still queued'; END IF;
  IF (SELECT count(*) FROM public.workflow_executions WHERE run_request_id = v_repeat AND status = 'failed') <> 4 THEN
    RAISE EXCEPTION 'four lapsed attempts are not four failed executions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_other AND status = 'queued' AND lapse_refunds = 1) THEN
    RAISE EXCEPTION 'the run beside it in the page was not swept: %', pg_temp.rw_row(v_other);
  END IF;
  INSERT INTO rw_cases VALUES ('F122: a fourth lapse with no send ends failed with terminal_at, and the rest of the page is swept');
END
$do$;

-- ── 7. only a lapse with no send in that attempt is refunded ─────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_id uuid;
  v_human uuid;
  v_tok uuid;
  v_sv bigint;
BEGIN
  PERFORM pg_temp.rw_reset();
  v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a8', 'sent-then-not', 2);
  -- Attempt 1 made an idempotent send: charged, retried.
  v_tok := pg_temp.rw_claim_start(v_id);
  v_sv := (SELECT state_version FROM public.run_requests WHERE id = v_id);
  PERFORM public.record_send_intent(v_org, v_id, v_tok, v_sv, 'upsert', 1, 'PUT', 'partner.example', true, 'derived-key-1');
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND attempts = 1 AND uncharged_attempts = 0 AND lapse_refunds = 0) THEN
    RAISE EXCEPTION 'a lapse after a send in its attempt was refunded: %', pg_temp.rw_row(v_id);
  END IF;
  -- Attempt 2 made none: refunded, so the run is not dead at max_attempts 2.
  PERFORM pg_temp.rw_claim_start(v_id);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND attempts = 2 AND uncharged_attempts = 1 AND lapse_refunds = 1) THEN
    RAISE EXCEPTION 'a lapse with no send in its own attempt was not refunded: %', pg_temp.rw_row(v_id);
  END IF;
  -- Attempt 3 sends idempotently again: charged 2 of 2, dead.
  v_tok := pg_temp.rw_claim_start(v_id);
  v_sv := (SELECT state_version FROM public.run_requests WHERE id = v_id);
  PERFORM public.record_send_intent(v_org, v_id, v_tok, v_sv, 'upsert', 1, 'PUT', 'partner.example', true, 'derived-key-3');
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'dead' AND status_reason = 'max_attempts' AND terminal_at = now()) THEN
    RAISE EXCEPTION 'a run out of charged attempts after a lapse is %', pg_temp.rw_row(v_id);
  END IF;

  -- A send not declared idempotent in an EARLIER attempt: needs_human, even though this attempt sent nothing.
  v_human := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023a9', 'sent-earlier');
  v_tok := pg_temp.rw_claim_start(v_human);
  v_sv := (SELECT state_version FROM public.run_requests WHERE id = v_human);
  PERFORM public.record_send_intent(v_org, v_human, v_tok, v_sv, 'post_lead', 1, 'POST', 'partner.example', false, NULL);
  PERFORM public.complete_run_request(v_org, v_human, v_tok, 'retry', p_error => 'later step failed');
  PERFORM pg_temp.rw_claim_start(v_human);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_human;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_human AND status = 'needs_human' AND status_reason = 'lease_expired_after_send' AND lapse_refunds = 0) THEN
    RAISE EXCEPTION 'a lapse after an earlier non idempotent send is %', pg_temp.rw_row(v_human);
  END IF;
  INSERT INTO rw_cases VALUES ('only a lapse with no send in its own attempt is refunded, and needs_human is judged first');
END
$do$;

-- ── 8. an uncharged attempt that lapses is not refunded twice ────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.rw_reset();
  v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023aa', 'wait-then-die');
  v_tok := pg_temp.rw_claim_start(v_id);           -- attempt 1, charged
  PERFORM pg_temp.rw_wait(v_id, v_tok, 'acquire_error');
  PERFORM pg_temp.rw_claim_start(v_id);            -- attempt 2, a resource_wait start: uncharged
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND attempts = 2 AND uncharged_attempts = 1
                 AND lapse_refunds = 1 AND resume_reason = 'retry' AND resource_wait_since IS NULL) THEN
    RAISE EXCEPTION 'an uncharged attempt that lapsed left %', pg_temp.rw_row(v_id);
  END IF;
  INSERT INTO rw_cases VALUES ('an uncharged attempt that lapses counts against the lapse cap and is not refunded twice');
END
$do$;

-- ── 9. the Worker deployed before this migration keeps working ────────────────
-- What apps/worker/src/ops/ops-writes.ts on main at 69d106c5 (the code running
-- when this migration is applied) sends and reads, copied from it.
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002334';
  v_spec record;
  v_fn record;
  v_args text[];
  v_cols text[];
  v_id uuid;
  v_tok uuid;
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('start_run_execution', ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_execution_id'], ARRAY['outcome', 'state_version', 'attempt']),
      ('complete_run_request', ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_outcome', 'p_reason', 'p_error', 'p_not_before'], ARRAY['outcome', 'run_status']),
      ('sweep_expired_leases', ARRAY['p_limit'], ARRAY['requeued', 'retried', 'needs_human', 'dead', 'more'])
    ) AS s(name, sent, read)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name) <> 1 THEN
      RAISE EXCEPTION '% does not have exactly one definition, so PostgREST cannot resolve the deployed call', v_spec.name;
    END IF;
    SELECT p.proargnames, p.proargmodes, p.pronargs, p.pronargdefaults INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name;
    v_args := v_fn.proargnames[1:v_fn.pronargs];
    v_cols := v_fn.proargnames[v_fn.pronargs + 1:];
    IF v_args <> v_spec.sent THEN RAISE EXCEPTION '% takes %, the deployed Worker sends %', v_spec.name, v_args, v_spec.sent; END IF;
    IF NOT (v_cols @> v_spec.read) THEN RAISE EXCEPTION '% answers %, the deployed Worker reads %', v_spec.name, v_cols, v_spec.read; END IF;
  END LOOP;

  -- The deployed Worker never suspends with resource_wait, so its runs carry no
  -- charge, refund or wait: every outcome it can send leaves the counters at zero.
  PERFORM pg_temp.rw_reset();
  v_id := pg_temp.rw_enqueue('00000000-0000-4000-8000-0000000023ab', 'deployed-shape');
  v_tok := pg_temp.rw_claim_start(v_id);
  PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'wake', p_not_before => now());
  v_tok := pg_temp.rw_claim_start(v_id);
  PERFORM public.complete_run_request(v_org, v_id, v_tok, 'retry', p_error => 'partner 503');
  v_tok := pg_temp.rw_claim_start(v_id);
  PERFORM public.complete_run_request(v_org, v_id, v_tok, 'done');
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'done' AND attempts = 3 AND uncharged_attempts = 0
                 AND lapse_refunds = 0 AND resource_wait_since IS NULL AND resource_wait_cause IS NULL) THEN
    RAISE EXCEPTION 'the deployed Worker''s outcomes left %', pg_temp.rw_row(v_id);
  END IF;
  INSERT INTO rw_cases VALUES ('the deployed Worker''s calls resolve to one definition with the names it sends and the columns it reads');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM rw_cases);
BEGIN
  IF v_n <> 9 THEN RAISE EXCEPTION 'run_engine_resource_wait: % of 9 cases ran', v_n; END IF;
  RAISE NOTICE 'run_engine_resource_wait: % cases passed', v_n;
END
$do$;

ROLLBACK;
