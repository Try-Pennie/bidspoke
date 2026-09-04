-- Gate the two destructive execution jobs on the archive having been VERIFIED
-- (#873 Phase A5, #1014, #1137).
--
-- Until now the archive and the deletion were unconnected. `execution_archive_days`
-- has carried a per day measurement since Phase A4, and on 2026-09-03 every day
-- Postgres held agreed exactly with Snowflake on executions AND steps, with the
-- payload probe passing on 60 sampled bundles per day. NOTHING read it: both
-- pg_cron jobs deleted on a calendar. This migration makes the deletion ask.
--
-- THE DECISION IS A PURE FUNCTION, ON PURPOSE. `verified_day_refusal` takes scalars
-- and answers with a refusal code or NULL. That is what makes the gate testable at
-- all: the procedures below COMMIT after each partition, deliberately, so they
-- release the lock rather than hold it across a whole run, and there is no local
-- Postgres in this project to run them against. With the decision extracted, every
-- refusal can be driven from literals and watched to fire, and only the few lines
-- that actually empty a partition need a real table.
--
-- MEASURED, NOT REASONED. All of it was exercised on a throwaway Supabase branch on
-- 2026-09-03 (`supabase/tests/verified_deletion_gate.test.sql`): 13 decision cases,
-- the day list in both directions of the step rule, and both procedures against real
-- daily partitions holding real rows. The results are recorded in that file.
--
-- A NULL IS A REFUSAL, NEVER A PASS. Three valued logic makes `NOT probe_ok` neither
-- true nor false when probe_ok is NULL, so a check written the obvious way falls
-- through to verified and authorises a deletion from a measurement nobody took. That
-- is not hypothetical: `pg_orphan_step_count` is NULL on every row in production,
-- because the orphan measurement moved to `orphan_execution_count` with a bounded
-- sample, while the abandoned column still reads like one of the gate's conditions.
-- It is dropped below so it cannot be wired up by mistake.
--
-- THE CLOCK IS AN ARGUMENT. `p_now` is passed in rather than read from now(), so a
-- staleness test pins both ends of the comparison instead of racing real time (L130).
--
-- THE COMMAND SHAPE IS DELIBERATE. The rescheduled jobs read
-- `CALL <procedure>(<integer>)`, the same shape as before, because
-- `execution_purge_retention()` (#1017, shipped hours before this) reads the
-- retention window by parsing the first integer literal out of the command text, and
-- `retentionDifferences` compares it against the code. Passing the day list inline
-- instead, as the phase issue originally sketched, makes that parse return NULL and
-- the drift guard reports the window as unreadable. Measured 2026-09-03.

-- ------------------------------------------------------------------
-- 1. The decision: why one archived day may not be deleted
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verified_day_refusal(
  p_pg_execution_count     BIGINT,
  p_erased_execution_count BIGINT,
  p_sf_execution_count     BIGINT,
  p_pg_step_count          BIGINT,
  p_sf_step_count          BIGINT,
  p_orphan_execution_count BIGINT,
  p_probe_ok               BOOLEAN,
  p_incomplete_count       BIGINT,
  p_measured_at            TIMESTAMPTZ,
  p_now                    TIMESTAMPTZ,
  p_max_measurement_age    INTERVAL
) RETURNS TEXT
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    -- Anything unmeasured, before anything else. Its own code, because "nobody
    -- looked" is a different finding from "the numbers disagree" (L11), and the
    -- remedies differ: one needs a gate run, the other needs a re-archive.
    WHEN p_pg_execution_count IS NULL
      OR p_erased_execution_count IS NULL
      OR p_sf_execution_count IS NULL
      OR p_pg_step_count IS NULL
      OR p_sf_step_count IS NULL
      OR p_orphan_execution_count IS NULL
      OR p_probe_ok IS NULL
      OR p_incomplete_count IS NULL
      OR p_measured_at IS NULL
      THEN 'unmeasured'

    -- Age next (#1137). A truthful reading of a past state is indistinguishable
    -- from a current one, and the disagreement a stale row reports may already
    -- have been repaired, so reporting that disagreement would claim more than
    -- was measured.
    WHEN p_measured_at < p_now - p_max_measurement_age THEN 'measurement-stale'

    -- Erasures are subtracted before comparing. A correct erasure legitimately
    -- lowers the archive side, and counted as a shortfall it would block the day
    -- forever while naming a remedy (re-archive) that cannot restore rows which
    -- were deliberately destroyed.
    WHEN p_sf_execution_count < p_pg_execution_count - p_erased_execution_count
      THEN 'executions-short'
    -- Its own code, and not a shortfall: more in the archive than Postgres holds
    -- is how a SHORTENED retention shows up, days vanishing from Postgres while
    -- the archive still has them.
    WHEN p_sf_execution_count > p_pg_execution_count - p_erased_execution_count
      THEN 'executions-surplus'

    -- The steps are the bulk of the data and all of the debugging value, so they
    -- refuse on their own rather than being protected by proxy through the
    -- execution count (L63).
    WHEN p_sf_step_count <> p_pg_step_count THEN 'steps-short'

    WHEN p_orphan_execution_count > 0 THEN 'orphan-executions'
    WHEN NOT p_probe_ok THEN 'probe-failed'
    WHEN p_incomplete_count > 0 THEN 'incomplete-rows'
    ELSE NULL
  END;
$function$;

COMMENT ON FUNCTION public.verified_day_refusal IS
  'Why one archived day may not be deleted, or NULL when it may. Pure, so every refusal can be driven from literals and watched to fire (#873).';

-- ------------------------------------------------------------------
-- 2. Which days a given parent may lose, for a retention window
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
  -- retention, and a daily partition for day d has upper bound d + 1. Deriving it
  -- differently here would quietly shift the window by a day and the two
  -- definitions would disagree forever.
  WITH verified AS (
    SELECT d.archive_day
    FROM public.execution_archive_days d
    WHERE d.archive_day + 1 <= (p_now AT TIME ZONE 'UTC')::date - p_retention_days
      AND public.verified_day_refusal(
            d.pg_execution_count, d.erased_execution_count, d.sf_execution_count,
            d.pg_step_count, d.sf_step_count, d.orphan_execution_count,
            d.probe_ok, d.incomplete_count, d.measured_at,
            p_now, p_max_measurement_age
          ) IS NULL
  )
  -- No verified day means an empty array means nothing is truncated and nothing
  -- is dropped. COALESCE matters: array_agg over no rows is NULL, and NULL fed to
  -- `<> ALL(...)` makes every comparison NULL, so a caller would act on nothing or
  -- on everything depending on how it happened to be written.
  SELECT COALESCE(array_agg(v.archive_day ORDER BY v.archive_day), '{}'::date[])
  FROM verified v
  WHERE
    -- A step partition for day D holds the post-midnight steps of day D-1's
    -- executions, because execution_steps partitions on the step's own
    -- started_at while the gate verifies by the EXECUTION's day. So D may only go
    -- when D-1 is verified too. With p99 duration 13 to 14 seconds, a maximum of
    -- 45, and about 100,000 executions a day, several hundred step rows cross UTC
    -- midnight every single day, never zero.
    p_parent <> 'execution_steps'
    OR EXISTS (SELECT 1 FROM verified p WHERE p.archive_day = v.archive_day - 1);
$function$;

COMMENT ON FUNCTION public.verified_purgeable_days IS
  'UTC days past retention whose archive is verified, for one partitioned parent. Empty array when none (#873).';

-- ------------------------------------------------------------------
-- 3. Nightly: empty the partitions of verified days
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
  v_i          INTEGER;
  v_has_rows   BOOLEAN;
  v_truncated  INTEGER := 0;
BEGIN
  -- Bound every lock acquisition; session level so it survives the COMMITs.
  SET lock_timeout = '2s';

  -- The parent names are parameters so the suite can point the whole procedure at
  -- fixture tables. No test can then name a production parent by accident, and a
  -- separate assertion checks the REGISTERED pg_cron commands name the real ones,
  -- so the seam cannot quietly leave production ungated.
  FOREACH v_parent IN ARRAY ARRAY[p_step_parent, p_execution_parent] LOOP
    v_days := public.verified_purgeable_days(p_retention_days, v_parent, p_max_measurement_age, p_now);

    -- A partition is acted on only when EVERY day inside its bound is verified.
    -- Partitions are daily today and the code must not assume that stays true.
    SELECT COALESCE(array_agg(x.partition_name ORDER BY x.partition_name), '{}')
    INTO v_partitions
    FROM (
      SELECT child.relname AS partition_name,
             (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM \(''([^'']+)''\)'))[1]::date AS from_day,
             (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO \(''([^'']+)''\)'))[1]::date   AS to_day
      FROM pg_inherits i
      JOIN pg_class child  ON child.oid  = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      WHERE parent.relname = v_parent
    ) x
    -- A bound that does not parse is SKIPPED rather than treated as day zero. The
    -- regex is the same one the procedures this replaces use, and the suite checks
    -- it against a real production bound string.
    WHERE x.from_day IS NOT NULL AND x.to_day IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM generate_series(x.from_day, x.to_day - 1, interval '1 day') g
        WHERE g::date <> ALL(v_days)
      );

    FOR v_i IN 1 .. COALESCE(array_length(v_partitions, 1), 0) LOOP
      BEGIN
        -- Skip an already empty shell: re-truncating it would take a needless
        -- ACCESS EXCLUSIVE on a cold partition.
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)', v_partitions[v_i]) INTO v_has_rows;
        IF v_has_rows THEN
          EXECUTE format('TRUNCATE TABLE public.%I', v_partitions[v_i]);
          v_truncated := v_truncated + 1;
          RAISE NOTICE 'Truncated verified partition %', v_partitions[v_i];
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

  RAISE NOTICE 'truncate_verified_execution_partitions: truncated % partition(s)', v_truncated;
END;
$$;

-- ------------------------------------------------------------------
-- 4. Weekly: drop the emptied shells, and REFUSE any that is not empty
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
  v_i          INTEGER;
  v_attempt    INTEGER;
  v_done       BOOLEAN;
  v_has_rows   BOOLEAN;
  v_dropped    INTEGER := 0;
  v_refused    INTEGER := 0;
BEGIN
  SET lock_timeout = '2s';

  FOREACH v_parent IN ARRAY ARRAY[p_step_parent, p_execution_parent] LOOP
    v_days := public.verified_purgeable_days(p_retention_days, v_parent, p_max_measurement_age, p_now);

    SELECT COALESCE(array_agg(x.partition_name ORDER BY x.partition_name), '{}')
    INTO v_partitions
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
        EXCEPTION
          WHEN lock_not_available THEN
            RAISE NOTICE 'Lock timeout on % (attempt %/%)', v_partitions[v_i], v_attempt, p_max_attempts;
            IF v_attempt < p_max_attempts THEN
              PERFORM pg_sleep(2 * v_attempt);
            END IF;
        END;
      END LOOP;
      COMMIT;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'drop_verified_execution_partitions: dropped %, refused % still holding rows', v_dropped, v_refused;
END;
$$;

-- ------------------------------------------------------------------
-- 5. Remove the abandoned orphan column
-- ------------------------------------------------------------------
-- NULL on every row in production. The orphan measurement moved to
-- `orphan_execution_count` with a bounded sample, and this column stayed behind
-- reading exactly like one of the gate's four conditions. The phase issue's own
-- body named it as the orphan input, which would have produced a condition that is
-- NULL for every day: either blocking every day forever or, written the obvious
-- way, silently dropping one of the checks.
ALTER TABLE public.execution_archive_days DROP COLUMN IF EXISTS pg_orphan_step_count;

-- ------------------------------------------------------------------
-- 6. Permissions
-- ------------------------------------------------------------------
-- `REVOKE ... ON FUNCTION` errors with 42809 on a procedure, so ROUTINE covers
-- both. anon and authenticated have no business reading, still less driving, the
-- machinery that destroys execution data.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'verified_day_refusal',
        'verified_purgeable_days',
        'truncate_verified_execution_partitions',
        'drop_verified_execution_partitions'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM anon', r.sig);
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM authenticated', r.sig);
  END LOOP;
END $$;

-- The Worker reads the gate's verdicts in order to report them; it never truncates.
GRANT EXECUTE ON ROUTINE public.verified_day_refusal(
  BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BOOLEAN, BIGINT, TIMESTAMPTZ, TIMESTAMPTZ, INTERVAL
) TO service_role;
GRANT EXECUTE ON ROUTINE public.verified_purgeable_days(
  INTEGER, TEXT, INTERVAL, TIMESTAMPTZ
) TO service_role;

-- ------------------------------------------------------------------
-- 7. Repoint both destructive jobs. The only step that changes a deletion.
-- ------------------------------------------------------------------
-- Same names and same slots, so `execution_purge_retention()`, the pg_cron watch
-- and `retentionDifferences` all keep working unchanged. The superseded procedures
-- are deliberately LEFT IN PLACE but unscheduled for one release, per the
-- expand/contract ADR, and dropped in a later migration.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-old-execution-partitions'; END $$;
SELECT cron.schedule(
  'purge-old-execution-partitions',
  '30 3 * * *',
  'CALL truncate_verified_execution_partitions(21)'
);

DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'reap-empty-execution-partitions'; END $$;
SELECT cron.schedule(
  'reap-empty-execution-partitions',
  '0 4 * * 0',
  'CALL drop_verified_execution_partitions(21)'
);
