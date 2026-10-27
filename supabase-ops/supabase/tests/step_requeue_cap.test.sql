-- The requeue cap (#2859): a service asking a step to wait (a 429, a 503 with
-- Retry-After) suspends the run as a rate_limit_wait, which spends no retry
-- attempt (#1693 7.4), and one step of one run may wait at most 10 times, none
-- waking more than 6 hours after its first, before the run ends failed with
-- requeue_cap_reached, named with what the service last said.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a rate limit wait suspends the run, records the step's wait, and the
--      start it resumes into is not charged;
--   2. a step that keeps being asked to wait is suspended 10 times and the 11th
--      wait ends the run failed with requeue_cap_reached, its last_error and
--      execution error naming the step's request, the status, the time asked
--      and the cap, never dead at max_attempts (the run has max_attempts 1);
--   3. a wait waking more than 6 hours after the step's first ends it the same
--      way, and one waking exactly 6 hours after does not;
--   4. the count is per step and survives every other outcome: two steps
--      refused in turn each keep their own count, and a retry between their
--      waits clears neither;
--   5. a rate limit wait names its step, wake time, request and a real status,
--      p_step and p_status belong to it alone, and a holder cannot fail a run
--      with requeue_cap_reached (F122);
--   6. an attempt resumed from a rate limit wait that lapses with no send is
--      not refunded twice;
--   7. the ops Worker deployed before this migration keeps working: one
--      definition of complete_run_request, its first arguments the ones that
--      Worker sends and every one after them defaulted, and its outcomes leave
--      no step wait behind.
--
-- TIME. now() is fixed inside a transaction, so time passing is simulated by
-- moving a row's own timestamps back as the table owner; no case sleeps.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE rq_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.rq_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.rq_enqueue(p_workflow uuid, p_key text, p_max_attempts integer DEFAULT 3)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000002859', p_workflow_id => p_workflow, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- Claim the one due run and start it. Returns the claim token.
CREATE FUNCTION pg_temp.rq_claim_start(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  r record;
  s record;
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT * INTO r FROM public.claim_run_requests('rq-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF r.run_request_id IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000002859', p_id, r.claim_token, gen_random_uuid());
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  RETURN r.claim_token;
END
$f$;

-- A rate limit wait of one step, as the Worker sends it.
CREATE FUNCTION pg_temp.rq_wait(p_id uuid, p_token uuid, p_step text DEFAULT 'notify', p_status integer DEFAULT 429,
  p_not_before timestamptz DEFAULT now() + interval '1 minute') RETURNS text LANGUAGE sql AS $f$
  SELECT run_status FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000002859', p_id, p_token, 'suspend',
    p_reason => 'rate_limit_wait', p_step => p_step, p_status => p_status, p_not_before => p_not_before,
    p_error => format('step %s (POST quota.example.com): rate_limited, answered %s, asked to wait until %s', p_step, p_status, p_not_before));
$f$;

CREATE FUNCTION pg_temp.rq_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. a wait suspends, is recorded against its step, and charges nothing ─────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.rq_reset();
  v_id := pg_temp.rq_enqueue('00000000-0000-4000-8000-000000002891', 'one-wait');
  v_tok := pg_temp.rq_claim_start(v_id);
  IF pg_temp.rq_wait(v_id, v_tok) <> 'suspended' THEN RAISE EXCEPTION 'a rate limit wait left %', pg_temp.rq_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'suspended' AND resume_reason = 'rate_limit_wait'
                 AND status_reason IS NULL AND not_before = now() + interval '1 minute' AND claim_expires_at IS NULL
                 AND (requeue_steps -> 'notify' ->> 'requeues')::integer = 1 AND (requeue_steps -> 'notify' ->> 'since')::timestamptz = now()
                 AND (requeue_steps -> 'notify' ->> 'last_status')::integer = 429
                 AND (requeue_steps -> 'notify' ->> 'last_not_before')::timestamptz = now() + interval '1 minute') THEN
    RAISE EXCEPTION 'the waiting run is %', pg_temp.rq_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 1 AND status = 'suspended'
                 AND error LIKE 'step notify (POST quota.example.com): rate_limited, answered 429%') THEN
    RAISE EXCEPTION 'the waiting attempt was not left suspended with what was asked';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a waiting run is not queued'; END IF;
  v_tok := pg_temp.rq_claim_start(v_id);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 2 AND uncharged_attempts = 1) THEN
    RAISE EXCEPTION 'the start resumed from a rate limit wait was charged: %', pg_temp.rq_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 2 AND status = 'running' AND resume_reason = 'rate_limit_wait') THEN
    RAISE EXCEPTION 'the resumed execution is not attempt 2 resumed by rate_limit_wait';
  END IF;
  INSERT INTO rq_cases VALUES ('a rate limit wait suspends, is recorded against its step, and its start is not charged');
