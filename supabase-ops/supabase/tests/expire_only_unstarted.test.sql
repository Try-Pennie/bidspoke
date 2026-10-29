-- Only a run that has never started expires (#1951, Dan's decision of
-- 2026-10-28). Migration 20261029120000_expire_only_unstarted_1951.sql.
--
-- A run past its expires_at used to end expired as not_started_in_time whether
-- or not it had started: claim_run_requests and expire_overdue_run_requests
-- took any queued or suspended run past it, which includes a run suspended
-- between slices, or waiting on a rate limit or a resource, with sends already
-- made. Dan's decision: only a run that has never started (attempts = 0) may
-- expire that way. A run that has started finishes, fails, or stops on its own
-- caps.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a run that has never started still expires: a queued one the claim
--      reaches, one whose claim lapsed before it started, and one suspended on
--      a resource wait before it started, each ends expired as
--      not_started_in_time with no execution;
--   2. a started run past its expiry is never expired by the sweep, whatever
--      it waits on (a retry, a wake, a resource wait, a rate limit wait, a
--      continuation): the sweep answers 0, and each run keeps its status and
--      its place in the queue;
--   3. the claim takes those same started runs past their expiry and they start
--      again, as attempt 2, never expired;
--   4. started runs past their expiry do not use up the sweep's page: with a
--      page of 1 and two started runs due earlier, the sweep still expires the
--      one that never started;
--   5. the ops Worker deployed when this migration is applied keeps working:
--      one definition of each function, the arguments it sends and the columns
--      it reads;
--   6. both functions are SECURITY DEFINER with a fixed search_path and
--      executable by service_role alone.
--
-- TIME. now() is fixed inside a transaction, so a run's expiry is moved into the
-- past as the table owner after it has started; no case sleeps. Every run is
-- enqueued not yet due and made due only when a case claims it, because the
-- claim is lane wide and would otherwise take the other runs of the case too.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE eu_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.eu_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

-- A run of its own workflow, not yet due, expiring in an hour.
CREATE FUNCTION pg_temp.eu_enqueue(p_key text) RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-0000000019e1', p_workflow_id => md5('eu-' || p_key)::uuid, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => 3,
    p_not_before => now() + interval '1 hour', p_expires_at => now() + interval '1 hour');
$f$;

CREATE FUNCTION pg_temp.eu_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- Makes the one run due and claims it; answers its claim token.
CREATE FUNCTION pg_temp.eu_claim(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_tok uuid;
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT c.claim_token INTO v_tok FROM public.claim_run_requests('eu-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF v_tok IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, pg_temp.eu_row(p_id); END IF;
  RETURN v_tok;
END
$f$;

-- Moves the run's expiry into the past, as the table owner.
CREATE FUNCTION pg_temp.eu_overdue(p_id uuid, p_by interval DEFAULT interval '1 minute') RETURNS void LANGUAGE sql AS $f$
  UPDATE public.run_requests SET expires_at = now() - p_by WHERE id = p_id;
$f$;

-- A run that has started once and now waits, not yet due, on p_kind: retry,
-- wake, resource_wait, rate_limit_wait or continue.
CREATE FUNCTION pg_temp.eu_started(p_key text, p_kind text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-0000000019e1';
  v_id uuid;
  v_tok uuid;
  v_exec uuid := gen_random_uuid();
  s record;
  c record;
  v_later timestamptz := now() + interval '1 hour';
BEGIN
  v_id := pg_temp.eu_enqueue(p_key);
  v_tok := pg_temp.eu_claim(v_id);
  SELECT * INTO s FROM public.start_run_execution(v_org, v_id, v_tok, v_exec);
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', v_id, s; END IF;
  CASE p_kind
    WHEN 'retry' THEN
      SELECT * INTO c FROM public.complete_run_request(v_org, v_id, v_tok, 'retry', p_error => 'partner 503', p_not_before => v_later);
    WHEN 'wake' THEN
      SELECT * INTO c FROM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'wake', p_not_before => v_later);
    WHEN 'resource_wait' THEN
      SELECT * INTO c FROM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'resource_wait', p_error => 'pool_full', p_not_before => v_later);
    WHEN 'rate_limit_wait' THEN
      SELECT * INTO c FROM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'rate_limit_wait', p_step => 'step-1',
        p_status => 429, p_error => 'GET example.test answered 429', p_not_before => v_later);
    WHEN 'continue' THEN
      PERFORM public.record_run_checkpoint(v_org, v_id, v_tok, v_exec, s.state_version, 2,
        format('checkpoints/v1/%s/%s/%s-%s.json', v_org, v_id, s.state_version, 2), repeat('c', 64), 900);
      SELECT * INTO c FROM public.complete_run_request(v_org, v_id, v_tok, 'suspend', p_reason => 'continue', p_not_before => v_later);
    ELSE
      RAISE EXCEPTION 'no such kind %', p_kind;
  END CASE;
  IF c.outcome <> 'completed' OR c.run_status NOT IN ('queued', 'suspended') THEN
    RAISE EXCEPTION 'the % of run % answered %: %', p_kind, v_id, c, pg_temp.eu_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND attempts = 1 AND resume_reason = p_kind) THEN
    RAISE EXCEPTION 'the % of run % did not leave one start waiting on %: %', p_kind, v_id, p_kind, pg_temp.eu_row(v_id);
  END IF;
  RETURN v_id;
