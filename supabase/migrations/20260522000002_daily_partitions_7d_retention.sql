-- ============================================================
-- Daily partitions + 7-day retention
-- ============================================================
-- Follows 20260518000001_retention_14_days.sql.
--
-- Why: at engine-bidding volume (~645K execution_steps rows/day) the disk
-- pressure comes from in-window hot data, not old data the purge missed.
-- With MONTHLY partitions, the current month's partition cannot be dropped
-- until the whole month is past the cutoff, so effective retention was
-- 22-45 days regardless of the 14-day setting. Switching to DAILY partitions
-- lets the drop track the window tightly, and 7-day retention halves the
-- hot footprint.
--
-- Transition shape:
--   * The existing May 2026 MONTHLY partition stays attached and keeps
--     receiving writes through 2026-05-31. It ages out under the new 7-day
--     rule (upper bound 2026-06-01 crosses cutoff on 2026-06-08).
--   * The empty June 2026 MONTHLY partition (auto-created by the old monthly
--     cron) is dropped here so the June range is free for daily partitions.
--   * From 2026-06-01 onward, writes land in DAILY partitions created by the
--     new rolling cron.
--
-- The existing drop_expired_execution_partitions() function is granularity
-- agnostic (its regex parses any TO ('YYYY-MM-DD') bound), so it needs no
-- change beyond being called with 7 instead of 14.

-- ============================================================
-- 1. Drop the empty June 2026 monthly partitions (free the June range)
-- ============================================================
-- Defensive: refuse to drop if they somehow contain rows (i.e. if June has
-- started before this migration is applied). DETACH before DROP because the
-- workflow_executions parent partition is FK-referenced by execution_steps.

DO $$
DECLARE
  v_tbl    TEXT;
  v_parent TEXT;
  v_cnt    BIGINT;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['execution_steps_2026_06', 'workflow_executions_2026_06'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = v_tbl AND relkind = 'r') THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_tbl) INTO v_cnt;
      IF v_cnt > 0 THEN
        RAISE EXCEPTION
          'Refusing to drop % - it has % rows (expected empty). Has June 2026 started? Re-scope this migration before applying.',
          v_tbl, v_cnt;
      END IF;
      v_parent := CASE
        WHEN v_tbl LIKE 'workflow_executions%' THEN 'workflow_executions'
        ELSE 'execution_steps'
      END;
      EXECUTE format('ALTER TABLE %I DETACH PARTITION public.%I', v_parent, v_tbl);
      EXECUTE format('DROP TABLE IF EXISTS public.%I', v_tbl);
      RAISE NOTICE 'Dropped empty partition %', v_tbl;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 2. Rolling daily partition creator
-- ============================================================
-- Ensures daily partitions exist for both partitioned tables out to
-- CURRENT_DATE + p_days_ahead. Starts from each table's highest existing
-- partition upper bound, so it never tries to create a daily partition that
-- overlaps a still-present monthly partition (e.g. May 2026). Idempotent.

CREATE OR REPLACE FUNCTION create_upcoming_daily_partitions(
  p_days_ahead INTEGER DEFAULT 10
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_created INTEGER := 0;
  v_parent  TEXT;
  v_max_ub  DATE;
  v_target  DATE := CURRENT_DATE + p_days_ahead;
  v_day     DATE;
  v_suffix  TEXT;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['workflow_executions', 'execution_steps'] LOOP
    -- Highest existing partition upper bound for this parent. Existing
    -- partitions cover [..., v_max_ub), so the first uncovered day is v_max_ub.
    SELECT MAX((regexp_match(
                  pg_get_expr(child.relpartbound, child.oid),
                  'TO \(''([^'']+)''\)'
                ))[1]::date)
      INTO v_max_ub
    FROM pg_inherits i
    JOIN pg_class child  ON child.oid  = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = v_parent;

    v_day := GREATEST(COALESCE(v_max_ub, CURRENT_DATE), CURRENT_DATE);
    WHILE v_day <= v_target LOOP
      v_suffix := TO_CHAR(v_day, 'YYYY_MM_DD');
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        v_parent || '_' || v_suffix, v_parent, v_day, v_day + 1
      );
      v_created := v_created + 1;
      v_day := v_day + 1;
    END LOOP;
  END LOOP;
  RETURN v_created;
END;
$$;

-- ============================================================
-- 3. Swap the monthly creator cron for the daily creator
-- ============================================================
-- Safe unschedule (no error if the job is already gone).

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'create-monthly-partitions'; END $$;

SELECT cron.schedule(
  'create-daily-partitions',
  '0 0 * * *',
  'SELECT create_upcoming_daily_partitions(10)'
);

-- ============================================================
-- 4. Retention 14d -> 7d
-- ============================================================

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-execution-partitions'; END $$;

SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  $$SELECT drop_expired_execution_partitions(7)$$
);

-- ============================================================
-- 5. Match the rollup full-refresh window to retention (14 -> 7)
-- ============================================================
-- Must be <= retention or the daily full refresh zeroes out rollup rows
-- whose source partitions have already been dropped. Runs at 03:45, after
-- the 03:30 purge, so the oldest day it recomputes (today-7) still has data.

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'refresh-workflow-stats-daily-full'; END $$;

SELECT cron.schedule(
  'refresh-workflow-stats-daily-full',
  '45 3 * * *',
  $$SELECT refresh_workflow_stats_daily(7)$$
);

-- ============================================================
-- 6. Seed the initial daily-partition buffer
-- ============================================================
-- Today this creates the 2026-06-01 daily partition (May's monthly partition
-- still covers everything through 2026-05-31). The daily cron extends the
-- buffer one day forward each night thereafter.

SELECT create_upcoming_daily_partitions(10);

-- ============================================================
-- Note: the 03:00 'compact-execution-payloads' cron (nulls payloads at 14d)
-- is now effectively dead under 7-day retention - partitions drop at 7d,
-- before its 14d threshold ever applies. Left in place as a harmless no-op;
-- can be unscheduled in a future cleanup.
-- ============================================================
