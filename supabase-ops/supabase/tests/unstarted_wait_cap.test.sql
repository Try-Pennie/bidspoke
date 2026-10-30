-- A run returned to the queue unstarted is given up after 1 hour of waiting (#3039).
-- Migration 20261030190000_unstarted_wait_cap_3039.sql.
--
-- Since #3023 a run returned unstarted (the ops Worker could not have its
-- definition, definition_unavailable, or its variables, variables_unavailable)
-- spends nothing, so nothing bounded it. Dan's decision of 2026-10-30: such a
-- run is given up after 1 hour of waiting, and ends failed by a named reason.
-- The hour is measured on the database clock from the run's FIRST unstarted
-- return since it last started, never from when it was enqueued.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. each unstarted return is counted (unstarted_returns); the first one of a
--      wait records when the wait began (unstarted_since, the database clock)
--      and the attempts it began at; a later one keeps that time and records
--      the cause it names, the latest return's;
--   2. a return 1 hour or more after the wait began ends the run failed with
--      unstarted_wait_exceeded: terminal, out of the queue, its error naming
--      the cause, the returns and when the wait began; one a second inside the
--      hour goes back to the queue;
--   3. a run that starts just inside the hour starts as any run does, and its
--      next unstarted return begins a new wait from that return, so an old
--      wait never gives up a run that has started since;
--   4. a retry names only an unstarted cause, and a cause on the retry of a
--      run that started is neither counted nor recorded;
--   5. unstarted_run_waits answers, per workflow, the runs whose wait has
--      lasted at least the minimum asked, the oldest wait's start and length,
--      and the causes, oldest first, at most the limit asked; never a wait a
--      start has ended, nor a run that is no longer waiting;
--   6. the ops Worker deployed when this migration is applied keeps working,
--      and is bounded by it: its return names no cause, is counted with a NULL
--      cause and is given up past the hour all the same; complete_run_request
--      keeps its one definition, its arguments and its answer; both functions
--      are SECURITY DEFINER with a fixed search_path and executable by
--      service_role alone, and the read is STABLE;
--   7. the migration wrote nothing to existing rows: a run enqueued before any
--      return reads 0 returns and no wait.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE uw_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.uw_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.uw_enqueue(p_key text, p_max_attempts integer DEFAULT 3, p_workflow uuid DEFAULT '00000000-0000-4000-8000-0000000030d1')
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000003039', p_workflow_id => p_workflow, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- Claim the one run (due now); answers the claim token.
CREATE FUNCTION pg_temp.uw_claim(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_tok uuid;
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT c.claim_token INTO v_tok FROM public.claim_run_requests('uw-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF v_tok IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  RETURN v_tok;
END
$f$;

CREATE FUNCTION pg_temp.uw_start(p_id uuid, p_tok uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000003039', p_id, p_tok, gen_random_uuid());
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
END
$f$;

-- Complete the claim; answers outcome:run_status.
CREATE FUNCTION pg_temp.uw_complete(p_id uuid, p_tok uuid, p_outcome text, p_reason text DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS text LANGUAGE sql AS $f$
  SELECT c.outcome || ':' || c.run_status FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003039', p_id, p_tok, p_outcome,
    p_reason => p_reason, p_error => p_error, p_not_before => now() + interval '1 minute') c;
$f$;

-- The return the Worker sends for a claimed run it could not start, naming why.
CREATE FUNCTION pg_temp.uw_return(p_id uuid, p_tok uuid, p_cause text DEFAULT 'definition_unavailable') RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.uw_complete(p_id, p_tok, 'retry', p_cause, 'the run''s definition could not be had');
$f$;

-- Moves the run's wait back in time, as the clock passing would.
CREATE FUNCTION pg_temp.uw_waited(p_id uuid, p_for interval) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.run_requests SET unstarted_since = now() - p_for WHERE id = p_id;
$f$;

CREATE FUNCTION pg_temp.uw_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. each return counted; the wait's start kept from its first ─────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.uw_reset();
  v_id := pg_temp.uw_enqueue('counted');
  v_tok := pg_temp.uw_claim(v_id);
  IF pg_temp.uw_return(v_id, v_tok, 'variables_unavailable') <> 'completed:queued' THEN RAISE EXCEPTION 'the first return left %', pg_temp.uw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND unstarted_returns = 1 AND unstarted_since = now()
                 AND unstarted_since_attempts = 0 AND unstarted_cause = 'variables_unavailable') THEN
    RAISE EXCEPTION 'the first return recorded %', pg_temp.uw_row(v_id);
  END IF;

  -- Twenty minutes later (as the clock reads it), returned again for its definition.
  PERFORM pg_temp.uw_waited(v_id, interval '20 minutes');
  v_tok := pg_temp.uw_claim(v_id);
  IF pg_temp.uw_return(v_id, v_tok, 'definition_unavailable') <> 'completed:queued' THEN RAISE EXCEPTION 'the second return left %', pg_temp.uw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND unstarted_returns = 2
                 AND unstarted_since = now() - interval '20 minutes' AND unstarted_since_attempts = 0 AND unstarted_cause = 'definition_unavailable') THEN
    RAISE EXCEPTION 'the second return recorded %', pg_temp.uw_row(v_id);
  END IF;
  INSERT INTO uw_cases VALUES ('each unstarted return is counted, the wait keeps its first return''s time, and the latest cause is recorded');
END
$do$;

-- ── 2. a return past the hour gives the run up; one inside it does not ───────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_ans text;
BEGIN
  PERFORM pg_temp.uw_reset();
  v_id := pg_temp.uw_enqueue('inside-the-hour');
  v_tok := pg_temp.uw_claim(v_id);
  PERFORM pg_temp.uw_return(v_id, v_tok);
  PERFORM pg_temp.uw_waited(v_id, interval '59 minutes 59 seconds');
  v_tok := pg_temp.uw_claim(v_id);
  IF pg_temp.uw_return(v_id, v_tok) <> 'completed:queued' THEN RAISE EXCEPTION 'a return a second inside the hour left %', pg_temp.uw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a return inside the hour left the run out of the queue'; END IF;

  v_id := pg_temp.uw_enqueue('past-the-hour');
  v_tok := pg_temp.uw_claim(v_id);
  PERFORM pg_temp.uw_return(v_id, v_tok);
  v_tok := pg_temp.uw_claim(v_id);
  PERFORM pg_temp.uw_return(v_id, v_tok);
  PERFORM pg_temp.uw_waited(v_id, interval '1 hour');
  v_tok := pg_temp.uw_claim(v_id);
  v_ans := pg_temp.uw_return(v_id, v_tok);
  IF v_ans <> 'completed:failed' THEN RAISE EXCEPTION 'a return an hour into the wait answered % and left %', v_ans, pg_temp.uw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'unstarted_wait_exceeded'
                 AND terminal_at = now() AND claim_expires_at IS NULL AND unstarted_returns = 3 AND attempts = 0
                 AND last_error LIKE 'unstarted_wait_exceeded: the run''s definition could not be had (definition_unavailable). The run was returned to the queue unstarted 3 times since %, and a run may wait at most 60 minutes to start') THEN
    RAISE EXCEPTION 'a run given up is %', pg_temp.uw_row(v_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a run given up was left in the queue'; END IF;
  INSERT INTO uw_cases VALUES ('a return an hour into the wait ends the run failed with unstarted_wait_exceeded, and one a second inside it does not');
END
$do$;

-- ── 3. a start inside the hour ends the wait ─────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.uw_reset();
  v_id := pg_temp.uw_enqueue('started-inside-the-hour', 3);
  v_tok := pg_temp.uw_claim(v_id);
  PERFORM pg_temp.uw_return(v_id, v_tok);
  PERFORM pg_temp.uw_waited(v_id, interval '59 minutes 59 seconds');
  -- Claimed and started a second inside the hour: it runs as any run does.
  v_tok := pg_temp.uw_claim(v_id);
  PERFORM pg_temp.uw_start(v_id, v_tok);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'running' AND attempts = 1) THEN
    RAISE EXCEPTION 'a run claimed inside the hour did not start: %', pg_temp.uw_row(v_id);
  END IF;
  -- It fails and is retried; an hour on, its old wait is two hours old.
  IF pg_temp.uw_complete(v_id, v_tok, 'retry', p_error => 'the step answered 500') <> 'completed:queued' THEN RAISE EXCEPTION 'the retry left %', pg_temp.uw_row(v_id); END IF;
  PERFORM pg_temp.uw_waited(v_id, interval '2 hours');
  -- Its next return begins a new wait: the old one ended when it started.
  v_tok := pg_temp.uw_claim(v_id);
  IF pg_temp.uw_return(v_id, v_tok) <> 'completed:queued' THEN RAISE EXCEPTION 'a return after a start was judged by the old wait: %', pg_temp.uw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND unstarted_since = now() AND unstarted_since_attempts = 1 AND unstarted_returns = 2) THEN
    RAISE EXCEPTION 'a return after a start did not begin a new wait: %', pg_temp.uw_row(v_id);
  END IF;
  INSERT INTO uw_cases VALUES ('a run that starts inside the hour runs, and its next unstarted return begins a new wait');
