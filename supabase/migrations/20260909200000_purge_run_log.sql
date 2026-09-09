-- Record which days the purge refused and why, rather than only raising a notice (#1142).
--
-- WHAT WAS WRONG. `truncate_verified_execution_partitions` and
-- `drop_verified_execution_partitions` gate every execution partition deletion
-- on the archive being verified (#873), and they reported what they did, and
-- what they refused, only through RAISE NOTICE and RAISE WARNING. pg_cron
-- records the run in `cron.job_run_details` but not the notices, so the day list
-- a run refused and the reason for each was lost the moment it finished.
--
-- The whole value of a gate is knowing when it fired. A night where it spared
-- six days because the archive was short was indistinguishable, from outside,
-- from a night where nothing was expired at all: both left a successful job run
-- and no other trace. That is the shape this milestone exists to remove, one
-- level down, and #873's own body asked for the record and it was not built.
--
-- ONE DEFINITION OF EXPIRY. The log has to name days the deletion never touched,
-- which means enumerating every expired day and not only the verified ones.
-- Writing that arithmetic a second time would let the log report a day the purge
-- never considered, or stay silent about one it deleted, and the two copies
-- would drift with nothing comparing them (L370). So `expired_day_verdicts` is
-- the single enumeration: every expired day with the refusal code
-- `verified_day_refusal` returned for it, or NULL when it may go.
-- `verified_purgeable_days` is now a filter over that, rather than a second
-- reader of the same table with its own WHERE clause.
--
-- AN EMPTY NIGHT IS ITS OWN OUTCOME. `nothing_expired` is written when there is
-- nothing past retention at all. Without it, a quiet night and a night where
-- every day was refused both leave no rows and the log answers neither (L98).
--
-- THE REFUSALS ARE COMMITTED BEFORE THE DELETION IS ATTEMPTED. The record exists
-- so a failure can be understood afterwards, and a record written by the same
-- operation that fails goes down with it (L561). The refusal rows are therefore
-- written and committed before the first partition is touched.
--
-- REASON IS FREE TEXT, DELIBERATELY. It stores whatever `verified_day_refusal`
-- returned. A CHECK constraint listing the codes would be a second copy of the
-- gate vocabulary maintained by hand, and the one guaranteed to fall behind is
-- the copy nothing runs (L96).
--
-- NO ALERT IS ADDED HERE. The gate already alerts on a day that is unverified
-- within `ALERT_WHEN_DAYS_LEFT` of its deletion, and since #1143 it refuses on
-- exactly the conditions this log records, so a second alert on the same cause
-- under a second name is how a pair of alerts teaches people to ignore both
-- (L11). What was missing was the durable record, and that is what this is.

-- ------------------------------------------------------------------
-- 1. The log
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purge_run_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         UUID        NOT NULL,
  job            TEXT        NOT NULL,
  parent         TEXT,
  archive_day    DATE,
  partition_name TEXT,
  outcome        TEXT        NOT NULL,
  reason         TEXT,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.purge_run_log IS
  'One row per day or partition per purge run, saying what happened to it and why. Holds what cron.job_run_details cannot express (#1142).';
COMMENT ON COLUMN public.purge_run_log.run_id IS
  'One value per procedure invocation, so a night reads as one run rather than as scattered rows.';
COMMENT ON COLUMN public.purge_run_log.outcome IS
  'truncated, dropped, refused_unverified, refused_non_empty, gave_up_locked, or nothing_expired.';
COMMENT ON COLUMN public.purge_run_log.reason IS
  'The code verified_day_refusal returned, for a refused_unverified row. Free text on purpose: a CHECK here would be a hand maintained copy of the gate vocabulary.';

CREATE INDEX IF NOT EXISTS purge_run_log_recorded_at_idx ON public.purge_run_log (recorded_at DESC);
CREATE INDEX IF NOT EXISTS purge_run_log_day_idx         ON public.purge_run_log (archive_day) WHERE archive_day IS NOT NULL;

ALTER TABLE public.purge_run_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purge_run_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.purge_run_log TO service_role;

-- ------------------------------------------------------------------
-- 2. Every expired day, with the verdict on it
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expired_day_verdicts(
  p_retention_days      INTEGER,
  p_max_measurement_age INTERVAL DEFAULT interval '36 hours',
  p_now                 TIMESTAMPTZ DEFAULT now()
) RETURNS TABLE (archive_day DATE, refusal TEXT)
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The expiry arithmetic, in the one place it exists. It matches the procedures
  -- this replaced EXACTLY: they select a partition whose upper bound is at or
  -- before CURRENT_DATE minus retention, and a daily partition for day d has
  -- upper bound d + 1.
  SELECT d.archive_day,
         CASE
           -- Already emptied after a fresh verification: that verdict is final
           -- (#1196), so it is not re-judged against a reading of a day whose
           -- rows are gone.
           WHEN d.executions_truncated_at IS NOT NULL THEN NULL
           ELSE public.verified_day_refusal(
                  p_pg_execution_count     => d.pg_execution_count,
                  p_erased_execution_count => d.erased_execution_count,
                  p_sf_execution_count     => d.sf_execution_count,
                  p_pg_step_count          => d.pg_step_count,
                  p_sf_step_count          => d.sf_step_count,
                  p_orphan_execution_count => d.orphan_execution_count,
                  p_hours_recorded         => d.hours_recorded,
                  p_hours_execution_count  => d.hours_execution_count,
                  p_probe_ok               => d.probe_ok,
                  p_probe_sampled          => d.probe_sampled,
                  p_incomplete_count       => d.incomplete_count,
                  p_measured_at            => d.measured_at,
                  p_now                    => p_now,
                  p_max_measurement_age    => p_max_measurement_age
                )
         END
  FROM public.execution_archive_days d
  WHERE d.archive_day + 1 <= (p_now AT TIME ZONE 'UTC')::date - p_retention_days;
$function$;

COMMENT ON FUNCTION public.expired_day_verdicts IS
  'Every UTC day past retention, with the reason it may not be deleted or NULL when it may. The single definition of expiry, read by both the deletion and its log (#1142).';

REVOKE ALL ON FUNCTION public.expired_day_verdicts(INTEGER, INTERVAL, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expired_day_verdicts(INTEGER, INTERVAL, TIMESTAMPTZ) TO service_role;

-- ------------------------------------------------------------------
-- 3. The day list becomes a filter over those verdicts
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
  WITH verified AS (
    SELECT v.archive_day
    FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now) v
    WHERE v.refusal IS NULL
  )
  -- No verified day means an empty array means nothing is truncated and nothing
  -- is dropped. COALESCE matters: array_agg over no rows is NULL, and NULL fed to
  -- `<> ALL(...)` makes every comparison NULL.
  SELECT COALESCE(array_agg(v.archive_day ORDER BY v.archive_day), '{}'::date[])
  FROM verified v
  WHERE
    -- A step partition for day D holds the post-midnight steps of day D-1's
    -- executions, so D may only go when D-1 is verified too, and "verified"
    -- includes "already truncated after verification".
    p_parent <> 'execution_steps'
    OR EXISTS (SELECT 1 FROM verified p WHERE p.archive_day = v.archive_day - 1);
$function$;

-- ------------------------------------------------------------------
-- 4. The truncate, saying what it did to every expired day
-- ------------------------------------------------------------------
-- Same signature and defaults, so the scheduled command and every guard reading
-- it keep working. The deletion logic is untouched: what is added is the record.
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
  v_run        UUID := gen_random_uuid();
  v_expired    INTEGER;
BEGIN
  -- Bound every lock acquisition; session level so it survives the COMMITs.
  SET lock_timeout = '2s';

  -- Written and committed BEFORE anything is touched, because the record exists
  -- so a failure can be understood afterwards and one written by the operation
  -- that fails goes down with it (L561). One row per refused day, carrying the
  -- code the decision returned rather than prose, so a night can be grouped and
  -- counted by reason.
  INSERT INTO public.purge_run_log (run_id, job, archive_day, outcome, reason)
  SELECT v_run, 'truncate', v.archive_day, 'refused_unverified', v.refusal
  FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now) v
  WHERE v.refusal IS NOT NULL;

  SELECT count(*) INTO v_expired
  FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now);
  IF v_expired = 0 THEN
    -- Its own outcome. A quiet night and a night where every day was refused
    -- both wrote nothing before this, and the log answered neither (L98).
    INSERT INTO public.purge_run_log (run_id, job, outcome)
    VALUES (v_run, 'truncate', 'nothing_expired');
  END IF;
  COMMIT;

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
        -- A partition skipped for the whole run is a deletion that did not
        -- happen, and a lock timeout is a failure that must be counted against a
        -- rate rather than logged and forgotten (L77).
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

-- ------------------------------------------------------------------
-- 5. The reap, saying what it did to every expired day
-- ------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.drop_verified_execution_partitions(
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
  v_froms      DATE[];
  v_i          INTEGER;
  v_attempt    INTEGER;
  v_done       BOOLEAN;
  v_has_rows   BOOLEAN;
  v_dropped    INTEGER := 0;
  v_refused    INTEGER := 0;
  v_run        UUID := gen_random_uuid();
  v_expired    INTEGER;
BEGIN
  SET lock_timeout = '2s';

  INSERT INTO public.purge_run_log (run_id, job, archive_day, outcome, reason)
  SELECT v_run, 'drop', v.archive_day, 'refused_unverified', v.refusal
  FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now) v
  WHERE v.refusal IS NOT NULL;

  SELECT count(*) INTO v_expired
  FROM public.expired_day_verdicts(p_retention_days, p_max_measurement_age, p_now);
  IF v_expired = 0 THEN
    INSERT INTO public.purge_run_log (run_id, job, outcome)
    VALUES (v_run, 'drop', 'nothing_expired');
  END IF;
  COMMIT;

  FOREACH v_parent IN ARRAY ARRAY[p_step_parent, p_execution_parent] LOOP
    v_days := public.verified_purgeable_days(p_retention_days, v_parent, p_max_measurement_age, p_now);

    SELECT COALESCE(array_agg(x.partition_name ORDER BY x.partition_name), '{}'),
           COALESCE(array_agg(x.from_day       ORDER BY x.partition_name), '{}')
    INTO v_partitions, v_froms
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
      -- THE PROCEDURE HONOURS ITS OWN NAME (#1014). The job is called
      -- reap-EMPTY-execution-partitions, and the procedure it used to call
      -- selected purely by age and never checked, so it could destroy a full
      -- partition the gate had deliberately spared. Keeping the check here, and
      -- not only in the gate, means a future caller cannot bypass the guarantee
      -- by calling the procedure directly.
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', v_partitions[v_i]) INTO v_has_rows;
      IF v_has_rows THEN
        v_refused := v_refused + 1;
        RAISE WARNING 'Refused to drop %: it still holds rows', v_partitions[v_i];
        -- Its own outcome, separate from a day refused by the gate: this one is
        -- a partition the gate DID verify whose rows are still present, which is
        -- a different fault with a different remedy (L11).
        INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome, reason)
        VALUES (v_run, 'drop', v_parent, v_froms[v_i], v_partitions[v_i], 'refused_non_empty',
                'the partition still holds rows');
        CONTINUE;
      END IF;

      v_done := FALSE;
      v_attempt := 0;
      WHILE NOT v_done AND v_attempt < p_max_attempts LOOP
        v_attempt := v_attempt + 1;
        BEGIN
          -- DETACH first: dropping a partition of an FK referenced parent fails
          -- with "other objects depend on it".
          EXECUTE format('ALTER TABLE %I DETACH PARTITION public.%I', v_parent, v_partitions[v_i]);
          EXECUTE format('DROP TABLE IF EXISTS public.%I', v_partitions[v_i]);
          v_done := TRUE;
          v_dropped := v_dropped + 1;
          RAISE NOTICE 'Dropped empty verified partition % (parent %)', v_partitions[v_i], v_parent;
          INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome)
          VALUES (v_run, 'drop', v_parent, v_froms[v_i], v_partitions[v_i], 'dropped');
        EXCEPTION
          WHEN lock_not_available THEN
            RAISE NOTICE 'Lock timeout on % (attempt %/%)', v_partitions[v_i], v_attempt, p_max_attempts;
            IF v_attempt < p_max_attempts THEN
              PERFORM pg_sleep(2 * v_attempt);
            END IF;
        END;
      END LOOP;
      IF NOT v_done THEN
        INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome, reason)
        VALUES (v_run, 'drop', v_parent, v_froms[v_i], v_partitions[v_i], 'gave_up_locked',
                format('%s lock timeouts', p_max_attempts));
      END IF;
      COMMIT;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'drop_verified_execution_partitions: dropped %, refused % still holding rows', v_dropped, v_refused;
END;
$$;

-- ------------------------------------------------------------------
-- 6. Prove the new objects work at apply time, not at 03:30 UTC
-- ------------------------------------------------------------------
-- A plpgsql body is only PARSED when it is created; the SQL inside it is planned
-- on first execution, so a wrong column name in one of the inserts above would
-- surface as a failed purge in the middle of the night rather than here. These
-- exercise the function for real and round trip one row through the table, then
-- remove it, so the shapes are checked now (L1).
DO $$
DECLARE v_n INTEGER; v_run UUID := gen_random_uuid();
BEGIN
  SELECT count(*) INTO v_n
  FROM public.expired_day_verdicts(9999, interval '36 hours', now());
  RAISE NOTICE 'expired_day_verdicts answered with % rows at retention 9999', v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'retention 9999 should expire nothing, got % days', v_n;
  END IF;

  INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome, reason)
  VALUES (v_run, 'migration-smoke', 'workflow_executions', CURRENT_DATE, 'none', 'nothing_expired', 'apply time check');
  DELETE FROM public.purge_run_log WHERE run_id = v_run;
  RAISE NOTICE 'purge_run_log accepted and released a row';
END $$;
