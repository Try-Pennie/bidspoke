-- #1152: return each job's jobid, so the watcher's grace period can tell one
-- incarnation of a job from the next.
--
-- WHAT WENT WRONG. The pg_cron watcher (#770) grants a job with no successful
-- run on record a grace period before it pages, because a rescheduled job is
-- recreated under a new jobid and loses its whole run history, so it correctly
-- reads as never having succeeded until its first slot arrives. The stamp
-- recording when a job was first seen in that state was keyed on the job's NAME
-- plus its SCHEDULE.
--
-- That key is more stable than the thing it describes. On 2026-09-04 at 14:30
-- UTC the #1147 migration changed only the COMMAND of the four rollup jobs, to
-- give them a statement timeout. `cron.unschedule` plus `cron.schedule` still
-- mints a new jobid (measured: old jobids 6 and 26 last ran at 14:25:00, new
-- jobids 45 and 47 took over at 14:30:00), so the two nightly jobs came back as
-- jobids 46 and 48 with zero rows in cron.job_run_details and their next slot
-- not until 03:47 and 03:52 UTC. Their names and schedules were unchanged, so
-- both read the stamp written for their PREVIOUS incarnation on 2026-08-18
-- (both keys held 1787079647014), concluded the grace had expired 17 days ago,
-- and paged "has never succeeded" 30 minutes after a healthy deploy.
--
-- jobid is the identity that disappears when a job is replaced, which is
-- exactly the event the grace exists to cover, so the stamp is keyed on it now
-- and cannot outlive the job it describes (LESSONS L576).
--
-- WHY DROP AND CREATE. A changed return type cannot go through CREATE OR
-- REPLACE. A DROP also discards the ACL, so the revoke from PUBLIC, anon and
-- authenticated is re-issued below rather than inherited: a security definer
-- function is callable by anon over the REST API without it (#762), and the
-- evidence of a missing REVOKE is an absence (L124).
--
-- Expand/contract: additive to the RESULT shape. Code that does not read jobid
-- ignores the new column, so the migration goes first and the worker deploy
-- follows. Worker code deployed AHEAD of this migration does not silently lose
-- its grace: a row with no jobid gets its own 'unknown_identity' outcome that
-- names this migration as the remedy, rather than being reported as a job that
-- never ran (L11).

DROP FUNCTION IF EXISTS public.pg_cron_health(INT);

CREATE FUNCTION public.pg_cron_health(window_hours INT DEFAULT 24)
RETURNS TABLE (
  jobid                 BIGINT,
  jobname               TEXT,
  schedule              TEXT,
  active                BOOLEAN,
  failures_in_window    BIGINT,
  last_failure_at       TIMESTAMPTZ,
  last_failure_message  TEXT,
  last_success_at       TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron, pg_temp
AS $$
  WITH failures AS (
    SELECT d.jobid, d.start_time, d.return_message
    FROM cron.job_run_details d
    -- FINISHED and not succeeded. A run still in flight has no end_time, and
    -- counting it as a failure produced the false alerts of 2026-08-20
    -- (20260820000002). Unchanged here.
    WHERE d.end_time IS NOT NULL
      AND d.status <> 'succeeded'
      AND d.start_time > now() - make_interval(hours => least(greatest(window_hours, 1), 168))
  ),
  successes AS (
    SELECT d.jobid, max(d.start_time) AS last_success
    FROM cron.job_run_details d
    WHERE d.status = 'succeeded'
      AND d.start_time > now() - interval '40 days'
    GROUP BY d.jobid
  )
  SELECT
    -- From cron.job, not from the run details: a job with no runs at all has no
    -- run rows, and that is precisely the job whose identity this has to report.
    j.jobid::bigint,
    j.jobname::text,
    j.schedule::text,
    j.active,
    count(f.jobid)::bigint,
    max(f.start_time),
    (array_agg(f.return_message ORDER BY f.start_time DESC))[1]::text,
    max(s.last_success)
  FROM cron.job j
  LEFT JOIN failures  f ON f.jobid = j.jobid
  LEFT JOIN successes s ON s.jobid = j.jobid
  GROUP BY j.jobid, j.jobname, j.schedule, j.active;
$$;

REVOKE ALL ON FUNCTION public.pg_cron_health(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pg_cron_health(INT) TO service_role;

COMMENT ON FUNCTION public.pg_cron_health(INT) IS
  'Per-job pg_cron health, keyed on jobid so a rescheduled job is not mistaken for its predecessor (#1152). Counts only runs that FINISHED without succeeding (#770)';
