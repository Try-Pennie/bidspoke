-- ============================================================
-- Reduced finalize of stranded workflow_executions rows
-- ============================================================
-- Same root cause as the lead_sightings strand (#353 / #343 / #309): the
-- execution-record finalize write in engine/index.ts (status, completed_at,
-- duration_ms) runs in a post-response ctx.waitUntil, fire-and-forget, so the
-- Worker isolate can be evicted before it lands. The lead is served correctly
-- (every execution_steps row completes, including the response step) but the
-- workflow_executions row itself is left at status='running' forever -- it is
-- never purged (purge only targets terminal statuses) so it silently
-- accumulates. Confirmed 2026-07-08: 1094 rows stuck this way across 4
-- workflows back to 2026-06-29 (822 Engine Bidding Workflow, 188 RML/LendSwift,
-- 62 RML/GigFi, 22 Main Flow). This is also what produced the false-positive
-- "Slow Execution Spike" Main Flow alert on 2026-07-07: slow-execution-rate.ts
-- counts a still-running row's elapsed time as "slow" -- a stranded row grows
-- that count without bound, well past the real ~1-minute worst case.
--
-- It additionally breaks the existing lead_sightings recovery
-- (reduce_finalize_stranded): that job only recovers a sighting once its
-- execution reaches status='completed', so a stranded execution silently
-- blocks its own sighting from ever being recovered, and after 26h it gets
-- mislabeled 'strand_unrecoverable' (outcome unknown) even though we can prove
-- from execution_steps that the lead was served fine.
--
-- This drains the recoverable subset the same way reduce_finalize_stranded
-- does for lead_sightings: reconstruct the terminal state from
-- execution_steps (the source of truth that DOES persist -- it's written
-- before the response returns, see step-logger.ts) rather than trusting
-- anything on the stuck row itself.
--   - any step with status='failed'            -> status='failed', carrying
--     that step's error_message/step_type (most recent by step_order).
--   - no failed step, but a 'response' or 'exit' step completed -> the lead
--     was served; status='completed', outcome='completed', completed_at/
--     duration_ms backfilled from the last completed step.
--   - neither (isolate died before any terminal step, or before any step at
--     all) -> honestly labeled 'failed' with a '[recovered]' marker message,
--     matching the "label honestly, don't guess" precedent from
--     finalize_unrecoverable_stranded -- NOT masqueraded as either outcome.
--
-- 30-minute age floor: every genuinely-completed run observed in production
-- finishes within ~60s even under heavy parallel bidding load, so 30 minutes
-- of "running" is never a real in-flight execution, only a stranded one.

CREATE OR REPLACE FUNCTION public.reduce_finalize_stranded_executions(
  p_min_age_minutes int DEFAULT 30,
  p_lookback_days int DEFAULT 14
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  WITH stranded AS (
    SELECT id, started_at
    FROM workflow_executions
    WHERE status = 'running'
      AND started_at < now() - make_interval(mins => p_min_age_minutes)
      AND started_at >= now() - make_interval(days => p_lookback_days)
  ),
  step_agg AS (
    SELECT
      es.execution_id,
      max(es.completed_at) FILTER (WHERE es.status = 'completed') AS last_completed_at,
      bool_or(es.status = 'failed') AS has_failed,
      bool_or(es.step_type IN ('response', 'exit') AND es.status = 'completed') AS reached_terminal,
      (array_agg(es.step_namespace ORDER BY es.step_order DESC)
        FILTER (WHERE es.status = 'completed' AND es.step_namespace IS NOT NULL))[1] AS last_namespace
    FROM execution_steps es
    WHERE es.execution_id IN (SELECT id FROM stranded)
      AND es.execution_started_at >= now() - make_interval(days => p_lookback_days)
    GROUP BY es.execution_id
  ),
  failed_detail AS (
    SELECT DISTINCT ON (es.execution_id)
      es.execution_id, es.error_message, es.step_type
    FROM execution_steps es
    WHERE es.execution_id IN (SELECT id FROM stranded)
      AND es.status = 'failed'
      AND es.execution_started_at >= now() - make_interval(days => p_lookback_days)
    ORDER BY es.execution_id, es.step_order DESC
  ),
  resolved AS (
    SELECT
      s.id,
      s.started_at,
      CASE
        WHEN COALESCE(a.has_failed, false) THEN 'failed'
        WHEN COALESCE(a.reached_terminal, false) THEN 'completed'
        ELSE 'failed'
      END AS new_status,
      CASE
        WHEN COALESCE(a.has_failed, false) THEN 'failed'
        WHEN COALESCE(a.reached_terminal, false) THEN 'completed'
        ELSE NULL
      END AS new_outcome,
      CASE
        WHEN COALESCE(a.reached_terminal, false) AND NOT COALESCE(a.has_failed, false) THEN a.last_completed_at
        WHEN COALESCE(a.has_failed, false) THEN COALESCE(a.last_completed_at, now())
        ELSE now()
      END AS new_completed_at,
      a.last_namespace AS new_final_node_namespace,
      CASE
        WHEN COALESCE(a.has_failed, false)
          THEN COALESCE(f.error_message, '[recovered] execution stranded after a failed step')
        WHEN COALESCE(a.reached_terminal, false) THEN NULL
        ELSE '[recovered] execution stranded: isolate evicted before finalize, no terminal step recorded'
      END AS new_error_message,
      CASE WHEN COALESCE(a.has_failed, false) THEN f.step_type ELSE NULL END AS new_failed_step_type
    FROM stranded s
    LEFT JOIN step_agg a ON a.execution_id = s.id
    LEFT JOIN failed_detail f ON f.execution_id = s.id
  )
  UPDATE workflow_executions e
  SET
    status = r.new_status,
    outcome = r.new_outcome,
    completed_at = r.new_completed_at,
    duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (r.new_completed_at - r.started_at)) * 1000))::int,
    final_node_namespace = COALESCE(r.new_final_node_namespace, e.final_node_namespace),
    error_message = COALESCE(r.new_error_message, e.error_message),
    failed_step_type = COALESCE(r.new_failed_step_type, e.failed_step_type)
  FROM resolved r
  WHERE e.id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'reduce_finalize_stranded_executions: finalized % execution(s)', n;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reduce_finalize_stranded_executions(int, int) TO service_role;

-- Every 30 min, offset 5 minutes past reduce-finalize-stranded (:00/:30) so the
-- two jobs don't contend for the same workflow_executions/execution_steps
-- partitions in the same instant. Recovering an execution here means the
-- EXISTING lead_sightings drain (reduce_finalize_stranded, next run) can then
-- also recover that execution's sighting -- no changes needed on that side.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reduce-finalize-stranded-executions'; END $$;
SELECT cron.schedule(
  'reduce-finalize-stranded-executions',
  '5,35 * * * *',
  'SELECT public.reduce_finalize_stranded_executions(30, 14)'
);