END
$f$;

CREATE TEMP TABLE eu_kinds (kind text PRIMARY KEY, id uuid) ON COMMIT DROP;

-- ── 1. a run that has never started still expires ───────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-0000000019e1';
  v_queued uuid;
  v_lapsed uuid;
  v_waiting uuid;
  v_tok uuid;
  v_n integer;
  r record;
BEGIN
  PERFORM pg_temp.eu_reset();

  -- Queued, never claimed: the claim reaches it and ends it.
  v_queued := pg_temp.eu_enqueue('never-claimed');
  PERFORM pg_temp.eu_overdue(v_queued);
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = v_queued;
  SELECT count(*) INTO v_n FROM public.claim_run_requests('eu-tick', 1000, 1000, 60);
  IF v_n <> 0 THEN RAISE EXCEPTION 'the claim took a run that never started past its expiry: %', pg_temp.eu_row(v_queued); END IF;

  -- Claimed, and the claim lapsed before it started: requeued, still never started.
  v_lapsed := pg_temp.eu_enqueue('lapsed-before-start');
  PERFORM pg_temp.eu_claim(v_lapsed);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_lapsed;
  IF (SELECT requeued FROM public.sweep_expired_leases(1000)) <> 1 THEN RAISE EXCEPTION 'the lapsed claim was not requeued: %', pg_temp.eu_row(v_lapsed); END IF;
  -- Requeued due now: put it back out of reach of the next case's claim.
  UPDATE public.run_queue SET not_before = now() + interval '1 hour' WHERE run_request_id = v_lapsed;

  -- Claimed, and suspended on a resource wait before it started.
  v_waiting := pg_temp.eu_enqueue('waited-before-start');
  v_tok := pg_temp.eu_claim(v_waiting);
  PERFORM public.complete_run_request(v_org, v_waiting, v_tok, 'suspend', p_reason => 'resource_wait', p_error => 'pool_full', p_not_before => now() + interval '1 hour');

  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id IN (v_lapsed, v_waiting) AND (attempts <> 0 OR status NOT IN ('queued', 'suspended'))) THEN
    RAISE EXCEPTION 'the never started runs are not waiting at attempt 0: % %', pg_temp.eu_row(v_lapsed), pg_temp.eu_row(v_waiting);
  END IF;
  PERFORM pg_temp.eu_overdue(v_lapsed);
  PERFORM pg_temp.eu_overdue(v_waiting);
  SELECT * INTO r FROM public.expire_overdue_run_requests(100);
  IF r.expired <> 2 OR r.more THEN RAISE EXCEPTION 'the expiry sweep answered % for two runs that never started', r; END IF;

  IF (SELECT count(*) FROM public.run_requests
      WHERE id IN (v_queued, v_lapsed, v_waiting) AND status = 'expired' AND status_reason = 'not_started_in_time' AND terminal_at IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'a run that never started was not expired: % % %', pg_temp.eu_row(v_queued), pg_temp.eu_row(v_lapsed), pg_temp.eu_row(v_waiting);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id IN (v_queued, v_lapsed, v_waiting)) THEN
    RAISE EXCEPTION 'an expired run was left in the queue';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id IN (v_queued, v_lapsed, v_waiting)) THEN
    RAISE EXCEPTION 'a run that never started has an execution';
  END IF;
  INSERT INTO eu_cases VALUES ('a run that never started (queued, lapsed before its start, waiting before its start) still expires');
