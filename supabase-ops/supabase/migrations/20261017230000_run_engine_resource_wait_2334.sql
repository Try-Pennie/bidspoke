-- The run engine's resource wait, charged attempts and lapse refund (#2334,
-- phase 4 of #1689, plan: discussion #2329, part 1, Phase 4a P54 and Phase 6
-- P101, finding F122). The SECOND of the phase's two deploys: it replaces three
-- live run engine functions, so it ships apart from the first deploy's new
-- Durable Object class (ADR 0011).
--
-- WHAT.
--   run_requests gains
--     uncharged_attempts  starts not charged against max_attempts. attempts is
--                  still every execution's identity (workflow_executions_attempt_key
--                  and the send ledger's key carry it), so it keeps rising on
--                  every start; what a run is judged by is attempts -
--                  uncharged_attempts (L365).
--     lapse_refunds  how many lapsed attempts with no send were refunded; at
--                  most 3.
--     resource_wait_since, resource_wait_cause  when the run's current wait
--                  for a resource began and what it last waited on. Set by the
--                  first resource_wait suspend, kept by the next ones, cleared
--                  by any other outcome.
--   The resume reason CHECKs (run_requests and workflow_executions) gain
--   resource_wait, and the status reason CHECK gains resource_wait_exceeded and
--   lease_lapsed_repeatedly, both reasons a run fails for.
--
--   complete_run_request  suspend also takes resource_wait, with its cause in
--                  p_error (one of the causes below, so the wait names what it
--                  waited on) and a wake time. A resource_wait suspend more
--                  than 24 hours after the wait began ends the run failed with
--                  resource_wait_exceeded instead (L110): Salesforce's daily
--                  allocation is a rolling 24 hours, so a wait longer than that
--                  is not waiting for capacity to come back. It is judged at
--                  each suspend, so a run waits at most 24 hours plus one wake
--                  interval. A retry is judged against the charged count. The
--                  failed guard a holder passes is UNCHANGED: resource_wait_exceeded
--                  and lease_lapsed_repeatedly are written by the engine alone
--                  (F122), so a holder that names either is refused.
--   start_run_execution  a start whose resume reason is resource_wait is not
--                  charged.
--   sweep_expired_leases  a lapsed attempt that recorded no send in THAT attempt
--                  is refunded (its isolate died before any write, for example
--                  because the ops database was unreachable during acquire),
--                  three times per run; the fourth such lapse ends the run
--                  failed with lease_lapsed_repeatedly, so a run that always
--                  dies early cannot loop for ever. That failure sets
--                  terminal_at (F122): run_requests_terminal_at_check requires
--                  it for every terminal status, and without it one such row
--                  would abort the whole sweep page every minute. A send not
--                  declared idempotent in ANY attempt still goes to needs_human,
--                  judged first, as before. An attempt that was already
--                  uncharged (a resource_wait start) counts against the cap and
--                  is not refunded twice. The sweep's answer gains failed.
--
-- THE CAUSES a resource_wait names: the refusals of acquire_sf_lease
-- (pool_full, workflow_share_full, sf_budget_floor, sf_budget_unmeasured,
-- sf_org_unmeasured, sf_cap_unset) and acquire_error (the acquire call itself
-- failed while the ops database still took the suspend).
--
-- APPLIED BEFORE THE CODE THAT USES IT (L640). The ops Worker running when this
-- is applied never suspends with resource_wait, so for every call it makes:
--   start_run_execution and complete_run_request keep their arguments and their
--   answers, uncharged_attempts stays 0 (so the charged count IS attempts), and
--   resource_wait_since stays NULL: they behave exactly as before;
--   sweep_expired_leases keeps its argument and every column that Worker reads,
--   and answers one more (failed), which it ignores. Its behaviour widens as
--   the plan specifies: a lapse with no send is refunded up to three times, and
--   the fourth ends failed. Production holds no run rows (read 2026-10-17).
-- run_engine_resource_wait.test.sql case 9 checks each deployed call by name.
-- sweep_expired_leases' answer gains a column, which CREATE OR REPLACE cannot
-- do, so it is dropped and created in this one transaction with the same
-- argument: no caller can see it absent.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: the table changes add columns
-- with constant defaults and swap CHECKs on tables that held no rows when this
-- was written; the functions change no rows.

SET lock_timeout = '5s';

-- ── run_requests and workflow_executions ──────────────────────────────────────
ALTER TABLE public.run_requests
  ADD COLUMN uncharged_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN lapse_refunds integer NOT NULL DEFAULT 0,
  ADD COLUMN resource_wait_since timestamptz,
  ADD COLUMN resource_wait_cause text,
  ADD CONSTRAINT run_requests_charged_check CHECK (uncharged_attempts BETWEEN 0 AND attempts AND lapse_refunds BETWEEN 0 AND 3),
  ADD CONSTRAINT run_requests_resource_wait_cause_check CHECK (resource_wait_cause IS NULL OR resource_wait_cause IN
    ('pool_full', 'workflow_share_full', 'sf_budget_floor', 'sf_budget_unmeasured', 'sf_org_unmeasured', 'sf_cap_unset', 'acquire_error')),
  ADD CONSTRAINT run_requests_resource_wait_pair_check CHECK ((resource_wait_since IS NULL) = (resource_wait_cause IS NULL)),
  DROP CONSTRAINT run_requests_status_reason_check,
  ADD CONSTRAINT run_requests_status_reason_check CHECK (status_reason IS NULL OR status_reason IN
    ('workflow_inactive', 'workflow_deleted', 'halted_by_rule', 'lease_requeue_cap', 'max_attempts',
     'lease_expired_after_send', 'send_outcome_unknown',
     'paused', 'rate_limited', 'overlap',
     'not_started_in_time',
     'max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded',
     'resource_wait_exceeded', 'lease_lapsed_repeatedly')),
  DROP CONSTRAINT run_requests_resume_reason_check,
  ADD CONSTRAINT run_requests_resume_reason_check CHECK (resume_reason IS NULL OR resume_reason IN ('continue', 'wake', 'retry', 'resource_wait'));

