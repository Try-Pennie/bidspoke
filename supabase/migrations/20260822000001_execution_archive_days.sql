-- The deletion gate's measurements (#872, Phase A4).
--
-- These tables hold NUMBERS, never a verdict. There is deliberately no
-- is_safe_to_delete column: that is exactly what app_config.logpush_active was,
-- a hand-set boolean that asserted a backup existed and was never checked
-- against one. A day is deletable only when a reader compares the numbers and
-- finds them equal, so a stale or missing row refuses on its own with no code
-- path needed to notice.
--
-- Both are ordinary small tables, not partitioned: one row per UTC day, and one
-- row per erased execution. execution_archive_erasures is deliberately
-- INDEPENDENT of workflow_executions, with no foreign key, because its whole
-- job is to survive the truncate of the partition whose rows it describes.

CREATE TABLE IF NOT EXISTS public.execution_archive_days (
  archive_day             DATE PRIMARY KEY,

  -- Postgres side, counted independently of anything the archiver reported. A
  -- check whose expected and actual come from one lookup only proves the lookup
  -- is self-consistent (L70).
  pg_execution_count      BIGINT,
  -- Counted by execution_started_at, NOT by the step's own started_at. Roughly
  -- 50 executions and several hundred steps cross UTC midnight every day, so
  -- counting by the step's own partition day would disagree with the Snowflake
  -- side on every single day forever.
  pg_step_count           BIGINT,
  -- Steps belonging to this day whose execution has no archived row. Non-zero
  -- refuses the day: those steps have no copy anywhere.
  pg_orphan_step_count    BIGINT,

  -- Snowflake side, read through the reader identity.
  sf_execution_count      BIGINT,   -- COUNT(DISTINCT execution_id)
  sf_step_count           BIGINT,   -- SUM(step_count)

  -- Subtracted from the Postgres side before comparing. Without this a correct
  -- erasure makes Snowflake legitimately lower, the gate reports a shortfall,
  -- and the refusal can never be cleared by the remedy it names: re-running the
  -- archiver re-inserts nothing, because those rows were deliberately
  -- destroyed. Its own column and its own message, so an erasure-driven
  -- difference never reads like a missing-row difference.
  erased_execution_count  BIGINT,

  -- Rows archived at the deadline while still non-terminal. Reported, not fatal.
  incomplete_count        BIGINT,

  -- Matching counts are satisfied by a day of truncated or corrupt blobs, so a
  -- sample is decompressed and checked against Postgres.
  probe_sampled           INTEGER,
  probe_ok                BOOLEAN,
  probe_failure_reason    TEXT,

  measured_at             TIMESTAMPTZ,
  -- Kept across re-measurements, so how long a day has been failing to
  -- reconcile is visible rather than reset by every fresh attempt.
  first_measured_at       TIMESTAMPTZ
);

COMMENT ON TABLE public.execution_archive_days IS
  'Deletion gate measurements per UTC day (#872). Numbers only, never a verdict: a missing or stale row refuses the day.';

CREATE TABLE IF NOT EXISTS public.execution_archive_erasures (
  execution_id  UUID        NOT NULL,
  archive_day   DATE        NOT NULL,
  erased_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason        TEXT        NOT NULL,
  PRIMARY KEY (execution_id, archive_day)
);

CREATE INDEX IF NOT EXISTS execution_archive_erasures_day_idx
  ON public.execution_archive_erasures (archive_day);

COMMENT ON TABLE public.execution_archive_erasures IS
  'Executions deliberately destroyed in the archive (#872, written by A7). No FK to workflow_executions on purpose: it must survive that partition being truncated.';

-- Service-role only, like the other archive bookkeeping tables. Nothing in the
-- browser reads these, and enabling RLS with no policy is the fail-closed state.
ALTER TABLE public.execution_archive_days     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_archive_erasures ENABLE ROW LEVEL SECURITY;