END
$do$;

-- ── 2. a started run past its expiry is never expired by the sweep ───────────
DO $do$
DECLARE
  v_kind text;
  r record;
BEGIN
  PERFORM pg_temp.eu_reset();
  DELETE FROM eu_kinds;
  FOREACH v_kind IN ARRAY ARRAY['retry', 'wake', 'resource_wait', 'rate_limit_wait', 'continue'] LOOP
    INSERT INTO eu_kinds VALUES (v_kind, pg_temp.eu_started('started-' || v_kind, v_kind));
  END LOOP;
  PERFORM pg_temp.eu_overdue(id) FROM eu_kinds;

  SELECT * INTO r FROM public.expire_overdue_run_requests(100);
  IF r.expired <> 0 OR r.more THEN
    RAISE EXCEPTION 'the expiry sweep answered % for started runs: %', r,
      (SELECT string_agg(k.kind || '=' || x.status || '/' || coalesce(x.status_reason, '-'), ', ') FROM eu_kinds k JOIN public.run_requests x ON x.id = k.id);
  END IF;
  FOR v_kind IN SELECT kind FROM eu_kinds LOOP
    IF NOT EXISTS (SELECT 1 FROM eu_kinds k JOIN public.run_requests x ON x.id = k.id
                   WHERE k.kind = v_kind AND x.status = CASE WHEN v_kind = 'retry' THEN 'queued' ELSE 'suspended' END
                     AND x.status_reason IS NULL AND x.terminal_at IS NULL AND x.attempts = 1)
       OR NOT EXISTS (SELECT 1 FROM eu_kinds k JOIN public.run_queue q ON q.run_request_id = k.id WHERE k.kind = v_kind) THEN
      RAISE EXCEPTION 'the started run waiting on % was changed by the expiry sweep: %', v_kind, pg_temp.eu_row((SELECT id FROM eu_kinds WHERE kind = v_kind));
    END IF;
  END LOOP;
  INSERT INTO eu_cases VALUES ('the expiry sweep leaves a started run past its expiry waiting, whatever it waits on');
END
$do$;

-- ── 3. the claim takes started runs past their expiry ────────────────────────
-- Follows case 2: the same five started runs, all past their expiry.
DO $do$
DECLARE
  v_n integer;
BEGIN
  IF (SELECT count(*) FROM eu_kinds) <> 5 THEN RAISE EXCEPTION 'case 2 left % started runs, not 5', (SELECT count(*) FROM eu_kinds); END IF;
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id IN (SELECT id FROM eu_kinds);
  CREATE TEMP TABLE eu_claimed ON COMMIT DROP AS SELECT * FROM public.claim_run_requests('eu-tick', 1000, 1000, 60);
  SELECT count(*) INTO v_n FROM eu_claimed c JOIN eu_kinds k ON k.id = c.run_request_id AND c.resume_reason = k.kind AND c.attempts = 1;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'the claim took % of the 5 started runs past their expiry: %', v_n,
      (SELECT string_agg(k.kind || '=' || x.status || '/' || coalesce(x.status_reason, '-'), ', ') FROM eu_kinds k JOIN public.run_requests x ON x.id = k.id);
  END IF;
  SELECT count(*) INTO v_n FROM eu_claimed c, public.start_run_execution('aaaaaaaa-0000-4000-8000-0000000019e1', c.run_request_id, c.claim_token, gen_random_uuid()) s
  WHERE s.outcome = 'started' AND s.attempt = 2;
  IF v_n <> 5 THEN RAISE EXCEPTION 'only % of the 5 claimed runs started again as attempt 2', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id IN (SELECT id FROM eu_kinds) AND (status <> 'running' OR status_reason IS NOT NULL)) THEN
    RAISE EXCEPTION 'a started run past its expiry did not run again';
  END IF;
  INSERT INTO eu_cases VALUES ('the claim takes a started run past its expiry, and it starts again');
END
$do$;

