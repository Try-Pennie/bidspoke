-- ============================================================
-- ONE-TIME bridge cleanup: delete >7-day-old rows from the May 2026 partition
-- ============================================================
-- NOT a migration. Do NOT put this in supabase/migrations/ (it must not run
-- in CI, and several statements below cannot run inside a transaction).
--
-- Context: the May 2026 monthly partition holds all of May's full-payload
-- execution data and cannot be dropped until ~2026-06-08 (see
-- 20260522000002_daily_partitions_7d_retention.sql). Until then it keeps the
-- disk at the high-water mark. This script deletes the rows older than 7 days
-- now, so new May writes reuse the freed space instead of expanding the disk
-- again (18GB -> 27GB).
--
-- Caveats (accepted):
--   * VACUUM (not VACUUM FULL) marks space reusable but does NOT return it to
--     the OS, so the *provisioned* disk stays ~18GB until the partition drops
--     on ~2026-06-08. The point is to stop further growth, not to shrink now.
--   * Run AFTER applying migration 20260522000002 (keeps everything consistent;
--     order is not strictly required, but do it after).
--
-- HOW TO RUN: execute each numbered block SEPARATELY (the SQL editor wraps a
-- multi-statement run in one transaction, which breaks CONCURRENTLY/VACUUM/
-- COMMIT). If the editor rejects CALL with "invalid transaction termination",
-- run blocks 2-3 from psql (connection string in Supabase > Project Settings
-- > Database). Watch the May partition size between runs in the dashboard.

-- ------------------------------------------------------------
-- BLOCK 1 - temp index so the batched delete uses an index scan, not a
-- seq scan, for `started_at < cutoff`. CONCURRENTLY = non-blocking on the
-- live table. Run on its own.
-- ------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tmp_we_2026_05_started_at
  ON workflow_executions_2026_05 (started_at);

-- ------------------------------------------------------------
-- BLOCK 2 - batched delete via a transaction-controlling procedure.
-- Deletes workflow_executions older than 7 days in small batches, committing
-- after each so locks release and live engine-bidding writes aren't starved.
-- execution_steps rows cascade automatically (FK ON DELETE CASCADE, supported
-- by idx_steps_execution). Run the CREATE then the CALL.
-- ------------------------------------------------------------
CREATE OR REPLACE PROCEDURE bridge_purge_old_executions(
  p_cutoff TIMESTAMPTZ,
  p_batch  INTEGER DEFAULT 2000
) LANGUAGE plpgsql AS $$
DECLARE
  v_deleted INTEGER;
  v_total   BIGINT := 0;
BEGIN
  LOOP
    DELETE FROM workflow_executions we
    USING (
      SELECT id, started_at
      FROM workflow_executions
      WHERE started_at < p_cutoff
      LIMIT p_batch
    ) victims
    WHERE we.id = victims.id AND we.started_at = victims.started_at;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_total := v_total + v_deleted;
    COMMIT;                       -- release locks, checkpoint WAL each batch
    EXIT WHEN v_deleted = 0;
    PERFORM pg_sleep(0.05);       -- small breather for live writes
  END LOOP;
  RAISE NOTICE 'bridge purge complete: % executions deleted (steps cascaded)', v_total;
END;
$$;

-- Cutoff = midnight UTC, 7 days ago. Matches the new 7-day retention.
CALL bridge_purge_old_executions(date_trunc('day', now()) - INTERVAL '7 days', 2000);

-- ------------------------------------------------------------
-- BLOCK 3 - reclaim the freed space for reuse and refresh planner stats.
-- VACUUM (not FULL) is non-blocking. ANALYZE prevents the stale-stats /
-- statement-timeout incident seen on 2026-05-18 after partition changes.
-- Run each statement separately.
-- ------------------------------------------------------------
VACUUM (ANALYZE) workflow_executions_2026_05;
VACUUM (ANALYZE) execution_steps_2026_05;

-- ------------------------------------------------------------
-- BLOCK 4 - cleanup the temporary objects.
-- ------------------------------------------------------------
DROP INDEX CONCURRENTLY IF EXISTS idx_tmp_we_2026_05_started_at;
DROP PROCEDURE IF EXISTS bridge_purge_old_executions(TIMESTAMPTZ, INTEGER);
