-- Refresh the field presence rollup incrementally, not by rebuilding a window (#1150).
--
-- THE SHAPE THAT KEEPS BITING. refresh_field_presence_daily deletes and
-- re-aggregates a window of whole days on every run. #1147 cut the cadence and
-- #1884 narrowed the frequent pass to today only, but the frequent pass still
-- RE-READS the whole of today's partition every 15 minutes: its cost is the size
-- of today's partition, not the handful of executions that finished since the
-- last pass. By mid afternoon today's partition is tens of thousands of rows and
-- the pass reads all of them to fold in a few hundred new ones. #1884 measured
-- refresh_field_presence_daily(2) at 348 MB read per run; today-only is lighter
-- but the shape is unchanged and grows with traffic and with the watched-field
-- set (#435 doubled the keys per execution).
--
-- THE CHANGE. The frequent pass becomes a watermark-driven incremental ADD:
--
--   refresh_field_presence_incremental()  reads field_presence_rollup_state.watermark,
--     aggregates only executions whose completed_at is in (watermark, now() - lag],
--     and UPSERTS each (workflow_id, field_path, day, is_test) by ADDING its counts
--     to the row already there, then advances the watermark. completed_at is the
--     finalize timestamp, written in the same update as field_presence (verified
--     on prod 2026-10-13: 0 rows with field_presence set and completed_at null),
--     so a newly finished execution crosses the watermark exactly once.
--
-- The day is still (started_at AT TIME ZONE 'UTC')::date, so a run that starts
-- before midnight and finishes after it lands in its START day, exactly as the
-- full reaggregation groups it. The counts are cumulative per day, so the
-- incremental pass can only ADD, never replace a day: a day already holds the
-- runs that finished earlier.
--
-- WHY THIS NEEDS AN EXACTLY-ONCE BOUNDARY, and how it gets one:
--   * incremental vs incremental: the window is half open (watermark, ceiling],
--     and the watermark only ever moves forward, so no execution is added twice
--     across passes.
--   * the lag (1 minute) keeps the ceiling behind now() so an execution whose
--     completed_at is just under now() but whose row is not yet visible
--     (committed microseconds later) is picked up by the NEXT pass rather than
--     skipped forever. Commit latency here is sub-second, so a minute is ample.
--   * incremental vs reconcile: the two share one advisory lock
--     (pg_advisory_xact_lock(883301, 2)), so a full reconcile's DELETE+INSERT and
--     an incremental ADD never interleave. And every reconcile counts and takes
--     its watermark in ONE statement (one snapshot), under the SAME one minute
--     ceiling, setting the watermark to the largest completed_at it counted
--     (never lower than before), so the incremental pass that follows cannot
--     re-add anything the reconcile already absorbed, even if the worker clock
--     that stamped completed_at ran ahead of the database clock.
--   * what neither pass can see: a run whose row commits more than a minute after
--     the completed_at it was stamped with, behind a newer run already counted.
--     The watermark does not recover it; the next hourly reconcile, which
--     recounts whole days, does.
--
-- THE BACKSTOP STAYS. refresh_field_presence_daily keeps its delete-then-insert
-- reaggregation unchanged (so its lookback 0 still rewrites today exactly, which
-- the SQL suite's rollup_today_only test drives directly); the only addition is
-- that it now advances the watermark too. The recent (every hour, lookback 2) and
-- nightly (lookback 7) jobs are the correctness backstop: they recompute whole
-- days from the raw table, so any drift the incremental pass leaves behind (an
-- execution finalised late and backdated by the strand finaliser, an execution
-- in flight at the exact instant a reconcile read) is corrected within the hour
-- for recent days and within a day for everything in retention. The incremental
-- pass is the freshness, the reconcile is the truth.
--
-- Expand/contract (ADR 0007): additive. A new index, a new one-row state table, a
-- new function, and one cron command repointed in place with cron.alter_job (jobid
-- kept, so run history and the pg_cron watch's grace survive, per #1884). No
-- column or signature changes the deployed worker reads, so code and schema deploy
-- in either order. The worker never calls either refresh function (both are pg_cron
-- only), so neither is a worker rpc and neither belongs in read-only-rpcs.json.
--
-- Guarded by supabase/tests/field_presence_incremental.test.sql,
-- supabase/tests/rollup_today_only.test.sql, and
-- apps/web/src/lib/__tests__/rollup-refresh-collision-guard.test.ts.

-- ------------------------------------------------------------------
-- 1. The watermark index on workflow_executions
-- ------------------------------------------------------------------
-- The incremental pass scans by completed_at, which is not the partition key
-- (started_at is), so without this index each pass would seq scan every retained
-- partition. The partial clause matches the pass's own predicate and keeps the
-- index to the rows that carry a presence map. Future partitions, made with
-- CREATE TABLE ... PARTITION OF (20260522000002), inherit it automatically.
--
-- PROD NOTE: a plain CREATE INDEX on the parent recurses and holds a lock on every
-- partition until the whole build commits, which would stall execution logging on
-- the live day. Partitions are DAILY, so on prod the index was built before this
-- migration ran, the way 20260824000001 did it:
--
--   -- 1. Per partition, each its own statement: every empty and sealed day
--   --    first, the live day last. Name: <partition>_fp_completed_at_idx.
--   CREATE INDEX workflow_executions_2026_10_06_fp_completed_at_idx
--     ON workflow_executions_2026_10_06 (completed_at) WHERE field_presence IS NOT NULL;
--   ...one per partition, empty future ones included, because the parent index
--   --    cannot become valid until every partition has a match...
--
--   -- 2. Parent index, metadata only (instant; INVALID until all attach)
--   CREATE INDEX workflow_executions_fp_completed_at_idx
--     ON ONLY workflow_executions (completed_at) WHERE field_presence IS NOT NULL;
--
--   -- 3. Attach each (the parent flips to VALID when the last one lands)
--   ALTER INDEX workflow_executions_fp_completed_at_idx
--     ATTACH PARTITION workflow_executions_2026_10_06_fp_completed_at_idx;
--
-- The statement below is therefore a NO-OP on prod (the named parent index already
-- exists). On fresh and CI databases it builds normally against small partitions.
CREATE INDEX IF NOT EXISTS workflow_executions_fp_completed_at_idx
  ON public.workflow_executions (completed_at)
  WHERE field_presence IS NOT NULL;

-- ------------------------------------------------------------------
-- 2. The watermark state
-- ------------------------------------------------------------------
-- One row. The watermark is the completed_at up to which every finished execution
-- is already folded into field_presence_daily. Internal machinery: no browser
-- role has any business reading it, so RLS is on with no policy (the live
-- privilege check requires RLS on every table anon/authenticated can reach), and
-- the browser roles are revoked outright (L124: Supabase's default grant is made
-- to anon and authenticated directly, not only to PUBLIC).
CREATE TABLE IF NOT EXISTS field_presence_rollup_state (
  id         BOOLEAN     PRIMARY KEY DEFAULT true,
  watermark  TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT field_presence_rollup_state_singleton CHECK (id)
);

ALTER TABLE field_presence_rollup_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE field_presence_rollup_state FROM anon, authenticated;

-- No placeholder row. The reconcile upserts the row, and this migration runs one
-- as its seed (section 5), so the first watermark is the reconcile's own: the
-- largest completed_at it counted, or its one minute ceiling when it counted
-- nothing. A placeholder at now() would sit above that ceiling, GREATEST would
-- keep it, and the runs of the minute before it would be skipped by both passes.

-- ------------------------------------------------------------------
-- 3. The reconcile: delete-then-insert, now also advancing the watermark
-- ------------------------------------------------------------------
-- Body is the #1720 reconcile (the scan runs as a statement with LITERAL
-- started_at bounds so the planner prunes to the days read and the run locks only
-- those partitions, never all of them), plus the watermark advance.
--
-- The count and the watermark's max are ONE statement (a data-modifying CTE), so
-- they read the SAME snapshot. As two statements, an execution that finished
-- between them was missed by the count yet sat below the new watermark, so the
-- incremental skipped it too, and it was lost until the next reconcile (#1150
-- review). In one snapshot such an execution is invisible to both.
--
-- The count also stops at the incremental's ceiling, now less one minute. Without
-- it the watermark could jump to a run stamped a second ago, past an older-stamped
-- run whose row had not committed when the snapshot was taken, and the incremental
-- would then skip that one too. With it, the reconcile and the incremental leave
-- exactly the same residual (a commit more than a minute behind its stamp), and
-- the next hourly reconcile recounts it.
--
-- The watermark becomes the largest completed_at actually counted, never now()
-- and never lower than it was. Every counted row therefore sits at or below the
-- watermark, so the incremental (completed_at strictly greater) cannot re-add it,
-- even when the worker clock that stamped completed_at ran ahead of the
-- database's. Using now() instead would also skip a recent execution from outside
-- this reconcile's window, which this window never counted.
CREATE OR REPLACE FUNCTION refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_from TIMESTAMPTZ := (CURRENT_DATE - p_lookback_days)::timestamptz;
  v_to   TIMESTAMPTZ := (CURRENT_DATE + 1)::timestamptz;
  v_max  TIMESTAMPTZ;
  v_ceiling TIMESTAMPTZ;
BEGIN
  SET LOCAL lock_timeout = '30s';
  PERFORM pg_advisory_xact_lock(883301, 2);

  -- The incremental's ceiling, read from the clock AFTER the lock: now() is when
  -- this transaction began, possibly before an incremental that held the lock
  -- moved the watermark further, and a ceiling below that watermark would delete
  -- runs the incremental had counted without recounting them.
  v_ceiling := clock_timestamp() - interval '1 minute';

  DELETE FROM field_presence_daily
  WHERE day >= (CURRENT_DATE - p_lookback_days);

  -- Literal bounds, so the planner prunes to the days read (#1720). A run with
  -- field_presence but no completed_at (none on prod, 2026-10-13) is counted here
  -- as it always was; the incremental never counts it, so nothing is doubled.
  EXECUTE format($q$
    WITH src AS (
      SELECT we.workflow_id, we.started_at, we.is_test, we.completed_at, we.field_presence
      FROM workflow_executions we
      WHERE we.started_at >= %L
        AND we.started_at <  %L
        AND we.field_presence IS NOT NULL
        AND (we.completed_at IS NULL OR we.completed_at <= %L)
    ), ins AS (
      INSERT INTO field_presence_daily (
        workflow_id, field_path, day, is_test, ran_count, present_count
      )
      SELECT
        src.workflow_id,
        je.key,
        (src.started_at AT TIME ZONE 'UTC')::date,
        src.is_test,
        count(*),
        count(*) FILTER (WHERE je.value = 'true'::jsonb)
      FROM src
      CROSS JOIN LATERAL jsonb_each(src.field_presence) AS je(key, value)
      GROUP BY
        src.workflow_id, je.key,
        (src.started_at AT TIME ZONE 'UTC')::date, src.is_test
      RETURNING 1
    )
    SELECT max(completed_at) FROM src
  $q$, v_from, v_to, v_ceiling) INTO v_max;

  -- An upsert, not an UPDATE: a restored database's state table is empty (it is
  -- structure only in the DR drill), and an UPDATE would touch no row, never seed
  -- it, and leave the incremental refusing on every pass. The reconcile seeds it.
  -- With nothing counted the watermark is left where it was (or seeded at the
  -- ceiling, so the incremental still takes the last minute).
  INSERT INTO field_presence_rollup_state (id, watermark, updated_at)
  VALUES (true, COALESCE(v_max, v_ceiling), now())
  ON CONFLICT (id) DO UPDATE
    SET watermark  = CASE
                       WHEN v_max IS NULL THEN field_presence_rollup_state.watermark
                       ELSE GREATEST(field_presence_rollup_state.watermark, v_max)
                     END,
        updated_at = now();
END;
$fn$;

-- ------------------------------------------------------------------
-- 4. The incremental: aggregate since the watermark, upsert-add
-- ------------------------------------------------------------------
-- The scan is bounded on completed_at (the watermark window) AND on started_at
-- (the partition key), the latter as a LITERAL so the planner prunes to recent
-- partitions and this every-15-minute pass does not take a lock on every
-- partition of workflow_executions the way the pre-#1720 rollups did. The
-- started_at floor is the watermark less two days: an execution finishes within
-- two days of starting in all but stranded cases, and a stranded one that
-- finishes later is folded in by the recent and nightly reconcile backstops
-- rather than by this pass, so the floor cannot lose a count the system keeps.
CREATE OR REPLACE FUNCTION refresh_field_presence_incremental()
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_last    TIMESTAMPTZ;
  -- Keep the ceiling behind now() so an execution whose row commits just after
  -- its completed_at is picked up by the next pass, not skipped (see header).
  v_ceiling TIMESTAMPTZ := now() - interval '1 minute';
  v_floor   TIMESTAMPTZ;
BEGIN
  SET LOCAL lock_timeout = '30s';
  -- The SAME lock the reconcile takes (883301, 2): an ADD and a delete-then-insert
  -- must never interleave.
  PERFORM pg_advisory_xact_lock(883301, 2);

  SELECT watermark INTO v_last FROM field_presence_rollup_state WHERE id;
  IF v_last IS NULL THEN
    -- The state row is seeded by this migration and advanced by every reconcile.
    -- Its absence is a real fault, not an empty incremental window, so refuse
    -- loudly rather than aggregate from the beginning of time (L11, L98).
    RAISE EXCEPTION 'field_presence_rollup_state has no watermark row; a reconcile must seed it first';
  END IF;

  -- Nothing has had time to settle since the last pass. Leave the watermark where
  -- it is; moving it would skip the minute between v_last and the ceiling.
  IF v_ceiling <= v_last THEN
    RETURN;
  END IF;

  v_floor := v_last - interval '2 days';

  -- Literal started_at bound prunes partitions (#1720); the completed_at window is
  -- the watermark interval, half open so each execution is counted exactly once.
  EXECUTE format($q$
    INSERT INTO field_presence_daily (
      workflow_id, field_path, day, is_test, ran_count, present_count
    )
    SELECT
      we.workflow_id,
      je.key,
      (we.started_at AT TIME ZONE 'UTC')::date,
      we.is_test,
      count(*),
      count(*) FILTER (WHERE je.value = 'true'::jsonb)
    FROM workflow_executions we
    CROSS JOIN LATERAL jsonb_each(we.field_presence) AS je(key, value)
    WHERE we.started_at  >= %L
      AND we.completed_at >  %L
      AND we.completed_at <= %L
      AND we.field_presence IS NOT NULL
    GROUP BY
      we.workflow_id, je.key,
      (we.started_at AT TIME ZONE 'UTC')::date, we.is_test
    ON CONFLICT (workflow_id, field_path, day, is_test) DO UPDATE
      SET ran_count     = field_presence_daily.ran_count     + EXCLUDED.ran_count,
          present_count = field_presence_daily.present_count + EXCLUDED.present_count
  $q$, v_floor, v_last, v_ceiling);

  UPDATE field_presence_rollup_state
  SET watermark = v_ceiling, updated_at = now()
  WHERE id;
END;
$fn$;

-- Same posture as the sibling refreshers (#762, #764): worker-less, pg_cron only.
-- CREATE OR REPLACE preserves an existing ACL, but a brand new function is granted
-- to PUBLIC by Postgres and to anon/authenticated by Supabase's defaults, so both
-- are revoked explicitly (L124), and refresh_field_presence_daily's revokes are
-- re-issued for the same reason the earlier migrations re-issue them.
REVOKE ALL ON FUNCTION refresh_field_presence_daily(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION refresh_field_presence_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION refresh_field_presence_daily(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_field_presence_incremental() TO service_role;

COMMENT ON FUNCTION refresh_field_presence_incremental() IS
  'Frequent field presence rollup pass (#1150): folds executions finished since field_presence_rollup_state.watermark into field_presence_daily by adding to each day, then advances the watermark. refresh_field_presence_daily remains the delete-then-insert reconcile backstop.';

-- ------------------------------------------------------------------
-- 5. Seed the recent baseline authoritatively, then advance the watermark
-- ------------------------------------------------------------------
-- Rewrite the last two days and set the watermark, so the incremental pass starts
-- from a correct, consistent baseline with no gap. Lookback 2, not 7: this runs at
-- whatever time the migration is applied, possibly at peak traffic, and a 7-day
-- reaggregation is the heaviest form of this read (the off-peak nightly job does it
-- under a 300s budget). The database stalled for memory on 2026-10-08 (#1884), so a
-- deploy must not add an unscheduled full scan. Lookback 2 is exactly what the
-- hourly recent job already runs every hour, so its cost is proven; days older than
-- two are already correct from the last nightly reconcile, which keeps running as
-- the backstop. Bounded at the nightly's 300s rather than 0, so a slow seed fails
-- loudly instead of holding the shared advisory lock indefinitely. Stated as its own
-- statement before the SELECT so it binds the call (a SET inside the function would
-- not, #1147).
SET LOCAL statement_timeout = '300s';
SELECT refresh_field_presence_daily(2);

-- ------------------------------------------------------------------
-- 6. Repoint the frequent job at the incremental pass
-- ------------------------------------------------------------------
-- Altered in place so the jobid, run history and the pg_cron watch's grace period
-- survive (#1884, #770). Schedule and budget unchanged; only the SELECT changes.
-- A job this migration cannot find is refused by name rather than left to
-- cron.alter_job's own null-id error (L11).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-field-presence-daily') THEN
    RAISE EXCEPTION '#1150: pg_cron job refresh-field-presence-daily is missing, so it cannot be repointed';
  END IF;
END
$$;

SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'refresh-field-presence-daily'),
  command := $$SET statement_timeout = '180s'; SET lock_timeout = '30s'; SELECT refresh_field_presence_incremental()$$
);
