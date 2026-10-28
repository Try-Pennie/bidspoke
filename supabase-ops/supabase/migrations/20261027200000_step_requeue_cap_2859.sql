-- The requeue cap (#2859, milestone "Move every Pipedream workflow to
-- Bidspoke"; #2673 asked for it, #1693 7.4 sets the rule it keeps).
--
-- WHY. connectionFetch turns a service's 429 (and a 503 with Retry-After, and
-- a token endpoint's 429) into a requeue at the time the service gave. Until
-- now the Worker ended that attempt as a retry, which is CHARGED against
-- max_attempts: a rate limit spent the run's retry attempts (3 by default)
-- against #1693 7.4 ("a 429 with Retry-After ... sets not_before ... without
-- spending an attempt"), and a host that kept answering 429 for a quota or
-- plan limit no wait clears ended dead as max_attempts, named as if the run
-- had failed three times. With the deferral made free, as 7.4 says, nothing
-- would bound it at all, so this adds the bound: a cap on how many times one
-- step of one run may be made to wait, and on how long after its first wait,
-- past which the run ends failed by name.
--
-- WHAT.
--   run_requests gains
--     requeue_steps  one entry per step key (the node id the Worker sends) that
--                  a service asked to wait in this run: {requeues, since,
--                  last_status, last_not_before}. Kept for the life of the run
--                  and never cleared by another outcome, because every attempt
--                  walks the graph from its start: two steps refused in turn
--                  would otherwise reset each other for ever. An object, by
--                  CHECK.
--   The resume reason CHECKs (run_requests and workflow_executions) gain
--   rate_limit_wait, and the status reason CHECK gains requeue_cap_reached, a
--   reason a run fails for that the engine alone writes (F122).
--
--   complete_run_request  suspend also takes rate_limit_wait, naming its step
--                  in p_step (new), the HTTP status that asked for the wait in
--                  p_status (new, null when no request was made), what was
--                  asked in p_error, and the wake time. The step's entry counts
--                  the wait. A wait asked when the step has already waited
--                  v_requeue_max times, or whose wake time is more than
--                  v_requeue_wait_max after the step's first wait, ends the run
--                  failed with requeue_cap_reached instead, its last_error
--                  naming the step, what the service last said (the status and
--                  the time it asked to wait until, in p_error) and the cap
--                  (L110, L365). p_step and p_status with any other outcome are
--                  refused. Its two new arguments make it a new signature, so
--                  it is dropped and created in this one transaction: no
--                  caller can see it absent, and there is still exactly one
--                  definition for PostgREST to resolve.
--   start_run_execution  a start resumed from rate_limit_wait is not charged,
--                  as one resumed from resource_wait is not (the list the
--                  Worker names UNCHARGED_RESUME_REASONS).
--   sweep_expired_leases  a lapsed attempt that was already uncharged (either
--                  wait) is not refunded twice, so uncharged_attempts can never
--                  pass attempts and abort the sweep page on its CHECK.
--
-- THE TWO NUMBERS. 10 waits, and 6 hours after the first. connectionFetch
-- clamps one wait to at most an hour (RETRY_AFTER_MAX_MS) and defaults to a
-- minute with no Retry-After, so a plain 429 with no header stops after about
-- ten minutes and an hourly quota after its sixth hour. The Worker names the
-- same two numbers (OPS_STEP_REQUEUE_MAX and OPS_STEP_REQUEUE_WAIT_MAX_MS in
-- apps/worker/src/ops/run-vocabulary.ts), which the vocabulary test holds to
-- this function.
--
-- APPLIED BEFORE THE CODE THAT USES IT (L640, ADR 0007). The ops Worker running
-- when this is applied never suspends with rate_limit_wait and never sends
-- p_step or p_status: its seven named arguments resolve to the new function by
-- their defaults, and every outcome it sends does what it did before (a 429 is
-- still its charged retry), leaving requeue_steps '{}'. The Worker that sends
-- rate_limit_wait needs this applied first: PostgREST refuses an argument the
-- function does not take, so its complete would fail and the lease sweep would
-- end the attempt. step_requeue_cap.test.sql case 7 checks the deployed calls.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: the table changes add a column
-- with a constant default and swap three CHECKs for wider lists, which the rows
-- already satisfy; the functions change no rows.

SET lock_timeout = '5s';

-- ── run_requests and workflow_executions ──────────────────────────────────────
ALTER TABLE public.run_requests
  ADD COLUMN requeue_steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT run_requests_requeue_steps_check CHECK (jsonb_typeof(requeue_steps) = 'object'),
  DROP CONSTRAINT run_requests_status_reason_check,
  ADD CONSTRAINT run_requests_status_reason_check CHECK (status_reason IS NULL OR status_reason IN
    ('workflow_inactive', 'workflow_deleted', 'halted_by_rule', 'lease_requeue_cap', 'max_attempts',
     'lease_expired_after_send', 'send_outcome_unknown',
     'paused', 'rate_limited', 'overlap',
     'not_started_in_time',
     'max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded',
     'resource_wait_exceeded', 'lease_lapsed_repeatedly', 'requeue_cap_reached')),
  DROP CONSTRAINT run_requests_resume_reason_check,
  ADD CONSTRAINT run_requests_resume_reason_check CHECK (resume_reason IS NULL OR resume_reason IN ('continue', 'wake', 'retry', 'resource_wait', 'rate_limit_wait'));

ALTER TABLE public.workflow_executions
  DROP CONSTRAINT workflow_executions_resume_reason_check,
  ADD CONSTRAINT workflow_executions_resume_reason_check CHECK (resume_reason IS NULL OR resume_reason IN ('continue', 'wake', 'retry', 'resource_wait', 'rate_limit_wait'));

-- ── start_run_execution ───────────────────────────────────────────────────────
-- As #2334's (20261017230000), and a start resumed from a rate limit wait is
-- not charged either.
CREATE OR REPLACE FUNCTION public.start_run_execution(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_execution_id     uuid
) RETURNS TABLE (outcome text, state_version bigint, attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_run record;
BEGIN
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'start_run_execution: an execution id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.run_requests r
  SET status = 'running', attempts = r.attempts + 1,
      uncharged_attempts = r.uncharged_attempts + CASE WHEN r.resume_reason IN ('resource_wait', 'rate_limit_wait') THEN 1 ELSE 0 END,
      state_version = r.state_version + 1, updated_at = v_now
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token
    AND r.status = 'claimed' AND r.claim_expires_at > v_now
  RETURNING r.* INTO v_run;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.workflow_executions e JOIN public.run_requests r ON r.id = e.run_request_id
               WHERE e.id = p_execution_id AND r.id = p_run_request_id AND r.organization_id = p_organization_id
                 AND r.claim_token = p_claim_token AND r.status = 'running') THEN
      RETURN QUERY SELECT 'already_started'::text, r.state_version, r.attempts FROM public.run_requests r WHERE r.id = p_run_request_id;
    ELSE
      RETURN QUERY SELECT 'claim_lost'::text, NULL::bigint, NULL::integer;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.workflow_executions (id, organization_id, run_request_id, execution_chain_id, attempt, workflow_id, workflow_version,
    trigger_type, status, resume_reason, resumed_from_execution_id, started_at)
  VALUES (p_execution_id, v_run.organization_id, v_run.id, v_run.execution_chain_id, v_run.attempts, v_run.workflow_id, v_run.workflow_version,
    v_run.trigger_kind, 'running', v_run.resume_reason, v_run.resumed_from_execution_id, v_now);
  RETURN QUERY SELECT 'started'::text, v_run.state_version, v_run.attempts;
END
$fn$;

-- ── complete_run_request ──────────────────────────────────────────────────────
-- The holder ends its claim. Outcomes: done, failed (terminal), retry (back to
-- the queue, or dead when the CHARGED attempts reach max_attempts), suspend
-- (sleeping until p_not_before, p_reason continue, wake, resource_wait or
-- rate_limit_wait, claimed ahead of new starts on waking; a resource_wait names
-- its cause in p_error and ends failed with resource_wait_exceeded once the
-- wait is past 24 hours; a rate_limit_wait names its step in p_step and its
-- status in p_status and ends failed with requeue_cap_reached at the requeue
-- cap), needs_human, dead (p_reason workflow_inactive, workflow_deleted or
-- halted_by_rule). Answers completed, already_completed (this token already
-- ended it), claim_lost (another holder, or swept) or not_found (no such run in
-- this organization).
DROP FUNCTION public.complete_run_request(uuid, uuid, uuid, text, text, text, timestamptz);
CREATE FUNCTION public.complete_run_request(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_outcome          text,
  p_reason           text DEFAULT NULL,
  p_error            text DEFAULT NULL,
  p_not_before       timestamptz DEFAULT NULL,
  p_step             text DEFAULT NULL,
  p_status           integer DEFAULT NULL
) RETURNS TABLE (outcome text, run_status text, state_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  -- The requeue cap (#2859): OPS_STEP_REQUEUE_MAX and OPS_STEP_REQUEUE_WAIT_MAX_MS in run-vocabulary.ts.
  v_requeue_max CONSTANT integer := 10;
  v_requeue_wait_max CONSTANT interval := interval '21600 seconds';
  v_now timestamptz := now();
  v_run record;
  v_status text;
  v_reason text := NULL;
  v_resume text := NULL;
  v_queue boolean := false;
  v_priority smallint;
  v_exec_status text;
  v_wait boolean := false;
  v_wait_since timestamptz := NULL;
  v_wait_cause text := NULL;
  v_rate boolean := false;
  v_requeues integer;
  v_since timestamptz;
  v_steps jsonb := NULL;
  v_error text := p_error;
BEGIN
  CASE p_outcome
    WHEN 'done' THEN v_status := 'done'; v_exec_status := 'success';
    WHEN 'failed' THEN
      -- resource_wait_exceeded, lease_lapsed_repeatedly and requeue_cap_reached
      -- are not here: only the engine ends a run for them (F122).
      IF p_reason IS NOT NULL AND p_reason NOT IN ('max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run fails for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'failed'; v_reason := p_reason; v_exec_status := 'failed';
    WHEN 'retry' THEN v_status := 'queued'; v_resume := 'retry'; v_queue := true; v_exec_status := 'failed';
    WHEN 'suspend' THEN
      IF p_reason IS NULL OR p_reason NOT IN ('continue', 'wake', 'resource_wait', 'rate_limit_wait') THEN
        RAISE EXCEPTION 'complete_run_request: a suspend needs the reason continue, wake, resource_wait or rate_limit_wait, not %', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF p_reason = 'resource_wait' THEN
        IF p_error IS NULL OR p_error NOT IN ('pool_full', 'workflow_share_full', 'sf_budget_floor', 'sf_budget_unmeasured', 'sf_org_unmeasured', 'sf_cap_unset', 'acquire_error') THEN
          RAISE EXCEPTION 'complete_run_request: a resource_wait suspend names what it waits on in p_error, not %', p_error USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF p_not_before IS NULL THEN
          RAISE EXCEPTION 'complete_run_request: a resource_wait suspend needs the time to try again' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_wait := true;
      END IF;
      IF p_reason = 'rate_limit_wait' THEN
        IF p_step IS NULL OR length(p_step) NOT BETWEEN 1 AND 200 THEN
          RAISE EXCEPTION 'complete_run_request: a rate_limit_wait suspend names its step in p_step (1 to 200 characters)' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF p_not_before IS NULL THEN
          RAISE EXCEPTION 'complete_run_request: a rate_limit_wait suspend needs the time to try again' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF p_status IS NOT NULL AND p_status NOT BETWEEN 100 AND 599 THEN
          RAISE EXCEPTION 'complete_run_request: % is not an HTTP status', p_status USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF p_error IS NULL OR length(p_error) = 0 THEN
          RAISE EXCEPTION 'complete_run_request: a rate_limit_wait suspend says what was asked in p_error' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_rate := true;
      END IF;
      v_status := 'suspended'; v_resume := p_reason; v_queue := true; v_exec_status := 'suspended';
    WHEN 'needs_human' THEN
      IF p_reason IS NULL OR p_reason NOT IN ('lease_expired_after_send', 'send_outcome_unknown') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run needs a person for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'needs_human'; v_reason := p_reason; v_exec_status := 'needs_human';
    WHEN 'dead' THEN
      IF p_reason IS NULL OR p_reason NOT IN ('workflow_inactive', 'workflow_deleted', 'halted_by_rule') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run is ended for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'dead'; v_reason := p_reason; v_exec_status := 'failed';
    ELSE
      RAISE EXCEPTION 'complete_run_request: % is not an outcome', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END CASE;
  IF NOT v_rate AND (p_step IS NOT NULL OR p_status IS NOT NULL) THEN
    RAISE EXCEPTION 'complete_run_request: p_step and p_status belong to a rate_limit_wait suspend only' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- No token is no claim: refused, so it can never match a swept or never
  -- claimed run's absent token and be told already_completed.
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'complete_run_request: a claim token is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.* INTO v_run FROM public.run_requests r
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  IF v_run.claim_token IS NULL OR v_run.claim_token <> p_claim_token THEN
    RETURN QUERY SELECT 'claim_lost'::text, v_run.status, v_run.state_version;
    RETURN;
  END IF;
  IF v_run.status NOT IN ('claimed', 'running') THEN
    RETURN QUERY SELECT 'already_completed'::text, v_run.status, v_run.state_version;
    RETURN;
  END IF;

  IF p_outcome = 'retry' AND v_run.attempts - v_run.uncharged_attempts >= v_run.max_attempts THEN
    v_status := 'dead'; v_reason := 'max_attempts'; v_resume := NULL; v_queue := false;
  END IF;
  -- A wait keeps the time it began and records what it waits on now; any other
  -- outcome clears both.
  IF v_wait THEN
    v_wait_since := coalesce(v_run.resource_wait_since, v_now);
    v_wait_cause := p_error;
    IF v_now - v_wait_since > interval '24 hours' THEN
      v_status := 'failed'; v_reason := 'resource_wait_exceeded'; v_resume := NULL; v_queue := false; v_exec_status := 'failed';
    END IF;
  END IF;
  -- A rate limit wait is counted against its step, which may wait at most
  -- v_requeue_max times, none waking more than v_requeue_wait_max after its
  -- first; the wait that would pass either ends the run failed by name.
  IF v_rate THEN
    v_requeues := coalesce((v_run.requeue_steps -> p_step ->> 'requeues')::integer, 0);
    v_since := coalesce((v_run.requeue_steps -> p_step ->> 'since')::timestamptz, v_now);
    IF v_requeues >= v_requeue_max OR p_not_before - v_since > v_requeue_wait_max THEN
      v_status := 'failed'; v_reason := 'requeue_cap_reached'; v_resume := NULL; v_queue := false; v_exec_status := 'failed';
      v_error := format('requeue_cap_reached: %s. The step had waited %s times since %s, and one step of a run may wait at most %s times, none waking more than %s hours after its first',
        p_error, v_requeues, to_char(v_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_requeue_max, (extract(epoch FROM v_requeue_wait_max) / 3600)::integer);
    ELSE
      v_steps := jsonb_set(v_run.requeue_steps, ARRAY[p_step], jsonb_build_object(
        'requeues', v_requeues + 1, 'since', v_since, 'last_status', p_status, 'last_not_before', p_not_before));
    END IF;
  END IF;
  v_priority := CASE WHEN v_status = 'suspended' THEN 10 ELSE v_run.priority END;

  UPDATE public.run_requests r
  SET status = v_status, status_reason = v_reason,
      resume_reason = CASE WHEN v_queue THEN v_resume ELSE r.resume_reason END,
      priority = v_priority, not_before = CASE WHEN v_queue THEN coalesce(p_not_before, v_now) ELSE r.not_before END,
      claim_expires_at = NULL, last_error = coalesce(v_error, r.last_error), state_version = r.state_version + 1, updated_at = v_now,
      resource_wait_since = v_wait_since, resource_wait_cause = v_wait_cause,
      requeue_steps = coalesce(v_steps, r.requeue_steps),
      terminal_at = CASE WHEN v_status IN ('done', 'failed', 'dead', 'expired', 'skipped') THEN v_now END
  WHERE r.id = v_run.id
  RETURNING r.* INTO v_run;

  IF v_queue THEN
    INSERT INTO public.run_queue (run_request_id, organization_id, workflow_id, not_before, priority, concurrency_limit, created_at)
    VALUES (v_run.id, v_run.organization_id, v_run.workflow_id, v_run.not_before, v_run.priority, v_run.concurrency_limit, v_run.created_at);
  END IF;
  UPDATE public.workflow_executions e SET status = v_exec_status, finished_at = v_now, error = v_error
  WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.status = 'running';

  RETURN QUERY SELECT 'completed'::text, v_run.status, v_run.state_version;
END
$fn$;

-- ── sweep_expired_leases ──────────────────────────────────────────────────────
-- As #2334's (20261017230000), and an attempt resumed from a rate limit wait,
-- like one resumed from a resource wait, was never charged, so is not refunded
-- twice. Same argument and answer, so replaced in place.
CREATE OR REPLACE FUNCTION public.sweep_expired_leases(p_limit integer)
RETURNS TABLE (requeued integer, retried integer, needs_human integer, dead integer, failed integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_run record;
  v_requeued integer := 0;
  v_retried integer := 0;
  v_human integer := 0;
  v_dead integer := 0;
  v_failed integer := 0;
  v_seen integer := 0;
  v_status text;
  v_reason text;
  v_queue boolean;
  v_refund boolean;
  v_uncharge boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'sweep_expired_leases: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR v_run IN
    SELECT r.id, r.status, r.attempts, r.uncharged_attempts, r.lapse_refunds, r.max_attempts, r.lease_requeues FROM public.run_requests r
    WHERE r.status IN ('claimed', 'running') AND r.claim_expires_at < v_now
    ORDER BY r.claim_expires_at, r.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_seen := v_seen + 1;
    v_reason := NULL;
    v_queue := false;
    v_refund := false;
    v_uncharge := false;
    IF v_run.status = 'claimed' THEN
      IF v_run.lease_requeues < 3 THEN
        v_status := 'queued'; v_queue := true; v_requeued := v_requeued + 1;
      ELSE
        v_status := 'dead'; v_reason := 'lease_requeue_cap'; v_dead := v_dead + 1;
      END IF;
    ELSE
      UPDATE public.workflow_executions e SET status = 'failed', finished_at = v_now, error = 'lease expired'
      WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.status = 'running';
      IF EXISTS (SELECT 1 FROM public.send_ledger l WHERE l.run_request_id = v_run.id AND NOT l.idempotent) THEN
        v_status := 'needs_human'; v_reason := 'lease_expired_after_send'; v_human := v_human + 1;
      ELSIF NOT EXISTS (SELECT 1 FROM public.send_ledger l WHERE l.run_request_id = v_run.id AND l.attempt = v_run.attempts) THEN
        IF v_run.lapse_refunds >= 3 THEN
          v_status := 'failed'; v_reason := 'lease_lapsed_repeatedly'; v_failed := v_failed + 1;
        ELSE
          v_status := 'queued'; v_queue := true; v_refund := true; v_retried := v_retried + 1;
          -- An attempt resumed from a wait was never charged: refund it once only.
          v_uncharge := NOT EXISTS (SELECT 1 FROM public.workflow_executions e
                                    WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.resume_reason IN ('resource_wait', 'rate_limit_wait'));
        END IF;
      ELSIF v_run.attempts - v_run.uncharged_attempts >= v_run.max_attempts THEN
        v_status := 'dead'; v_reason := 'max_attempts'; v_dead := v_dead + 1;
      ELSE
        v_status := 'queued'; v_queue := true; v_retried := v_retried + 1;
      END IF;
    END IF;

    -- The claim is over: its token goes, so the old holder's complete answers
    -- claim_lost, never already_completed (a token is kept past a complete only
    -- so that the holder's own repeat is recognised).
    UPDATE public.run_requests r
    SET status = v_status, status_reason = v_reason, claim_expires_at = NULL, claim_token = NULL,
        lease_requeues = r.lease_requeues + CASE WHEN v_run.status = 'claimed' AND v_queue THEN 1 ELSE 0 END,
        uncharged_attempts = r.uncharged_attempts + CASE WHEN v_uncharge THEN 1 ELSE 0 END,
        lapse_refunds = r.lapse_refunds + CASE WHEN v_refund THEN 1 ELSE 0 END,
        -- A run put back in the queue is no longer a first start: it keeps its
        -- reason (a continuation stays one) or becomes a retry. Never NULL, or an
        -- overlap 'queue' workflow whose waiting slot a later fire now holds trips
        -- run_requests_overlap_queue_idx, and that one row fails every sweep.
        resume_reason = CASE
          WHEN v_queue AND v_run.status = 'running' THEN 'retry'
          WHEN v_queue THEN coalesce(r.resume_reason, 'retry')
          ELSE r.resume_reason END,
        not_before = CASE WHEN v_queue THEN v_now ELSE r.not_before END,
        last_error = CASE WHEN v_run.status = 'running' THEN 'lease expired' ELSE r.last_error END,
        -- An attempt that ran and lapsed ends any wait it was resumed from; a
        -- run claimed but never started is still waiting.
        resource_wait_since = CASE WHEN v_run.status = 'running' THEN NULL ELSE r.resource_wait_since END,
        resource_wait_cause = CASE WHEN v_run.status = 'running' THEN NULL ELSE r.resource_wait_cause END,
        state_version = r.state_version + 1, updated_at = v_now,
        -- Every terminal status the sweep writes (F122): run_requests_terminal_at_check.
        terminal_at = CASE WHEN v_status IN ('dead', 'failed') THEN v_now END
    WHERE r.id = v_run.id;
    IF v_queue THEN
      INSERT INTO public.run_queue (run_request_id, organization_id, workflow_id, not_before, priority, concurrency_limit, created_at)
      SELECT r.id, r.organization_id, r.workflow_id, r.not_before, r.priority, r.concurrency_limit, r.created_at
      FROM public.run_requests r WHERE r.id = v_run.id;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_requeued, v_retried, v_human, v_dead, v_failed, v_seen = p_limit;
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
-- As #1948 left them: service_role only. The dropped and created complete
-- starts with the platform's default grants, so this matters for it most.
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('start_run_execution', 'complete_run_request', 'sweep_expired_leases')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;