-- No policies are created, so every role that does not bypass RLS sees nothing.
-- The Worker's service_role bypasses it; anon and authenticated do not.
REVOKE ALL ON public.execution_archive_days     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.execution_archive_erasures FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- The Postgres half of a day's measurement
-- ------------------------------------------------------------
--
-- One round trip rather than four, and a SQL function rather than PostgREST
-- queries, because the orphan count is an ANTI-JOIN and PostgREST cannot express
-- one. The alternative it forces is paging every archived id into the Worker and
-- filtering there: roughly 105,000 ids a day against a 1,000 row response cap,
-- which does not fit the invocation's budget. This is the one measurement
-- standing between a partition and permanent deletion, so a check nobody can
-- actually run would leave the orphan column permanently NULL, refusing safely
-- but unexplained (L24).
--
-- VOLUME, stated rather than assumed. Per day: roughly 105,000 executions and
-- 1,050,000 step rows, against roughly 105,000 rows in execution_archive_ids.
-- The orphan count GROUPS the steps to one row per execution first, so the
-- anti-join probes the ids primary key 105,000 times rather than 1,050,000.
--
-- THE DAY PREDICATE IS date_trunc('day', ... AT TIME ZONE 'UTC'), and this
-- expression is the declared source of truth that the TypeScript helper in
-- archive/clock.ts and the fixture in archive/fixtures/archive-day-cases.json
-- are tested against (L26, L39). The BETWEEN predicates beside it are partition
-- pruning hints ONLY: they are deliberately wider than the day, so they can
-- never exclude a row the day predicate would include.
CREATE OR REPLACE FUNCTION public.archive_day_measurements(p_day DATE)
RETURNS TABLE (
  pg_execution_count      BIGINT,
  pg_step_count           BIGINT,
  pg_orphan_step_count    BIGINT,
  erased_execution_count  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      (p_day::timestamp AT TIME ZONE 'UTC')                  AS day_start,
      ((p_day + 1)::timestamp AT TIME ZONE 'UTC')            AS day_end,
      -- A step's own started_at is at or after its execution's, and an execution
      -- that resumes can span hours. A full day of slack each side is far past
      -- anything measured (p99 duration 14 s, max 45 s) and still prunes to
      -- three partitions rather than every partition the table has.
      ((p_day - 1)::timestamp AT TIME ZONE 'UTC')            AS step_from,
      ((p_day + 2)::timestamp AT TIME ZONE 'UTC')            AS step_to
  ),
  executions AS (
    SELECT count(*) AS n
    FROM workflow_executions e, bounds b
    WHERE e.started_at >= b.day_start
      AND e.started_at <  b.day_end
      AND date_trunc('day', e.started_at AT TIME ZONE 'UTC') = p_day
  ),
  -- One row per execution that has steps on this day, with how many. Feeds both
  -- the step total and the orphan count, so those two can never be counted over
  -- different populations.
  steps_by_execution AS (
    SELECT s.execution_id, count(*) AS n
    FROM execution_steps s, bounds b
    WHERE s.started_at >= b.step_from
      AND s.started_at <  b.step_to
      AND s.execution_started_at >= b.day_start
      AND s.execution_started_at <  b.day_end
      AND date_trunc('day', s.execution_started_at AT TIME ZONE 'UTC') = p_day
    GROUP BY s.execution_id
  ),
  step_total AS (
    SELECT COALESCE(sum(n), 0) AS n FROM steps_by_execution
  ),
  orphans AS (
    SELECT COALESCE(sum(g.n), 0) AS n
    FROM steps_by_execution g
    WHERE NOT EXISTS (
      SELECT 1 FROM execution_archive_ids a WHERE a.execution_id = g.execution_id::text
    )
    -- An execution deliberately erased from the archive is not an orphan. Its
    -- steps have no copy because somebody asked for that, and counting them
    -- here would block the day forever with no remedy that could clear it.
    AND NOT EXISTS (
      SELECT 1 FROM execution_archive_erasures x WHERE x.execution_id = g.execution_id
    )
  ),
  erased AS (
    SELECT count(*) AS n FROM execution_archive_erasures WHERE archive_day = p_day
  )
  SELECT executions.n, step_total.n, orphans.n, erased.n
  FROM executions, step_total, orphans, erased;
$$;

REVOKE ALL ON FUNCTION public.archive_day_measurements(DATE) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.archive_day_measurements(DATE) IS
  'Postgres half of the deletion gate measurement for one UTC day (#872). Numbers only.';