END
$do$;

-- ── 2. the eleventh wait of one step ends the run by name ─────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_i integer;
  v_status text;
  v_err text;
BEGIN
  PERFORM pg_temp.rq_reset();
  -- max_attempts 1: a wait that spent an attempt would end the run dead at the second.
  v_id := pg_temp.rq_enqueue('00000000-0000-4000-8000-000000002892', 'never-clears', 1);
  v_tok := pg_temp.rq_claim_start(v_id);
  FOR v_i IN 1..10 LOOP
    v_status := pg_temp.rq_wait(v_id, v_tok);
    IF v_status <> 'suspended' THEN RAISE EXCEPTION 'wait % ended the run: %', v_i, pg_temp.rq_row(v_id); END IF;
    v_tok := pg_temp.rq_claim_start(v_id);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 11 AND uncharged_attempts = 10
                 AND (requeue_steps -> 'notify' ->> 'requeues')::integer = 10) THEN
    RAISE EXCEPTION 'after ten waits the run is %', pg_temp.rq_row(v_id);
  END IF;
  v_status := pg_temp.rq_wait(v_id, v_tok, p_status => 503);
  IF v_status <> 'failed' THEN RAISE EXCEPTION 'the eleventh wait of one step left the run %: %', v_status, pg_temp.rq_row(v_id); END IF;
  SELECT last_error INTO v_err FROM public.run_requests WHERE id = v_id;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'requeue_cap_reached'
                 AND terminal_at = now() AND claim_expires_at IS NULL AND (requeue_steps -> 'notify' ->> 'requeues')::integer = 10) THEN
    RAISE EXCEPTION 'the run stopped at the cap is %', pg_temp.rq_row(v_id);
  END IF;
  IF v_err NOT LIKE 'requeue_cap_reached: step notify (POST quota.example.com): rate_limited, answered 503, asked to wait until %'
     OR v_err NOT LIKE '%waited 10 times since %' OR v_err NOT LIKE '%at most 10 times, none waking more than 6 hours after its first' THEN
    RAISE EXCEPTION 'the cap''s error does not name the request, the status, the time and the cap: %', v_err;
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN RAISE EXCEPTION 'a run stopped at the cap is still queued'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 11 AND status = 'failed' AND error = v_err) THEN
    RAISE EXCEPTION 'the last attempt of a run stopped at the cap was not ended failed with its error';
  END IF;
  INSERT INTO rq_cases VALUES ('a step asked to wait an eleventh time ends the run failed with requeue_cap_reached, never dead at max_attempts');
END
$do$;

-- ── 3. a wait waking past 6 hours after the first ends it the same way ───────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.rq_reset();
  v_id := pg_temp.rq_enqueue('00000000-0000-4000-8000-000000002893', 'too-long');
  v_tok := pg_temp.rq_claim_start(v_id);
  PERFORM pg_temp.rq_wait(v_id, v_tok);
  v_tok := pg_temp.rq_claim_start(v_id);
  -- The first wait was 5 hours 59 minutes ago: waking in a minute is exactly 6 hours after it, not past.
  UPDATE public.run_requests SET requeue_steps = jsonb_set(requeue_steps, '{notify,since}', to_jsonb(now() - interval '5 hours 59 minutes')) WHERE id = v_id;
  IF pg_temp.rq_wait(v_id, v_tok) <> 'suspended' THEN RAISE EXCEPTION 'a wait waking exactly 6 hours after the first was ended: %', pg_temp.rq_row(v_id); END IF;
  IF (SELECT (requeue_steps -> 'notify' ->> 'since')::timestamptz FROM public.run_requests WHERE id = v_id) <> now() - interval '5 hours 59 minutes' THEN
    RAISE EXCEPTION 'a later wait restarted the step''s first: %', pg_temp.rq_row(v_id);
  END IF;
  v_tok := pg_temp.rq_claim_start(v_id);
  IF pg_temp.rq_wait(v_id, v_tok, p_not_before => now() + interval '1 minute 1 second') <> 'failed' THEN
    RAISE EXCEPTION 'a wait waking past 6 hours after the first was not ended: %', pg_temp.rq_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'requeue_cap_reached'
                 AND last_error LIKE '%waited 2 times since %' AND terminal_at = now()) THEN
    RAISE EXCEPTION 'the run that waited too long is %', pg_temp.rq_row(v_id);
  END IF;
  INSERT INTO rq_cases VALUES ('a wait waking more than 6 hours after the step''s first ends the run, exactly 6 hours does not');
