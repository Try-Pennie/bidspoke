-- Suspend and resume an ops run (#1951, the slice after the observe one).
-- Migration 20261028220000_run_continuation_1951.sql.
--
-- A slice of an ops run that has spent its budget writes its checkpoint to R2,
-- names it on its run (record_run_checkpoint, 20261027150000) and then ends its
-- claim suspended with the reason continue. The next holder resumes from the
-- checkpoint the run names. The database half of that is here.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a continue suspend is refused by name unless this attempt named a
--      checkpoint: none named, or one named by an earlier attempt (at an older
--      state version), leaves the run running and changes nothing;
--   2. after this attempt names a checkpoint, a continue suspend ends the claim
--      suspended with resume_reason continue, queued ahead of new starts, the
--      execution suspended, the checkpoint still named, and counts the run's
--      continuations; a repeat of that complete is already_completed and
--      counts nothing more;
--   3. a continuation's start is not charged against max_attempts: a run with
--      max_attempts 1 continues three times and ends done, never dead, and each
--      start answers how many times the run has continued;
--   4. a retry after a continuation is charged, and the run's continuations are
--      kept, so its next start still answers them (the Worker resumes it from
--      the checkpoint rather than from its first step);
--   5. an attempt resumed from a continuation that lapses with no send is
--      requeued as a retry and not refunded twice;
--   6. the ops Worker deployed before this migration keeps working: one
--      definition each of start_run_execution and complete_run_request, the
--      arguments it sends and the columns it reads, and every run it can make
--      counts no continuation;
--   7. start_run_execution, dropped and created again, is SECURITY DEFINER with
--      a fixed search_path and executable by service_role alone, and
--      continuations is written by no one but the functions.
--
-- TIME. now() is fixed inside a transaction, so a lapse is simulated by moving
-- the row's lease back as the table owner; no case sleeps.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE rc_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.rc_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.rc_enqueue(p_key text, p_max_attempts integer DEFAULT 3)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000001951', p_workflow_id => '00000000-0000-4000-8000-0000000019c0', p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- What one claim and start answered.
CREATE TEMP TABLE rc_held (run_request_id uuid PRIMARY KEY, claim_token uuid, execution_id uuid, state_version bigint, continuations integer) ON COMMIT DROP;

-- Claim the one due run and start it; keeps what the holder holds.
CREATE FUNCTION pg_temp.rc_claim_start(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  r record;
  s record;
  v_exec uuid := gen_random_uuid();
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT * INTO r FROM public.claim_run_requests('rc-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF r.run_request_id IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000001951', p_id, r.claim_token, v_exec);
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  DELETE FROM rc_held WHERE run_request_id = p_id;
  INSERT INTO rc_held VALUES (p_id, r.claim_token, v_exec, s.state_version, s.continuations);
  RETURN r.claim_token;
END
$f$;

-- The holder names a checkpoint of p_steps steps at the state version its start answered.
CREATE FUNCTION pg_temp.rc_name(p_id uuid, p_steps integer) RETURNS text LANGUAGE sql AS $f$
  SELECT public.record_run_checkpoint('aaaaaaaa-0000-4000-8000-000000001951', h.run_request_id, h.claim_token, h.execution_id, h.state_version, p_steps,
    format('checkpoints/v1/%s/%s/%s-%s.json', 'aaaaaaaa-0000-4000-8000-000000001951', h.run_request_id, h.state_version, p_steps), repeat('c', 64), 900)
  FROM rc_held h WHERE h.run_request_id = p_id;
$f$;

-- The holder ends its claim to continue, as the Worker sends it.
CREATE FUNCTION pg_temp.rc_continue(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT c.outcome || ':' || c.run_status FROM rc_held h,
    public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001951', h.run_request_id, h.claim_token, 'suspend', p_reason => 'continue', p_not_before => now()) c
  WHERE h.run_request_id = p_id;
$f$;

CREATE FUNCTION pg_temp.rc_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. a continue suspend needs a checkpoint this attempt named ──────────────
DO $do$
DECLARE
  v_id uuid;
  v_refused text;
BEGIN
  PERFORM pg_temp.rc_reset();
  v_id := pg_temp.rc_enqueue('none-named');
  PERFORM pg_temp.rc_claim_start(v_id);
  BEGIN
    PERFORM pg_temp.rc_continue(v_id);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := SQLERRM;
  END;
  IF v_refused IS NULL OR v_refused NOT LIKE '%continue suspend needs a checkpoint this attempt named%' THEN
    RAISE EXCEPTION 'a continue suspend with no checkpoint named was not refused by name: %', coalesce(v_refused, pg_temp.rc_row(v_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'running' AND continuations = 0 AND resume_reason IS NULL) THEN
    RAISE EXCEPTION 'a refused continue changed the run: %', pg_temp.rc_row(v_id);
  END IF;

  -- A checkpoint named by an earlier attempt: name one, retry, and continue from the new attempt without naming.
  PERFORM pg_temp.rc_name(v_id, 2);
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001951', v_id, (SELECT claim_token FROM rc_held WHERE run_request_id = v_id), 'retry');
  PERFORM pg_temp.rc_claim_start(v_id);
  v_refused := NULL;
  BEGIN
    PERFORM pg_temp.rc_continue(v_id);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := SQLERRM;
  END;
  IF v_refused IS NULL OR v_refused NOT LIKE '%continue suspend needs a checkpoint this attempt named%' THEN
    RAISE EXCEPTION 'a continue suspend on an earlier attempt''s checkpoint was not refused by name: %', coalesce(v_refused, pg_temp.rc_row(v_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'running' AND continuations = 0) THEN
    RAISE EXCEPTION 'a refused continue changed the run: %', pg_temp.rc_row(v_id);
  END IF;
  INSERT INTO rc_cases VALUES ('a continue suspend is refused by name unless this attempt named a checkpoint');
END
$do$;

-- ── 2. a continue suspend with a named checkpoint ────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_key text;
BEGIN
  PERFORM pg_temp.rc_reset();
  v_id := pg_temp.rc_enqueue('continues');
  PERFORM pg_temp.rc_claim_start(v_id);
  IF pg_temp.rc_name(v_id, 3) <> 'recorded' THEN RAISE EXCEPTION 'the holder could not name its checkpoint'; END IF;
  SELECT checkpoint_key INTO v_key FROM public.run_requests WHERE id = v_id;
  IF pg_temp.rc_continue(v_id) <> 'completed:suspended' THEN RAISE EXCEPTION 'a continue suspend left %', pg_temp.rc_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'suspended' AND resume_reason = 'continue' AND status_reason IS NULL
                 AND priority = 10 AND not_before = now() AND claim_expires_at IS NULL AND continuations = 1 AND checkpoint_key = v_key AND terminal_at IS NULL) THEN
    RAISE EXCEPTION 'the continuing run is %', pg_temp.rc_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id AND priority = 10) THEN
    RAISE EXCEPTION 'a continuing run is not queued ahead of new starts';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 1 AND status = 'suspended' AND finished_at = now()) THEN
    RAISE EXCEPTION 'the slice''s attempt was not left suspended';
  END IF;
  -- A repeat after a lost answer.
  IF pg_temp.rc_continue(v_id) <> 'already_completed:suspended' THEN RAISE EXCEPTION 'a repeated continue was not recognised'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND continuations = 1) THEN
    RAISE EXCEPTION 'a repeated continue was counted twice: %', pg_temp.rc_row(v_id);
  END IF;
  INSERT INTO rc_cases VALUES ('a continue suspend with this attempt''s checkpoint queues the run ahead of new starts and counts once');
END
$do$;

-- ── 3. a continuation's start is not charged ─────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_i integer;
BEGIN
  PERFORM pg_temp.rc_reset();
  -- max_attempts 1: a continuation that spent an attempt would end the run dead at its first retry check.
  v_id := pg_temp.rc_enqueue('long-run', 1);
  PERFORM pg_temp.rc_claim_start(v_id);
  IF (SELECT continuations FROM rc_held WHERE run_request_id = v_id) <> 0 THEN RAISE EXCEPTION 'a first start answered continuations'; END IF;
  FOR v_i IN 1..3 LOOP
    PERFORM pg_temp.rc_name(v_id, v_i * 2);
    IF pg_temp.rc_continue(v_id) <> 'completed:suspended' THEN RAISE EXCEPTION 'slice % did not suspend: %', v_i, pg_temp.rc_row(v_id); END IF;
    PERFORM pg_temp.rc_claim_start(v_id);
    IF (SELECT continuations FROM rc_held WHERE run_request_id = v_id) <> v_i THEN
      RAISE EXCEPTION 'the start after continuation % answered %', v_i, (SELECT continuations FROM rc_held WHERE run_request_id = v_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = v_i + 1 AND resume_reason = 'continue' AND status = 'running') THEN
      RAISE EXCEPTION 'attempt % was not resumed by continue', v_i + 1;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 4 AND uncharged_attempts = 3 AND continuations = 3) THEN
    RAISE EXCEPTION 'continuation starts were charged: %', pg_temp.rc_row(v_id);
  END IF;
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001951', v_id, (SELECT claim_token FROM rc_held WHERE run_request_id = v_id), 'done');
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'done') THEN RAISE EXCEPTION 'the run did not end done: %', pg_temp.rc_row(v_id); END IF;
  INSERT INTO rc_cases VALUES ('a continuation start is not charged against max_attempts, and answers the run''s continuations');
