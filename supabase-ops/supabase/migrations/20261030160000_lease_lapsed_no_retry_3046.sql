-- A run set not to retry is never requeued when its lease lapses (#3046).
--
-- WHY. A workflow whose retry setting is { mode: 'none' } (#2992,
-- packages/workflow-definition/src/retry.ts) ends its run at the first real
-- failure, but only the ops Worker knew that: the database never learned the
-- setting. So when a running attempt's lease lapsed, sweep_expired_leases put
-- the run back in the queue like any other: refunded when the attempt sent
-- nothing, charged up to max_attempts when it made idempotent sends. A no-retry
-- run that stalled after sending could send again.
--
-- Dan, 2026-10-30, on #3046: such a run ends failed, as stalled, with a named
-- reason, and pages if the workflow is live. It is never requeued, whether or
-- not it sent anything.
--
-- WHAT.
--   run_requests.retry_disabled  boolean, NOT NULL, false by default: the run's
--                 workflow is set not to retry. Written by start_run_execution
--                 from what the Worker read at the run's version (run-live.ts,
--                 retryPolicyOf), the one reader of the setting, so the
--                 database never parses the definition itself. A start is the
--                 only way a run becomes running, which is the only status
--                 whose lapse retries, so the setting is always there when
--                 the sweep needs it. A flag rather than max_attempts = 1: a
--                 lapse with nothing sent is refunded and never reaches
--                 max_attempts, and the run must fail by its own name, not
--                 end dead at max_attempts.
--   run_requests  the status reason CHECK gains lease_lapsed_no_retry, a reason
--                 only the sweep ends a run for (F122): complete_run_request's
--                 guard is unchanged and refuses it from a holder.
--   start_run_execution  takes p_retry_disabled (DEFAULT NULL) and keeps it on
--                 the run; NULL, the start of a Worker that sends none, leaves
--                 what the run holds. Dropped and created, since its
--                 arguments change; it answers as before.
--   sweep_expired_leases  a running attempt of a run with retry_disabled that
--                 lapsed ends failed, lease_lapsed_no_retry, refunding and
--                 charging nothing, whatever it sent. That includes a send that
--                 cannot be repeated, which on any other run waits for a person
--                 (lease_expired_after_send): Dan, 2026-10-30, it ends failed by
--                 the same reason and still pages at once. A claim that never
--                 started is returned to the queue unrun, as before (#3023):
--                 nothing ran. It answers two new columns: no_retry_workflow_ids,
--                 the workflow of each run it ended this way, and
--                 no_retry_after_send_workflow_ids, the workflow of each of
--                 those that had made a send that cannot be repeated, since the
--                 run's own record no longer says a send may have landed; the
--                 tick pages from both (tick.ts). Dropped and created, since its
--                 answer changes; it takes the same argument.
--
-- APPLIED BEFORE THE CODE THAT USES IT (L640, ADR 0007). Expand only. The ops
-- Worker running when this is applied (main at f041892d4):
--   * starts runs with the five arguments it always sent, which leave
--     retry_disabled false, so every lapse is swept exactly as before;
--   * reads the sweep's six columns by name and ignores the two new ones;
--   * never sends lease_lapsed_no_retry.
-- lease_lapsed_no_retry.test.sql case 7 checks the deployed calls; cases 1 and
-- 5 that a start with no setting sweeps as before. The Worker that sends
-- p_retry_disabled and reads no_retry_workflow_ids needs this applied first;
-- it refuses a sweep answer without that column, by name (ops-writes.ts), and
-- Deploy's check for unapplied ops migrations refuses to deploy it until then.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: one column with a constant
-- default (no rewrite: every existing row reads false, which is what it was
-- before, the default retry setting), the CHECK swapped for a wider list that
-- every row already satisfies, and two functions replaced, which change no
-- rows. A run running when this is applied holds false, so if its lease lapses
-- it is swept as before; only runs started by the new Worker carry the setting.
-- Guarded by supabase-ops/supabase/tests/lease_lapsed_no_retry.test.sql.

SET lock_timeout = '5s';

-- ── run_requests ──────────────────────────────────────────────────────────────
ALTER TABLE public.run_requests
  ADD COLUMN retry_disabled boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT run_requests_status_reason_check,
  ADD CONSTRAINT run_requests_status_reason_check CHECK (status_reason IS NULL OR status_reason IN
    ('workflow_inactive', 'workflow_deleted', 'halted_by_rule', 'lease_requeue_cap', 'max_attempts',
     'lease_expired_after_send', 'send_outcome_unknown',
     'paused', 'rate_limited', 'overlap',
     'not_started_in_time',
     'max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded',
     'resource_wait_exceeded', 'lease_lapsed_repeatedly', 'requeue_cap_reached',
     'retry_disabled', 'lease_lapsed_no_retry'));

-- ── start_run_execution ───────────────────────────────────────────────────────
-- As #2998's (20261029180000), and it keeps the run's retry setting.
DROP FUNCTION public.start_run_execution(uuid, uuid, uuid, uuid, jsonb);
CREATE FUNCTION public.start_run_execution(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_execution_id     uuid,
  p_variables        jsonb DEFAULT NULL,
  p_retry_disabled   boolean DEFAULT NULL
) RETURNS TABLE (outcome text, state_version bigint, attempt integer, continuations integer, run_variables jsonb)
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
  IF p_variables IS NOT NULL AND NOT (coalesce((p_variables ->> 'source') IN ('bidding', 'copy'), false) AND public.run_variables_shape_ok(p_variables)) THEN
    RAISE EXCEPTION 'start_run_execution: p_variables is not { source, served_at, values, secret_keys } (a secret''s value is never kept)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.run_requests r
  SET status = 'running', attempts = r.attempts + 1,
      uncharged_attempts = r.uncharged_attempts + CASE WHEN r.resume_reason IN ('continue', 'resource_wait', 'rate_limit_wait') THEN 1 ELSE 0 END,
      state_version = r.state_version + 1, updated_at = v_now,
      -- The first start's record wins: a retry or a continuation never replaces it.
      run_variables = coalesce(r.run_variables, p_variables),
      -- The setting the Worker read at the run's version (#3046); none sent keeps what the run holds.
      retry_disabled = coalesce(p_retry_disabled, r.retry_disabled)
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token
    AND r.status = 'claimed' AND r.claim_expires_at > v_now
  RETURNING r.* INTO v_run;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.workflow_executions e JOIN public.run_requests r ON r.id = e.run_request_id
               WHERE e.id = p_execution_id AND r.id = p_run_request_id AND r.organization_id = p_organization_id
                 AND r.claim_token = p_claim_token AND r.status = 'running') THEN
      RETURN QUERY SELECT 'already_started'::text, r.state_version, r.attempts, r.continuations, r.run_variables
        FROM public.run_requests r WHERE r.id = p_run_request_id;
    ELSE
      RETURN QUERY SELECT 'claim_lost'::text, NULL::bigint, NULL::integer, NULL::integer, NULL::jsonb;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.workflow_executions (id, organization_id, run_request_id, execution_chain_id, attempt, workflow_id, workflow_version,
    trigger_type, status, resume_reason, resumed_from_execution_id, started_at)
  VALUES (p_execution_id, v_run.organization_id, v_run.id, v_run.execution_chain_id, v_run.attempts, v_run.workflow_id, v_run.workflow_version,
    v_run.trigger_kind, 'running', v_run.resume_reason, v_run.resumed_from_execution_id, v_now);
  RETURN QUERY SELECT 'started'::text, v_run.state_version, v_run.attempts, v_run.continuations, v_run.run_variables;
