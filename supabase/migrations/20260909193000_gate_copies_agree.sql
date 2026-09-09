-- Give the SQL deletion gate every condition the reporter refuses on (#1143).
--
-- WHAT WAS WRONG. The rule deciding whether a day of execution history may be
-- destroyed exists twice. `refusalsFor` in apps/worker/src/archive/gate.ts
-- refuses on eleven conditions and draws the report; it deletes nothing.
-- `verified_day_refusal` refuses on eight and is the only one the purge asks.
-- Measured on 2026-09-04, three conditions could not be answered here at all:
--
--   hours-missing          the archiver never finished all 24 hours of the day
--   late-executions        rows arrived after their hour had been archived
--   probe-sampled-nothing  the payload probe examined zero bundles and reported ok
--
-- The first two were usually caught sideways, because a day missing hours
-- normally also comes up short on the execution count. "Usually" is exactly the
-- proxy the step count was deliberately kept separate from (L63). The third was
-- a present hole with no indirect cover at all: `probe_ok` is TRUE when the probe
-- sampled nothing, `WHEN NOT p_probe_ok` is then false, and a whole day of
-- unexamined bundles read as verified.
--
-- WHY THE ASYMMETRY IS THE POINT. The copy with FEWER checks is the one that
-- destroys data; the richer copy only draws a dashboard. So the two could
-- disagree about the same day with nothing anywhere comparing them: the report
-- says refused, the purge proceeds (L263, L370).
--
-- ARGUMENTS, NOT NEW MEASUREMENT. `hours_recorded`, `hours_execution_count` and
-- `probe_sampled` are already columns on `execution_archive_days`, written by
-- `record_archive_day_measurement`. Nothing new is measured here; the numbers
-- simply reach the decision.
--
-- ONE VOCABULARY. Four conditions had a different name on each side
-- (`unmeasured`/`never-measured`, `measurement-stale`/`stale-measurement`,
-- `executions-short`/`executions-disagree`, `steps-short`/`steps-disagree`),
-- which is what let two different rules read as one thing. The reporter's names
-- win, because those are the ones a person sees. `gate-copies-agree.test.ts`
-- now derives both sets from source and fails when they diverge, so the next
-- condition added to one side cannot quietly skip the other.
--
-- NAMED ARGUMENTS AT THE CALL SITE. The signature grew from eleven positional
-- arguments to fourteen, and a positional call is exactly the shape that goes
-- silently wrong when a parameter is inserted (L237). `verified_purgeable_days`
-- now passes every one by name, so a reordering cannot compile into a different
-- question.
--
-- THE OLD ARITY IS DROPPED, NOT LEFT BESIDE THE NEW ONE. Postgres overloads on
-- arity, so a wider CREATE OR REPLACE leaves the eleven argument version
-- callable, carrying its own GRANT, still authorising deletion without the three
-- conditions above. That is the weaker copy this migration exists to remove, so
-- leaving it would be shipping the defect beside its own fix (L29). It is safe
-- to drop in the same release: the only callers are `verified_purgeable_days`,
-- replaced below in the same transaction, and `supabase/tests/verified_deletion_gate.test.sql`,
-- updated beside this file. No Worker code calls it; the Worker has its own copy
-- of the decision, which is the whole subject of this change.
--
-- NULLS STAY REFUSALS. All three new inputs join the unmeasured check. Without
-- that, three valued logic makes `p_hours_recorded < 24` neither true nor false
-- on a day whose hours were never counted, the CASE falls through, and the gate
-- authorises a deletion from a reading nobody took. A row predating the columns
-- (added 2026-08-22) therefore refuses as never-measured until it is measured
-- again, which is the safe direction and clears itself on the next gate run.

-- ------------------------------------------------------------------
-- 1. The decision, with every condition the reporter has
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verified_day_refusal(
  p_pg_execution_count     BIGINT,
  p_erased_execution_count BIGINT,
  p_sf_execution_count     BIGINT,
  p_pg_step_count          BIGINT,
  p_sf_step_count          BIGINT,
  p_orphan_execution_count BIGINT,
  p_hours_recorded         BIGINT,
  p_hours_execution_count  BIGINT,
  p_probe_ok               BOOLEAN,
  p_probe_sampled          INTEGER,
  p_incomplete_count       BIGINT,
  p_measured_at            TIMESTAMPTZ,
  p_now                    TIMESTAMPTZ,
  p_max_measurement_age    INTERVAL
) RETURNS TEXT
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    -- Anything unmeasured, before anything else. Its own code, because "nobody
    -- looked" is a different finding from "the numbers disagree" (L11), and the
    -- remedies differ: one needs a gate run, the other needs a re-archive.
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

    -- Age next (#1137). A truthful reading of a past state is indistinguishable
    -- from a current one, and the disagreement a stale row reports may already
    -- have been repaired, so reporting that disagreement would claim more than
    -- was measured.
    WHEN p_measured_at < p_now - p_max_measurement_age THEN 'stale-measurement'

    -- Before every count below, because p_pg_step_count is SUMMED from these
    -- hours: with hours missing, each count describes a fraction of the day and
    -- would report a step shortfall of unexplained size rather than the hour
    -- that is actually absent (L11). 24 is the same constant the reporter holds
    -- as HOURS_IN_A_DAY; the guard asserts the two match.
    WHEN p_hours_recorded < 24 THEN 'hours-missing'

    -- Two independent Postgres counts of one population. They can differ only
    -- when executions arrived after their hour was archived, which nothing else
    -- notices: every hour reconciled at the time it ran.
    WHEN p_hours_execution_count <> p_pg_execution_count THEN 'late-executions'

    -- Erasures are subtracted before comparing. A correct erasure legitimately
    -- lowers the archive side, and counted as a shortfall it would block the day
    -- forever while naming a remedy (re-archive) that cannot restore rows which
    -- were deliberately destroyed.
    WHEN p_sf_execution_count < p_pg_execution_count - p_erased_execution_count
      THEN 'executions-disagree'
    -- Its own code, and not a shortfall: more in the archive than Postgres holds
    -- is how a SHORTENED retention shows up, days vanishing from Postgres while
    -- the archive still has them.
    WHEN p_sf_execution_count > p_pg_execution_count - p_erased_execution_count
      THEN 'executions-surplus'

    -- The steps are the bulk of the data and all of the debugging value, so they
    -- refuse on their own rather than being protected by proxy through the
    -- execution count (L63).
    WHEN p_sf_step_count <> p_pg_step_count THEN 'steps-disagree'

    WHEN p_orphan_execution_count > 0 THEN 'orphan-executions'
    WHEN NOT p_probe_ok THEN 'probe-failed'
    -- Reached only when the probe passed. A probe that examined no bundles is
    -- not a probe that passed (L98): without this a probe step that selected no
    -- ids reports ok and a whole day of unchecked payloads is authorised. A
    -- genuinely empty day is exempt, because its zero is honest.
    WHEN p_probe_sampled = 0 AND p_pg_execution_count > 0 THEN 'probe-sampled-nothing'
    WHEN p_incomplete_count > 0 THEN 'incomplete-rows'
    ELSE NULL
  END;
$function$;

COMMENT ON FUNCTION public.verified_day_refusal(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT,
  BOOLEAN, INTEGER, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, INTERVAL
) IS
  'Why one archived day may not be deleted, or NULL when it may. Refuses on the same eleven conditions as refusalsFor in the Worker, under the same names (#873, #1143).';

-- ------------------------------------------------------------------
-- 2. The caller, passing every measurement by name
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verified_purgeable_days(
  p_retention_days      INTEGER,
  p_parent              TEXT,
  p_max_measurement_age INTERVAL DEFAULT interval '36 hours',
  p_now                 TIMESTAMPTZ DEFAULT now()
) RETURNS DATE[]
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The expiry arithmetic matches the procedures this replaces EXACTLY: they
  -- select a partition whose upper bound is at or before CURRENT_DATE minus
  -- retention, and a daily partition for day d has upper bound d + 1.
  WITH verified AS (
    SELECT d.archive_day
    FROM public.execution_archive_days d
    WHERE d.archive_day + 1 <= (p_now AT TIME ZONE 'UTC')::date - p_retention_days
      AND (
        -- Already emptied after a fresh verification: that verdict is final (#1196).
        d.executions_truncated_at IS NOT NULL
        OR public.verified_day_refusal(
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
             p_max_measurement_age    => p_max_measurement_age
           ) IS NULL
      )
  )
  -- No verified day means an empty array means nothing is truncated and nothing
  -- is dropped. COALESCE matters: array_agg over no rows is NULL, and NULL fed to
  -- `<> ALL(...)` makes every comparison NULL.
  SELECT COALESCE(array_agg(v.archive_day ORDER BY v.archive_day), '{}'::date[])
  FROM verified v
  WHERE
    -- A step partition for day D holds the post-midnight steps of day D-1's
    -- executions, so D may only go when D-1 is verified too, and "verified"
    -- includes "already truncated after verification".
    p_parent <> 'execution_steps'
    OR EXISTS (SELECT 1 FROM verified p WHERE p.archive_day = v.archive_day - 1);
$function$;

-- ------------------------------------------------------------------
-- 3. Remove the weaker arity, so nothing can ask the old question
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.verified_day_refusal(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BOOLEAN, BIGINT,
  TIMESTAMPTZ, TIMESTAMPTZ, INTERVAL
);

-- ------------------------------------------------------------------
-- 4. Permissions on the new signature
-- ------------------------------------------------------------------
-- The old GRANT went with the dropped function. anon and authenticated have no
-- business reading, still less driving, the machinery that destroys execution
-- data; the Worker reads the verdicts in order to report them.
REVOKE ALL ON ROUTINE public.verified_day_refusal(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT,
  BOOLEAN, INTEGER, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, INTERVAL
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ROUTINE public.verified_day_refusal(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT,
  BOOLEAN, INTEGER, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, INTERVAL
) TO service_role;
