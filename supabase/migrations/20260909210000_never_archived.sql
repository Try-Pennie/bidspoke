-- Tell a day the archive never touched from one it covered partly (#1016).
--
-- WHAT WAS WRONG. Between 2026-08-16 and 2026-08-21 the execution archive
-- covered zero days while Postgres held all six, and nothing reported it. The
-- standstill check could not have: the archiver was running normally on current
-- hours the whole time, so it was neither stalled nor failing. It was simply
-- never asked about the older days, because the hourly run walks forward from a
-- watermark and never looks back. It was found on 2026-08-23 by hand.
--
-- The gate did refuse those days, as `hours-missing`, which reads as a gate
-- being strict rather than as data about to be lost. Some hours archived and
-- some missing is a re-archive of the gap. NO hours archived, while Postgres
-- holds a full day of executions, is a day the walk has never reached, and it is
-- recoverable only until its partition is purged. Different states, different
-- responses, so different codes (L11).
--
-- AN EMPTY DAY IS NOT A DAY THAT WAS MISSED. A day with no executions has no
-- hours to record and nothing to lose, so its zero is honest. It now falls
-- through to the count comparisons, which it passes, rather than refusing on
-- hours it was never going to have.
--
-- That is not tidiness. Measured on production 2026-09-09: 2026-08-14 and
-- 2026-08-15 are empty days carrying zero archived hours, and they refused. A
-- step partition for day D may only go once D-1 is verified, so 2026-08-15
-- stranded 2026-08-16's step partition, 17 execution days authorised against 16
-- step days, with nothing reporting it (#1249).
--
-- WHAT THIS DOES NOT DO, measured after applying rather than assumed. Those two
-- days are STILL refused, as `stale-measurement`, because age is checked before
-- the hours rule and their readings are 147 and 128 hours old. This stops a
-- future empty day entering that state; it does not rescue one already in it,
-- and #1249 stays open for that. Deleting an empty partition loses nothing, so
-- verifying an empty day is the safe direction either way.
--
-- Same signature, so this is a replacement rather than a new arity, and every
-- caller keeps working. `gate-copies-agree.test.ts` fails until the Worker's copy
-- of the decision carries the same code, and it did exactly that when the Worker
-- side of this change landed first.

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

    -- Age next (#1137). A truthful reading of a past state is indistinguishable
    -- from a current one, and the disagreement a stale row reports may already
    -- have been repaired.
    WHEN p_measured_at < p_now - p_max_measurement_age THEN 'stale-measurement'

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

COMMENT ON FUNCTION public.verified_day_refusal(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT,
  BOOLEAN, INTEGER, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, INTERVAL
) IS
  'Why one archived day may not be deleted, or NULL when it may. Refuses on the same twelve conditions as refusalsFor in the Worker, under the same names (#873, #1143, #1016).';

-- ------------------------------------------------------------------
-- Prove the two new behaviours at apply time, not at 03:30 UTC
-- ------------------------------------------------------------------
DO $$
DECLARE v_got TEXT; v_now TIMESTAMPTZ := '2026-09-03T12:00:00Z'; v_ok TIMESTAMPTZ := '2026-09-03T11:00:00Z';
BEGIN
  -- A full day of executions with no archived hour: named for what is at risk.
  v_got := public.verified_day_refusal(104599,0,104599,1000,1000,0,0,104599,true,60,0,v_ok,v_now,interval '36 hours');
  IF v_got IS DISTINCT FROM 'never-archived' THEN
    RAISE EXCEPTION 'expected never-archived for a day with no archived hour, got %L', v_got;
  END IF;

  -- Some hours archived is still short, not never touched.
  v_got := public.verified_day_refusal(104599,0,104599,1000,1000,0,1,104599,true,60,0,v_ok,v_now,interval '36 hours');
  IF v_got IS DISTINCT FROM 'hours-missing' THEN
    RAISE EXCEPTION 'expected hours-missing for a partly archived day, got %L', v_got;
  END IF;

  -- An empty day verifies rather than refusing on hours it never had (#1249).
  v_got := public.verified_day_refusal(0,0,0,0,0,0,0,0,true,0,0,v_ok,v_now,interval '36 hours');
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'expected an empty day to verify, got %L', v_got;
  END IF;

  RAISE NOTICE 'never-archived, hours-missing and the empty day all behave as intended';
END $$;
