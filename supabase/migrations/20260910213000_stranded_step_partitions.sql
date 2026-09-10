-- Report a step partition held back by an unverified predecessor (#1249).
--
-- WHY THIS EXISTS. A step partition for day D holds the post-midnight steps of
-- day D-1's executions, so D may only be deleted once D-1 is verified. That
-- rule is right, and it means the two authorised lists legitimately differ in
-- length. On 2026-09-09 they differed by one and the reason was a defect: two
-- empty days refusing `stale-measurement` for ever held 2026-08-16's step
-- partition, and nothing said so. The two lists diverging is exactly the state
-- that must never be silent, and a bare length comparison cannot report it,
-- because one of the two differences it sees is expected.
--
-- THE EXPECTED DIFFERENCE, which this deliberately does NOT report: the OLDEST
-- verified day's own step partition is always held back, because its
-- predecessor is older than anything the gate measures. That predecessor's
-- partition has usually already been dropped, so the day being held costs
-- nothing. Measured 2026-09-10: the oldest verified execution day is
-- 2026-08-14, its predecessor 2026-08-13 was never measured, and neither day
-- has a step partition at all. Reporting that as a stall would be an alarm that
-- fires on every healthy day, which is how a panel gets ignored (L112).
--
-- WHAT IT DOES REPORT is a step partition that EXISTS, whose own day is
-- verified, and which is held back only because the day before it is not. That
-- is the shape the defect took, it costs real disk, and it is always worth
-- somebody's attention.

CREATE OR REPLACE FUNCTION public.stranded_step_partitions(
  p_retention_days integer,
  p_max_measurement_age interval DEFAULT '36:00:00'::interval,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE(archive_day date, partition_name text, blocked_by date, blocked_by_refusal text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH verdicts AS (
    SELECT v.archive_day, v.refusal
    FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now) v
  ),
  -- The step partitions that actually exist, so a day whose partition is
  -- already gone is never reported as stranded: there is nothing there to free.
  existing AS (
    SELECT c.relname::text AS partition_name,
           to_date(right(c.relname, 10), 'YYYY_MM_DD') AS archive_day
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE i.inhparent = 'public.execution_steps'::regclass
      AND c.relname ~ '^execution_steps_\d{4}_\d{2}_\d{2}$'
  )
  SELECT e.archive_day,
         e.partition_name,
         prev.archive_day AS blocked_by,
         prev.refusal AS blocked_by_refusal
  FROM existing e
  JOIN verdicts own ON own.archive_day = e.archive_day AND own.refusal IS NULL
  JOIN verdicts prev ON prev.archive_day = e.archive_day - 1
  -- Held back ONLY by the predecessor: this day itself is verified, and the day
  -- before it is measured and refusing. A predecessor with no verdict row at all
  -- is the oldest-edge case above and is deliberately not reported.
  WHERE prev.refusal IS NOT NULL
  ORDER BY e.archive_day;
$function$;

COMMENT ON FUNCTION public.stranded_step_partitions(integer, interval, timestamptz) IS
  'Step partitions that exist, are themselves verified, and are held back only because the day before them refuses (#1249). Read only. The oldest verified day is excluded: its predecessor is outside the measured window and its partition is already gone.';

REVOKE ALL ON FUNCTION public.stranded_step_partitions(integer, interval, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stranded_step_partitions(integer, interval, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.stranded_step_partitions(integer, interval, timestamptz) TO service_role;
