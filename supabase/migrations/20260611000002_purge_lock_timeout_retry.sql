-- ============================================================
-- Fix: nightly partition purge parks live traffic behind its lock
-- ============================================================
-- Incident (2026-06-10 03:30 UTC): drop_expired_execution_partitions(7) takes
-- ACCESS EXCLUSIVE on the partitioned parents to DETACH each expired
-- partition. Postgres queues new inserts BEHIND a waiting-or-held ACCESS
-- EXCLUSIVE request, so while the purge held/awaited the lock (~15s), engine
-- inserts queued past the 8s statement timeout and 8 executions lost their
-- audit trail entirely (worker-side retry added separately, issue #23).
--
-- Fix mirrors 20260529000002 (the create-side procedure):
--   - session lock_timeout = '2s': the DETACH waits at most 2s for the lock,
--     so queued inserts stall ~2s worst case (well under the 8s statement
--     timeout) before the DDL yields and releases the queue.
--   - bounded retry with backoff: a yielded DETACH is retried up to 3 times
--     (sleeping 2s/4s between attempts, with no locks held while sleeping);
--     a partition that stays contended is skipped and the next nightly run
--     gets it (the drop is idempotent and a day late is harmless).
--   - PROCEDURE with COMMIT after each partition, so locks are never held
--     across more than one DETACH+DROP. The partition list is materialized
--     into arrays first so transaction control happens outside any cursor.
--
-- The old drop_expired_execution_partitions() FUNCTION is kept for manual
-- runs; the cron is repointed at the procedure (CALL permits the COMMITs).

CREATE OR REPLACE PROCEDURE drop_expired_execution_partitions_safe(
  p_retention_days INTEGER DEFAULT 7,
  p_max_attempts   INTEGER DEFAULT 3
) LANGUAGE plpgsql AS $$
DECLARE
  cutoff_date  DATE := CURRENT_DATE - p_retention_days;
  v_parents    TEXT[];
  v_partitions TEXT[];
  v_i          INTEGER;
  v_attempt    INTEGER;
  v_done       BOOLEAN;
  dropped_count INTEGER := 0;
BEGIN
  -- Bound every lock acquisition in this session. Session-level (not LOCAL)
  -- so it survives the per-partition COMMITs below.
  SET lock_timeout = '2s';

  -- Materialize the expired set up front: child (execution_steps) partitions
  -- first to keep FK semantics clean, then parent (workflow_executions).
  SELECT
    COALESCE(array_agg(parent_table ORDER BY parent_rank, partition_name), '{}'),
    COALESCE(array_agg(partition_name ORDER BY parent_rank, partition_name), '{}')
  INTO v_parents, v_partitions
  FROM (
    SELECT
      parent.relname AS parent_table,
      child.relname  AS partition_name,
      CASE parent.relname WHEN 'execution_steps' THEN 0 ELSE 1 END AS parent_rank
    FROM pg_inherits i
    JOIN pg_class child  ON child.oid  = i.inhrelid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname IN ('execution_steps', 'workflow_executions')
      AND (regexp_match(
        pg_get_expr(child.relpartbound, child.oid),
        'TO \(''([^'']+)''\)'
      ))[1]::date <= cutoff_date
  ) expired;

  FOR v_i IN 1 .. COALESCE(array_length(v_partitions, 1), 0) LOOP
    v_done := FALSE;
    v_attempt := 0;
    WHILE NOT v_done AND v_attempt < p_max_attempts LOOP
      v_attempt := v_attempt + 1;
      BEGIN
        -- DETACH first: dropping a partition of the FK-referenced parent
        -- fails with "other objects depend on it" because the FK on
        -- execution_steps tracks each parent partition as a dependency.
        EXECUTE format(
          'ALTER TABLE %I DETACH PARTITION public.%I',
          v_parents[v_i], v_partitions[v_i]
        );
        EXECUTE format('DROP TABLE IF EXISTS public.%I', v_partitions[v_i]);
        v_done := TRUE;
        dropped_count := dropped_count + 1;
        RAISE NOTICE 'Dropped partition % (parent: %)', v_partitions[v_i], v_parents[v_i];
      EXCEPTION
        WHEN lock_not_available THEN
          RAISE NOTICE 'Lock timeout on % (attempt %/%)', v_partitions[v_i], v_attempt, p_max_attempts;
          IF v_attempt < p_max_attempts THEN
            -- The failed subtransaction released its locks; sleeping here
            -- holds nothing and lets the queued inserts drain.
            PERFORM pg_sleep(2 * v_attempt);
          END IF;
      END;
    END LOOP;
    -- Release everything before the next partition; locks are never held
    -- across more than one DETACH+DROP. (The session-level lock_timeout
    -- survives the COMMIT.)
    COMMIT;
  END LOOP;

  RAISE NOTICE 'drop_expired_execution_partitions_safe: dropped % partition(s)', dropped_count;
END;
$$;

-- ============================================================
-- Repoint the nightly purge cron at the procedure
-- ============================================================
-- Same schedule (03:30 UTC); CALL is required so the COMMITs are permitted.

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-execution-partitions'; END $$;

SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  'CALL drop_expired_execution_partitions_safe(7)'
);
