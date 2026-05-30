-- ============================================================
-- Fix: partition-creation cron lock contention (online ATTACH)
-- ============================================================
-- Follows 20260529000001_fix_daily_partition_rollover.sql.
--
-- Incident (2026-05-29 ~00:00 UTC / 8:00 PM EDT): after the rollover fix made
-- create_upcoming_daily_partitions() actually create partitions again, the
-- nightly 'create-daily-partitions' cron ran its first real backfill. Each
-- CREATE TABLE ... PARTITION OF takes ACCESS EXCLUSIVE on the parent
-- (workflow_executions / execution_steps), and the function did every create
-- inside ONE transaction, so the lock was held for the whole ~45s run. The
-- engine's concurrent inserts blocked behind it and were canceled by the
-- statement timeout, surfacing as
--   "workflow_executions insert failed: canceling statement due to statement timeout"
-- (Permanent error, "unknown step" -- it fails at the execution-record insert,
-- before any step runs). Because the cron adds >=1 partition every night, this
-- recurs at 00:00 UTC nightly until fixed.
--
-- Fix -- avoid the insert-blocking lock ENTIRELY by switching from
-- "CREATE TABLE ... PARTITION OF" (ACCESS EXCLUSIVE on the parent) to the
-- online build-then-attach pattern (Postgres 12+). Per partition:
--   1. CREATE the partition as a STANDALONE table (LIKE parent). Only ACCESS
--      SHARE on the parent -- compatible with INSERT, so the engine keeps
--      writing throughout.
--   2. ADD a CHECK matching the day's range (incl. NOT NULL). This lets the
--      ATTACH skip its validation scan, so the attach is instant.
--   3. ATTACH PARTITION. Takes SHARE UPDATE EXCLUSIVE on the parent, which does
--      NOT conflict with INSERT (ROW EXCLUSIVE) -- inserts never block.
--   4. DROP the now-redundant CHECK (the partition bound enforces the range).
-- Belt-and-suspenders: a PROCEDURE that COMMITs after each partition (releases
-- the lighter catalog locks immediately) and lock_timeout = 3s (the only
-- residual conflict for SHARE UPDATE EXCLUSIVE is autovacuum/DDL on the parent;
-- if it can't get the lock in 3s it skips and the next run/buffer covers it).
--
-- This migration only defines the procedure and reschedules the cron -- it
-- takes NO partition locks at apply time, so it is safe under live load. The
-- buffer is extended on the next nightly run; the existing buffer already
-- reaches ~2026-06-09, so there is no coverage gap before then.
--
-- Both parents are RANGE (started_at) -- verified against prod 2026-05-29.

CREATE OR REPLACE PROCEDURE create_upcoming_daily_partitions_safe(
  p_days_ahead INTEGER DEFAULT 30
) LANGUAGE plpgsql AS $$
DECLARE
  v_parent  TEXT;
  v_target  DATE := CURRENT_DATE + p_days_ahead;
  v_day     DATE;
  v_suffix  TEXT;
  v_child   TEXT;
  v_covered BOOLEAN;
BEGIN
  -- SHARE UPDATE EXCLUSIVE only conflicts with autovacuum / DDL on the parent,
  -- never with the engine's inserts. Bound the wait anyway. Session level (not
  -- LOCAL) so it survives the COMMITs below.
  SET lock_timeout = '3s';

  FOREACH v_parent IN ARRAY ARRAY['workflow_executions', 'execution_steps'] LOOP
    v_day := CURRENT_DATE;
    WHILE v_day <= v_target LOOP
      -- Already covered by an existing partition (incl. the still-attached May
      -- monthly one or a day created on a prior run)?
      SELECT EXISTS (
        SELECT 1
        FROM pg_inherits i
        JOIN pg_class child  ON child.oid  = i.inhrelid
        JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname = v_parent
          AND child.relkind = 'r'
          AND v_day >= (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM \(''([^'']+)''\)'))[1]::date
          AND v_day <  (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO \(''([^'']+)''\)'))[1]::date
      ) INTO v_covered;

      IF NOT v_covered THEN
        v_suffix := TO_CHAR(v_day, 'YYYY_MM_DD');
        v_child  := v_parent || '_' || v_suffix;

        BEGIN
          -- 1. Standalone table -- no insert-blocking lock on the parent.
          EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I (LIKE %I INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS)',
            v_child, v_parent
          );
          -- 2. Range-matching CHECK so ATTACH skips the validation scan.
          EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I CHECK (started_at IS NOT NULL AND started_at >= %L AND started_at < %L)',
            v_child, v_child || '_ck', v_day, v_day + 1
          );
          -- 3. ATTACH -- SHARE UPDATE EXCLUSIVE on the parent; inserts flow.
          EXECUTE format(
            'ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
            v_parent, v_child, v_day, v_day + 1
          );
          -- 4. Drop the now-redundant CHECK (partition bound enforces it).
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', v_child, v_child || '_ck');
        EXCEPTION
          -- Couldn't get the catalog lock in 3s (e.g. autovacuum on the
          -- parent). The whole step rolls back -- no leftover standalone table.
          -- The buffer + next nightly run cover this day.
          WHEN lock_not_available THEN
            RAISE NOTICE 'Skipped % (lock timeout)', v_child;
        END;

        -- Release everything before the next day / other parent. Core of the
        -- fix: locks are never held across more than one partition.
        COMMIT;
      END IF;

      v_day := v_day + 1;
    END LOOP;
  END LOOP;
END;
$$;

-- ============================================================
-- Repoint the nightly cron at the procedure (CALL, not SELECT)
-- ============================================================
-- Same name + schedule (00:00 UTC) -- the fix is the lock behavior, not the
-- time. CALL is required so the procedure's COMMITs are permitted.

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'create-daily-partitions'; END $$;

SELECT cron.schedule(
  'create-daily-partitions',
  '0 0 * * *',
  'CALL create_upcoming_daily_partitions_safe(30)'
);

-- Note: the old create_upcoming_daily_partitions() FUNCTION is left in place
-- (no longer scheduled). The cron no longer uses it.
