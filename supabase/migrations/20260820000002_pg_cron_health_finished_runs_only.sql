-- ============================================================
-- Count a pg_cron run as failed only once it has FINISHED (#770 follow-up)
-- ============================================================
-- pg_cron_health counted every row whose status was not 'succeeded' as a
-- failure. A run that has STARTED but not yet finished is not succeeded either,
-- so it was counted as a failure while it was still working.
--
-- Observed in production on 2026-08-20 at 20:01 UTC. Slack reported:
--
--   reduce-finalize-stranded (*/30 * * * *): 1 failed run(s) in the window,
--   most recently at 2026-08-20T20:00:02.409913+00:00: no message recorded
--   refresh-field-presence-daily (*/5 * * * *): 1 failed run(s) ...
--   most recently at 2026-08-20T20:00:02.377021+00:00: no message recorded
--
-- Neither run failed. Both are recorded as 'succeeded' with the message '1 row',
-- and the timestamps the alert quoted are the START times of those two
-- SUCCESSFUL runs. Queried afterwards, pg_cron_health(24) reports
-- failures_in_window = 0 and last_failure_at = NULL for both, so no failure
-- exists anywhere in the window the alert claimed to be reading.
--
-- Three details of the alert are explained by one cause and nothing else: a
-- count of one, a "failure" time that is really a start time, and a missing
-- message, which is what a run that has not finished has to report.
--
-- WHY IT HITS THESE TWO JOBS. The watcher runs hourly on the hour. These two
-- fire every 5 and every 30 minutes, so both are starting at the exact moment it
-- looks. It would page roughly every hour, and an alert that cries wolf gets
-- ignored, which costs the real failures this check exists to surface (L36).
--
-- THE FIX KEYS ON end_time, NOT ON A LIST OF STATUS NAMES. A finished run has an
-- end_time; a running one does not. That is structural, so it stays correct
-- whatever pg_cron calls its in-progress states, and it stays FAIL-SAFE: an
-- unrecognised terminal status still counts as a failure, because the check is
-- "finished and not succeeded" rather than "matches a known bad name" (L93).
--
-- Verified against the live table first: over 7 days and 4,427 runs, every row
-- at rest carries an end_time, and no row is 'succeeded' without one, so this
-- predicate excludes nothing that has actually finished.

CREATE OR REPLACE FUNCTION public.pg_cron_health(window_hours INT DEFAULT 24)
RETURNS TABLE (
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
    -- counting it as a failure is what produced the false alerts of 2026-08-20.
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
  GROUP BY j.jobname, j.schedule, j.active;
$$;

-- Postgres grants EXECUTE on a function to PUBLIC by default, so a security
-- definer function is callable by `anon` over the REST API unless that grant is
-- explicitly removed (#762). CREATE OR REPLACE preserves existing grants, but
-- the REVOKE is repeated here so this file is correct run on its own.
REVOKE ALL ON FUNCTION public.pg_cron_health(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pg_cron_health(INT) TO service_role;

COMMENT ON FUNCTION public.pg_cron_health(INT) IS
  'Per-job pg_cron health. Counts only runs that FINISHED without succeeding: an in-flight run has no end_time and is not a failure (#770)';
