-- An empty day stops refusing forever and stranding its successor (#1249, #1253).
--
-- WHAT IS STUCK. Measured on production 2026-09-09 and again on 2026-09-10:
-- 2026-08-14 and 2026-08-15 both refuse `stale-measurement`, with zero hours
-- recorded, zero executions, and readings 147 and 128 hours old. They come from
-- the six day gap when the archive was covering nothing, and both partitions
-- hold 80 kB, which is an empty partition's overhead.
--
-- They cannot clear. The gate only measures days inside its candidate window,
-- so a day that leaves that window unverified is never measured again and its
-- reading only gets older. #1016 made an EMPTY day fall through to the count
-- comparisons and pass them, but the AGE test runs first, so a day already
-- stale when that shipped stays refused for ever.
--
-- AND IT TAKES THE NEXT DAY WITH IT. A step partition for day D holds the post
-- midnight steps of day D-1's executions, so D may only go once D-1 is
-- verified. On 2026-09-09 that was 17 execution days authorised against 16 step
-- days, with nothing reporting the difference.
--
-- WHY AGE DOES NOT APPLY TO AN EMPTY DAY. Staleness matters because a truthful
-- reading of a past state is indistinguishable from a current one, and the
-- thing it describes may have changed since. A day with no executions has
-- nothing to describe and nothing to lose: deleting an empty partition destroys
-- nothing, whatever its reading's age.
--
-- BUT THE EMPTINESS IS PROVED LIVE, NOT READ OFF THE STALE ROW. Exempting a day
-- from the age rule on the strength of the very reading whose age is in
-- question would be circular, and a stale zero is exactly the value that would
-- authorise deleting a day that has since acquired rows. So `p_partition_empty`
-- is a fact the caller establishes at verdict time, and the exemption applies
-- only when it is TRUE. A caller that cannot establish it passes false and the
-- day goes on refusing, which is the fail-safe direction (L215).
--
-- This is direction 1 of #1249, and it settles #1253's question the same way:
-- an empty day becomes deletable, because there is nothing there to keep.

CREATE OR REPLACE FUNCTION public.verified_day_refusal(
  p_pg_execution_count bigint,
  p_erased_execution_count bigint,
  p_sf_execution_count bigint,
  p_pg_step_count bigint,
  p_sf_step_count bigint,
  p_orphan_execution_count bigint,
  p_hours_recorded bigint,
  p_hours_execution_count bigint,
  p_probe_ok boolean,
  p_probe_sampled integer,
  p_incomplete_count bigint,
  p_measured_at timestamptz,
  p_now timestamptz,
  p_max_measurement_age interval,
  p_partition_empty boolean DEFAULT false
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    -- Anything unmeasured, before anything else. Its own code, because "nobody
    -- looked" is a different finding from "the numbers disagree" (L11).
    WHEN p_pg_execution_count IS NULL
      OR p_erased_execution_count IS NULL
      OR p_sf_execution_count IS NULL
      OR p_pg_step_count IS NULL
      OR p_sf_step_count IS NULL
      OR p_orphan_execution_count IS NULL
      OR p_hours_recorded IS NULL
      OR p_hours_execution_count IS NULL
      OR p_probe_ok IS NULL
      OR p_probe_sampled IS NULL
      OR p_incomplete_count IS NULL
      OR p_measured_at IS NULL
      THEN 'never-measured'

    -- Age next (#1137), EXCEPT for a day proved empty right now (#1249).
    --
    -- The exemption needs all three: the live partition holds nothing, and the
    -- reading agrees there was nothing. Requiring the reading to agree as well
    -- is not redundant with the live check, it is what stops a day whose rows
    -- were removed by something OTHER than this gate reading as verified.
    WHEN p_measured_at < p_now - p_max_measurement_age
      AND NOT (p_partition_empty AND p_pg_execution_count = 0 AND p_hours_recorded = 0)
      THEN 'stale-measurement'

    -- No hour at all, with executions to lose (#1016). Worded about the data,
    -- not about the gate: this is the only state where the archive's promise is
    -- being broken and it is still fixable.
    WHEN p_hours_recorded = 0 AND p_pg_execution_count > 0 THEN 'never-archived'

    -- Partly archived. Before every count below, because p_pg_step_count is
    -- SUMMED from these hours: with hours missing, each count describes a
    -- fraction of the day and would report a shortfall of unexplained size
    -- rather than the hour that is actually absent (L11). 24 is the same
    -- constant the reporter holds as HOURS_IN_A_DAY.
    WHEN p_hours_recorded > 0 AND p_hours_recorded < 24 THEN 'hours-missing'

    -- An empty day reaches here with zero hours and zero executions, and passes
    -- every comparison below, which is the point.

    -- Two independent Postgres counts of one population. They can differ only
    -- when executions arrived after their hour was archived.
    WHEN p_hours_execution_count <> p_pg_execution_count THEN 'late-executions'

    -- Erasures are subtracted before comparing, or a correct erasure blocks its
    -- day forever while naming a remedy that cannot restore destroyed rows.
    WHEN p_sf_execution_count < p_pg_execution_count - p_erased_execution_count
      THEN 'executions-disagree'
    WHEN p_sf_execution_count > p_pg_execution_count - p_erased_execution_count
      THEN 'executions-surplus'

    -- The steps are the bulk of the data and all of the debugging value, so they
    -- refuse on their own rather than by proxy through the execution count (L63).
    WHEN p_sf_step_count <> p_pg_step_count THEN 'steps-disagree'

    WHEN p_orphan_execution_count > 0 THEN 'orphan-executions'
    WHEN NOT p_probe_ok THEN 'probe-failed'
    -- Reached only when the probe passed. A probe that examined no bundles is
    -- not a probe that passed (L98); a genuinely empty day is exempt.
    WHEN p_probe_sampled = 0 AND p_pg_execution_count > 0 THEN 'probe-sampled-nothing'
    WHEN p_incomplete_count > 0 THEN 'incomplete-rows'
    ELSE NULL
  END;
$function$;

-- The caller establishes emptiness LIVE, with an EXISTS rather than a count, so
-- the cost is a single index probe per expired day whatever the day holds.
CREATE OR REPLACE FUNCTION public.expired_day_verdicts(
  p_retention_days integer,
  p_max_measurement_age interval DEFAULT '36:00:00'::interval,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE(archive_day date, refusal text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The expiry arithmetic, in the one place it exists. It matches the procedures
  -- this replaced EXACTLY: they select a partition whose upper bound is at or
  -- before CURRENT_DATE minus retention, and a daily partition for day d has
  -- upper bound d + 1.
  SELECT d.archive_day,
         CASE
           -- Already emptied after a fresh verification: that verdict is final
           -- (#1196), so it is not re-judged against a reading of a day whose
           -- rows are gone.
           WHEN d.executions_truncated_at IS NOT NULL THEN NULL
           ELSE public.verified_day_refusal(
                  p_pg_execution_count     => d.pg_execution_count,
                  p_erased_execution_count => d.erased_execution_count,
                  p_sf_execution_count     => d.sf_execution_count,
                  p_pg_step_count          => d.pg_step_count,
                  p_sf_step_count          => d.sf_step_count,
                  p_orphan_execution_count => d.orphan_execution_count,
                  p_hours_recorded         => d.hours_recorded,
                  p_hours_execution_count  => d.hours_execution_count,
                  p_probe_ok               => d.probe_ok,
                  p_probe_sampled          => d.probe_sampled,
                  p_incomplete_count       => d.incomplete_count,
                  p_measured_at            => d.measured_at,
                  p_now                    => p_now,
                  p_max_measurement_age    => p_max_measurement_age,
                  -- Measured NOW, not read off the row whose age is in question
                  -- (#1249). NOT EXISTS is one index probe: it stops at the
                  -- first row, so a busy day costs the same as an empty one.
                  p_partition_empty        => NOT EXISTS (
                    SELECT 1 FROM public.workflow_executions e
                    WHERE e.started_at >= d.archive_day::timestamptz
                      AND e.started_at <  (d.archive_day + 1)::timestamptz
                  )
                )
         END
  FROM public.execution_archive_days d
  WHERE d.archive_day + 1 <= (p_now AT TIME ZONE 'UTC')::date - p_retention_days;
$function$;

COMMENT ON FUNCTION public.verified_day_refusal(bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, integer, bigint, timestamptz, timestamptz, interval, boolean) IS
  'Why an expired day may not be deleted, or NULL when it may. An empty day is exempt from the measurement-age rule when its partition is proved empty at verdict time (#1249).';