ALTER TABLE public.workflow_executions
  DROP CONSTRAINT workflow_executions_resume_reason_check,
  ADD CONSTRAINT workflow_executions_resume_reason_check CHECK (resume_reason IS NULL OR resume_reason IN ('continue', 'wake', 'retry', 'resource_wait'));

-- ── start_run_execution ───────────────────────────────────────────────────────
-- As #1948's, and a start resumed from a resource wait is not charged.
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
      uncharged_attempts = r.uncharged_attempts + CASE WHEN r.resume_reason = 'resource_wait' THEN 1 ELSE 0 END,
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
-- (sleeping until p_not_before, p_reason continue, wake or resource_wait,
-- claimed ahead of new starts on waking; a resource_wait names its cause in
-- p_error and ends failed with resource_wait_exceeded once the wait is past 24
-- hours), needs_human, dead (p_reason workflow_inactive, workflow_deleted or
-- halted_by_rule). Answers completed, already_completed (this token already
-- ended it), claim_lost (another holder, or swept) or not_found (no such run in
-- this organization).
CREATE OR REPLACE FUNCTION public.complete_run_request(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_outcome          text,
  p_reason           text DEFAULT NULL,
  p_error            text DEFAULT NULL,
  p_not_before       timestamptz DEFAULT NULL
) RETURNS TABLE (outcome text, run_status text, state_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
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
BEGIN
  CASE p_outcome
    WHEN 'done' THEN v_status := 'done'; v_exec_status := 'success';
    WHEN 'failed' THEN
      -- resource_wait_exceeded and lease_lapsed_repeatedly are not here: only
      -- the engine ends a run for them (F122).
      IF p_reason IS NOT NULL AND p_reason NOT IN ('max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run fails for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'failed'; v_reason := p_reason; v_exec_status := 'failed';
    WHEN 'retry' THEN v_status := 'queued'; v_resume := 'retry'; v_queue := true; v_exec_status := 'failed';
    WHEN 'suspend' THEN
      IF p_reason IS NULL OR p_reason NOT IN ('continue', 'wake', 'resource_wait') THEN
        RAISE EXCEPTION 'complete_run_request: a suspend needs the reason continue, wake or resource_wait, not %', p_reason USING ERRCODE = 'invalid_parameter_value';
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
  v_priority := CASE WHEN v_status = 'suspended' THEN 10 ELSE v_run.priority END;

  UPDATE public.run_requests r
  SET status = v_status, status_reason = v_reason,
      resume_reason = CASE WHEN v_queue THEN v_resume ELSE r.resume_reason END,
      priority = v_priority, not_before = CASE WHEN v_queue THEN coalesce(p_not_before, v_now) ELSE r.not_before END,
      claim_expires_at = NULL, last_error = coalesce(p_error, r.last_error), state_version = r.state_version + 1, updated_at = v_now,
      resource_wait_since = v_wait_since, resource_wait_cause = v_wait_cause,
      terminal_at = CASE WHEN v_status IN ('done', 'failed', 'dead', 'expired', 'skipped') THEN v_now END
  WHERE r.id = v_run.id
  RETURNING r.* INTO v_run;

  IF v_queue THEN
    INSERT INTO public.run_queue (run_request_id, organization_id, workflow_id, not_before, priority, concurrency_limit, created_at)
    VALUES (v_run.id, v_run.organization_id, v_run.workflow_id, v_run.not_before, v_run.priority, v_run.concurrency_limit, v_run.created_at);
  END IF;
  UPDATE public.workflow_executions e SET status = v_exec_status, finished_at = v_now, error = p_error
  WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.status = 'running';

  RETURN QUERY SELECT 'completed'::text, v_run.status, v_run.state_version;
END
$fn$;

-- ── sweep_expired_leases ──────────────────────────────────────────────────────
-- Up to p_limit runs whose lease lapsed, oldest first, skipping any row another
-- sweep or writer holds (so overlapping ticks share the work, and it never waits
-- on the live claim, which locks queue rows, L519). A run claimed but never
-- started is requeued without spending an attempt, three times at most. A run
-- that lapsed mid flight goes to needs_human if it made any send not declared
-- idempotent in any attempt; else, if its lapsed attempt recorded no send at
-- all, that attempt is refunded and the run retried, three times per run, and
-- the fourth such lapse ends it failed with lease_lapsed_repeatedly; else the
-- attempt is charged and the run is retried or ends dead at max_attempts. Every
-- terminal end sets terminal_at (F122). more says a full page was taken, so
-- call again.
DROP FUNCTION public.sweep_expired_leases(integer);
CREATE FUNCTION public.sweep_expired_leases(p_limit integer)
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
          -- An attempt resumed from a resource wait was never charged: refund it once only.
          v_uncharge := NOT EXISTS (SELECT 1 FROM public.workflow_executions e
                                    WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.resume_reason = 'resource_wait');
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
-- As #1948 left them: service_role only. The dropped and created sweep starts
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

NOTIFY pgrst, 'reload schema';

RESET lock_timeout;
