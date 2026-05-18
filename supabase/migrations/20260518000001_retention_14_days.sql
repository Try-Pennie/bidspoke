-- ============================================================
-- Retention policy: 14-day hard purge via partition DROP
-- ============================================================
-- Replaces the previous 14d-compact / 90d-purge shape.
--
-- Why partition DROP instead of row-level DELETE:
--   At 500K+ execution_steps rows per day, row-level DELETE bloats WAL,
--   churns autovacuum, and only reclaims physical space after vacuum runs.
--   DROP TABLE on a partition is instant, reclaims disk immediately, and
--   has no FK-cascade overhead. We still keep the 03:00 UTC compaction
--   cron in place so payloads on lingering-but-soon-to-die rows get
--   nulled out half a day before their partition is dropped.
--
-- Note: this migration leaves `app_config.logpush_active` in place as a
-- no-op. The cold-tier-with-archive concept is being abandoned; the row
-- can be cleaned up in a future migration.

-- ============================================================
-- 1. Partition dropper function
-- ============================================================
-- Drops any partition of workflow_executions or execution_steps whose
-- upper bound is older than `p_retention_days` ago. Returns the count.
-- Safe to run manually any time. Idempotent.

CREATE OR REPLACE FUNCTION drop_expired_execution_partitions(
  p_retention_days INTEGER DEFAULT 14
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  cutoff_date   DATE := CURRENT_DATE - p_retention_days;
  dropped_count INTEGER := 0;
  rec           RECORD;
BEGIN
  -- Drop child (execution_steps) partitions first to keep FK semantics
  -- clean, then parent (workflow_executions) partitions.
  FOR rec IN
    SELECT
      child.relname  AS partition_name,
      parent.relname AS parent_table,
      (regexp_match(
        pg_get_expr(child.relpartbound, child.oid),
        'TO \(''([^'']+)''\)'
      ))[1]::date AS upper_bound
    FROM pg_inherits i
    JOIN pg_class child  ON child.oid  = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname IN ('execution_steps', 'workflow_executions')
    ORDER BY
      CASE parent.relname WHEN 'execution_steps' THEN 0 ELSE 1 END,
      child.relname
  LOOP
    IF rec.upper_bound <= cutoff_date THEN
      -- DETACH first: dropping a partition of the referenced table in an FK
      -- relationship (workflow_executions) fails with "other objects depend
      -- on it" because the FK constraint on execution_steps tracks each
      -- parent partition as a dependency. DETACH severs that dependency
      -- without touching the FK definition itself. Safe for both parent and
      -- child tables; DETACH on a child partition (execution_steps) is a no-op
      -- in terms of FK semantics.
      EXECUTE format(
        'ALTER TABLE %I DETACH PARTITION public.%I',
        rec.parent_table, rec.partition_name
      );
      EXECUTE format('DROP TABLE IF EXISTS public.%I', rec.partition_name);
      dropped_count := dropped_count + 1;
      RAISE NOTICE 'Dropped partition % (parent: %, upper bound: %)',
        rec.partition_name, rec.parent_table, rec.upper_bound;
    END IF;
  END LOOP;

  RETURN dropped_count;
END;
$$;

-- ============================================================
-- 2. Replace the row-level purge cron with partition-drop cron
-- ============================================================

SELECT cron.unschedule('purge-old-executions');

SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  $$SELECT drop_expired_execution_partitions(14)$$
);

-- ============================================================
-- 3. Shrink rollup daily full-refresh window 90 → 14
-- ============================================================
-- The 03:45 UTC full refresh was DELETE-then-INSERT over a 90-day window,
-- which would silently zero out all dashboard history older than 14 days
-- once the source rows are gone. Shrinking the window to 14 leaves old
-- rollup rows frozen in place — they become the long-term historical
-- record even after the source partitions are dropped.
--
-- The 5-minute incremental refresh (2-day lookback) is unchanged.

SELECT cron.unschedule('refresh-workflow-stats-daily-full');

SELECT cron.schedule(
  'refresh-workflow-stats-daily-full',
  '45 3 * * *',
  $$SELECT refresh_workflow_stats_daily(14)$$
);

-- ============================================================
-- 4. One-time backfill: drop partitions already past the 14-day cutoff
-- ============================================================
-- On 2026-05-18 this drops the April 2026 partition (upper bound
-- 2026-05-01, cutoff 2026-05-04). May 2026 stays until June 5 when its
-- upper bound (2026-06-01) crosses cutoff. After this runs, the daily
-- cron at 03:30 UTC handles ongoing drops.
--
-- This is the destructive moment of this migration. If you want to defer
-- the immediate drop and let the cron handle it tomorrow, comment out
-- this SELECT before running `supabase db push`.

SELECT drop_expired_execution_partitions(14);
