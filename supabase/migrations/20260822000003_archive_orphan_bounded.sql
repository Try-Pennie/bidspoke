-- Bound the orphan measurement, so the gate can still report the day it exists
-- to report (#872, Phase A4).
--
-- The previous version counted every step row belonging to an execution the
-- archiver never claimed. On a healthy day that is zero rows and free. On a day
-- where archiving has NOT happened it is every step row the day has, which is
-- the case the measurement exists to detect.
--
-- MEASURED against production 2026-08-22:
--
--   2026-01-01  no executions                                        0.5 s
--   2026-08-22  83,341 executions, 19,756 orphaned, 206,795 steps   17.5 s
--   2026-08-20  115,536 executions, essentially all orphaned        TIMED OUT at 30 s
--
-- So the measurement failed hardest on the worst day, which is the shape where
-- an alert is destroyed by the very event it announces. A gate that cannot
-- report "nothing here is archived" is worse than no gate, because a timeout
-- leaves the previous row in place to age quietly into a stale refusal that
-- names the wrong thing.
--
-- THE FIX: count orphan EXECUTIONS exactly, which is the unit the refusal is
-- really about and is cheap (an anti-join over roughly 115,000 rows), and count
-- their steps only for a bounded sample. The step figure becomes an
-- illustration with a stated bound rather than a total, and the gate's message
-- says so: a message may claim only what its check actually measured (L11).

-- How many orphan executions have their steps counted. Enough that the number
-- in the message is meaningful, small enough that the join is a bounded index
-- walk (roughly 500 x 11 steps) whatever the day looks like.
DROP FUNCTION IF EXISTS public.archive_day_measurements(DATE);

CREATE FUNCTION public.archive_day_measurements(p_day DATE)
RETURNS TABLE (
  pg_execution_count      BIGINT,
  pg_step_count           BIGINT,
  erased_execution_count  BIGINT,
  hours_recorded          BIGINT,
  hours_execution_count   BIGINT,
  orphan_execution_count  BIGINT,
  -- Steps belonging to at most `orphan_sample_size` orphan executions. A LOWER
  -- BOUND, never a total, and named so at every layer that reads it.
  orphan_step_count_seen  BIGINT,
  orphan_sample_size      BIGINT
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
      -- Nothing below day_start can qualify: a step's started_at is at or after
      -- its execution's, which is at or after the day start. Upward the slack is
      -- real, because an execution starting at 23:59 has steps after midnight.
      ((p_day + 2)::timestamp AT TIME ZONE 'UTC') AS step_to
  ),
  -- date_trunc('day', ... AT TIME ZONE 'UTC') is the declared source of truth
  -- the TypeScript helper in archive/clock.ts is tested against (L26, L39). The
  -- range predicates are partition pruning hints only, and are deliberately
  -- wider, so they can never exclude a row the day predicate would include.
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
  orphan_executions AS (
    SELECT d.id, d.started_at
    FROM day_executions d
    WHERE NOT EXISTS (SELECT 1 FROM execution_archive_ids a WHERE a.execution_id = d.id::text)
      AND NOT EXISTS (SELECT 1 FROM execution_archive_erasures x WHERE x.execution_id = d.id)
  ),
  orphan_sample AS (
    SELECT id, started_at FROM orphan_executions LIMIT 500
  ),
  orphan_steps AS (
    SELECT count(*) AS n
    FROM orphan_sample o
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
    erased.n,
    hours.n,
    hours.executions,
    (SELECT count(*) FROM orphan_executions),
    orphan_steps.n,
    (SELECT count(*) FROM orphan_sample)
  FROM executions, hours, orphan_steps, erased;
$$;

REVOKE ALL ON FUNCTION public.archive_day_measurements(DATE) FROM PUBLIC, anon, authenticated;
