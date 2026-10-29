-- A run returned to the queue before it starts is never out of attempts (#3023).
-- Migration 20261029230000_unstarted_return_3023.sql.
--
-- The ops Worker returns a run it has claimed but not started to the queue with
-- the outcome retry when it cannot have the run's definition
-- (definition_unavailable, run-live.ts) or its variables
-- (runs_variables_unavailable, tick.ts). Nothing ran under that claim, so the
-- return must spend no attempt, now or later: it is never judged against
-- max_attempts, and it leaves the run as the claim found it, so the start that
-- follows is charged exactly as it would have been without the return.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a run whose charged attempts already equal max_attempts, claimed after a
--      resource wait, is returned to the queue by a retry from claimed, never
--      ended dead as max_attempts, however many times it is returned; it keeps
--      its resume reason and its wait, and its next start is not charged;
--   2. the same for a run claimed to continue: it stays a continuation, so its
--      next start is not charged and still answers its continuations;
--   3. a run returned before its first start becomes a retry (never NULL, for
--      the overlap queue index), spends nothing, and its start is charged as a
--      first start always is;
--   4. a started run at max_attempts still ends dead as max_attempts, whether
--      it started charged or resumed from a wait, and a return before the start
--      does not hide that bound;
--   5. the other outcomes from a claimed run are unchanged: dead ends it dead by
--      its reason, failed ends it failed;
--   6. the ops Worker deployed when this migration is applied keeps working:
--      one definition of complete_run_request, the arguments it sends and the
--      columns it reads; it is SECURITY DEFINER with a fixed search_path and
--      executable by service_role alone.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE ur_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.ur_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.ur_enqueue(p_key text, p_max_attempts integer)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000003023', p_workflow_id => '00000000-0000-4000-8000-0000000030c1', p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- Claim the one run (due now); answers the claim token.
CREATE FUNCTION pg_temp.ur_claim(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_tok uuid;
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT c.claim_token INTO v_tok FROM public.claim_run_requests('ur-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF v_tok IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  RETURN v_tok;
END
$f$;

-- Start the claimed run; answers the continuations the start answered.
CREATE FUNCTION pg_temp.ur_start(p_id uuid, p_tok uuid) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000003023', p_id, p_tok, gen_random_uuid());
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  RETURN s.continuations;
END
$f$;

-- Complete the claim; answers outcome:run_status.
CREATE FUNCTION pg_temp.ur_complete(p_id uuid, p_tok uuid, p_outcome text, p_reason text DEFAULT NULL, p_error text DEFAULT NULL, p_not_before timestamptz DEFAULT NULL)
RETURNS text LANGUAGE sql AS $f$
  SELECT c.outcome || ':' || c.run_status FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003023', p_id, p_tok, p_outcome,
    p_reason => p_reason, p_error => p_error, p_not_before => p_not_before) c;
$f$;

-- The return the Worker sends for a claimed run it could not start.
CREATE FUNCTION pg_temp.ur_return(p_id uuid, p_tok uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.ur_complete(p_id, p_tok, 'retry', p_error => 'the run''s definition could not be had', p_not_before => now() + interval '1 minute');
$f$;

CREATE FUNCTION pg_temp.ur_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. a run at max_attempts claimed after a resource wait ───────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_since timestamptz;
  v_i integer;
  v_ans text;
BEGIN
  PERFORM pg_temp.ur_reset();
  v_id := pg_temp.ur_enqueue('waited-then-returned', 1);
  v_tok := pg_temp.ur_claim(v_id);
  PERFORM pg_temp.ur_start(v_id, v_tok);                                  -- attempt 1, charged 1 of 1
  IF pg_temp.ur_complete(v_id, v_tok, 'suspend', 'resource_wait', 'pool_full', now()) <> 'completed:suspended' THEN
    RAISE EXCEPTION 'the resource wait did not suspend: %', pg_temp.ur_row(v_id);
  END IF;
  SELECT resource_wait_since INTO v_since FROM public.run_requests WHERE id = v_id;
  IF v_since IS NULL THEN RAISE EXCEPTION 'the wait recorded no start: %', pg_temp.ur_row(v_id); END IF;

  -- Claimed, and returned before its start, three times over.
  FOR v_i IN 1..3 LOOP
    v_tok := pg_temp.ur_claim(v_id);
    v_ans := pg_temp.ur_return(v_id, v_tok);
    IF v_ans <> 'completed:queued' THEN
      RAISE EXCEPTION 'return % of a claimed, never started run at max_attempts answered % and left %', v_i, v_ans, pg_temp.ur_row(v_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND status_reason IS NULL AND terminal_at IS NULL
                   AND attempts = 1 AND uncharged_attempts = 0 AND resume_reason = 'resource_wait'
                   AND resource_wait_since = v_since AND resource_wait_cause = 'pool_full'
                   AND not_before = now() + interval '1 minute' AND claim_expires_at IS NULL
                   AND last_error = 'the run''s definition could not be had') THEN
      RAISE EXCEPTION 'return % left %', v_i, pg_temp.ur_row(v_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id AND not_before = now() + interval '1 minute') THEN
      RAISE EXCEPTION 'return % did not put the run back in the queue', v_i;
    END IF;
  END LOOP;

  -- Its next start resumes the wait, so it is not charged, and it can finish.
  v_tok := pg_temp.ur_claim(v_id);
  PERFORM pg_temp.ur_start(v_id, v_tok);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 2 AND uncharged_attempts = 1) THEN
    RAISE EXCEPTION 'the start after the returns was charged: %', pg_temp.ur_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 2 AND resume_reason = 'resource_wait') THEN
    RAISE EXCEPTION 'the start after the returns did not resume the wait';
  END IF;
  IF pg_temp.ur_complete(v_id, v_tok, 'done') <> 'completed:done' THEN RAISE EXCEPTION 'the run did not end done: %', pg_temp.ur_row(v_id); END IF;
  INSERT INTO ur_cases VALUES ('a run at max_attempts returned unstarted after a wait goes back to the queue, keeps its wait, and its next start is not charged');
END
$do$;

-- ── 2. a run at max_attempts claimed to continue ─────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_exec uuid := gen_random_uuid();
  v_named text;
  v_cont integer;
  s record;
BEGIN
  PERFORM pg_temp.ur_reset();
  v_id := pg_temp.ur_enqueue('continued-then-returned', 1);
  v_tok := pg_temp.ur_claim(v_id);
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000003023', v_id, v_tok, v_exec);   -- attempt 1, charged 1 of 1
  v_named := public.record_run_checkpoint('aaaaaaaa-0000-4000-8000-000000003023', v_id, v_tok, v_exec, s.state_version, 2,
    format('checkpoints/v1/%s/%s/%s-%s.json', 'aaaaaaaa-0000-4000-8000-000000003023', v_id, s.state_version, 2), repeat('c', 64), 900);
  IF v_named <> 'recorded' THEN RAISE EXCEPTION 'the holder could not name its checkpoint: %', v_named; END IF;
  IF pg_temp.ur_complete(v_id, v_tok, 'suspend', 'continue', NULL, now()) <> 'completed:suspended' THEN
    RAISE EXCEPTION 'the continue did not suspend: %', pg_temp.ur_row(v_id);
  END IF;

  v_tok := pg_temp.ur_claim(v_id);
  IF pg_temp.ur_return(v_id, v_tok) <> 'completed:queued' THEN
    RAISE EXCEPTION 'a claimed, never started continuation at max_attempts was not returned to the queue: %', pg_temp.ur_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND resume_reason = 'continue' AND continuations = 1
                 AND attempts = 1 AND uncharged_attempts = 0 AND checkpoint_steps = 2) THEN
    RAISE EXCEPTION 'the returned continuation is %', pg_temp.ur_row(v_id);
  END IF;

  v_tok := pg_temp.ur_claim(v_id);
  v_cont := pg_temp.ur_start(v_id, v_tok);
  IF v_cont <> 1 THEN RAISE EXCEPTION 'the start after the return answered % continuations, so it would start from its first step', v_cont; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 2 AND uncharged_attempts = 1) THEN
    RAISE EXCEPTION 'the continuation''s start after the return was charged: %', pg_temp.ur_row(v_id);
  END IF;
  INSERT INTO ur_cases VALUES ('a continuation at max_attempts returned unstarted stays a continuation, and its next start is not charged');