-- ------------------------------------------------------------
-- Recording a measurement
-- ------------------------------------------------------------
--
-- A function rather than a PostgREST upsert so first_measured_at is preserved by
-- the database rather than by whoever writes the caller. How long a day has been
-- failing to reconcile is the number that says whether this is a blip or a
-- standing problem, and an upsert that overwrote it would reset that clock on
-- every attempt, so the day would look freshly troubled forever.
CREATE OR REPLACE FUNCTION public.record_archive_day_measurement(
  p_day                     DATE,
  p_pg_execution_count      BIGINT,
  p_pg_step_count           BIGINT,
  p_pg_orphan_step_count    BIGINT,
  p_sf_execution_count      BIGINT,
  p_sf_step_count           BIGINT,
  p_erased_execution_count  BIGINT,
  p_incomplete_count        BIGINT,
  p_probe_sampled           INTEGER,
  p_probe_ok                BOOLEAN,
  p_probe_failure_reason    TEXT
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO execution_archive_days AS d (
    archive_day, pg_execution_count, pg_step_count, pg_orphan_step_count,
    sf_execution_count, sf_step_count, erased_execution_count, incomplete_count,
    probe_sampled, probe_ok, probe_failure_reason, measured_at, first_measured_at
  ) VALUES (
    p_day, p_pg_execution_count, p_pg_step_count, p_pg_orphan_step_count,
    p_sf_execution_count, p_sf_step_count, p_erased_execution_count, p_incomplete_count,
    p_probe_sampled, p_probe_ok, p_probe_failure_reason, NOW(), NOW()
  )
  ON CONFLICT (archive_day) DO UPDATE SET
    pg_execution_count     = EXCLUDED.pg_execution_count,
    pg_step_count          = EXCLUDED.pg_step_count,
    pg_orphan_step_count   = EXCLUDED.pg_orphan_step_count,
    sf_execution_count     = EXCLUDED.sf_execution_count,
    sf_step_count          = EXCLUDED.sf_step_count,
    erased_execution_count = EXCLUDED.erased_execution_count,
    incomplete_count       = EXCLUDED.incomplete_count,
    probe_sampled          = EXCLUDED.probe_sampled,
    probe_ok               = EXCLUDED.probe_ok,
    probe_failure_reason   = EXCLUDED.probe_failure_reason,
    measured_at            = EXCLUDED.measured_at,
    first_measured_at      = d.first_measured_at;
$$;

REVOKE ALL ON FUNCTION public.record_archive_day_measurement(
  DATE, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- The probe's Postgres side
-- ------------------------------------------------------------
--
-- Matching counts are satisfied by a whole day of truncated or corrupt blobs, so
-- a sample of bundles is decompressed and checked against what Postgres holds.
-- This returns the Postgres half of that comparison: which executions to look
-- at, and what each one should say.
--
-- Sampled with ORDER BY random() over ONE daily partition (workflow_executions
-- is partitioned by day), so this is a scan of roughly 105,000 rows and a top-N
-- sort, not a sort of the whole table.
--
-- The step count is taken by execution_started_at, the same key the day
-- predicate uses everywhere else, so a probe disagreement can never be an
-- artifact of counting steps by their own partition day.
CREATE OR REPLACE FUNCTION public.archive_day_probe_sample(p_day DATE, p_sample_size INTEGER)
RETURNS TABLE (
  execution_id  UUID,
  trace_id      TEXT,
  step_count    BIGINT
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
      ((p_day - 1)::timestamp AT TIME ZONE 'UTC') AS step_from,
      ((p_day + 2)::timestamp AT TIME ZONE 'UTC') AS step_to
  ),
  sampled AS (
    SELECT e.id, e.started_at, e.trace_id
    FROM workflow_executions e, bounds b
    WHERE e.started_at >= b.day_start
      AND e.started_at <  b.day_end
      AND date_trunc('day', e.started_at AT TIME ZONE 'UTC') = p_day
    ORDER BY random()
    LIMIT GREATEST(p_sample_size, 0)
  )
  SELECT
    sampled.id,
    sampled.trace_id,
    (
      SELECT count(*)
      FROM execution_steps s, bounds b
      WHERE s.execution_id = sampled.id
        AND s.execution_started_at = sampled.started_at
        AND s.started_at >= b.step_from
        AND s.started_at <  b.step_to
    )
  FROM sampled;
$$;

REVOKE ALL ON FUNCTION public.archive_day_probe_sample(DATE, INTEGER) FROM PUBLIC, anon, authenticated;
