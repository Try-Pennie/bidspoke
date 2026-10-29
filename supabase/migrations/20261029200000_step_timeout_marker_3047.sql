-- ============================================================
-- Mark a step that hit a deadline on its own row (#3047)
-- ============================================================
-- A step stopped by its own deadline was recorded in execution_steps only as
-- error_message text ("Step timed out after <n>ms ..."), with error_type just
-- 'transient'. Two readers found timeouts by that text: the daily direct Send
-- Salesforce writes report (#2938) and step_timeout_audit_by_workflow (#2934).
-- L35: classify an error once, never by its message.
--
-- The engine now writes two columns on a step a deadline stopped, and on no
-- other row:
--   timeout_kind        'step' when the step's own deadline passed,
--                       'parallel_block' when its parallel block stopped waiting
--                       for it (the row the block writes for a cut off child).
--   timed_out_after_ms  the deadline that passed, in ms.
-- The list of kinds lives in apps/worker/src/engine/step-timeout.ts.
--
-- WHY NOT A NEW error_type. error_type decides whether a step is retried
-- (withRetry retries only 'transient'), how a failure alert labels it, what the
-- lead sighting's equifax_error_type and the Snowflake export carry, and what
-- the run pages show. A 'timeout' value would have stopped timed out steps
-- being retried and relabelled their alerts. The marker sits beside it instead.
--
-- NO CHECK on timeout_kind, as there is none on error_type or status
-- (20260617000002): a value added in code before its migration would make the
-- engine's step writes fail, and adding one would scan every partition.
--
-- PRODUCTION ROWS. Both columns are nullable with no default, so adding them
-- changes only the catalog: no row is rewritten or scanned, and every existing
-- row reads NULL in both, which every reader takes as "written before the
-- marker" and judges by its message (the text fallback). The ALTER takes an
-- ACCESS EXCLUSIVE lock on execution_steps and each partition for a moment;
-- lock_timeout makes it give up rather than queue behind a long read while the
-- engine's step writes queue behind it (they retry for 7 s, step-logger.ts).
-- If it times out, push again.
--
-- ORDER (ADR 0007). Apply this before the Worker that writes and reads the
-- columns deploys; Deploy refuses while it is unapplied. The Worker before it
-- never names these columns, and the function below still counts its rows by
-- their message, so this is safe to apply with either Worker live.
--
-- step_timeout_audit_by_workflow: unchanged but for which failures it counts as
-- timed out (one predicate, in `timeouts`): a row marked 'step', or a row with
-- no marker whose message is the step deadline's. The text half goes when the
-- engine's own fallback does (engine/step-timeout.ts says when: 8 days after
-- the Worker carrying #3047 deployed). It still reads failed rows through the
-- partial index idx_steps_wf_ns_failed, so its cost is unchanged. Same
-- signature, so CREATE OR REPLACE keeps its grants; they are restated anyway.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.execution_steps ADD COLUMN IF NOT EXISTS timeout_kind TEXT;
ALTER TABLE public.execution_steps ADD COLUMN IF NOT EXISTS timed_out_after_ms INTEGER;

COMMENT ON COLUMN public.execution_steps.timeout_kind IS
  'Set only on a step a deadline stopped (#3047): step (its own timeout_ms) or parallel_block (its block stopped waiting). NULL on every other row, and on rows written before the marker. Values: TIMEOUT_KINDS in apps/worker/src/engine/step-timeout.ts.';
COMMENT ON COLUMN public.execution_steps.timed_out_after_ms IS
  'The deadline, in ms, that stopped the step, beside timeout_kind (#3047). NULL when timeout_kind is.';

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
        -- Stopped by its own deadline: the engine's marker (#3047), or, on a row
        -- written before the marker, the engine's message.
        AND (es.timeout_kind = 'step' OR (es.timeout_kind IS NULL AND es.error_message LIKE 'Step timed out after %'))
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