END
$do$;

-- ── 3. a run returned before its first start ─────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.ur_reset();
  v_id := pg_temp.ur_enqueue('never-started', 1);
  v_tok := pg_temp.ur_claim(v_id);
  IF pg_temp.ur_return(v_id, v_tok) <> 'completed:queued' THEN RAISE EXCEPTION 'a first claim returned unstarted left %', pg_temp.ur_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND resume_reason = 'retry' AND attempts = 0 AND uncharged_attempts = 0
                 AND resource_wait_since IS NULL AND resource_wait_cause IS NULL) THEN
    RAISE EXCEPTION 'a first claim returned unstarted is %', pg_temp.ur_row(v_id);
  END IF;
  v_tok := pg_temp.ur_claim(v_id);
  PERFORM pg_temp.ur_start(v_id, v_tok);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 1 AND uncharged_attempts = 0) THEN
    RAISE EXCEPTION 'a first start after a return was not charged: %', pg_temp.ur_row(v_id);
  END IF;
  INSERT INTO ur_cases VALUES ('a run returned before its first start becomes a retry, spends nothing, and its first start is charged');
END
$do$;

-- ── 4. a started run at max_attempts still ends dead ─────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  -- Started charged, at max: dead.
  PERFORM pg_temp.ur_reset();
  v_id := pg_temp.ur_enqueue('started-at-max', 1);
  v_tok := pg_temp.ur_claim(v_id);
  PERFORM pg_temp.ur_start(v_id, v_tok);
  IF pg_temp.ur_complete(v_id, v_tok, 'retry', p_error => 'partner 503') <> 'completed:dead' THEN
    RAISE EXCEPTION 'a started run at max_attempts was not ended: %', pg_temp.ur_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'dead' AND status_reason = 'max_attempts' AND terminal_at = now()) THEN
    RAISE EXCEPTION 'a started run at max_attempts is %', pg_temp.ur_row(v_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a dead run is still queued'; END IF;

  -- Started from a wait (uncharged) whose charged attempts are at max, after a
  -- return before that start: the retry still ends it dead.
  v_id := pg_temp.ur_enqueue('waited-returned-started', 1);
  v_tok := pg_temp.ur_claim(v_id);
  PERFORM pg_temp.ur_start(v_id, v_tok);
  PERFORM pg_temp.ur_complete(v_id, v_tok, 'suspend', 'resource_wait', 'pool_full', now());
  v_tok := pg_temp.ur_claim(v_id);
  PERFORM pg_temp.ur_return(v_id, v_tok);
  v_tok := pg_temp.ur_claim(v_id);
  PERFORM pg_temp.ur_start(v_id, v_tok);
  IF pg_temp.ur_complete(v_id, v_tok, 'retry', p_error => 'partner 503') <> 'completed:dead' THEN
    RAISE EXCEPTION 'a run that started from a wait at max_attempts was not ended: %', pg_temp.ur_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'dead' AND status_reason = 'max_attempts' AND attempts = 2 AND uncharged_attempts = 1) THEN
    RAISE EXCEPTION 'a run that started from a wait at max_attempts is %', pg_temp.ur_row(v_id);
  END IF;
  INSERT INTO ur_cases VALUES ('a started run at max_attempts still ends dead as max_attempts, a return before its start notwithstanding');
