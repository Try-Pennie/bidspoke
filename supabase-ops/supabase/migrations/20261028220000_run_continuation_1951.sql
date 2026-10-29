-- Suspend and resume an ops run (#1951, track B4 of the #1698 run engine, the
-- slice after the observe one in 20261027150000_run_checkpoints_1951.sql).
--
-- WHY. A ported workflow longer than one invocation can only finish across
-- several (spike 0, docs/ops-ceilings-spike.md). With OPS_CONTINUATION=on, a
-- slice that has spent its budget writes its checkpoint to R2, names it on its
-- run (record_run_checkpoint), and ends its claim suspended with the reason
-- continue; the next holder resumes from the checkpoint the run names (#1698
-- 1.5 and 1.8). This is the database half.
--
-- WHAT.
--   run_requests gains
--     continuations  how many times the run has been suspended to continue.
--                  The Worker resumes an attempt from the run's checkpoint
--                  whenever it is above 0, whatever the attempt was resumed
--                  by, so a retry after a continuation never starts the graph
--                  again from its first step and repeats a send an earlier
--                  slice made. Written by complete_run_request alone.
--   complete_run_request  a continue suspend is refused by name unless this
--                  attempt named a checkpoint (the run names one at the state
--                  version this attempt's start answered), so a run is never
--                  suspended to continue from nothing (#1698 1.5: it
--                  checkpoints, then finalises suspended). Each continue
--                  suspend counts one continuation. Same arguments and answer,
--                  so replaced in place.
--   start_run_execution  a start resumed by continue is not charged against
--                  max_attempts (a continuation is not a failure, #1698 1.5),
--                  as one resumed from a wait is not; and it answers the run's
--                  continuations, so the Worker knows to resume without a
--                  second call. Its answer gains a column, which is a new
--                  return type, so it is dropped and created in this one
--                  transaction: no caller can see it absent, and there is still
--                  exactly one definition for PostgREST to resolve.
--   sweep_expired_leases  a lapsed attempt resumed by continue was never
--                  charged, so it is not refunded twice. Same argument and
--                  answer, so replaced in place.
--
-- BOUNDS. A continuation spends no attempt, so max_attempts does not bound a
-- run that keeps continuing. Its whole run step cap does: every slice walks at
-- least one step before its boundary, and the walk ends a run failed with
-- max_steps_exceeded at OPS_WALK_MAX_STEPS steps across all its slices
-- (apps/worker/src/ops/run-walk.ts).
--
-- APPLIED BEFORE THE CODE THAT USES IT (L640, ADR 0007). The ops Worker running
-- when this is applied never suspends with continue, sends the same four
-- arguments to start_run_execution and reads its first three columns, so it
-- works unchanged: its runs count no continuation and its starts are charged
-- as before. The Worker that reads continuations needs this applied first: it
-- refuses a start answered without them, by name (ops-writes.ts).
-- run_continuation.test.sql case 6 checks the deployed calls.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: one column with a constant
-- default and a CHECK every row satisfies (0); the functions change no rows.
-- Guarded by supabase-ops/supabase/tests/run_continuation.test.sql.

SET lock_timeout = '5s';

-- ── run_requests ──────────────────────────────────────────────────────────────
ALTER TABLE public.run_requests
  ADD COLUMN continuations integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT run_requests_continuations_check CHECK (continuations >= 0);

-- ── start_run_execution ───────────────────────────────────────────────────────
-- As #2859's (20261027200000), and a start resumed by continue is not charged
-- either, and the answer names the run's continuations.
DROP FUNCTION public.start_run_execution(uuid, uuid, uuid, uuid);
CREATE FUNCTION public.start_run_execution(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_execution_id     uuid
) RETURNS TABLE (outcome text, state_version bigint, attempt integer, continuations integer)
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
      uncharged_attempts = r.uncharged_attempts + CASE WHEN r.resume_reason IN ('continue', 'resource_wait', 'rate_limit_wait') THEN 1 ELSE 0 END,
      state_version = r.state_version + 1, updated_at = v_now
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token
    AND r.status = 'claimed' AND r.claim_expires_at > v_now
  RETURNING r.* INTO v_run;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.workflow_executions e JOIN public.run_requests r ON r.id = e.run_request_id
               WHERE e.id = p_execution_id AND r.id = p_run_request_id AND r.organization_id = p_organization_id
                 AND r.claim_token = p_claim_token AND r.status = 'running') THEN
      RETURN QUERY SELECT 'already_started'::text, r.state_version, r.attempts, r.continuations FROM public.run_requests r WHERE r.id = p_run_request_id;
    ELSE
      RETURN QUERY SELECT 'claim_lost'::text, NULL::bigint, NULL::integer, NULL::integer;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.workflow_executions (id, organization_id, run_request_id, execution_chain_id, attempt, workflow_id, workflow_version,
    trigger_type, status, resume_reason, resumed_from_execution_id, started_at)
  VALUES (p_execution_id, v_run.organization_id, v_run.id, v_run.execution_chain_id, v_run.attempts, v_run.workflow_id, v_run.workflow_version,
    v_run.trigger_kind, 'running', v_run.resume_reason, v_run.resumed_from_execution_id, v_now);
  RETURN QUERY SELECT 'started'::text, v_run.state_version, v_run.attempts, v_run.continuations;
END
$fn$;

-- ── complete_run_request ──────────────────────────────────────────────────────
-- As #2859's (20261027200000), and a continue suspend needs a checkpoint this
-- attempt named, and counts one continuation.
CREATE OR REPLACE FUNCTION public.complete_run_request(
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
  -- A run is suspended to continue only from a checkpoint this attempt named
  -- (#1951): record_run_checkpoint names one only for the running attempt at
  -- the state version its start answered, which is the run's until this
  -- complete moves it. Anything else would resume from nothing, or from an
  -- earlier slice whose later sends would then be made again.
  IF p_outcome = 'suspend' AND p_reason = 'continue'
      AND (v_run.status <> 'running' OR v_run.checkpoint_state_version IS DISTINCT FROM v_run.state_version) THEN
    RAISE EXCEPTION 'complete_run_request: a continue suspend needs a checkpoint this attempt named (record_run_checkpoint), and run % names %',
      v_run.id, coalesce(v_run.checkpoint_key, 'none') USING ERRCODE = 'invalid_parameter_value';
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
      continuations = r.continuations + CASE WHEN v_status = 'suspended' AND v_resume = 'continue' THEN 1 ELSE 0 END,
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
-- As #2859's (20261027200000), and an attempt resumed by continue, like one
-- resumed from a wait, was never charged, so is not refunded twice.
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
          -- An attempt resumed by a continuation or from a wait was never charged: refund it once only.
          v_uncharge := NOT EXISTS (SELECT 1 FROM public.workflow_executions e
                                    WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.resume_reason IN ('continue', 'resource_wait', 'rate_limit_wait'));
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
-- As #1948 left them: service_role only. The dropped and created start begins
-- with the platform's default grants, so this matters for it most.
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

RESET lock_timeout;
