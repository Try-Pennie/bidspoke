-- A run returned to the queue before it starts is never out of attempts (#3023).
--
-- WHY. The ops Worker returns a run it has claimed but not started to the
-- queue with the outcome retry when it cannot have the run's definition
-- (definition_unavailable, apps/worker/src/ops/run-live.ts) or its variables
-- (runs_variables_unavailable, apps/worker/src/ops/tick.ts, since #2998).
-- Nothing ran under that claim. But complete_run_request judged every retry
-- against max_attempts, so a run whose charged attempts already equalled
-- max_attempts ended dead as max_attempts on an attempt that never ran. That
-- happens whenever a run's last charged attempt suspended (on a resource wait,
-- a rate limit wait, or to continue) and the claim that resumed it was
-- returned. A run below the cap lost an attempt by a second route: the return
-- rewrote its resume reason to retry, so the start that followed was charged,
-- although it resumed a wait or a continuation that would not have been.
--
-- WHAT. complete_run_request, for a retry of a run still claimed (status
-- claimed: start_run_execution has not succeeded under this claim, so it never
-- started this attempt):
--   never ends it dead as max_attempts; it goes back to the queue at
--                  p_not_before, as a retry always did;
--   keeps its resume reason, so a start resumed from a wait or to continue is
--                  still not charged and still resumes from its checkpoint; a
--                  first claim (NULL) becomes retry, as the sweep makes it,
--                  never NULL (run_requests_overlap_queue_idx);
--   keeps resource_wait_since and resource_wait_cause, so a return does not
--                  restart the 24 hour bound of the wait it is in.
-- That is exactly what sweep_expired_leases already does to an unstarted claim
-- whose lease lapsed, less the lease_requeues count, which bounds lapses only.
-- Every other outcome, and a retry of a run that started (status running),
-- is unchanged, max_attempts judgement included. A new outcome for "return
-- unstarted" was the other way; it needs a Worker change applied after this
-- and leaves the deployed Worker's returns wrong until then, while the
-- database already knows a claimed run never started, so the check lives at
-- the one layer every caller shares (L593). Same arguments and answer, so
-- replaced in place.
--
-- BOUNDS. An unstarted return spends nothing, so nothing in it bounds a run
-- returned again and again. That was already so for every run below its cap;
-- only a run at the cap was ended, and wrongly. What ends such a run is what
-- ended it before: the workflow switched off or deleted (the tick ends it dead
-- unrun), an expiry for a run that never started (20261029120000), and every
-- cap judged once it starts.
--
-- APPLIED BEFORE OR AFTER THE CODE THAT USES IT (L640, ADR 0007). No Worker
-- change goes with it. The ops Worker running when this is applied sends the
-- same arguments and reads the same two columns; the only difference it can
-- see is run_status queued where it was dead for a return at the cap, and
-- neither return site reads it. unstarted_return.test.sql case 6 checks the
-- deployed call. CREATE OR REPLACE keeps the function's owner and grants; they
-- are also set explicitly below, as 20261028220000 does.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: nothing. It replaces one
-- function. A run already ended dead as max_attempts by this fault stays dead.
-- Guarded by supabase-ops/supabase/tests/unstarted_return.test.sql.

SET lock_timeout = '5s';

-- ── complete_run_request ──────────────────────────────────────────────────────
-- As #1951's (20261028220000), and a retry of a run still claimed returns it
-- unstarted: never judged against max_attempts, its resume reason and wait kept.
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
  v_unstarted boolean;
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

  -- A retry of a run still claimed returns it to the queue unstarted (#3023):
  -- nothing ran under this claim, so it spends no attempt, now or later. It is
  -- never judged against max_attempts, and it leaves the run as the claim found
  -- it: the reason it was resumed for (so a start resumed from a wait or to
  -- continue is still not charged; a first start's NULL becomes retry, as the
  -- sweep makes it) and the wait it is in. As sweep_expired_leases returns an
  -- unstarted claim that lapsed.
  v_unstarted := p_outcome = 'retry' AND v_run.status = 'claimed';
  IF v_unstarted THEN
    v_resume := coalesce(v_run.resume_reason, 'retry');
    v_wait_since := v_run.resource_wait_since; v_wait_cause := v_run.resource_wait_cause;
  ELSIF p_outcome = 'retry' AND v_run.attempts - v_run.uncharged_attempts >= v_run.max_attempts THEN
    v_status := 'dead'; v_reason := 'max_attempts'; v_resume := NULL; v_queue := false;
  END IF;
  -- A wait keeps the time it began and records what it waits on now; any other
  -- outcome clears both, except an unstarted return (above), which keeps them.
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

-- ── function privileges ───────────────────────────────────────────────────────
-- As #1948 left them: service_role only.
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'complete_run_request'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

RESET lock_timeout;