END
$do$;

-- ── 5. the other outcomes from a claimed run are unchanged ───────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.ur_reset();
  v_id := pg_temp.ur_enqueue('claimed-then-ended', 1);
  v_tok := pg_temp.ur_claim(v_id);
  IF pg_temp.ur_complete(v_id, v_tok, 'dead', 'workflow_inactive') <> 'completed:dead' THEN RAISE EXCEPTION 'a claimed run ended dead left %', pg_temp.ur_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'dead' AND status_reason = 'workflow_inactive' AND terminal_at = now()) THEN
    RAISE EXCEPTION 'a claimed run ended dead is %', pg_temp.ur_row(v_id);
  END IF;

  v_id := pg_temp.ur_enqueue('claimed-then-failed', 1);
  v_tok := pg_temp.ur_claim(v_id);
  IF pg_temp.ur_complete(v_id, v_tok, 'failed', p_error => 'refused') <> 'completed:failed' THEN RAISE EXCEPTION 'a claimed run ended failed left %', pg_temp.ur_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason IS NULL AND terminal_at = now()) THEN
    RAISE EXCEPTION 'a claimed run ended failed is %', pg_temp.ur_row(v_id);
  END IF;
  INSERT INTO ur_cases VALUES ('dead and failed from a claimed run end it as they always did');
END
$do$;

-- ── 6. the Worker deployed when this is applied keeps working ────────────────
-- What apps/worker/src/ops/ops-writes.ts on main at 7249d119a (the code running
-- when this migration is applied) sends and reads, copied from it.
DO $do$
DECLARE
  v_fn record;
  v_proc regprocedure;
  v_sent text[] := ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_outcome', 'p_reason', 'p_error', 'p_not_before', 'p_step', 'p_status'];
  v_read text[] := ARRAY['outcome', 'run_status'];
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'complete_run_request') <> 1 THEN
    RAISE EXCEPTION 'complete_run_request does not have exactly one definition, so PostgREST cannot resolve the deployed call';
  END IF;
  SELECT p.oid::regprocedure AS oid, p.proargnames, p.pronargs, p.pronargdefaults INTO v_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'complete_run_request';
  IF v_fn.proargnames[1:v_fn.pronargs] <> v_sent OR v_fn.pronargdefaults <> 5 THEN
    RAISE EXCEPTION 'complete_run_request takes % (% defaulted), the deployed Worker sends %', v_fn.proargnames[1:v_fn.pronargs], v_fn.pronargdefaults, v_sent;
  END IF;
  IF NOT (v_fn.proargnames[v_fn.pronargs + 1:] @> v_read) THEN
    RAISE EXCEPTION 'complete_run_request answers %, the deployed Worker reads %', v_fn.proargnames[v_fn.pronargs + 1:], v_read;
  END IF;
  v_proc := v_fn.oid;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_proc) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_proc; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_proc AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_proc; END IF;
  IF NOT has_function_privilege('service_role', v_proc, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_proc; END IF;
  IF has_function_privilege('anon', v_proc, 'EXECUTE') OR has_function_privilege('authenticated', v_proc, 'EXECUTE') OR has_function_privilege('public', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute %', v_proc;
  END IF;
  INSERT INTO ur_cases VALUES ('complete_run_request keeps its one definition, the deployed Worker''s arguments and answer, and service_role alone');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM ur_cases);
BEGIN
  IF v_n <> 6 THEN RAISE EXCEPTION 'unstarted_return: % of 6 cases ran', v_n; END IF;
  RAISE NOTICE 'unstarted_return: % cases passed', v_n;
END
$do$;

ROLLBACK;
