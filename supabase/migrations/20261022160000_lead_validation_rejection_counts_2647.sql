-- Count a lead validation rejection watch's buckets in one pass (#2647). EXPAND only.
--
-- The watch (apps/worker/src/lib/lead-validation-rejection-watch.ts) sent 3 + 9
-- PostgREST head counts per span: every finished live run, those ending at the
-- validation step, those that failed there, and one per rejection reason. Each
-- was its own index scan on (workflow_id, started_at) per daily partition plus
-- a heap fetch of every run. For RML LendSwift's baseline week (about 99,000
-- runs, 101,000 pages, 790 MB of the 1 GB shared_buffers) the twelve passes were
-- cancelled at the 30 s service_role ceiling at 04:00 and 09:00 UTC on
-- 2026-10-22. This function reads the span's rows once and groups them, so a
-- span costs one pass: one LendSwift day read 14,436 pages in 37 ms warm
-- (2026-10-22 15:30 UTC, a generic plan, runtime partition pruning removing the
-- other 40 partitions).
--
-- What it counts, the same predicates the head counts used:
--   runs     finished live runs: workflow_id, NOT is_test, status <> 'running',
--            started_at in [p_from, p_to)
--   at_step  of those, final_node_namespace = p_namespace
--   failed   of those, status = 'failed'
--   by_reason  of the runs at the step that did not fail, a count per
--            response_body->>'reason' that is not null. Every reason given,
--            listed or not: the Worker narrows to its list, and what is left
--            over is its "a reason not on the list" bucket. The answer body is
--            only detoasted for runs that ended at the step.
-- One row always, so the 1,000 row cap never applies.
--
-- SECURITY: invoker (service_role bypasses RLS, and that is the only caller).
-- Postgres grants EXECUTE to PUBLIC on a new function (#762), so the REVOKE is
-- load-bearing: a browser role must not count another organization's runs.
-- STABLE and read only, so it is on the readOnly rpc list
-- (apps/worker/src/lib/read-only-rpcs.json) and the local dev write guard lets
-- it through.
--
-- Additive: a new function nothing yet calls. The Worker deployed before it is
-- applied keeps its head counts; the Worker that calls it needs it applied first.

CREATE OR REPLACE FUNCTION public.lead_validation_rejection_counts(
  p_workflow_id uuid,
  p_namespace   text,
  p_from        timestamptz,
  p_to          timestamptz
) RETURNS TABLE (
  runs      bigint,
  at_step   bigint,
  failed    bigint,
  by_reason jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH g AS (
    SELECT
      we.final_node_namespace = p_namespace AS at_step,
      we.status = 'failed' AS failed,
      CASE WHEN we.final_node_namespace = p_namespace AND we.status <> 'failed'
           THEN we.response_body ->> 'reason' END AS reason,
      count(*) AS n
    FROM public.workflow_executions we
    WHERE we.workflow_id = p_workflow_id
      AND NOT we.is_test
      AND we.status <> 'running'
      AND we.started_at >= p_from
      AND we.started_at < p_to
    GROUP BY 1, 2, 3
  )
  SELECT
    coalesce(sum(n), 0)::bigint,
    coalesce(sum(n) FILTER (WHERE g.at_step), 0)::bigint,
    coalesce(sum(n) FILTER (WHERE g.at_step AND g.failed), 0)::bigint,
    coalesce(jsonb_object_agg(g.reason, n) FILTER (WHERE g.reason IS NOT NULL), '{}'::jsonb)
  FROM g
$$;

REVOKE ALL ON FUNCTION public.lead_validation_rejection_counts(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_validation_rejection_counts(uuid, text, timestamptz, timestamptz) TO service_role;