END
$do$;

-- ── 4. a retry after a continuation is charged, and keeps the continuations ──
DO $do$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_temp.rc_reset();
  v_id := pg_temp.rc_enqueue('continue-then-retry', 3);
  PERFORM pg_temp.rc_claim_start(v_id);
  PERFORM pg_temp.rc_name(v_id, 2);
  PERFORM pg_temp.rc_continue(v_id);
  PERFORM pg_temp.rc_claim_start(v_id);           -- attempt 2: a continuation, uncharged
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001951', v_id, (SELECT claim_token FROM rc_held WHERE run_request_id = v_id), 'retry', p_error => 'a later step failed');
  PERFORM pg_temp.rc_claim_start(v_id);           -- attempt 3: a retry, charged
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 3 AND uncharged_attempts = 1 AND continuations = 1 AND resume_reason = 'retry'
                 AND checkpoint_steps = 2) THEN
    RAISE EXCEPTION 'the retry after a continuation is %', pg_temp.rc_row(v_id);
  END IF;
  IF (SELECT continuations FROM rc_held WHERE run_request_id = v_id) <> 1 THEN
    RAISE EXCEPTION 'the retry''s start did not answer the run''s continuation, so it would start again from its first step';
  END IF;
  INSERT INTO rc_cases VALUES ('a retry after a continuation is charged and still answers the run''s continuations');