END
$do$;

-- ── 4. counted per step, and kept through every other outcome ────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002859';
  v_id uuid;
  v_tok uuid;
  v_i integer;
BEGIN
  PERFORM pg_temp.rq_reset();
  v_id := pg_temp.rq_enqueue('00000000-0000-4000-8000-000000002894', 'two-steps', 5);
  v_tok := pg_temp.rq_claim_start(v_id);
  -- Steps a and b refused in turn, ten times each: neither resets the other.
  FOR v_i IN 1..10 LOOP
    IF pg_temp.rq_wait(v_id, v_tok, 'a') <> 'suspended' THEN RAISE EXCEPTION 'a''s wait % ended the run', v_i; END IF;
    v_tok := pg_temp.rq_claim_start(v_id);
    IF pg_temp.rq_wait(v_id, v_tok, 'b') <> 'suspended' THEN RAISE EXCEPTION 'b''s wait % ended the run', v_i; END IF;
    v_tok := pg_temp.rq_claim_start(v_id);
  END LOOP;
  -- A genuine failure between: retried, charged, and the step counts stay.
  IF (SELECT run_status FROM public.complete_run_request(v_org, v_id, v_tok, 'retry', p_error => 'partner 500')) <> 'queued' THEN
    RAISE EXCEPTION 'the retry was refused: %', pg_temp.rq_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND (requeue_steps -> 'a' ->> 'requeues')::integer = 10
                 AND (requeue_steps -> 'b' ->> 'requeues')::integer = 10) THEN
    RAISE EXCEPTION 'a retry cleared the step counts: %', pg_temp.rq_row(v_id);
  END IF;
  v_tok := pg_temp.rq_claim_start(v_id);
  -- A third step still has all its waits; a is out of them.
  IF pg_temp.rq_wait(v_id, v_tok, 'c') <> 'suspended' THEN RAISE EXCEPTION 'a step that never waited was refused its first wait'; END IF;
  v_tok := pg_temp.rq_claim_start(v_id);
  IF pg_temp.rq_wait(v_id, v_tok, 'a') <> 'failed' THEN RAISE EXCEPTION 'a step out of waits was suspended again: %', pg_temp.rq_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status_reason = 'requeue_cap_reached' AND last_error LIKE 'requeue_cap_reached: step a %') THEN
    RAISE EXCEPTION 'the run did not end naming step a: %', pg_temp.rq_row(v_id);
  END IF;
  INSERT INTO rq_cases VALUES ('the cap counts each step apart, and no other outcome clears a step''s count');
END
$do$;

-- ── 5. what a holder may and may not say ─────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002859';
  v_id uuid;
  v_tok uuid;
  v_bad record;
BEGIN
  PERFORM pg_temp.rq_reset();
  v_id := pg_temp.rq_enqueue('00000000-0000-4000-8000-000000002895', 'refusals');
  v_tok := pg_temp.rq_claim_start(v_id);
  FOR v_bad IN
    SELECT * FROM (VALUES
      ('no step', NULL::text, 429, now() + interval '1 minute', 'x'),
      ('an empty step', '', 429, now() + interval '1 minute', 'x'),
      ('a step past 200 characters', repeat('s', 201), 429, now() + interval '1 minute', 'x'),
      ('no wake time', 'notify', 429, NULL::timestamptz, 'x'),
      ('a status that is not one', 'notify', 42, now() + interval '1 minute', 'x'),
      ('nothing said of what was asked', 'notify', 429, now() + interval '1 minute', NULL::text)
    ) AS b(label, step, status, not_before, error)
  LOOP
    BEGIN
      PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'rate_limit_wait',
        p_step => v_bad.step, p_status => v_bad.status, p_not_before => v_bad.not_before, p_error => v_bad.error);
      RAISE EXCEPTION 'a rate limit wait with % was accepted', v_bad.label;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.complete_run_request(v_org, v_id, v_tok, 'retry', p_error => 'x', p_step => 'notify');
    RAISE EXCEPTION 'a retry naming a step was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'wake', p_not_before => now(), p_status => 429);
    RAISE EXCEPTION 'a wake naming a status was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- F122: the engine alone ends a run at the cap.
  BEGIN
    PERFORM public.complete_run_request(v_org, v_id, v_tok, 'failed', p_reason => 'requeue_cap_reached');
    RAISE EXCEPTION 'a holder failed a run with requeue_cap_reached';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'running' AND requeue_steps = '{}'::jsonb) THEN
    RAISE EXCEPTION 'a refused complete changed the run: %', pg_temp.rq_row(v_id);
  END IF;
  -- No request made (a token endpoint 429): a wait with no status is accepted.
  IF pg_temp.rq_wait(v_id, v_tok, p_status => NULL) <> 'suspended' THEN RAISE EXCEPTION 'a wait with no status was refused'; END IF;
  IF (SELECT requeue_steps -> 'notify' -> 'last_status' FROM public.run_requests WHERE id = v_id) <> 'null'::jsonb THEN
    RAISE EXCEPTION 'a wait with no status recorded one: %', pg_temp.rq_row(v_id);
  END IF;
  INSERT INTO rq_cases VALUES ('a rate limit wait names its step, wake time, request and a real status, and only it may');
