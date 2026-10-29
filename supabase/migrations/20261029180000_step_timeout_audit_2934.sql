-- ============================================================
-- The daily step timeout alert's five day reading (#2934)
-- ============================================================
-- The daily Step Timeout Warnings alert judged a step only on the runs that
-- FINISHED, from step_duration_percentiles_by_workflow: the two hours or the day
-- before it, and at most the 3,000 most recent runs. On 2026-10-29 it missed
-- Main Flow's Credit Collections, which lost 7 runs to its 4,500 ms timeout,
-- because a run the timeout cuts off never finishes and so is never sampled.
--
-- step_timeout_audit_by_workflow answers, for each named step of one workflow
-- over [p_since, p_until):
--   * p50, p99, slowest and count of an EVEN sample of finished runs: at most
--     p_per_hour of them from each hour, so one slow day weighs its share of the
--     period and not the whole of it.
--   * timed_out: every run that failed on the step timeout, and timed_out_at,
--     when they started (the most recent 1,000), from which the Worker tells a
--     short burst (an outage) from a step losing runs.
--
-- "Failed on the step timeout" is a final failure whose message is the engine's
-- own, `Step timed out after <n>ms` (engine/retry.ts, withTimeout). A parallel
-- group's own timeout ("Parallel group timed out") and a token fetch timeout are
-- other messages and are not counted. A web test holds the prefix here equal to
-- the engine's message.
--
-- COST. Measured on production 2026-10-29 (read only): the even sample at 10 an
-- hour over 5 days took 5.3 s cold for all 22 steps of Engine Bidding, the
-- busiest workflow per step, and 0.29 s warm for Main Flow's 90. The Worker asks
-- for at most 10 steps per call, so each call stays well inside the Data API's
-- 8 s. Counting the timed out runs without an index on failed rows meant reading
-- every row of every step for five days (over 100 s on Engine Bidding), so this
-- adds a partial index on failed rows only, which is small: failures are a
-- fraction of a percent of steps.
--
-- APPLYING ON PRODUCTION. CREATE INDEX on the partitioned parent locks writes on
-- every partition while it builds, and the engine writes steps all the time. So
-- on production the index is built BEFORE this file is pushed, without the lock,
-- following docs in the PR (ON ONLY on the parent, CONCURRENTLY on each
-- partition, then ATTACH). The IF NOT EXISTS below then finds it and does
-- nothing; on a fresh or CI database it builds normally.
--
-- SECURITY: invoker (service_role bypasses RLS and is the only caller, the daily
-- audit). Postgres grants EXECUTE to PUBLIC on a new function (#762), so the
-- REVOKE is needed. STABLE and read only, so it is on the readOnly rpc list.
-- Additive only (ADR 0007): nothing existing changes.

CREATE INDEX IF NOT EXISTS idx_steps_wf_ns_failed
  ON public.execution_steps (workflow_id, step_namespace, started_at)
  WHERE status = 'failed';

CREATE OR REPLACE FUNCTION public.step_timeout_audit_by_workflow(
  p_workflow_id UUID,
  p_since TIMESTAMPTZ,
  p_until TIMESTAMPTZ,
  p_namespaces TEXT[],
  p_per_hour INT
) RETURNS TABLE (
  step_namespace TEXT,
  p50            INT,
  p99            INT,
  max_ms         INT,
  sample_size    BIGINT,
  timed_out      BIGINT,
  timed_out_at   TIMESTAMPTZ[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- Refused rather than clamped, so a caller's mistake is an error it sees.
  IF p_per_hour IS NULL OR p_per_hour < 1 OR p_per_hour > 50 THEN
    RAISE EXCEPTION 'p_per_hour must be 1 to 50, got %', p_per_hour USING ERRCODE = '22023';
  END IF;
  IF p_since IS NULL OR p_until IS NULL OR p_until <= p_since OR p_until - p_since > interval '8 days' THEN
    RAISE EXCEPTION 'the period must be a non empty span of at most 8 days, got % to %', p_since, p_until USING ERRCODE = '22023';
  END IF;
  IF coalesce(array_length(p_namespaces, 1), 0) > 50 THEN
    RAISE EXCEPTION 'at most 50 steps a call, got %', array_length(p_namespaces, 1) USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH ns AS (
    SELECT DISTINCT u.namespace FROM unnest(p_namespaces) AS u(namespace)
  ),
  buckets AS (
    SELECT g.lo, least(g.lo + interval '1 hour', p_until) AS hi
    FROM generate_series(p_since, p_until - interval '1 microsecond', interval '1 hour') AS g(lo)
  ),
  sampled AS (
    SELECT ns.namespace, r.duration_ms
    FROM ns
    CROSS JOIN buckets b
    CROSS JOIN LATERAL (
      SELECT es.duration_ms
      FROM public.execution_steps es
      WHERE es.workflow_id = p_workflow_id
        AND es.step_namespace = ns.namespace
        AND es.started_at >= b.lo
        AND es.started_at < b.hi
        AND es.status = 'completed'
        AND es.duration_ms IS NOT NULL
        AND es.is_test IS NOT TRUE
      ORDER BY es.started_at DESC
      LIMIT p_per_hour
    ) r
  ),
  durations AS (
    SELECT s.namespace,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY s.duration_ms)::int AS p50,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms)::int AS p99,
      max(s.duration_ms)::int AS max_ms,
      count(*) AS sample_size
    FROM sampled s
    GROUP BY s.namespace
  ),
  timeouts AS (
    SELECT ns.namespace, t.n, t.at
    FROM ns
    CROSS JOIN LATERAL (
      SELECT count(*) AS n,
        (array_agg(es.started_at ORDER BY es.started_at DESC))[1:1000] AS at
      FROM public.execution_steps es
      WHERE es.workflow_id = p_workflow_id
        AND es.step_namespace = ns.namespace
        AND es.started_at >= p_since
        AND es.started_at < p_until
        AND es.status = 'failed'
        AND es.error_message LIKE 'Step timed out after %'
        AND es.is_test IS NOT TRUE
    ) t
    WHERE t.n > 0
  )
  SELECT coalesce(d.namespace, t.namespace),
    d.p50, d.p99, d.max_ms,
    coalesce(d.sample_size, 0),
    coalesce(t.n, 0),
    coalesce(t.at, ARRAY[]::timestamptz[])
  FROM durations d
  FULL JOIN timeouts t ON t.namespace = d.namespace;
END
$$;

REVOKE ALL ON FUNCTION public.step_timeout_audit_by_workflow(uuid, timestamptz, timestamptz, text[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.step_timeout_audit_by_workflow(uuid, timestamptz, timestamptz, text[], int) TO service_role;
