-- ============================================================
-- Fix daily-partition rollover (silent no-op since 2026-05-22)
-- ============================================================
-- Follows 20260522000002_daily_partitions_7d_retention.sql.
--
-- Bug: that migration dropped only the empty JUNE monthly partition but left
-- the empty JULY/AUG/SEP monthly partitions the old monthly cron had already
-- pre-created. create_upcoming_daily_partitions() seeded from the MAX existing
-- partition upper bound (2026-10-01, from the Sep partition), so for a target
-- of CURRENT_DATE + N it always concluded "everything is already covered" and
-- created ZERO daily partitions. The nightly cron has reported success while
-- doing nothing since 2026-05-22.
--
-- Consequences:
--   * No daily partitions exist. No JUNE partition exists at all.
--   * On 2026-06-01, every execution_steps / workflow_executions insert fails
--     ("no partition of relation found for row") -> engine step-logging dies.
--
-- Fix:
--   1. Drop the empty Jul/Aug/Sep monthly partitions (empty-guarded). They
--      would otherwise keep July+ on monthly granularity (defeating the
--      7-day daily retention) and re-trigger the same MAX-upper-bound trap.
--   2. Rewrite create_upcoming_daily_partitions() to be gap-tolerant: for each
--      day in the window, create a daily partition unless an existing partition
--      already covers that day. This both fills the June gap and is immune to
--      a stray future-dated partition silently disabling the rollover again.
--   3. Re-seed the daily buffer.
--
-- The May 2026 monthly partition stays attached and ages out naturally under
-- drop_expired_execution_partitions(7) around 2026-06-09; this migration does
-- not touch it.

-- ============================================================
-- 1. Drop the empty Jul/Aug/Sep 2026 monthly partitions
-- ============================================================
-- DETACH before DROP because the workflow_executions parent partition is
-- FK-referenced by execution_steps. Refuse to drop anything non-empty.

DO $$
DECLARE
  v_tbl    TEXT;
  v_parent TEXT;
  v_cnt    BIGINT;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'execution_steps_2026_07', 'execution_steps_2026_08', 'execution_steps_2026_09',
    'workflow_executions_2026_07', 'workflow_executions_2026_08', 'workflow_executions_2026_09'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = v_tbl AND relkind = 'r') THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_tbl) INTO v_cnt;
      IF v_cnt > 0 THEN
        RAISE EXCEPTION
          'Refusing to drop % - it has % rows (expected empty).', v_tbl, v_cnt;
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
-- 2. Gap-tolerant rolling daily partition creator
-- ============================================================
-- For each day in [CURRENT_DATE, CURRENT_DATE + p_days_ahead], create a daily
-- partition UNLESS some existing partition already covers that day. Skipping
-- covered days means it never tries to overlap the still-attached May monthly
-- partition, and creating uncovered days means a gap (or a stray future
-- partition) can no longer silently disable the rollover.

CREATE OR REPLACE FUNCTION create_upcoming_daily_partitions(
  p_days_ahead INTEGER DEFAULT 10
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_created INTEGER := 0;
  v_parent  TEXT;
  v_target  DATE := CURRENT_DATE + p_days_ahead;
  v_day     DATE;
  v_suffix  TEXT;
  v_covered BOOLEAN;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['workflow_executions', 'execution_steps'] LOOP
    v_day := CURRENT_DATE;
    WHILE v_day <= v_target LOOP
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
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          v_parent || '_' || v_suffix, v_parent, v_day, v_day + 1
        );
        v_created := v_created + 1;
      END IF;

      v_day := v_day + 1;
    END LOOP;
  END LOOP;
  RETURN v_created;
END;
$$;

-- ============================================================
-- 3. Re-seed the daily-partition buffer (creates the missing June partitions)
-- ============================================================

SELECT create_upcoming_daily_partitions(10);
