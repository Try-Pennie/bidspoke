-- Only a run that has never started expires (#1951, Dan's decision of
-- 2026-10-28, recorded on the issue).
--
-- WHY. A run's expires_at says how late it may still START (#1698 D4), and the
-- reason it ends with says so: not_started_in_time. But claim_run_requests and
-- expire_overdue_run_requests expired every queued or suspended run past it,
-- which includes a run that has already started and now waits: on a retry, on a
-- wake, on a Salesforce resource, on a rate limit, or between two slices of a
-- continuation (20261028220000). Such a run would end expired, with sends
-- already made, under a reason saying it never started. Dan's answer: only a
-- run that has never started (attempts = 0) may expire as not_started_in_time;
-- a run that has started finishes, fails, or stops on its own caps.
--
-- WHAT. Each function expires a run past its expiry only when its attempts is
-- 0. attempts rises at every start (start_run_execution) and at nothing else,
-- so 0 is exactly "never started": a run claimed whose claim lapsed before its
-- start, or one suspended on a resource wait before its start, is still 0 and
-- still expires.
--   claim_run_requests           a started run past its expiry that the claim
--                  picks is claimed like any other, so it runs again. Same
--                  arguments and answer, so replaced in place.
--   expire_overdue_run_requests  a started run past its expiry is not selected,
--                  so it neither ends nor leaves the queue, and it does not
--                  use up a page: the page is filled from runs that may expire.
--                  Its final UPDATE needs no copy of the condition: it reaches
--                  only runs whose queue row this call deleted, and attempts
--                  moves only at a start, which needs a claim, which takes the
--                  queue row first. Same argument and answer, so replaced in
--                  place.
--
-- BOUNDS. What ends a started run instead, each already in force:
--   a retry           max_attempts, judged on the charged count
--                     (complete_run_request and sweep_expired_leases end it
--                     dead with max_attempts);
--   a wake            nothing yet: no Worker code suspends with wake today. Its
--                     start is charged, but max_attempts is judged only on a
--                     retry, so the step that first sends a wake must bring
--                     its own cap (#1951 hand back);
--   a resource wait   24 hours from the first wait, then failed with
--                     resource_wait_exceeded (complete_run_request);
--   a rate limit wait 10 waits per step, none waking more than 6 hours after
--                     the step's first, then failed with requeue_cap_reached;
--   a continuation    the whole run's step cap, OPS_WALK_MAX_STEPS (200), then
--                     failed with max_steps_exceeded (run-walk.ts), since every
--                     slice walks at least one step;
--   any lapse         3 refunded lapses (lease_lapsed_repeatedly) and 3
--                     lapses of an unstarted claim (lease_requeue_cap).
-- Every one of those is judged only when the run is claimed and completes
-- again. A started run that nothing claims (the ops tick in observe mode, or
-- its live claim held) waits until claiming resumes; before this change an
-- expiry, where one was set, would have ended it. No code sets an expiry today
-- (enqueueRunRequest and recordScheduleFire send p_expires_at only when a
-- caller passes one, and none does).
--
-- APPLIED BEFORE OR AFTER THE CODE THAT USES IT (L640, ADR 0007). No Worker
-- change goes with it. The ops Worker running when this is applied sends the
-- same arguments to both functions and reads the same columns, all still
-- answered; expire_only_unstarted.test.sql case 5 checks the deployed calls.
-- CREATE OR REPLACE keeps each function's owner and grants; they are also set
-- explicitly below, as 20261028220000 does.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: nothing. It replaces two
-- functions. Guarded by supabase-ops/supabase/tests/expire_only_unstarted.test.sql.

SET lock_timeout = '5s';

-- ── claim_run_requests ────────────────────────────────────────────────────────
-- As #2336's (20261018140000), and only a run that has never started expires.
CREATE OR REPLACE FUNCTION public.claim_run_requests(
  p_worker         text,
  p_limit          integer,
  p_per_workflow   integer,
  p_lease_seconds  integer
) RETURNS TABLE (
  run_request_id uuid, organization_id uuid, workflow_id uuid, workflow_version integer, trigger_kind text,
  claim_token uuid, claim_expires_at timestamptz, state_version bigint, attempts integer, max_attempts integer,
  resume_reason text, execution_chain_id uuid, resumed_from_execution_id uuid, payload jsonb, payload_ref text,
  uncharged_attempts integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_left integer;
  v_wf uuid;
  v_active integer;
  v_head_limit integer;
  v_take integer;
  v_ids uuid[];
  v_rows integer;
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'claim_run_requests: a worker name of 1 to 200 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'claim_run_requests: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_per_workflow IS NULL OR p_per_workflow NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'claim_run_requests: per workflow must be 1 to 1000, not %', p_per_workflow USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'claim_run_requests: lease must be 10 to 300 seconds, not %', p_lease_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_left := p_limit;

  FOR v_wf IN
    SELECT q.workflow_id FROM public.run_queue q
    WHERE q.not_before <= v_now
    GROUP BY q.workflow_id
    ORDER BY max(q.priority) DESC, min(q.created_at), q.workflow_id
    LIMIT 1000
  LOOP
    EXIT WHEN v_left <= 0;
    -- Another claimer holds this workflow: skip it, as SKIP LOCKED skips a row.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('run_claim:' || v_wf::text, 0));

    SELECT count(*) INTO v_active FROM public.run_requests r WHERE r.workflow_id = v_wf AND r.status IN ('claimed', 'running');
    SELECT q.concurrency_limit INTO v_head_limit FROM public.run_queue q
    WHERE q.workflow_id = v_wf AND q.not_before <= v_now
    ORDER BY q.priority DESC, q.created_at, q.run_request_id LIMIT 1;
    v_take := least(p_per_workflow, v_left, coalesce(v_head_limit - v_active, p_per_workflow));
    CONTINUE WHEN v_take <= 0;

    WITH picked AS (
      SELECT q.run_request_id FROM public.run_queue q
      WHERE q.workflow_id = v_wf AND q.not_before <= v_now
      ORDER BY q.priority DESC, q.created_at, q.run_request_id
      LIMIT v_take
      FOR UPDATE SKIP LOCKED
    ), gone AS (
      DELETE FROM public.run_queue q USING picked WHERE q.run_request_id = picked.run_request_id RETURNING q.run_request_id
    )
    SELECT array_agg(gone.run_request_id ORDER BY gone.run_request_id) INTO v_ids FROM gone;
    CONTINUE WHEN v_ids IS NULL;

    -- A run past its expiry is never started (#1698 D4). Only one that has
    -- never started expires (#1951): a started one is claimed below and runs on
    -- to its own caps.
    UPDATE public.run_requests r
    SET status = 'expired', status_reason = 'not_started_in_time', terminal_at = v_now, updated_at = v_now, state_version = r.state_version + 1
    WHERE r.id = ANY (v_ids) AND r.status IN ('queued', 'suspended') AND r.expires_at IS NOT NULL AND r.expires_at <= v_now
      AND r.attempts = 0;

    RETURN QUERY
    WITH claimed AS (
      UPDATE public.run_requests r
      SET status = 'claimed', claimed_by = p_worker, claim_token = gen_random_uuid(), claimed_at = v_now,
          claim_expires_at = v_now + make_interval(secs => p_lease_seconds), state_version = r.state_version + 1, updated_at = v_now
      WHERE r.id = ANY (v_ids) AND r.status IN ('queued', 'suspended')
      RETURNING r.id, r.organization_id, r.workflow_id, r.workflow_version, r.trigger_kind, r.claim_token, r.claim_expires_at,
        r.state_version, r.attempts, r.max_attempts, r.resume_reason, r.execution_chain_id, r.resumed_from_execution_id, r.payload, r.payload_ref,
        r.uncharged_attempts
    )
    SELECT * FROM claimed;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_left := v_left - v_rows;
  END LOOP;
END
$fn$;

-- ── expire_overdue_run_requests ───────────────────────────────────────────────
-- As #1948's (20261016200000), and only a run that has never started expires.
-- Waiting runs that never started end expired past their expiry, even when no
-- claim reaches them.
-- Takes the queue row first (the lock order the claim keeps).
CREATE OR REPLACE FUNCTION public.expire_overdue_run_requests(p_limit integer)
RETURNS TABLE (expired integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_ids uuid[];
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'expire_overdue_run_requests: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH overdue AS (
    SELECT r.id FROM public.run_requests r
    WHERE r.status IN ('queued', 'suspended') AND r.expires_at IS NOT NULL AND r.expires_at <= v_now
      AND r.attempts = 0
    ORDER BY r.expires_at, r.id
    LIMIT p_limit
  ), locked AS (
    SELECT q.run_request_id FROM public.run_queue q JOIN overdue o ON o.id = q.run_request_id
    FOR UPDATE OF q SKIP LOCKED
  ), gone AS (
    DELETE FROM public.run_queue q USING locked WHERE q.run_request_id = locked.run_request_id RETURNING q.run_request_id
  )
  SELECT array_agg(gone.run_request_id) INTO v_ids FROM gone;

  UPDATE public.run_requests r
  SET status = 'expired', status_reason = 'not_started_in_time', terminal_at = v_now, updated_at = v_now, state_version = r.state_version + 1
  WHERE r.id = ANY (coalesce(v_ids, ARRAY[]::uuid[])) AND r.status IN ('queued', 'suspended');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows, coalesce(array_length(v_ids, 1), 0) = p_limit;
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
-- As #1948 left them: service_role only.
REVOKE ALL ON FUNCTION public.claim_run_requests(text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_run_requests(text, integer, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.expire_overdue_run_requests(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_overdue_run_requests(integer) TO service_role;

NOTIFY pgrst, 'reload schema';
