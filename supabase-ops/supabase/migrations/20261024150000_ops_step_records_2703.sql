-- Each step of an ops run, recorded (#2703).
--
-- An ops run recorded only how it ended (run_requests, workflow_executions and
-- the send ledger); the walk held each step's output in memory and wrote none
-- of it, so a failed run did not show what came before the step that failed,
-- and a step could not be tested with a past run's data (#2339).
--
-- Dan decided on 2026-10-24 (recorded on #2703): each step record keeps the
-- step's output with every connection secret removed and a size cap, the same
-- way step test results are kept (#2762, migration 20261024010000), and step
-- records are kept 7 days, deleted with the run they belong to, the same as
-- run history.
--
--  - ops_step_records: one row per step an attempt walked, keyed by the
--    attempt's execution and the step's place in it. The output is what the
--    step answered: connectionFetch scrubs a connection's secrets from every
--    answer before an action reads it, and the run definition may read no
--    environment variable, so no secret reaches it. service_role reads it; it
--    writes only through record_ops_step. Its rows go with their execution, so
--    a run's purge (purge_terminal_run_requests) takes them.
--  - record_ops_step: the holder of the running attempt records one step,
--    fenced by the claim token like every other run write. The steps of an
--    attempt are recorded in order with no gap, so the records of an attempt
--    are always the steps it walked, from the first, and a step missing from
--    them is one the attempt never finished.
--  - run_step_context: what a step test from a past run needs (#2339): the
--    run's payload and the latest completed output of each step before the
--    step's last recorded place (every step, when the run never reached it),
--    within one organization's workflow, and nothing once the attempt is 7 days
--    old by the database clock, whether or not the purge has run yet.
--  - purge_ops_step_records: deletes the records of attempts started more than
--    7 days ago, a page at a time. The ops minute tick runs it in the nightly
--    observation_purge sweep.
--
-- Additive only (ADR 0007): a new table, an index and three new functions.
-- Guarded by supabase-ops/supabase/tests/ops_step_records.test.sql.

SET lock_timeout = '5s';

CREATE TABLE public.ops_step_records (
  execution_id          uuid NOT NULL REFERENCES public.workflow_executions (id) ON DELETE CASCADE,
  -- The step's place in its attempt, from 0. A loop walks a step more than once, each its own place.
  seq                   integer NOT NULL CONSTRAINT ops_step_records_seq_check CHECK (seq BETWEEN 0 AND 999),
  organization_id       uuid NOT NULL,
  run_request_id        uuid NOT NULL,
  workflow_id           uuid NOT NULL,
  -- The attempt's start, copied from its execution: the 7 days are counted from it.
  execution_started_at  timestamptz NOT NULL,
  node_id               text NOT NULL CONSTRAINT ops_step_records_node_id_check CHECK (length(node_id) BETWEEN 1 AND 200),
  namespace             text NOT NULL CONSTRAINT ops_step_records_namespace_check CHECK (length(namespace) BETWEEN 1 AND 200),
  step_type             text NOT NULL CONSTRAINT ops_step_records_step_type_check CHECK (length(step_type) BETWEEN 1 AND 100),
  status                text NOT NULL CONSTRAINT ops_step_records_status_check CHECK (status IN ('completed', 'failed')),
  -- When the step started, on the Worker's clock, and how long it took.
  started_at            timestamptz NOT NULL,
  duration_ms           integer NOT NULL CONSTRAINT ops_step_records_duration_check CHECK (duration_ms >= 0),
  -- What the step answered, scrubbed of the connection's secrets; null for a failure or an answer over the cap.
  output                jsonb,
  -- The answer's size, so one over the cap is named rather than read as empty.
  output_bytes          integer CONSTRAINT ops_step_records_output_bytes_check CHECK (output_bytes IS NULL OR output_bytes >= 0),
  error                 text CONSTRAINT ops_step_records_error_check CHECK (error IS NULL OR length(error) <= 2000),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_step_records_pkey PRIMARY KEY (execution_id, seq),
  -- The same cap as a step's test result: 256 KB of answer in the database's own text form.
  CONSTRAINT ops_step_records_output_size CHECK (output IS NULL OR octet_length(output::text) <= 262144),
  CONSTRAINT ops_step_records_failed_has_error CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX ops_step_records_age_idx ON public.ops_step_records (execution_started_at);
ALTER TABLE public.ops_step_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_step_records FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.ops_step_records FROM service_role;
GRANT SELECT ON public.ops_step_records TO service_role;

-- The holder of the running attempt records one step. Answers recorded,
-- already_recorded (this place already holds this step: a repeat after a lost
-- answer, which changes nothing) or stale (the run is not this holder's running
-- attempt any more: another token, another organization, an attempt that ended,
-- or an execution that is not its current one), and writes nothing then.
-- Refuses by name a place that would leave a gap, or one another step holds.
CREATE FUNCTION public.record_ops_step(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_execution_id     uuid,
  p_seq              integer,
  p_node_id          text,
  p_namespace        text,
  p_step_type        text,
  p_status           text,
  p_started_at       timestamptz,
  p_duration_ms      integer,
  p_output           jsonb,
  -- The size of an answer not kept (p_output null because it was over the cap); ignored when p_output is given.
  p_output_bytes     integer,
  p_error            text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_exec record;
  v_held text;
  v_next integer;
BEGIN
  IF p_organization_id IS NULL OR p_run_request_id IS NULL OR p_claim_token IS NULL OR p_execution_id IS NULL OR p_seq IS NULL
      OR p_node_id IS NULL OR p_namespace IS NULL OR p_step_type IS NULL OR p_status IS NULL OR p_started_at IS NULL OR p_duration_ms IS NULL THEN
    RAISE EXCEPTION 'record_ops_step: organization, run, claim token, execution, place, step, step id, type, status, start and duration are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The run's running attempt under this token. KEY SHARE holds the run against a
  -- complete (FOR UPDATE) until this record commits, but not against the heartbeat.
  SELECT e.started_at, r.workflow_id INTO v_exec
  FROM public.run_requests r JOIN public.workflow_executions e ON e.run_request_id = r.id AND e.attempt = r.attempts
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token AND r.status = 'running'
    AND e.id = p_execution_id AND e.status = 'running'
  FOR KEY SHARE OF r;
  IF NOT FOUND THEN
    RETURN 'stale';
  END IF;

  SELECT s.node_id INTO v_held FROM public.ops_step_records s WHERE s.execution_id = p_execution_id AND s.seq = p_seq;
  IF FOUND THEN
    IF v_held = p_node_id THEN
      RETURN 'already_recorded';
    END IF;
    RAISE EXCEPTION 'record_ops_step: place % of execution % holds step %, not %', p_seq, p_execution_id, v_held, p_node_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT coalesce(max(s.seq) + 1, 0) INTO v_next FROM public.ops_step_records s WHERE s.execution_id = p_execution_id;
  IF p_seq <> v_next THEN
    RAISE EXCEPTION 'record_ops_step: place % of execution % would leave a gap; the next place is %', p_seq, p_execution_id, v_next
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.ops_step_records (execution_id, seq, organization_id, run_request_id, workflow_id, execution_started_at, node_id, namespace,
    step_type, status, started_at, duration_ms, output, output_bytes, error)
  VALUES (p_execution_id, p_seq, p_organization_id, p_run_request_id, v_exec.workflow_id, v_exec.started_at, p_node_id, p_namespace,
    p_step_type, p_status, p_started_at, p_duration_ms, p_output,
    CASE WHEN p_output IS NULL THEN p_output_bytes ELSE octet_length(p_output::text) END, p_error);
  RETURN 'recorded';
END
$fn$;

-- What a step test from a past run needs (#2339): one row for one
-- organization's attempt of one workflow, or none. reached says the attempt
-- recorded the step p_node_id; steps is then the latest completed output of
-- each step recorded before its last place (the context the run had there),
-- and otherwise of every completed step. Each entry says whether its output was
-- kept. Past 7 days by the database clock, payload and steps are null and
-- within_retention false. steps is null too when its outputs together pass
-- 768 KB of text (context_bytes says how big), more than a test takes.
CREATE FUNCTION public.run_step_context(p_organization_id uuid, p_workflow_id uuid, p_execution_id uuid, p_node_id text)
RETURNS TABLE (execution_status text, started_at timestamptz, within_retention boolean, reached boolean, payload jsonb, payload_elsewhere boolean,
  context_bytes bigint, steps jsonb, db_now timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_exec record;
  v_cut integer;
  v_fresh boolean;
  v_bytes bigint;
  v_steps jsonb;
BEGIN
  IF p_node_id IS NULL THEN
    RAISE EXCEPTION 'run_step_context: the step is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.status, e.started_at, r.payload, r.payload_ref INTO v_exec
  FROM public.workflow_executions e JOIN public.run_requests r ON r.id = e.run_request_id
  WHERE e.id = p_execution_id AND e.organization_id = p_organization_id AND e.workflow_id = p_workflow_id AND r.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_fresh := v_exec.started_at > now() - interval '7 days';
  SELECT max(s.seq) INTO v_cut FROM public.ops_step_records s WHERE s.execution_id = p_execution_id AND s.node_id = p_node_id;
  IF NOT v_fresh THEN
    RETURN QUERY SELECT v_exec.status, v_exec.started_at, false, v_cut IS NOT NULL, NULL::jsonb, false, NULL::bigint, NULL::jsonb, now();
    RETURN;
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (s.namespace) s.namespace, s.node_id, s.seq, s.output, s.output_bytes
    FROM public.ops_step_records s
    WHERE s.execution_id = p_execution_id AND s.status = 'completed' AND (v_cut IS NULL OR s.seq < v_cut)
    ORDER BY s.namespace, s.seq DESC
  )
  SELECT coalesce(sum(coalesce(octet_length(l.output::text), 0)), 0),
    coalesce(jsonb_agg(jsonb_build_object('namespace', l.namespace, 'node_id', l.node_id, 'seq', l.seq, 'output', l.output,
      'output_kept', NOT (l.output IS NULL AND l.output_bytes IS NOT NULL)) ORDER BY l.seq), '[]'::jsonb)
  INTO v_bytes, v_steps
  FROM latest l;

  RETURN QUERY SELECT v_exec.status, v_exec.started_at, true, v_cut IS NOT NULL,
    v_exec.payload, v_exec.payload IS NULL AND v_exec.payload_ref IS NOT NULL,
    v_bytes, CASE WHEN v_bytes > 786432 THEN NULL ELSE v_steps END, now();
END
$fn$;

-- Deletes up to p_limit records of attempts started more than 7 days ago by the
-- database clock, oldest first. Rows another session holds are skipped, not
-- waited on. more says a full page went, so call again. Lane wide: retention is
-- the same for every organization.
CREATE FUNCTION public.purge_ops_step_records(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - interval '7 days';
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_ops_step_records: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH old AS (
    SELECT s.execution_id, s.seq FROM public.ops_step_records s
    WHERE s.execution_started_at <= v_cutoff
    ORDER BY s.execution_started_at, s.execution_id, s.seq
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM public.ops_step_records s USING old
    WHERE s.execution_id = old.execution_id AND s.seq = old.seq
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM gone;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.record_ops_step(uuid, uuid, uuid, uuid, integer, text, text, text, text, timestamptz, integer, jsonb, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ops_step(uuid, uuid, uuid, uuid, integer, text, text, text, text, timestamptz, integer, jsonb, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.run_step_context(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_step_context(uuid, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.purge_ops_step_records(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_ops_step_records(integer) TO service_role;

RESET lock_timeout;