END
$do$;

-- ── 6. a lapsed attempt resumed from a rate limit wait is not refunded twice ──
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
BEGIN
  PERFORM pg_temp.rq_reset();
  v_id := pg_temp.rq_enqueue('00000000-0000-4000-8000-000000002896', 'wait-then-die');
  v_tok := pg_temp.rq_claim_start(v_id);           -- attempt 1, charged
  PERFORM pg_temp.rq_wait(v_id, v_tok);
  PERFORM pg_temp.rq_claim_start(v_id);            -- attempt 2, a rate_limit_wait start: uncharged
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND attempts = 2 AND uncharged_attempts = 1
                 AND lapse_refunds = 1 AND resume_reason = 'retry' AND (requeue_steps -> 'notify' ->> 'requeues')::integer = 1) THEN
    RAISE EXCEPTION 'an uncharged attempt that lapsed left %', pg_temp.rq_row(v_id);
  END IF;
  INSERT INTO rq_cases VALUES ('an attempt resumed from a rate limit wait that lapses is not refunded twice, and keeps its step count');
END
$do$;

-- ── 7. the Worker deployed before this migration keeps working ────────────────
-- What apps/worker/src/ops/ops-writes.ts on main at a20a7d33 (the code running
-- when this migration is applied) sends complete_run_request, copied from it.
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002859';
  v_sent text[] := ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_outcome', 'p_reason', 'p_error', 'p_not_before'];
  v_fn record;
  v_id uuid;
  v_tok uuid;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'complete_run_request') <> 1 THEN
    RAISE EXCEPTION 'complete_run_request does not have exactly one definition, so PostgREST cannot resolve the deployed call';
  END IF;
  SELECT p.proargnames, p.pronargs, p.pronargdefaults INTO v_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'complete_run_request';
  IF v_fn.proargnames[1:array_length(v_sent, 1)] <> v_sent THEN
    RAISE EXCEPTION 'complete_run_request takes %, the deployed Worker sends %', v_fn.proargnames[1:v_fn.pronargs], v_sent;
  END IF;
  IF v_fn.proargnames[array_length(v_sent, 1) + 1:v_fn.pronargs] <> ARRAY['p_step', 'p_status'] OR v_fn.pronargdefaults < v_fn.pronargs - 4 THEN
    RAISE EXCEPTION 'complete_run_request''s arguments after the deployed ones are % with % defaults', v_fn.proargnames[1:v_fn.pronargs], v_fn.pronargdefaults;
  END IF;

  -- Every outcome the deployed Worker sends, a 429's charged retry included, leaves no step wait behind.
  PERFORM pg_temp.rq_reset();
  v_id := pg_temp.rq_enqueue('00000000-0000-4000-8000-000000002897', 'deployed-shape');
  v_tok := pg_temp.rq_claim_start(v_id);
  PERFORM public.complete_run_request(v_org, v_id, v_tok, 'retry', p_error => 'step post: rate_limited', p_not_before => now() + interval '1 minute');
  v_tok := pg_temp.rq_claim_start(v_id);
  PERFORM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'resource_wait', p_error => 'pool_full', p_not_before => now());
  v_tok := pg_temp.rq_claim_start(v_id);
  PERFORM public.complete_run_request(v_org, v_id, v_tok, 'done');
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'done' AND attempts = 3 AND uncharged_attempts = 1
                 AND requeue_steps = '{}'::jsonb) THEN
    RAISE EXCEPTION 'the deployed Worker''s outcomes left %', pg_temp.rq_row(v_id);
  END IF;
  INSERT INTO rq_cases VALUES ('the deployed Worker''s complete resolves to one definition, its new arguments defaulted, and leaves no step wait');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM rq_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'step_requeue_cap: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'step_requeue_cap: % cases passed', v_n;
END
$do$;

ROLLBACK;
