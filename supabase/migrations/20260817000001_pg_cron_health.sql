-- ============================================================
-- Expose pg_cron health to the Worker (#770)
-- ============================================================
-- Nothing read cron.job_run_details, so a scheduled job could fail every run and
-- the first signal would be whatever downstream symptom eventually surfaced.
-- Measured while writing this: 62 failed runs across four jobs going back to
-- 2026-07-19, including the nightly reconciler for the dashboard's analytics
-- rollups, failing roughly daily for a month with nobody told (#833).
--
-- The Worker reads through this function rather than the table directly, for two
-- reasons. The `cron` schema is not exposed to PostgREST at all, and the table
-- grows unboundedly and is not pruned by default, so a bare select would be the
-- same row-cap trap as #115. The window is bounded inside the function, where it
-- cannot be forgotten by a caller.
--
-- SECURITY: Postgres grants EXECUTE on a new function to PUBLIC by default, so a
-- security definer function is callable by `anon` over the REST API unless that
-- grant is explicitly removed. That is #762, six functions exposed exactly this
-- way, two of which wrote. The REVOKE below is the load-bearing line, not the
-- GRANT: without it this hands anybody with the publishable key a listing of
-- every scheduled job and its failure messages.

-- TWO windows, not one, and the reason is worth stating because a single window
-- cannot serve both questions. Failures must be RECENT or the check reports a
-- month-old error as news. Last success must reach back further than the slowest
-- schedule, or a weekly job legitimately shows no success in a 24 hour window and
-- reads as never having run. Measured before shipping: with one 24 hour window,
-- three healthy jobs (two weekly, one monthly) came back with no recorded success
-- and would have paged on the first run (LESSONS L56, L162).
CREATE OR REPLACE FUNCTION public.pg_cron_health(window_hours integer DEFAULT 24)
RETURNS TABLE (
  jobname                text,
  schedule               text,
  active                 boolean,
  failures_in_window     bigint,
  last_failure_at        timestamptz,
  last_failure_message   text,
  last_success_at        timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, cron, public
AS $$
  WITH failures AS (
    -- Recent failures only. Bounded here, once, and clamped so a caller cannot
    -- ask for a window wide enough to scan the whole unpruned table.
    SELECT d.jobid, d.start_time, d.return_message
    FROM cron.job_run_details d
    WHERE d.status <> 'succeeded'
      AND d.start_time > now() - make_interval(hours => least(greatest(window_hours, 1), 168))
  ),
  successes AS (
    -- A fixed 40 day reach, which is longer than the slowest schedule in use
    -- (monthly). Anything shorter makes a healthy weekly or monthly job
    -- indistinguishable from one that has never run.
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

-- The line that matters. Without it, `anon` can call this with the publishable
-- key and read every scheduled job and its error messages.
REVOKE ALL ON FUNCTION public.pg_cron_health(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pg_cron_health(integer) FROM anon;
REVOKE ALL ON FUNCTION public.pg_cron_health(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.pg_cron_health(integer) TO service_role;

COMMENT ON FUNCTION public.pg_cron_health(integer) IS
  'Per-job pg_cron health over a bounded window, for the Worker''s scheduled-job watch (#770). service_role only: the failure messages name internal objects.';
