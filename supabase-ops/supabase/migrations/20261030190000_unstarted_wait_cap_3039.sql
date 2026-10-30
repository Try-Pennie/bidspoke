-- A run returned to the queue unstarted is given up after 1 hour of waiting (#3039).
--
-- WHY. The ops Worker returns a run it has claimed but not started to the
-- queue when it cannot have the run's definition (definition_unavailable,
-- apps/worker/src/ops/run-live.ts) or its variables (variables_unavailable,
-- apps/worker/src/ops/tick.ts). Since #3023 (20261029230000) such a return
-- spends nothing and is never judged against max_attempts, so a run whose
-- definition or variables stay unavailable was claimed and returned once a
-- minute for ever. Dan's decision of 2026-10-30, recorded on #3039: such a run
-- is given up after 1 hour of waiting, and ends failed by a named reason.
--
-- THE HOUR. Measured on the database clock (now(), the transaction's time, as
-- every other wait in complete_run_request is) from the run's FIRST unstarted
-- return since it last started, never from when it was enqueued. The enqueue
-- time also holds time the run waited for its own not_before, behind the claim
-- limits, in a resource or rate limit wait, or ran earlier attempts, none of
-- which is a wait to start, so a run delayed for those reasons would be given up
-- on its first unstarted return. A count of returns would drift with how often
-- the tick claims. The wait is the run's while its attempts stand where they
-- were at its first return: attempts rises at every start (start_run_execution)
-- and at nothing else, so a start ends the wait on every path, the lease sweep's
-- requeue of a started run included, with no change to either function.
--
-- WHAT.
--   run_requests   unstarted_returns, every unstarted return the run has had,
--                  as lease_requeues counts lapsed claims; unstarted_since,
--                  when its current wait began; unstarted_since_attempts, its
--                  attempts then; unstarted_cause, the cause the latest return
--                  named (NULL when none was named). The status reason CHECK,
--                  as 20261030160000 (#3046) left it, gains
--                  unstarted_wait_exceeded, a reason only the engine fails a
--                  run for.
--   complete_run_request  a retry may name its cause in p_reason:
--                  definition_unavailable or variables_unavailable, nothing else.
--                  A retry of a run still claimed (an unstarted return, #3023)
--                  is counted and records its wait; once the wait has lasted 1
--                  hour (v_unstarted_wait_max) the return ends the run failed
--                  with unstarted_wait_exceeded instead, its error naming the
--                  cause, the returns and when the wait began. A cause on the
--                  retry of a started run is neither counted nor recorded.
--                  Nothing else changes. Same arguments and answer, so replaced
--                  in place.
--   unstarted_run_waits  read only, lane wide: per workflow, the runs waiting
--                  to start (queued or claimed again, in a wait no start has
--                  ended) whose wait has lasted at least p_min_wait_seconds, the
--                  oldest wait's start and length, and the causes, oldest wait
--                  first. The ops tick pages from it at 15 minutes.
--   run_requests_unstarted_wait_idx  the runs in a wait, for that read.
--
-- APPLIED BEFORE THE CODE THAT USES IT (L640, ADR 0007). Expand only. The ops
-- Worker running when this is applied sends the same arguments to
-- complete_run_request (a retry with no p_reason) and reads the same columns:
-- its return is counted with a NULL cause and given up past the hour, so the
-- bound holds from the moment this is applied (unstarted_wait_cap.test.sql
-- case 6). It calls neither new object. The Worker that names causes and reads
-- unstarted_run_waits needs this applied first; Deploy's check for unapplied
-- ops migrations refuses to deploy it until then. CREATE OR REPLACE keeps
-- complete_run_request's owner and grants; they are also set explicitly below.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS. The new columns are added with a
-- constant default (unstarted_returns 0) or none, which Postgres records in the
-- catalogue without rewriting a row. The CHECKs scan run_requests once to
-- validate, which every row passes (the columns are new). The index builds on
-- no row (no run is in a wait yet), holding a SHARE lock on run_requests while
-- it scans; the lane runs in observe mode (OPS_TICK_MODE unset), which claims
-- nothing, so the table is near empty. The functions change no rows. A run
-- already waiting when this is applied begins its wait at its next return.
-- Guarded by supabase-ops/supabase/tests/unstarted_wait_cap.test.sql.

SET lock_timeout = '5s';

-- ── run_requests ──────────────────────────────────────────────────────────────
ALTER TABLE public.run_requests
  ADD COLUMN IF NOT EXISTS unstarted_returns integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unstarted_since timestamptz,
  ADD COLUMN IF NOT EXISTS unstarted_since_attempts integer,
  ADD COLUMN IF NOT EXISTS unstarted_cause text;

ALTER TABLE public.run_requests
  ADD CONSTRAINT run_requests_unstarted_returns_check CHECK (unstarted_returns >= 0),
  ADD CONSTRAINT run_requests_unstarted_since_check CHECK ((unstarted_since IS NULL) = (unstarted_since_attempts IS NULL)),
  -- Its one TypeScript home is UNSTARTED_RETURN_CAUSES in apps/worker/src/ops/run-vocabulary.ts.
  ADD CONSTRAINT run_requests_unstarted_cause_check CHECK (unstarted_cause IS NULL OR unstarted_cause IN
    ('definition_unavailable', 'variables_unavailable')),
  DROP CONSTRAINT run_requests_status_reason_check,
  ADD CONSTRAINT run_requests_status_reason_check CHECK (status_reason IS NULL OR status_reason IN
    ('workflow_inactive', 'workflow_deleted', 'halted_by_rule', 'lease_requeue_cap', 'max_attempts',
     'lease_expired_after_send', 'send_outcome_unknown',
     'paused', 'rate_limited', 'overlap',
     'not_started_in_time',
     'max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded',
     'resource_wait_exceeded', 'lease_lapsed_repeatedly', 'requeue_cap_reached',
     'retry_disabled', 'lease_lapsed_no_retry', 'unstarted_wait_exceeded'));

-- The runs in a wait to start, for unstarted_run_waits. A wait a start has
-- ended stays in it until the run's next return or end; the read filters those.
CREATE INDEX IF NOT EXISTS run_requests_unstarted_wait_idx ON public.run_requests (unstarted_since)
  WHERE unstarted_since IS NOT NULL AND status IN ('queued', 'claimed');

-- ── complete_run_request ──────────────────────────────────────────────────────
-- As #3013's (20261029233000), and an unstarted return is counted, records its
-- wait and its cause, and gives the run up once the wait has lasted 1 hour.
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
  -- The wait to start (#3039): OPS_UNSTARTED_WAIT_MAX_MS in run-vocabulary.ts.
  v_unstarted_wait_max CONSTANT interval := interval '3600 seconds';
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
  v_unstarted_since timestamptz := NULL;
BEGIN
  CASE p_outcome
    WHEN 'done' THEN v_status := 'done'; v_exec_status := 'success';
    WHEN 'failed' THEN
      -- resource_wait_exceeded, lease_lapsed_repeatedly, requeue_cap_reached and
      -- unstarted_wait_exceeded are not here: only the engine ends a run for
      -- them (F122). retry_disabled is the holder's: the workflow is set not to
      -- retry (#3013).
      IF p_reason IS NOT NULL AND p_reason NOT IN ('max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded', 'retry_disabled') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run fails for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'failed'; v_reason := p_reason; v_exec_status := 'failed';
    WHEN 'retry' THEN
      -- A return unstarted names why the run could not start (#3039).
      IF p_reason IS NOT NULL AND p_reason NOT IN ('definition_unavailable', 'variables_unavailable') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a cause a run is returned unstarted for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'queued'; v_resume := 'retry'; v_queue := true; v_exec_status := 'failed';
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
    -- Its wait to start (#3039) began at its first unstarted return since it
    -- last started: a start raises attempts, which ends the wait it was in.
    v_unstarted_since := CASE WHEN v_run.unstarted_since IS NOT NULL AND v_run.unstarted_since_attempts = v_run.attempts
                              THEN v_run.unstarted_since ELSE v_now END;
    IF v_now - v_unstarted_since >= v_unstarted_wait_max THEN
      v_status := 'failed'; v_reason := 'unstarted_wait_exceeded'; v_resume := NULL; v_queue := false; v_exec_status := 'failed';
      v_wait_since := NULL; v_wait_cause := NULL;
      v_error := format('unstarted_wait_exceeded: %s (%s). The run was returned to the queue unstarted %s times since %s, and a run may wait at most %s minutes to start',
        coalesce(p_error, 'it was returned unstarted'), coalesce(p_reason, 'no cause named'), v_run.unstarted_returns + 1,
        to_char(v_unstarted_since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), (extract(epoch FROM v_unstarted_wait_max) / 60)::integer);
    END IF;
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
      unstarted_returns = r.unstarted_returns + CASE WHEN v_unstarted THEN 1 ELSE 0 END,
      unstarted_since = CASE WHEN v_unstarted THEN v_unstarted_since ELSE r.unstarted_since END,
      unstarted_since_attempts = CASE WHEN v_unstarted THEN r.attempts ELSE r.unstarted_since_attempts END,
      unstarted_cause = CASE WHEN v_unstarted THEN p_reason ELSE r.unstarted_cause END,
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

-- ── unstarted_run_waits ───────────────────────────────────────────────────────
-- Per workflow, the runs waiting to start whose wait has lasted at least
-- p_min_wait_seconds on the database clock, oldest wait first, at most p_limit
-- workflows. A run waits to start while it is queued or claimed again in a wait
-- no start has ended (its attempts still those its wait began at). causes is
-- each distinct cause the runs' latest returns named, NULL for a return that
-- named none. Lane wide: each row carries its organization.
CREATE FUNCTION public.unstarted_run_waits(p_min_wait_seconds integer, p_limit integer)
RETURNS TABLE (organization_id uuid, workflow_id uuid, runs integer, oldest_since timestamptz, waited_seconds integer, causes text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_min_wait_seconds IS NULL OR p_min_wait_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'unstarted_run_waits: the minimum wait must be 0 to 86400 seconds, not %', p_min_wait_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'unstarted_run_waits: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT r.organization_id, r.workflow_id, count(*)::integer, min(r.unstarted_since),
         floor(extract(epoch FROM now() - min(r.unstarted_since)))::integer,
         array_agg(DISTINCT r.unstarted_cause ORDER BY r.unstarted_cause)
  FROM public.run_requests r
  WHERE r.unstarted_since IS NOT NULL AND r.status IN ('queued', 'claimed')
    AND r.unstarted_since_attempts = r.attempts
    AND r.unstarted_since <= now() - make_interval(secs => p_min_wait_seconds)
  GROUP BY r.organization_id, r.workflow_id
  ORDER BY min(r.unstarted_since), r.workflow_id
  LIMIT p_limit;
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
    WHERE n.nspname = 'public' AND p.proname IN ('complete_run_request', 'unstarted_run_waits')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

RESET lock_timeout;
