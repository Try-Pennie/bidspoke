-- Stamp a day at its FIRST deletion, and retry a lost lock (#1204).
--
-- WHAT HAPPENED. The first unaided run of the gated purge, 2026-09-07 03:30 UTC,
-- truncated execution_steps_2026_08_30 and then waited on an ACCESS EXCLUSIVE
-- lock for workflow_executions_2026_08_30 behind two pg_cron jobs that start in
-- the same second (refresh_workflow_stats_daily and refresh_field_presence_daily
-- both read across execution partitions). The 2 second lock_timeout expired, the
-- procedure skipped that partition with a NOTICE nobody reads, and reported
-- success. Migration 20260906200000 wrote the day's stamp only in the execution
-- loop, which is the loop that never ran, so 08-30 stayed unstamped.
--
-- WHY THE NEXT NIGHT COULD NOT REPAIR IT. The gate re-measured 08-30 at 13:00 and
-- refused it: the payload probe compares each sampled bundle against LIVE step
-- rows, and the step rows were gone. A half deleted day therefore fails
-- re-verification by construction, its remaining partition is never authorised
-- again, and the next day's step partition is blocked behind it (the step rule
-- needs the previous day verified or stamped). 08-30's executions and 08-31's
-- steps, 2.6 GB, were stranded, and the same happens on any night the lock race
-- is lost.
--
-- THE FIX. The stamp records that this day's deletion BEGAN after a fresh
-- verification, so it is written when the first partition of the day is emptied,
-- whichever parent that is, in the same transaction as that TRUNCATE. A stamped
-- day already counts as verified for both parents and is skipped by the gate's
-- re-measurement, so a run that dies or loses a lock between the two loops is
-- completed by the next run instead of stranded. That is L33 applied where it
-- was missed: record the authorisation before the irreversible work, not after
-- the last piece of it.
--
-- And the lock is retried, three attempts with short sleeps, exactly as
-- drop_verified_execution_partitions already does. The ungated procedure this
-- gate replaced had retries for the same collision (#708, 2026-07-08); the gated
-- rewrite was written fresh and lost them (L501).
--
-- Same names and defaults for the first five parameters, so every scheduled
-- command and every guard reading them keeps working; p_max_attempts is added at
-- the end with a default, mirroring the reaper.
--
-- THE OLD SIGNATURE IS DROPPED FIRST, DELIBERATELY. A CREATE OR REPLACE with a
-- different parameter list does not replace a procedure, it adds an OVERLOAD, and
-- `CALL truncate_verified_execution_partitions(7)` then matches both and fails as
-- ambiguous on every nightly run. Measured on the throwaway branch before this
-- shipped: the first version of this migration produced exactly that error.
-- pg_cron holds the command text, not a reference to the routine, so the drop is
-- safe between runs, and the REVOKEs are repeated because a newly created routine
-- gets PUBLIC EXECUTE by default (L503).

COMMENT ON COLUMN public.execution_archive_days.executions_truncated_at IS
  'When this day''s deletion BEGAN: the first of its partitions was emptied after a fresh verification. A stamped day stays verified for both parents and for the reaper however old its measurement, so a partial run is completed by the next one (#1196, #1204).';

DROP PROCEDURE IF EXISTS public.truncate_verified_execution_partitions(INTEGER, TEXT, TEXT, INTERVAL, TIMESTAMPTZ);

CREATE OR REPLACE PROCEDURE public.truncate_verified_execution_partitions(
  p_retention_days      INTEGER DEFAULT 7,
  p_step_parent         TEXT DEFAULT 'execution_steps',
  p_execution_parent    TEXT DEFAULT 'workflow_executions',
  p_max_measurement_age INTERVAL DEFAULT interval '36 hours',
  p_now                 TIMESTAMPTZ DEFAULT now(),
  p_max_attempts        INTEGER DEFAULT 3
) LANGUAGE plpgsql AS $$
DECLARE
  v_parent     TEXT;
  v_days       DATE[];
  v_partitions TEXT[];
  v_from       DATE[];
  v_to         DATE[];
  v_i          INTEGER;
  v_attempt    INTEGER;
  v_done       BOOLEAN;
  v_has_rows   BOOLEAN;
  v_truncated  INTEGER := 0;
  v_stamped    INTEGER := 0;
  v_skipped    INTEGER := 0;
BEGIN
  -- Bound every lock acquisition; session level so it survives the COMMITs.
  SET lock_timeout = '2s';

  FOREACH v_parent IN ARRAY ARRAY[p_step_parent, p_execution_parent] LOOP
    v_days := public.verified_purgeable_days(p_retention_days, v_parent, p_max_measurement_age, p_now);

    -- A partition is acted on only when EVERY day inside its bound is verified.
    -- The bounds travel with the names so the stamp covers exactly the days the
    -- partition held, whatever the partition granularity.
    SELECT COALESCE(array_agg(x.partition_name ORDER BY x.partition_name), '{}'),
           COALESCE(array_agg(x.from_day       ORDER BY x.partition_name), '{}'),
           COALESCE(array_agg(x.to_day         ORDER BY x.partition_name), '{}')
    INTO v_partitions, v_from, v_to
    FROM (
      SELECT child.relname AS partition_name,
             (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM \(''([^'']+)''\)'))[1]::date AS from_day,
             (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO \(''([^'']+)''\)'))[1]::date   AS to_day
      FROM pg_inherits i
      JOIN pg_class child  ON child.oid  = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      WHERE parent.relname = v_parent
    ) x
    WHERE x.from_day IS NOT NULL AND x.to_day IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM generate_series(x.from_day, x.to_day - 1, interval '1 day') g
        WHERE g::date <> ALL(v_days)
      );

    FOR v_i IN 1 .. COALESCE(array_length(v_partitions, 1), 0) LOOP
      v_done := FALSE;
      v_attempt := 0;
      WHILE NOT v_done AND v_attempt < p_max_attempts LOOP
        v_attempt := v_attempt + 1;
        BEGIN
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', v_partitions[v_i]) INTO v_has_rows;
          IF v_has_rows THEN
            EXECUTE format('TRUNCATE TABLE public.%I', v_partitions[v_i]);
            v_truncated := v_truncated + 1;
            RAISE NOTICE 'Truncated verified partition %', v_partitions[v_i];
          END IF;
          -- The day's deletion has begun (or had already begun): stamped in the
          -- same transaction as the TRUNCATE, for whichever parent goes first,
          -- and only the first stamp is kept (L37). An already empty partition
          -- is in the same final state and is stamped too, so a re-run after a
          -- partial night completes the day rather than re-judging it.
          UPDATE public.execution_archive_days
             SET executions_truncated_at = p_now
           WHERE archive_day >= v_from[v_i] AND archive_day < v_to[v_i]
             AND executions_truncated_at IS NULL;
          IF FOUND THEN v_stamped := v_stamped + 1; END IF;
          v_done := TRUE;
        EXCEPTION
          WHEN lock_not_available THEN
            RAISE NOTICE 'Lock timeout on % (attempt %/%)', v_partitions[v_i], v_attempt, p_max_attempts;
            IF v_attempt < p_max_attempts THEN
              PERFORM pg_sleep(2 * v_attempt);
            END IF;
          WHEN undefined_table THEN
            v_done := TRUE; -- reaped between detection and truncate; fine
        END;
      END LOOP;
      IF NOT v_done THEN
        v_skipped := v_skipped + 1;
        RAISE WARNING 'Gave up on % after % lock timeouts; the next run retries it', v_partitions[v_i], p_max_attempts;
      END IF;
      COMMIT;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'truncate_verified_execution_partitions: truncated % partition(s), stamped % day(s), gave up on % partition(s)', v_truncated, v_stamped, v_skipped;
END;
$$;

-- anon and authenticated have no business driving the machinery that destroys
-- execution data; the scheduled job runs as the database owner.
REVOKE ALL ON PROCEDURE public.truncate_verified_execution_partitions(INTEGER, TEXT, TEXT, INTERVAL, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON PROCEDURE public.truncate_verified_execution_partitions(INTEGER, TEXT, TEXT, INTERVAL, TIMESTAMPTZ, INTEGER) FROM anon;
REVOKE ALL ON PROCEDURE public.truncate_verified_execution_partitions(INTEGER, TEXT, TEXT, INTERVAL, TIMESTAMPTZ, INTEGER) FROM authenticated;
