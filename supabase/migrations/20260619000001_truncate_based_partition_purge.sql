-- ============================================================
-- Root fix: nightly purge no longer locks live tables or storms the schema cache
-- ============================================================
-- Issues #236 / #133. The nightly purge DETACHed+DROPped expired partitions of
-- execution_steps + workflow_executions. Two harms at 03:30 UTC:
--   1. DETACH takes ACCESS EXCLUSIVE on the partitioned parent, stalling live
--      inserts (bounded to ~2s by lock_timeout, but still contends).
--   2. Every DETACH (ALTER TABLE) and DROP fires a PostgREST schema-cache
--      reload (extensions.pgrst_ddl_watch / pgrst_drop_watch), which 503s ALL
--      PostgREST traffic for the rebuild — this is what dropped lead-sightings
--      rows (#237) and tripped the Hyperdrive-fallback alert (#235).
--
-- TRUNCATE avoids both: it locks only the named (old, untouched) partition, not
-- the parent, so live inserts don't contend; and its command tag is in NEITHER
-- pgrst watch list, so it fires no schema-cache reload. Verified on a scratch
-- schema against this database (PG 17.6) 2026-06-19.
--
-- Obstacle TRUNCATE hits: "cannot truncate a table referenced in a foreign key
-- constraint, unless all such tables are also truncated in the same command"
-- (verified — fails even naming both partitions, because the restriction is at
-- the referencing-TABLE level, not the partition). execution_steps references
-- workflow_executions via execution_steps_execution_fk, so we must drop that FK
-- to truncate workflow_executions partitions. Safe here: these are append-only
-- log tables and the engine always inserts the workflow_executions row before
-- any execution_steps row (createExecutionRecord precedes flushStepLogs), so the
-- FK was a backstop, not load-bearing. Its ON DELETE CASCADE (added in
-- 20260424000001) only mattered for ad-hoc row-level DELETEs of executions;
-- retention is entirely partition-based and there is no active
-- DELETE-FROM-workflow_executions cron (verified against cron.job 2026-06-19),
-- so nothing live depends on the cascade. The only loss: a future manual
-- DELETE FROM workflow_executions would orphan its steps instead of cascading.
-- Trade-off accepted per #236 (B2).
--
-- Partition removal still has to happen eventually to bound partition count
-- (TRUNCATE empties a partition but leaves the empty shell attached). That is
-- moved to a separate WEEKLY reaper (Sunday 04:00 UTC) that detach+drops the now
-- empty expired shells via the existing safe procedure — so the unavoidable
-- DROP-driven reload happens ~weekly in a quiet window instead of nightly. The
-- weekly reap keeps the nightly truncate set small (<= ~7 days of partitions).

-- ------------------------------------------------------------
-- 1. Drop the FK that blocks truncating workflow_executions partitions
-- ------------------------------------------------------------
ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_execution_fk;

-- ------------------------------------------------------------
-- 2. Nightly TRUNCATE of expired partitions (no parent lock, no reload)
-- ------------------------------------------------------------
CREATE OR REPLACE PROCEDURE truncate_expired_execution_partitions(
  p_retention_days INTEGER DEFAULT 7
) LANGUAGE plpgsql AS $$
DECLARE
  cutoff_date    DATE := CURRENT_DATE - p_retention_days;
  v_partitions   TEXT[];
  v_i            INTEGER;
  v_has_rows     BOOLEAN;
  truncated_count INTEGER := 0;
BEGIN
  -- Bound every lock acquisition; survives the per-partition COMMITs.
  SET lock_timeout = '2s';

  -- Same expired-partition detection as the drop-based purge: child
  -- (execution_steps) partitions first, then parent (workflow_executions).
  SELECT COALESCE(array_agg(partition_name ORDER BY parent_rank, partition_name), '{}')
  INTO v_partitions
  FROM (
    SELECT
      child.relname AS partition_name,
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
    BEGIN
      -- Skip partitions already empty (re-truncating a prior night's emptied
      -- shell would take a needless ACCESS EXCLUSIVE on a cold partition).
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', v_partitions[v_i])
        INTO v_has_rows;
      IF v_has_rows THEN
        EXECUTE format('TRUNCATE TABLE public.%I', v_partitions[v_i]);
        truncated_count := truncated_count + 1;
        RAISE NOTICE 'Truncated expired partition %', v_partitions[v_i];
      END IF;
    EXCEPTION
      WHEN lock_not_available THEN
        RAISE NOTICE 'Lock timeout truncating % (skipped; next run retries)', v_partitions[v_i];
      WHEN undefined_table THEN
        NULL; -- reaped between detection and truncate; fine
    END;
    -- Release the partition lock before the next one.
    COMMIT;
  END LOOP;

  RAISE NOTICE 'truncate_expired_execution_partitions: truncated % partition(s)', truncated_count;
END;
$$;

-- ------------------------------------------------------------
-- 3. Repoint the nightly cron at the truncate procedure
-- ------------------------------------------------------------
-- Same 03:30 UTC slot; CALL is required so the per-partition COMMITs are
-- permitted. The drop-based drop_expired_execution_partitions_safe procedure is
-- kept (now driven weekly below + available for manual runs).
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-execution-partitions'; END $$;

SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  'CALL truncate_expired_execution_partitions(7)'
);

-- ------------------------------------------------------------
-- 4. Weekly reaper: detach+drop the emptied expired shells
-- ------------------------------------------------------------
-- Bounds partition count. This is the only step that still fires a schema-cache
-- reload, now ~weekly in a low-traffic window instead of nightly. Sunday 04:00
-- UTC (after that night's truncate). drop_expired_execution_partitions_safe is
-- idempotent and detaches before dropping, which still works post-FK-drop.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reap-empty-execution-partitions'; END $$;

SELECT cron.schedule(
  'reap-empty-execution-partitions',
  '0 4 * * 0',
  'CALL drop_expired_execution_partitions_safe(7)'
);
