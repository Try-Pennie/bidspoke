-- Let the gated purge succeed on its own schedule (#1196).
--
-- WHAT WAS WRONG. `truncate_verified_execution_partitions` and
-- `drop_verified_execution_partitions` (#873) act only on days whose
-- `execution_archive_days` row is verified AND measured within 36 hours. The gate
-- that measures runs at 13:00 UTC and, until the code change beside this
-- migration, looked back RETENTION_DAYS - 1 days. A day becomes eligible two
-- days after it leaves that window, so at the 03:30 UTC purge every eligible
-- day's last reading was 38.5 hours old and `verified_purgeable_days` excluded
-- it as `measurement-stale`. Both jobs ran gated for two nights and reported
-- "truncated 0 partition(s)"; the one deletion so far was a hand run inside the
-- window on 2026-09-06. Measured against the real 2026-08-16 row: refused at
-- the next cron, authorised 12 hours earlier.
--
-- The gate window itself is fixed in the Worker (`archive/candidate-days.ts`),
-- which now measures through the day aged RETENTION_DAYS at 13:00, 14.5 hours
-- before its deletion, and one day further so a day the purge missed is measured
-- again rather than stranded; the Worker skips any candidate carrying the stamp
-- below. That alone is not enough for the step partitions: day D's steps may
-- go only once day D - 1 is verified, because D's step partition holds the
-- post-midnight steps of D - 1's executions. But D - 1's execution partition was
-- truncated the night before, so a fresh re-measurement of it reads zero
-- executions against the archive's full count and refuses as
-- `executions-surplus`, and the reading from before its truncation is stale by
-- D's night. The rule as written needed a fresh, passing reading of a day that
-- no longer exists in Postgres.
--
-- THE STAMP. When the truncate empties a day's execution partition it does so
-- having just found that day verified and fresh, and it records that fact on the
-- day's row, in the SAME transaction as the TRUNCATE, so the stamp and the
-- deletion cannot disagree (L33). A stamped day then counts as verified in
-- `verified_purgeable_days` however old its measurement: the irreversible action
-- it authorised has already happened, and its post-midnight steps were counted
-- in the step verification that authorised it. That admits D's step partition
-- the following night and lets the Sunday reaper drop empty shells whose
-- readings have aged past the bound. The staleness rule for a day NOT yet
-- truncated is unchanged (L567).
--
-- Expand only: a nullable column, and two routines replaced with the same
-- signatures and defaults, so every scheduled command and every guard reading
-- them keeps working. `record_archive_day_measurement` never lists the column,
-- so a later re-measurement cannot clear it.

ALTER TABLE public.execution_archive_days
  ADD COLUMN IF NOT EXISTS executions_truncated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.execution_archive_days.executions_truncated_at IS
  'When the gated purge emptied this day''s execution partition after verifying it fresh. A stamped day stays verified for the step rule and the reaper however old its measurement (#1196).';

-- ------------------------------------------------------------------
-- 1. A stamped day is verified.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verified_purgeable_days(
  p_retention_days      INTEGER,
  p_parent              TEXT,
  p_max_measurement_age INTERVAL DEFAULT interval '36 hours',
  p_now                 TIMESTAMPTZ DEFAULT now()
) RETURNS DATE[]
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The expiry arithmetic matches the procedures this replaces EXACTLY: they
  -- select a partition whose upper bound is at or before CURRENT_DATE minus
  -- retention, and a daily partition for day d has upper bound d + 1.
  WITH verified AS (
    SELECT d.archive_day
    FROM public.execution_archive_days d
    WHERE d.archive_day + 1 <= (p_now AT TIME ZONE 'UTC')::date - p_retention_days
      AND (
        -- Already emptied after a fresh verification: that verdict is final.
        d.executions_truncated_at IS NOT NULL
        OR public.verified_day_refusal(
             d.pg_execution_count, d.erased_execution_count, d.sf_execution_count,
             d.pg_step_count, d.sf_step_count, d.orphan_execution_count,
             d.probe_ok, d.incomplete_count, d.measured_at,
             p_now, p_max_measurement_age
           ) IS NULL
      )
  )
  -- No verified day means an empty array means nothing is truncated and nothing
  -- is dropped. COALESCE matters: array_agg over no rows is NULL, and NULL fed to
  -- `<> ALL(...)` makes every comparison NULL.
  SELECT COALESCE(array_agg(v.archive_day ORDER BY v.archive_day), '{}'::date[])
  FROM verified v
  WHERE
    -- A step partition for day D holds the post-midnight steps of day D-1's
    -- executions, so D may only go when D-1 is verified too, and "verified" now
    -- includes "already truncated after verification".
    p_parent <> 'execution_steps'
    OR EXISTS (SELECT 1 FROM verified p WHERE p.archive_day = v.archive_day - 1);
$function$;

-- ------------------------------------------------------------------
-- 2. The truncate stamps every day it empties, in the same transaction.
-- ------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.truncate_verified_execution_partitions(
  p_retention_days      INTEGER DEFAULT 7,
  p_step_parent         TEXT DEFAULT 'execution_steps',
  p_execution_parent    TEXT DEFAULT 'workflow_executions',
  p_max_measurement_age INTERVAL DEFAULT interval '36 hours',
  p_now                 TIMESTAMPTZ DEFAULT now()
) LANGUAGE plpgsql AS $$
DECLARE
  v_parent     TEXT;
  v_days       DATE[];
  v_partitions TEXT[];
  v_from       DATE[];
  v_to         DATE[];
  v_i          INTEGER;
  v_has_rows   BOOLEAN;
  v_truncated  INTEGER := 0;
  v_stamped    INTEGER := 0;
BEGIN
  -- Bound every lock acquisition; session level so it survives the COMMITs.
  SET lock_timeout = '2s';

  FOREACH v_parent IN ARRAY ARRAY[p_step_parent, p_execution_parent] LOOP
    v_days := public.verified_purgeable_days(p_retention_days, v_parent, p_max_measurement_age, p_now);

    -- A partition is acted on only when EVERY day inside its bound is verified.
    -- The bounds travel with the names so the stamp below covers exactly the
    -- days the partition held, whatever the partition granularity.
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
      BEGIN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', v_partitions[v_i]) INTO v_has_rows;
        IF v_has_rows THEN
          EXECUTE format('TRUNCATE TABLE public.%I', v_partitions[v_i]);
          v_truncated := v_truncated + 1;
          RAISE NOTICE 'Truncated verified partition %', v_partitions[v_i];
        END IF;
        -- Stamped whether or not there was anything to truncate: an already
        -- empty verified partition (a genuinely empty day, or a re-run) is in
        -- the same final state, and the following day's step rule needs to know
        -- it. Only the first stamp is kept, so a re-run cannot move the record
        -- of when the deletion actually happened (L37).
        IF v_parent = p_execution_parent THEN
          UPDATE public.execution_archive_days
             SET executions_truncated_at = p_now
           WHERE archive_day >= v_from[v_i] AND archive_day < v_to[v_i]
             AND executions_truncated_at IS NULL;
          v_stamped := v_stamped + 1;
        END IF;
      EXCEPTION
        WHEN lock_not_available THEN
          RAISE NOTICE 'Lock timeout truncating % (skipped; next run retries)', v_partitions[v_i];
        WHEN undefined_table THEN
          NULL; -- reaped between detection and truncate; fine
      END;
      COMMIT;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'truncate_verified_execution_partitions: truncated % partition(s), stamped % execution partition(s)', v_truncated, v_stamped;
END;
$$;

-- ------------------------------------------------------------------
-- 3. Backfill the stamp for the hand run of 2026-09-06.
-- ------------------------------------------------------------------
-- The 14 days 2026-08-16 to 2026-08-29 were emptied by
-- `truncate_verified_execution_partitions(7)` at 16:08:00 UTC that day, each with
-- a gate reading from the 13:00 pass (08-16 from the day before), none refused.
-- They predate the column. Without this, 2026-08-30's step partition would be
-- refused on 2026-09-07 for want of a stamped predecessor and stranded for good,
-- exactly like execution_steps_2026_08_16 already is.
DO $$
DECLARE v_rows INTEGER;
BEGIN
  UPDATE public.execution_archive_days
     SET executions_truncated_at = '2026-09-06T16:08:00Z'
   WHERE archive_day BETWEEN '2026-08-16' AND '2026-08-29'
     AND executions_truncated_at IS NULL
     AND sf_execution_count = pg_execution_count;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'backfilled executions_truncated_at on % day(s) emptied by the 2026-09-06 hand run', v_rows;
END $$;
