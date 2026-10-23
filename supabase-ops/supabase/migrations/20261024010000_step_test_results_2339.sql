-- A step's test result, kept on ops (#2339, phase 9 of #1689).
--
-- Dan decided on 2026-10-23 (recorded on #2339): a step's test result is kept
-- in the ops database only, never the bidding database, so outside service data
-- (emails, customer rows) stays beside ops run data and never reaches a database
-- the browser reads. Only the latest result per step is kept, and it is deleted
-- 7 days after the test, the same as run history; after that the data picker
-- asks for a fresh test. It is read back for the picker through the ops
-- connection (OpsConnections), and the token removal rule applies before it is
-- stored (the ops Worker's connectionFetch scrubs every answer, and records each
-- request only once sanitised).
--
--  - step_test_results: one row per (organization, workflow, step), replaced by
--    each test. service_role reads it; it writes only through record_step_test.
--  - record_step_test: keeps the latest result. It refuses a workflow ops holds
--    as another organization's (a draft not yet copied is allowed: the
--    organization is the one the bidding Worker derived from the caller's JWT).
--  - step_test_result: one organization's result for one step, and nothing
--    once it is 7 days old by the database clock, whether or not the purge has
--    run yet.
--  - purge_step_test_results: deletes the results tested more than 7 days ago,
--    a page at a time. The ops minute tick runs it in the nightly
--    observation_purge sweep, so a result is gone within about a day of
--    reaching 7 days old, and no reader sees it past 7 days in any case.
--
-- Additive only (ADR 0007): a new table, an index and three new functions.
-- Guarded by supabase-ops/supabase/tests/step_test_results.test.sql.

SET lock_timeout = '5s';

CREATE TABLE public.step_test_results (
  organization_id  uuid NOT NULL,
  workflow_id      uuid NOT NULL,
  -- The canvas node id of the step, and its step id (namespace) for the picker's paths.
  node_id          text NOT NULL CONSTRAINT step_test_results_node_id_check CHECK (length(node_id) BETWEEN 1 AND 200),
  namespace        text NOT NULL CONSTRAINT step_test_results_namespace_check CHECK (length(namespace) BETWEEN 1 AND 200),
  -- The users.id of the person who ran the test.
  tested_by        uuid NOT NULL,
  tested_at        timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL CONSTRAINT step_test_results_status_check CHECK (status IN ('completed', 'failed')),
  -- The action's answer, scrubbed of the connection's secrets; null for a failure or an answer over the cap.
  output           jsonb,
  -- The size of the answer, so one over the cap is named rather than read as empty.
  output_bytes     integer CONSTRAINT step_test_results_output_bytes_check CHECK (output_bytes IS NULL OR output_bytes >= 0),
  error            text CONSTRAINT step_test_results_error_check CHECK (error IS NULL OR length(error) <= 2000),
  -- Each request the step made, sanitised before its login was applied.
  requests         jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms      integer NOT NULL CONSTRAINT step_test_results_duration_check CHECK (duration_ms >= 0),
  CONSTRAINT step_test_results_pkey PRIMARY KEY (organization_id, workflow_id, node_id),
  -- A sample for the data picker, not a data store: 256 KB of answer, 64 KB of requests.
  CONSTRAINT step_test_results_output_size CHECK (output IS NULL OR octet_length(output::text) <= 262144),
  CONSTRAINT step_test_results_requests_shape CHECK (jsonb_typeof(requests) = 'array' AND octet_length(requests::text) <= 65536),
  CONSTRAINT step_test_results_failed_has_error CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX step_test_results_age_idx ON public.step_test_results (tested_at);
ALTER TABLE public.step_test_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.step_test_results FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.step_test_results FROM service_role;
GRANT SELECT ON public.step_test_results TO service_role;

-- Keeps one step's latest test result, replacing the one before. Answers the
-- time it was recorded at, on the database clock.
CREATE FUNCTION public.record_step_test(
  p_organization_id  uuid,
  p_workflow_id      uuid,
  p_node_id          text,
  p_namespace        text,
  p_tested_by        uuid,
  p_status           text,
  p_output           jsonb,
  -- The size of an answer not kept (p_output null because it was over the cap); ignored when p_output is given.
  p_output_bytes     integer,
  p_error            text,
  p_requests         jsonb,
  p_duration_ms      integer
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_copy_org uuid;
  v_at timestamptz := now();
BEGIN
  IF p_organization_id IS NULL OR p_workflow_id IS NULL OR p_node_id IS NULL OR p_namespace IS NULL OR p_tested_by IS NULL
      OR p_status IS NULL OR p_duration_ms IS NULL THEN
    RAISE EXCEPTION 'record_step_test: organization, workflow, step, step id, tester, status and duration are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.organization_id INTO v_copy_org FROM public.ops_workflow_copies c WHERE c.workflow_id = p_workflow_id;
  IF FOUND AND v_copy_org <> p_organization_id THEN
    RAISE EXCEPTION 'record_step_test: workflow % is not this organization''s', p_workflow_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.step_test_results (organization_id, workflow_id, node_id, namespace, tested_by, tested_at, status, output, output_bytes, error,
    requests, duration_ms)
  VALUES (p_organization_id, p_workflow_id, p_node_id, p_namespace, p_tested_by, v_at, p_status, p_output,
    CASE WHEN p_output IS NULL THEN p_output_bytes ELSE octet_length(p_output::text) END, p_error, coalesce(p_requests, '[]'::jsonb), p_duration_ms)
  ON CONFLICT ON CONSTRAINT step_test_results_pkey DO UPDATE
  SET namespace = excluded.namespace, tested_by = excluded.tested_by, tested_at = excluded.tested_at, status = excluded.status,
      output = excluded.output, output_bytes = excluded.output_bytes, error = excluded.error, requests = excluded.requests,
      duration_ms = excluded.duration_ms;
  RETURN v_at;
END
$fn$;

-- One organization's latest test result for one step, nothing once it is 7 days old.
CREATE FUNCTION public.step_test_result(p_organization_id uuid, p_workflow_id uuid, p_node_id text)
RETURNS TABLE (node_id text, namespace text, tested_by uuid, tested_at timestamptz, status text, output jsonb, output_bytes integer,
  error text, requests jsonb, duration_ms integer, db_now timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT r.node_id, r.namespace, r.tested_by, r.tested_at, r.status, r.output, r.output_bytes, r.error, r.requests, r.duration_ms, now()
  FROM public.step_test_results r
  WHERE r.organization_id = p_organization_id AND r.workflow_id = p_workflow_id AND r.node_id = p_node_id
    AND r.tested_at > now() - interval '7 days';
$fn$;

-- Deletes up to p_limit results tested more than 7 days ago by the database
-- clock, oldest first. Rows another session holds are skipped, not waited on.
-- more says a full page went, so call again. Lane wide: retention is the same
-- for every organization.
CREATE FUNCTION public.purge_step_test_results(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - interval '7 days';
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_step_test_results: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH old AS (
    SELECT r.organization_id, r.workflow_id, r.node_id FROM public.step_test_results r
    WHERE r.tested_at <= v_cutoff
    ORDER BY r.tested_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM public.step_test_results r USING old
    WHERE r.organization_id = old.organization_id AND r.workflow_id = old.workflow_id AND r.node_id = old.node_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM gone;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.record_step_test(uuid, uuid, text, text, uuid, text, jsonb, integer, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_step_test(uuid, uuid, text, text, uuid, text, jsonb, integer, text, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.step_test_result(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.step_test_result(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.purge_step_test_results(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_step_test_results(integer) TO service_role;

RESET lock_timeout;