END
$fn$;

-- ── sweep_expired_leases ──────────────────────────────────────────────────────
-- As #1951's (20261028220000), and a lapsed attempt of a run set not to retry
-- ends failed rather than going back to the queue.
DROP FUNCTION public.sweep_expired_leases(integer);
CREATE FUNCTION public.sweep_expired_leases(p_limit integer)
RETURNS TABLE (requeued integer, retried integer, needs_human integer, dead integer, failed integer, more boolean,
  no_retry_workflow_ids uuid[], no_retry_after_send_workflow_ids uuid[])
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
  v_no_retry uuid[] := '{}';
  v_no_retry_sent uuid[] := '{}';
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
    SELECT r.id, r.workflow_id, r.status, r.attempts, r.uncharged_attempts, r.lapse_refunds, r.max_attempts, r.lease_requeues, r.retry_disabled
    FROM public.run_requests r
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
      IF v_run.retry_disabled THEN
        -- Set not to retry (#3046): never requeued, sent or not, and never left
        -- for a person either (Dan, 2026-10-30). A send that cannot be repeated
        -- is named to the tick, whose page says it may have landed.
        v_status := 'failed'; v_reason := 'lease_lapsed_no_retry'; v_failed := v_failed + 1;
        v_no_retry := v_no_retry || v_run.workflow_id;
        IF EXISTS (SELECT 1 FROM public.send_ledger l WHERE l.run_request_id = v_run.id AND NOT l.idempotent) THEN
          v_no_retry_sent := v_no_retry_sent || v_run.workflow_id;
        END IF;
      ELSIF EXISTS (SELECT 1 FROM public.send_ledger l WHERE l.run_request_id = v_run.id AND NOT l.idempotent) THEN
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
  RETURN QUERY SELECT v_requeued, v_retried, v_human, v_dead, v_failed, v_seen = p_limit, v_no_retry, v_no_retry_sent;
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
-- service_role only, as #1948 left the run engine's. Both were dropped and
-- created, so each begins with the platform's default grants.
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('start_run_execution', 'sweep_expired_leases')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

NOTIFY pgrst, 'reload schema';

RESET lock_timeout;
