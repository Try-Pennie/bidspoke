-- An ops run records the variables it started with (#2998, phase 2 of #2982).
--
-- Dan, 2026-10-28 and 29: an ops run reads each variable's current value when
-- it starts, secrets included, and ops never stores a secret's value. The tick
-- asks the bidding Worker for a claimed run's variables and carries them in
-- that run's signed dispatch. This is where the run keeps what it started with,
-- so "what did run R send with" can be answered, and so every retry and every
-- continued slice (#1951) uses the same plain values.
--
--   run_requests.run_variables  null until the run's first start, then
--                        { source, served_at, values, secret_keys }: where the
--                        values came from (the bidding Worker, or in phase 3
--                        the copy ops keeps), when they were served, the plain
--                        values, and the NAMES of the secrets the run read.
--                        Never a secret's value: the shape is held by a CHECK
--                        (run_variables_shape_ok), which allows no other key.
--   start_run_execution  takes p_variables (DEFAULT NULL) and keeps it on the
--                        run's first start only (coalesce), so a retry or a
--                        continuation never replaces it; refuses by name one
--                        of the wrong shape; and answers the run's record as a
--                        fifth column, run_variables, on started and
--                        already_started.
--   purge_run_variables  clears the record of runs terminal more than 7 days,
--                        a page at a time, the same window as a run's step
--                        records (#2703). The ops tick runs it in the nightly
--                        observation_purge sweep. A run kept by a person
--                        (kept_by) keeps it.
--
-- APPLIED BEFORE THE CODE THAT USES IT (L640, ADR 0007). The ops Worker running
-- when this is applied sends the four arguments it always sent, which leave
-- p_variables null, and reads its columns by name, so it works unchanged. The
-- Worker that sends p_variables needs this applied first: it refuses a start
-- answered without run_variables, by name (ops-writes.ts).
-- run_variables.test.sql case 7 checks the deployed call.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: one nullable column with no
-- default (every row null, which its CHECK accepts) and one partial index over
-- no row; the functions change no rows.
-- Guarded by supabase-ops/supabase/tests/run_variables.test.sql.

SET lock_timeout = '5s';

-- ── the shape ─────────────────────────────────────────────────────────────────
-- Exactly { source, served_at, values, secret_keys }: values an object of
-- variable names to text, secret_keys an array of variable names, none also
-- among the values, served_at text that reads as a time. The source's list sits
-- in the CHECK itself, where the vocabulary test reads it (RUN_VARIABLE_SOURCES).
-- Each test in turn, so no jsonb function is ever called on the wrong type, and
-- never null: a CHECK passes a null.
CREATE FUNCTION public.run_variables_shape_ok(p jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $fn$
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN false; END IF;
  IF (SELECT array_agg(k COLLATE "C" ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) k)
     IS DISTINCT FROM ARRAY['secret_keys', 'served_at', 'source', 'values'] COLLATE "C" THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p -> 'source') <> 'string' OR jsonb_typeof(p -> 'served_at') <> 'string'
     OR (p ->> 'served_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p -> 'values') <> 'object' OR jsonb_typeof(p -> 'secret_keys') <> 'array' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(p -> 'values') e WHERE e.key !~ '^[A-Za-z0-9_]+$' OR jsonb_typeof(e.value) <> 'string') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'secret_keys') s WHERE jsonb_typeof(s) <> 'string' OR (s #>> '{}') !~ '^[A-Za-z0-9_]+$') THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p -> 'secret_keys') s WHERE (p -> 'values') ? s) THEN RETURN false; END IF;
  RETURN octet_length(p::text) <= 262144;
END
$fn$;
-- Executed only by the CHECK and the definer start, both as the owner: no role is given it.
REVOKE ALL ON FUNCTION public.run_variables_shape_ok(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ── run_requests ──────────────────────────────────────────────────────────────
ALTER TABLE public.run_requests
  ADD COLUMN run_variables jsonb,
  ADD CONSTRAINT run_requests_run_variables_check CHECK (run_variables IS NULL OR (
    coalesce((run_variables ->> 'source') IN ('bidding', 'copy'), false) AND public.run_variables_shape_ok(run_variables)));

-- The purge's walk: only records still held, so it shrinks as it purges.
CREATE INDEX run_requests_run_variables_purge_idx ON public.run_requests (terminal_at, id)
  WHERE run_variables IS NOT NULL AND terminal_at IS NOT NULL AND kept_by IS NULL;

-- ── start_run_execution ───────────────────────────────────────────────────────
-- As #1951's (20261028220000), and it keeps the variables the run started with.
DROP FUNCTION public.start_run_execution(uuid, uuid, uuid, uuid);
CREATE FUNCTION public.start_run_execution(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_execution_id     uuid,
  p_variables        jsonb DEFAULT NULL
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
      run_variables = coalesce(r.run_variables, p_variables)
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

-- ── purge_run_variables ───────────────────────────────────────────────────────
CREATE FUNCTION public.purge_run_variables(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - interval '7 days';
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_run_variables: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH old AS (
    SELECT r.id FROM public.run_requests r
    WHERE r.run_variables IS NOT NULL AND r.terminal_at IS NOT NULL AND r.kept_by IS NULL AND r.terminal_at <= v_cutoff
    ORDER BY r.terminal_at, r.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), cleared AS (
    UPDATE public.run_requests r SET run_variables = NULL FROM old WHERE r.id = old.id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM cleared;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
-- service_role only, as #1948 left the run engine's. The dropped and created
-- start begins with the platform's default grants, so this matters for it most.
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('start_run_execution', 'purge_run_variables')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

RESET lock_timeout;
