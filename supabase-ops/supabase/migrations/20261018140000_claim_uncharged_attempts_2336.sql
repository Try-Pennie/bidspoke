-- The claim answers uncharged_attempts (#2336, phase 6 of #1689; requirement of
-- 2026-10-17 from #2334 deploy 2).
--
-- WHY. Since 20261017230000 (resource_wait) a run is judged against
-- max_attempts by its CHARGED count, attempts - uncharged_attempts: attempts
-- keeps rising on every start, because it is each execution's identity, while
-- a start resumed from a wait on the Salesforce pool, and a lapse the sweep
-- refunds, is not charged. claim_run_requests answered attempts and
-- max_attempts but not uncharged_attempts, so only the database could see the
-- charged count, and a run invocation comparing attempts with max_attempts (to
-- decide a retry is its last) would misjudge every run that waited.
--
-- WHAT. claim_run_requests answers one more column, uncharged_attempts, read
-- from the row it claims. Nothing else about it changes: the same arguments,
-- the same claim, the same rows changed. Whether a retry after the claimed
-- run's start ends it is then, from the answer alone,
--   attempts + 1 - uncharged_attempts - (1 if resume_reason is resource_wait) >= max_attempts,
-- the judgement complete_run_request makes; lastChargedAttempt in
-- apps/worker/src/ops/ops-writes.ts is the Worker's copy, and
-- claim_uncharged_attempts.test.sql checks it against the database.
--
-- APPLIED BEFORE OR AFTER THE CODE THAT READS IT (L640, ADR 0007). The ops
-- Worker running when this is applied sends the same four arguments and reads
-- fifteen answer columns, all still answered; PostgREST answers rows as JSON by
-- name, so one more column is ignored. The Worker that reads the new column
-- accepts an answer without it as unknown (unchargedAttempts null), so it also
-- works against the function this replaces. claim_uncharged_attempts.test.sql
-- case 4 checks the deployed call by name.
--
-- A function's answer gains a column only by DROP and CREATE (CREATE OR
-- REPLACE refuses a changed result type). Both run in this one transaction
-- with the same arguments, so no caller can see the function absent. A created
-- function takes the default privileges the first migration set (service_role
-- only); its grants are also set explicitly below, as 20261017230000 does, so
-- they do not rest on those defaults alone.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: nothing. It replaces a function.

SET lock_timeout = '5s';

-- ── claim_run_requests ────────────────────────────────────────────────────────
-- As #1948's (20261016200000), answering uncharged_attempts as well.
DROP FUNCTION public.claim_run_requests(text, integer, integer, integer);
CREATE FUNCTION public.claim_run_requests(
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

    -- A run past its expiry is never started (#1698 D4).
    UPDATE public.run_requests r
    SET status = 'expired', status_reason = 'not_started_in_time', terminal_at = v_now, updated_at = v_now, state_version = r.state_version + 1
    WHERE r.id = ANY (v_ids) AND r.status IN ('queued', 'suspended') AND r.expires_at IS NOT NULL AND r.expires_at <= v_now;

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

-- ── function privileges ───────────────────────────────────────────────────────
-- As #1948 left them: service_role only (run_engine_schema.test.sql checks the
-- effective privileges, which the defaults alone already give).
REVOKE ALL ON FUNCTION public.claim_run_requests(text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_run_requests(text, integer, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

RESET lock_timeout;