END
$do$;

-- ── 4. the causes a retry may name ───────────────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_refused boolean := false;
BEGIN
  PERFORM pg_temp.uw_reset();
  v_id := pg_temp.uw_enqueue('named-causes');
  v_tok := pg_temp.uw_claim(v_id);
  BEGIN
    PERFORM pg_temp.uw_return(v_id, v_tok, 'workflow_inactive');
  EXCEPTION WHEN invalid_parameter_value THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a retry naming workflow_inactive was taken: %', pg_temp.uw_row(v_id); END IF;

  -- A cause on the retry of a run that started: neither counted nor recorded.
  PERFORM pg_temp.uw_start(v_id, v_tok);
  IF pg_temp.uw_complete(v_id, v_tok, 'retry', 'definition_unavailable', 'odd') <> 'completed:queued' THEN RAISE EXCEPTION 'the retry of a started run left %', pg_temp.uw_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND unstarted_returns = 0 AND unstarted_since IS NULL AND unstarted_cause IS NULL) THEN
    RAISE EXCEPTION 'the retry of a started run was counted as unstarted: %', pg_temp.uw_row(v_id);
  END IF;
  INSERT INTO uw_cases VALUES ('a retry names only an unstarted cause, and one on a started run is not counted');
END
$do$;

-- ── 5. unstarted_run_waits ───────────────────────────────────────────────────
DO $do$
DECLARE
  v_a uuid := '00000000-0000-4000-8000-0000000030d1';
  v_b uuid := '00000000-0000-4000-8000-0000000030d2';
  v_c uuid := '00000000-0000-4000-8000-0000000030d3';
  v_id uuid;
  v_tok uuid;
  w record;
  v_n integer;
  v_refused boolean;