-- ── 4. started runs do not use up the sweep's page ───────────────────────────
DO $do$
DECLARE
  v_a uuid;
  v_b uuid;
  v_never uuid;
  r record;
BEGIN
  PERFORM pg_temp.eu_reset();
  v_a := pg_temp.eu_started('page-a', 'wake');
  v_b := pg_temp.eu_started('page-b', 'continue');
  v_never := pg_temp.eu_enqueue('page-never');
  -- The started runs are due to expire first, so they lead the sweep's order.
  PERFORM pg_temp.eu_overdue(v_a, interval '3 hours');
  PERFORM pg_temp.eu_overdue(v_b, interval '2 hours');
  PERFORM pg_temp.eu_overdue(v_never, interval '1 minute');

  SELECT * INTO r FROM public.expire_overdue_run_requests(1);
  IF r.expired <> 1 OR (SELECT status FROM public.run_requests WHERE id = v_never) <> 'expired' THEN
    RAISE EXCEPTION 'a page of 1 answered % and did not reach the run that never started: %', r, pg_temp.eu_row(v_never);
  END IF;
  SELECT * INTO r FROM public.expire_overdue_run_requests(1);
  IF r.expired <> 0 OR r.more THEN RAISE EXCEPTION 'the next page answered %, with nothing left that may expire', r; END IF;
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id IN (v_a, v_b) AND status <> 'suspended') THEN
    RAISE EXCEPTION 'a started run was expired by a page: % %', pg_temp.eu_row(v_a), pg_temp.eu_row(v_b);
  END IF;
  INSERT INTO eu_cases VALUES ('started runs past their expiry do not use up the expiry sweep''s page');
END
$do$;

-- ── 5. the Worker deployed when this is applied keeps working ────────────────
-- What apps/worker/src/ops/ops-writes.ts on main at a6d78fc2 (the code running
-- when this migration is applied) sends and reads, copied from it.
DO $do$
DECLARE
  v_spec record;
  v_fn record;
  v_args text[];
  v_cols text[];
BEGIN
  FOR v_spec IN
    SELECT * FROM (VALUES
      ('claim_run_requests', ARRAY['p_worker', 'p_limit', 'p_per_workflow', 'p_lease_seconds'],
        ARRAY['run_request_id', 'organization_id', 'workflow_id', 'workflow_version', 'trigger_kind', 'claim_token', 'claim_expires_at',
              'state_version', 'attempts', 'uncharged_attempts', 'max_attempts', 'resume_reason', 'execution_chain_id',
              'resumed_from_execution_id', 'payload', 'payload_ref']),
      ('expire_overdue_run_requests', ARRAY['p_limit'], ARRAY['expired', 'more'])
    ) AS s(name, sent, read)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name) <> 1 THEN
      RAISE EXCEPTION '% does not have exactly one definition, so PostgREST cannot resolve the deployed call', v_spec.name;
    END IF;
    SELECT p.proargnames, p.pronargs, p.pronargdefaults INTO v_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_spec.name;
    v_args := v_fn.proargnames[1:v_fn.pronargs];
    v_cols := v_fn.proargnames[v_fn.pronargs + 1:];
    IF v_args <> v_spec.sent THEN
      RAISE EXCEPTION '% takes %, the deployed Worker sends %', v_spec.name, v_args, v_spec.sent;
    END IF;
    IF NOT (v_cols @> v_spec.read) THEN RAISE EXCEPTION '% answers %, the deployed Worker reads %', v_spec.name, v_cols, v_spec.read; END IF;
  END LOOP;
  INSERT INTO eu_cases VALUES ('the deployed Worker''s claim and expiry calls resolve to one definition each, with what it sends and reads');
END
$do$;

-- ── 6. privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('claim_run_requests', 'expire_overdue_run_requests')
  LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn;
    END IF;
  END LOOP;
  INSERT INTO eu_cases VALUES ('both functions are definer, fixed search_path, service_role alone');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM eu_cases);
BEGIN
  IF v_n <> 6 THEN RAISE EXCEPTION 'expire_only_unstarted: % of 6 cases ran', v_n; END IF;
  RAISE NOTICE 'expire_only_unstarted: % cases passed', v_n;
END
$do$;

ROLLBACK;