END
$do$;

-- ── 5. a lapsed continuation attempt is not refunded twice ───────────────────
DO $do$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_temp.rc_reset();
  v_id := pg_temp.rc_enqueue('continue-then-lapse');
  PERFORM pg_temp.rc_claim_start(v_id);           -- attempt 1, charged
  PERFORM pg_temp.rc_name(v_id, 2);
  PERFORM pg_temp.rc_continue(v_id);
  PERFORM pg_temp.rc_claim_start(v_id);           -- attempt 2, a continuation: uncharged
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  PERFORM public.sweep_expired_leases(100);
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND attempts = 2 AND uncharged_attempts = 1
                 AND lapse_refunds = 1 AND resume_reason = 'retry' AND continuations = 1) THEN
    RAISE EXCEPTION 'a continuation attempt that lapsed left %', pg_temp.rc_row(v_id);
  END IF;
  INSERT INTO rc_cases VALUES ('a continuation attempt that lapses with no send is requeued as a retry and not refunded twice');
END
$do$;

-- ── 6. the Worker deployed before this migration keeps working ───────────────
-- What apps/worker/src/ops/ops-writes.ts on main at 04fbb63b (the code running
-- when this migration is applied) sends and reads, copied from it.
DO $do$
DECLARE
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
      ('complete_run_request', ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_outcome', 'p_reason', 'p_error', 'p_not_before'], ARRAY['outcome', 'run_status'])
    ) AS s(name, sent, read)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name) <> 1 THEN
      RAISE EXCEPTION '% does not have exactly one definition, so PostgREST cannot resolve the deployed call', v_spec.name;
    END IF;
    SELECT p.proargnames, p.pronargs, p.pronargdefaults INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name;
    v_args := v_fn.proargnames[1:v_fn.pronargs];
    v_cols := v_fn.proargnames[v_fn.pronargs + 1:];
    IF v_args[1:array_length(v_spec.sent, 1)] <> v_spec.sent OR v_fn.pronargs - array_length(v_spec.sent, 1) > v_fn.pronargdefaults THEN
      RAISE EXCEPTION '% takes % (% defaulted), the deployed Worker sends %', v_spec.name, v_args, v_fn.pronargdefaults, v_spec.sent;
    END IF;
    IF NOT (v_cols @> v_spec.read) THEN RAISE EXCEPTION '% answers %, the deployed Worker reads %', v_spec.name, v_cols, v_spec.read; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'run_requests' AND column_name = 'continuations'
                 AND is_nullable = 'NO' AND column_default = '0') THEN
    RAISE EXCEPTION 'run_requests.continuations is not a NOT NULL count defaulting to 0';
  END IF;

  -- The deployed Worker never suspends to continue: every outcome it sends counts none.
  PERFORM pg_temp.rc_reset();
  v_id := pg_temp.rc_enqueue('deployed-shape');
  v_tok := pg_temp.rc_claim_start(v_id);
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001951', v_id, v_tok, 'suspend', p_reason => 'wake', p_not_before => now());
  v_tok := pg_temp.rc_claim_start(v_id);
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001951', v_id, v_tok, 'retry', p_error => 'partner 503');
  v_tok := pg_temp.rc_claim_start(v_id);
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000001951', v_id, v_tok, 'done');
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'done' AND continuations = 0 AND uncharged_attempts = 0) THEN
    RAISE EXCEPTION 'the deployed Worker''s outcomes left %', pg_temp.rc_row(v_id);
  END IF;
  INSERT INTO rc_cases VALUES ('the deployed Worker''s start and complete resolve to one definition each, and count no continuation');
END
$do$;

-- ── 7. privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
  v_wrote boolean;
BEGIN
  SELECT p.oid::regprocedure INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'start_run_execution';
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute %', v_fn;
  END IF;
  PERFORM pg_temp.rc_reset();
  PERFORM pg_temp.rc_enqueue('direct-write');
  SET LOCAL ROLE service_role;
  BEGIN
    UPDATE public.run_requests SET continuations = 5;
    v_wrote := true;
  EXCEPTION WHEN insufficient_privilege THEN
    v_wrote := false;
  END;
  RESET ROLE;
  IF v_wrote THEN RAISE EXCEPTION 'service_role wrote continuations directly'; END IF;
  INSERT INTO rc_cases VALUES ('start_run_execution is definer, fixed search_path, service_role alone; continuations is written by the functions alone');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM rc_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'run_continuation: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'run_continuation: % cases passed', v_n;
END
$do$;

ROLLBACK;