BEGIN
  PERFORM pg_temp.uw_reset();
  -- Workflow A: two runs past 15 minutes (20 and 40), one at 5, for both causes.
  v_id := pg_temp.uw_enqueue('a-40', 3, v_a); v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok, 'definition_unavailable'); PERFORM pg_temp.uw_waited(v_id, interval '40 minutes');
  v_id := pg_temp.uw_enqueue('a-20', 3, v_a); v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok, 'variables_unavailable'); PERFORM pg_temp.uw_waited(v_id, interval '20 minutes');
  v_id := pg_temp.uw_enqueue('a-5', 3, v_a); v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok, 'definition_unavailable'); PERFORM pg_temp.uw_waited(v_id, interval '5 minutes');
  -- Workflow B: one run at 50 minutes, still claimed again (waiting all the same).
  v_id := pg_temp.uw_enqueue('b-50', 3, v_b); v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok, 'variables_unavailable'); PERFORM pg_temp.uw_waited(v_id, interval '50 minutes');
  v_tok := pg_temp.uw_claim(v_id);
  -- Workflow C: a run whose wait a start ended (running now), and one given up: neither is waiting.
  v_id := pg_temp.uw_enqueue('c-started', 3, v_c); v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok); PERFORM pg_temp.uw_waited(v_id, interval '30 minutes');
  v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_start(v_id, v_tok);
  v_id := pg_temp.uw_enqueue('c-given-up', 3, v_c); v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok); PERFORM pg_temp.uw_waited(v_id, interval '61 minutes');
  v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok);
  -- And one queued again after a start with an old wait (the lease sweep's path): its wait ended at the start.
  v_id := pg_temp.uw_enqueue('c-stale', 3, v_c); v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_return(v_id, v_tok); PERFORM pg_temp.uw_waited(v_id, interval '30 minutes');
  v_tok := pg_temp.uw_claim(v_id); PERFORM pg_temp.uw_start(v_id, v_tok); PERFORM pg_temp.uw_complete(v_id, v_tok, 'retry', p_error => 'a step failed');

  SELECT count(*) INTO v_n FROM public.unstarted_run_waits(900, 100);
  IF v_n <> 2 THEN RAISE EXCEPTION 'unstarted_run_waits answered % workflows, not A and B: %', v_n, (SELECT json_agg(x) FROM public.unstarted_run_waits(900, 100) x); END IF;
  SELECT * INTO w FROM public.unstarted_run_waits(900, 100) LIMIT 1;
  IF w.workflow_id <> v_b OR w.organization_id <> 'aaaaaaaa-0000-4000-8000-000000003039' OR w.runs <> 1 OR w.oldest_since <> now() - interval '50 minutes'
     OR w.waited_seconds <> 3000 OR w.causes <> ARRAY['variables_unavailable'] THEN
    RAISE EXCEPTION 'the oldest wait first was not B''s: %', row_to_json(w);
  END IF;
  SELECT * INTO w FROM public.unstarted_run_waits(900, 100) OFFSET 1;
  IF w.workflow_id <> v_a OR w.runs <> 2 OR w.oldest_since <> now() - interval '40 minutes' OR w.waited_seconds <> 2400
     OR w.causes <> ARRAY['definition_unavailable', 'variables_unavailable'] THEN
    RAISE EXCEPTION 'A''s waits read %', row_to_json(w);
  END IF;
  -- The limit, and a lower minimum taking in the 5 minute wait.
  IF (SELECT count(*) FROM public.unstarted_run_waits(900, 1)) <> 1 THEN RAISE EXCEPTION 'the limit was not held'; END IF;
  IF (SELECT runs FROM public.unstarted_run_waits(0, 100) WHERE workflow_id = v_a) <> 3 THEN RAISE EXCEPTION 'a minimum of 0 did not count every waiting run'; END IF;

  FOR w IN SELECT * FROM (VALUES (900, 0), (900, 1001), (-1, 10), (NULL::integer, 10)) AS t(min_wait, lim) LOOP
    v_refused := false;
    BEGIN
      PERFORM * FROM public.unstarted_run_waits(w.min_wait, w.lim);
    EXCEPTION WHEN invalid_parameter_value THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'unstarted_run_waits(%, %) was not refused', w.min_wait, w.lim; END IF;
  END LOOP;
  INSERT INTO uw_cases VALUES ('unstarted_run_waits answers each workflow''s waits past the minimum, oldest first, and no wait that ended');
END
$do$;

-- ── 6. the Worker deployed when this is applied ──────────────────────────────
-- What apps/worker/src/ops/ops-writes.ts on main at f041892d4 (the code running
-- when this migration is applied) sends and reads, copied from it: a retry
-- with no p_reason.
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_fn record;
  v_proc regprocedure;
  v_sent text[] := ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_outcome', 'p_reason', 'p_error', 'p_not_before', 'p_step', 'p_status'];
  v_read text[] := ARRAY['outcome', 'run_status'];
  v_name text;
BEGIN
  PERFORM pg_temp.uw_reset();
  v_id := pg_temp.uw_enqueue('deployed-worker');
  v_tok := pg_temp.uw_claim(v_id);
  IF pg_temp.uw_complete(v_id, v_tok, 'retry', p_error => 'the run''s definition could not be had') <> 'completed:queued' THEN
    RAISE EXCEPTION 'the deployed Worker''s return left %', pg_temp.uw_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND unstarted_returns = 1 AND unstarted_since = now() AND unstarted_cause IS NULL) THEN
    RAISE EXCEPTION 'the deployed Worker''s return was not counted: %', pg_temp.uw_row(v_id);
  END IF;
  PERFORM pg_temp.uw_waited(v_id, interval '61 minutes');
  v_tok := pg_temp.uw_claim(v_id);
  IF pg_temp.uw_complete(v_id, v_tok, 'retry', p_error => 'the run''s definition could not be had') <> 'completed:failed' THEN
    RAISE EXCEPTION 'the deployed Worker''s return past the hour left %', pg_temp.uw_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status_reason = 'unstarted_wait_exceeded'
                 AND last_error LIKE 'unstarted_wait_exceeded: the run''s definition could not be had (no cause named). %') THEN
    RAISE EXCEPTION 'the deployed Worker''s run given up is %', pg_temp.uw_row(v_id);
  END IF;

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

  FOREACH v_name IN ARRAY ARRAY['complete_run_request', 'unstarted_run_waits'] LOOP
    SELECT p.oid::regprocedure INTO v_proc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_proc) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_proc; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_proc AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_proc; END IF;
    IF NOT has_function_privilege('service_role', v_proc, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_proc; END IF;
    IF has_function_privilege('anon', v_proc, 'EXECUTE') OR has_function_privilege('authenticated', v_proc, 'EXECUTE') OR has_function_privilege('public', v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_proc;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'unstarted_run_waits') <> 's' THEN
    RAISE EXCEPTION 'unstarted_run_waits is not STABLE';
  END IF;
  INSERT INTO uw_cases VALUES ('the deployed Worker''s return is counted and capped, and both functions are service_role''s alone');
END
$do$;

-- ── 7. nothing written to existing rows ──────────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_temp.uw_reset();
  v_id := pg_temp.uw_enqueue('never-returned');
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND unstarted_returns = 0 AND unstarted_since IS NULL
                 AND unstarted_since_attempts IS NULL AND unstarted_cause IS NULL) THEN
    RAISE EXCEPTION 'a run never returned reads %', pg_temp.uw_row(v_id);
  END IF;
  INSERT INTO uw_cases VALUES ('a run never returned reads no returns and no wait');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM uw_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'unstarted_wait_cap: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'unstarted_wait_cap: % cases passed', v_n;
END
$do$;

ROLLBACK;
