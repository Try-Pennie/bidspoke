-- Per-hour archive counts, and a deletion gate measurement that can actually
-- run against production volume (#872, Phase A4).
--
-- WHY THIS EXISTS. The first version of archive_day_measurements counted the
-- day's steps with a single COUNT(*) over execution_steps. MEASURED against
-- production on 2026-08-22, for 2026-08-20: 115,536 executions and 1,231,867
-- step rows. The execution count takes 0.5 s. The step count takes 17.5 s with a
-- tight partition hint and 30.0 s with a wider one, which is the statement
-- timeout. The gate measures six days per run, so the day's step count alone
-- would be roughly 105 s of database time in statements each sitting at the
-- timeout, and the orphan anti-join ran on top of that. The whole function timed
-- out on its first real call. This is L24 exactly: state the expected volume
-- before writing the query.
--
-- WHAT REPLACES IT. The archiver ALREADY issues an independent Postgres
-- COUNT(*) of each hour's steps, keyed on execution_started_at, and already
-- refuses the hour unless the rows it actually read reconcile against that count
-- (see streamHour). So a verified per-hour Postgres count exists on every run
-- and was being thrown away. It is now kept, and the day's step count is the sum
-- of its hours.
--
-- That stays INDEPENDENT of the Snowflake side in the way the gate requires: one
-- is a COUNT(*) against execution_steps, the other is SUM(step_count) where
-- step_count was derived by decompressing and re-parsing the bundle actually
-- written. Two stores, two statements, neither derived from the other.
--
-- And it adds a check the day-level count could never make: a day is 24 hours,
-- so a MISSING hour is now visible as a missing hour rather than as a step
-- shortfall of unexplained size.

CREATE TABLE IF NOT EXISTS public.execution_archive_hours (
  hour_start       TIMESTAMPTZ PRIMARY KEY,
  archive_day      DATE   NOT NULL,
  -- Both counted by the archiver's own reconciliation reads, and both already
  -- load-bearing there: an hour whose rows do not match these is refused and its
  -- watermark does not advance, so a row here means the hour reconciled.
  execution_count  BIGINT NOT NULL,
  step_count       BIGINT NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS execution_archive_hours_day_idx
  ON public.execution_archive_hours (archive_day);

COMMENT ON TABLE public.execution_archive_hours IS
  'Per-hour Postgres counts the archiver reconciled against (#872). The gate sums these instead of scanning 1.2M step rows per day.';

ALTER TABLE public.execution_archive_hours ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.execution_archive_hours FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- The Postgres half of a day's measurement, second version
-- ------------------------------------------------------------
--
-- Same four columns, plus the two that let the gate tell a missing hour from a
-- shortfall. Every part is now bounded:
--
--   executions       one partition-pruned COUNT(*), MEASURED at 0.5 s
--   hours present    at most 24 rows
--   steps            SUM over at most 24 rows
--   orphan steps     an anti-join over EXECUTIONS (roughly 115,000) rather than
--                    over STEPS (roughly 1,231,867), then the steps of only the
--                    orphans, which is zero rows when nothing is wrong
--
-- The orphan two-stage is the other half of the fix. The question "which steps
-- have no archived execution" is answered by "which executions were never
-- archived", which is 10x fewer rows, and only then by counting the steps of
-- those few. A healthy day pays nothing for the second stage.
-- Dropped and recreated rather than replaced: CREATE OR REPLACE cannot change a
-- function's return type, and this adds two columns. Nothing in production calls
-- it yet (the code that does is in the same release), so the window in which it
-- does not exist is harmless.
DROP FUNCTION IF EXISTS public.archive_day_measurements(DATE);

CREATE FUNCTION public.archive_day_measurements(p_day DATE)
RETURNS TABLE (
  pg_execution_count      BIGINT,
  pg_step_count           BIGINT,
  pg_orphan_step_count    BIGINT,
  erased_execution_count  BIGINT,
  hours_recorded          BIGINT,
  -- The archiver's own per-hour execution counts, summed. Compared against the
  -- direct count above by the gate: both count executions whose started_at falls
  -- in this day, so they can only differ if executions were written AFTER their
  -- hour was archived, which is the one way a day can be short while every hour
  -- reconciled at the time. Nothing else would notice it.
  hours_execution_count   BIGINT,
  orphan_execution_count  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      (p_day::timestamp AT TIME ZONE 'UTC')       AS day_start,
      ((p_day + 1)::timestamp AT TIME ZONE 'UTC') AS day_end,
      -- A step's own started_at is at or after its execution's, which is at or
      -- after the day start, so there is nothing to look for below it. The
      -- previous version widened downward by a day for no reason and paid 12
      -- extra seconds for rows that cannot exist. Upward the slack is real: an
      -- execution that starts at 23:59 has steps after midnight.
      ((p_day + 2)::timestamp AT TIME ZONE 'UTC') AS step_to
  ),
  -- THE DAY PREDICATE, date_trunc('day', ... AT TIME ZONE 'UTC'), is the
  -- declared source of truth that the TypeScript helper in archive/clock.ts is
  -- tested against (L26, L39). The range predicates beside it are partition
  -- pruning hints only and are deliberately wider, so they can never exclude a
  -- row the day predicate would include.
  day_executions AS (
    SELECT e.id, e.started_at
    FROM workflow_executions e, bounds b
    WHERE e.started_at >= b.day_start
      AND e.started_at <  b.day_end
      AND date_trunc('day', e.started_at AT TIME ZONE 'UTC') = p_day
  ),
  executions AS (SELECT count(*) AS n FROM day_executions),
  hours AS (
    SELECT
      count(*)                          AS n,
      COALESCE(sum(step_count), 0)      AS steps,
      COALESCE(sum(execution_count), 0) AS executions
    FROM execution_archive_hours WHERE archive_day = p_day
  ),
  -- Executions Postgres holds for this day that the archiver never claimed, and
  -- that nobody deliberately erased.
  orphan_executions AS (
    SELECT d.id, d.started_at
    FROM day_executions d
    WHERE NOT EXISTS (SELECT 1 FROM execution_archive_ids a WHERE a.execution_id = d.id::text)
      AND NOT EXISTS (SELECT 1 FROM execution_archive_erasures x WHERE x.execution_id = d.id)
  ),
  orphan_steps AS (
    SELECT count(*) AS n
    FROM orphan_executions o
    CROSS JOIN bounds b
    JOIN execution_steps s
      ON s.execution_id = o.id
     AND s.execution_started_at = o.started_at
     AND s.started_at >= b.day_start
     AND s.started_at <  b.step_to
  ),
  erased AS (
    SELECT count(*) AS n FROM execution_archive_erasures WHERE archive_day = p_day
  )
  SELECT
    executions.n,
    hours.steps,
    orphan_steps.n,
    erased.n,
    hours.n,
    hours.executions,
    (SELECT count(*) FROM orphan_executions)
  FROM executions, hours, orphan_steps, erased;
$$;

REVOKE ALL ON FUNCTION public.archive_day_measurements(DATE) FROM PUBLIC, anon, authenticated;
