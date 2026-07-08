-- ============================================================
-- Give the nightly partition truncate real retries against lock contention
-- ============================================================
-- Found 2026-07-08: workflow_executions/execution_steps partitions for
-- 2026-06-28, 06-29, 06-30 (72K-95K rows each, well above a typical day's
-- volume) were still full days after their 7-day retention window passed,
-- while every other day in the same range was cleaned up fine. The nightly
-- purge (03:30 UTC) bounds each partition's TRUNCATE to a 2-second
-- lock_timeout and, on lock_not_available, just logs a NOTICE and moves on --
-- no retry. reduce_finalize_stranded (30 8 * * *, 8-day lookback) runs daily
-- at 07:45 UTC and, per postgres logs, its 1-day variant alone (every 30 min)
-- already takes 30+ seconds against workflow_executions; an 8-day scan over
-- unusually large partitions plausibly runs long enough to make a single
-- 2-second lock attempt an unlucky bet most nights for these specific,
-- oversized partitions. (Not proven by a smoking-gun log line -- the failure
-- path only emits a quiet NOTICE, not an error -- but consistent with every
-- other observation: no FK blocks it, no lock is held outside these windows,
-- and the size/timing correlation is exact.)
--
-- Fix: don't rely on one 2-second roll of the dice. Retry each partition a
-- few times with a short pause between attempts, and use a slightly more
-- generous timeout per attempt. Three attempts at up to 10s each (with 5s
-- pauses between) gives ~45s of total opportunity per partition to find a gap
-- between other jobs, comfortably past the ~30s a single reduce_finalize_
-- stranded run takes, while still bounded and safe to run nightly.

CREATE OR REPLACE PROCEDURE truncate_expired_execution_partitions(
  p_retention_days INTEGER DEFAULT 7
) LANGUAGE plpgsql AS $$
DECLARE
  cutoff_date     DATE := CURRENT_DATE - p_retention_days;
  v_partitions    TEXT[];
  v_i             INTEGER;
  v_attempt       INTEGER;
  v_has_rows      BOOLEAN;
  v_truncated     BOOLEAN;
  truncated_count INTEGER := 0;
  skipped_count   INTEGER := 0;
BEGIN
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
    -- Skip partitions already empty (re-truncating a prior night's emptied
    -- shell would take a needless ACCESS EXCLUSIVE on a cold partition).
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', v_partitions[v_i])
      INTO v_has_rows;
    IF NOT v_has_rows THEN
      CONTINUE;
    END IF;

    v_truncated := false;
    FOR v_attempt IN 1 .. 3 LOOP
      BEGIN
        SET lock_timeout = '10s';
        EXECUTE format('TRUNCATE TABLE public.%I', v_partitions[v_i]);
        truncated_count := truncated_count + 1;
        v_truncated := true;
        RAISE NOTICE 'Truncated expired partition % (attempt %)', v_partitions[v_i], v_attempt;
      EXCEPTION
        WHEN lock_not_available THEN
          RAISE NOTICE 'Lock timeout truncating % (attempt %/3)', v_partitions[v_i], v_attempt;
        WHEN undefined_table THEN
          v_truncated := true; -- reaped between detection and truncate; fine
      END;
      -- Release whatever lock this attempt may have queued/held before the
      -- next attempt or partition, same as the prior single-attempt version.
      COMMIT;
      EXIT WHEN v_truncated;
      IF v_attempt < 3 THEN
        PERFORM pg_sleep(5);
      END IF;
    END LOOP;

    IF NOT v_truncated THEN
      skipped_count := skipped_count + 1;
      RAISE NOTICE 'Gave up on % after 3 attempts (skipped; next run retries)', v_partitions[v_i];
    END IF;
  END LOOP;

  RAISE NOTICE 'truncate_expired_execution_partitions: truncated % partition(s), skipped %', truncated_count, skipped_count;
END;
$$;
