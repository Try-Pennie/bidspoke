-- The nightly purge lost a lock race and left a day half deleted (#1720).
--
-- WHAT HAPPENED. On 2026-10-01 and 2026-10-02 the 03:30 UTC purge gave up on
-- `workflow_executions_2026_09_23` after three 2s lock timeouts, so 84,549
-- executions that were fully archived stayed in Postgres two nights past
-- retention. This is the collision #1204 found on 2026-09-07 and answered with
-- retries; the retries were too short for the refresh, and the refresh's habit of
-- locking every partition was never removed.
--
-- THE LOCK HOLDER, measured rather than inferred. Postgres logs show the purge
-- waiting on relation 30197668 (`workflow_executions_2026_09_23`) from 03:30:02
-- to 03:30:13. `refresh_field_presence_daily` starts on the same 03:30:00 tick
-- and ran 21.6s. Its WHERE bounds were `CURRENT_DATE - p_lookback_days`, which
-- the planner cannot evaluate, so it cannot prune at plan time: it opens and
-- locks EVERY partition of `workflow_executions` for its whole transaction, not
-- just the two days it reads. Read only against production, that query shape
-- took 430 relation locks including a day eight days old; the same query with
-- literal bounds took 30 and did not touch that day. `refresh_workflow_stats_daily`
-- has the identical shape. The purge's whole retry window (about 12s) was
-- shorter than the refresh, so whichever expired partition it reached first lost
-- every slow night. 2026-09-24 only went because it was reached later.
--
-- TWO CHANGES, both CREATE OR REPLACE with unchanged signatures, so the deployed
-- worker and the cron commands are untouched (ADR 0007).
--
--   1. Both rollup refreshes run their scan as a statement with LITERAL bounds,
--      so the planner prunes and they lock only the partitions they read. A
--      plpgsql variable is not enough: a cached generic plan prunes at executor
--      start, after every partition has already been locked.
--   2. The purge retries for about 42s per partition instead of about 12s,
--      outlasting the slowest refresh on record (39s at p99, #1147). The wait per
--      attempt stays at 2s on purpose: while TRUNCATE waits for its lock, live
--      reads of the table queue behind it, and a short wait bounds that.
--
-- THE STAMP IS DELIBERATELY UNCHANGED. The day was stamped `executions_truncated_at`
-- when only its steps had gone, which looked like the defect, and is the design
-- (#1204, 20260907150000): a half deleted day fails re-verification by
-- construction, because the probe reads live step rows, so a stamp written only
-- after the executions go would strand the executions for good. The stamp did its
-- job on 2026-10-02: it authorised the retry, which then lost the lock again.
-- What was missing was anybody being told the day was still there, which the
-- gate's alert now says in words (#1720).
--
-- The schedule is deliberately NOT moved off 03:30. With change 1 the refreshes
-- no longer touch old partitions at all, and anything else reading a partition
-- is covered by change 2; moving the minute would only re-time a collision that
-- no longer exists, while every alert and comment naming 03:30 went stale.

-- ------------------------------------------------------------------
-- 1. Rollup refreshes lock only the partitions they read
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_from TIMESTAMPTZ := (CURRENT_DATE - p_lookback_days)::timestamptz;
  v_to   TIMESTAMPTZ := (CURRENT_DATE + 1)::timestamptz;
BEGIN
  SET LOCAL lock_timeout = '30s';
  PERFORM pg_advisory_xact_lock(883301, 2);

  DELETE FROM field_presence_daily
  WHERE day >= (CURRENT_DATE - p_lookback_days);

  -- Literal bounds, so the planner prunes to the days read (#1720).
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
    WHERE we.started_at >= %L
      AND we.started_at <  %L
      AND we.field_presence IS NOT NULL
    GROUP BY
      we.workflow_id, je.key,
      (we.started_at AT TIME ZONE 'UTC')::date, we.is_test
  $q$, v_from, v_to);
END;
$fn$;

CREATE OR REPLACE FUNCTION refresh_workflow_stats_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_from TIMESTAMPTZ := (CURRENT_DATE - p_lookback_days)::timestamptz;
  v_to   TIMESTAMPTZ := (CURRENT_DATE + 1)::timestamptz;
BEGIN
  SET LOCAL lock_timeout = '30s';
  PERFORM pg_advisory_xact_lock(883301, 1);

  DELETE FROM workflow_stats_daily
  WHERE day >= (CURRENT_DATE - p_lookback_days);

  -- Literal bounds, so the planner prunes to the days read (#1720).
  EXECUTE format($q$
    INSERT INTO workflow_stats_daily (
      workflow_id, status, outcome, day, is_test,
      run_count, duration_ms_sum, duration_ms_count, cost_usd_sum
    )
    SELECT
      we.workflow_id,
      we.status,
      COALESCE(we.outcome, ''),
      (we.started_at AT TIME ZONE 'UTC')::date,
      we.is_test,
      count(*),
      COALESCE(sum(we.duration_ms), 0)::bigint,
      count(we.duration_ms),
      COALESCE(sum(we.cost_usd), 0)
    FROM workflow_executions we
    WHERE we.started_at >= %L
      AND we.started_at <  %L
    GROUP BY
      we.workflow_id, we.status, COALESCE(we.outcome, ''),
      (we.started_at AT TIME ZONE 'UTC')::date, we.is_test
  $q$, v_from, v_to);
END;
$fn$;

-- CREATE OR REPLACE preserves the ACL; re-issued because the evidence of a
-- missing REVOKE is an absence (L124).
REVOKE ALL ON FUNCTION refresh_field_presence_daily(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION refresh_workflow_stats_daily(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_field_presence_daily(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_workflow_stats_daily(INTEGER) TO service_role;

-- ------------------------------------------------------------------
-- 2. The truncate retries for longer
-- ------------------------------------------------------------------
-- Same signature; only the p_max_attempts default changes, from 3 to 6.
CREATE OR REPLACE PROCEDURE public.truncate_verified_execution_partitions(
  p_retention_days      INTEGER DEFAULT 7,
  p_step_parent         TEXT DEFAULT 'execution_steps',
  p_execution_parent    TEXT DEFAULT 'workflow_executions',
  p_max_measurement_age INTERVAL DEFAULT interval '36 hours',
  p_now                 TIMESTAMPTZ DEFAULT now(),
  p_max_attempts        INTEGER DEFAULT 6
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
  v_run        UUID := gen_random_uuid();
  v_expired    INTEGER;
BEGIN
  -- Bound every lock acquisition; session level so it survives the COMMITs.
  -- Short on purpose: while TRUNCATE waits, live reads of the table queue
  -- behind it. Persistence comes from the attempts, not from a long wait.
  SET lock_timeout = '2s';

  -- Written and committed BEFORE anything is touched, because the record exists
  -- so a failure can be understood afterwards and one written by the operation
  -- that fails goes down with it (L561).
  INSERT INTO public.purge_run_log (run_id, job, archive_day, outcome, reason)
  SELECT v_run, 'truncate', v.archive_day, 'refused_unverified', v.refusal
  FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now) v
  WHERE v.refusal IS NOT NULL;

  SELECT count(*) INTO v_expired
  FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now);
  IF v_expired = 0 THEN
    INSERT INTO public.purge_run_log (run_id, job, outcome)
    VALUES (v_run, 'truncate', 'nothing_expired');
  END IF;
  COMMIT;

  FOREACH v_parent IN ARRAY ARRAY[p_step_parent, p_execution_parent] LOOP
    v_days := public.verified_purgeable_days(p_retention_days, v_parent, p_max_measurement_age, p_now);

    -- A partition is acted on only when EVERY day inside its bound is verified.
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
            -- In the same transaction as the TRUNCATE, so the record and the
            -- deletion cannot disagree about what happened (L33).
            INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome)
            VALUES (v_run, 'truncate', v_parent, v_from[v_i], v_partitions[v_i], 'truncated');
          END IF;
          -- The day's deletion has begun (or had already begun): stamped in the
          -- same transaction as the TRUNCATE, for whichever parent goes first,
          -- and only the first stamp is kept (L37, #1204). An already empty
          -- partition is in the same final state and is stamped too, so a re-run
          -- after a partial night completes the day rather than re-judging it.
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
        INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome, reason)
        VALUES (v_run, 'truncate', v_parent, v_from[v_i], v_partitions[v_i], 'gave_up_locked',
                format('%s lock timeouts', p_max_attempts));
      END IF;
      COMMIT;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'truncate_verified_execution_partitions: truncated % partition(s), stamped % day(s), gave up on % partition(s)', v_truncated, v_stamped, v_skipped;
END;
$$;
