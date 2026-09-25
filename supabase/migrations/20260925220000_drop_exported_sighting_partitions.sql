-- Drop a past month's sightings partition once everything in it is safely in
-- Snowflake (#464, and closes #781).
--
-- WHY. lead_sightings, lead_sighting_bids and achieve_evaluations are a write
-- buffer partitioned by month: rows are exported to Snowflake and purged a day
-- later, row by row. A drained past month is left behind as an empty partition
-- that still holds its bloat (measured 2026-09-25: eleven such partitions, all
-- at zero rows, about 263 MB), and a month drained only by DELETE keeps its
-- disk until a VACUUM FULL nobody runs. Dropping the partition is instant and
-- returns the space.
--
-- THE RULE, decided by Dan on 2026-09-25. A partition is dropped only when ALL
-- of these hold, checked on the partition itself at the moment of the drop:
--   1. it is a PAST month: its upper bound is at or before the start of the
--      current UTC month, so the current month and the months ahead are never
--      candidates, empty or not;
--   2. no row in it is still waiting to export (exported_at IS NULL);
--   3. no row in it was set aside because Snowflake refused it (#427,
--      export_rejected_at IS NOT NULL). Those rows exist nowhere else and must
--      never be lost;
--   4. every row in it was exported more than the purge grace ago, the same 24
--      hours the row purge waits (PURGE_GRACE_HOURS in sightings-export.ts).
-- A partition that fails any of these is kept and its reason logged. The empty
-- partitions already there are dropped by the first run.
--
-- WHAT IS GIVEN UP. POST /api/admin/backfill-sightings writes rows stamped with
-- the ORIGINAL execution's time, so it can only re-import a month whose
-- partition exists. After a month is dropped, a backfill of it fails on insert
-- (there is no default partition) until the partition is recreated by hand:
--   CREATE TABLE public.lead_sightings_YYYY_MM PARTITION OF public.lead_sightings
--     FOR VALUES FROM ('YYYY-MM-01') TO ('<next month>-01');
-- (and the same for lead_sighting_bids). create_monthly_analytics_partitions()
-- only ever creates the current month and the three after it. Dan accepted this
-- on 2026-09-25: those months are already in Snowflake, which is canonical.
--
-- SAFETY OF THE NAMES. The function takes no table or partition name from its
-- caller. It walks the partitions of three fixed parents from the catalogue
-- (pg_inherits), and addresses each by its oid cast to regclass, so no text
-- from outside is ever interpolated into DDL.
--
-- WHO CAN RUN IT. SECURITY DEFINER with a fixed search_path, so the Worker can
-- call it over PostgREST if it ever needs to (it cannot run DDL itself), and
-- EXECUTE for service_role only. pg_cron runs it nightly as postgres.
--
-- THE RECORD. Every decision goes to purge_run_log (job
-- 'sightings-partition-drop'), the same log the execution partition drops
-- write, because pg_cron keeps no notices (#1142). A night with nothing to
-- consider writes 'nothing_expired', so a quiet night and a broken one differ.
--
-- LOCKING. Dropping a partition takes an ACCESS EXCLUSIVE lock on the parent,
-- which live traffic writes to all the time. lock_timeout is 5s for the whole
-- function, a lock not granted in time is recorded as 'gave_up_locked' and
-- retried the next night, and the drop runs at 08:10 UTC, the quietest hour
-- (about 1,400 sightings an hour, against 6,000 at peak).

CREATE OR REPLACE FUNCTION public.drop_exported_sighting_partitions(
  p_grace INTERVAL DEFAULT interval '24 hours'
) RETURNS TABLE (parent TEXT, partition_name TEXT, outcome TEXT, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET lock_timeout = '5s'
AS $$
DECLARE
  v_run        UUID := gen_random_uuid();
  v_month_start TIMESTAMP := date_trunc('month', now() AT TIME ZONE 'utc');
  -- The grace is a floor, so a caller cannot shorten it below the purge's own.
  v_cutoff     TIMESTAMPTZ := now() - greatest(p_grace, interval '24 hours');
  v_parent     TEXT;
  v_part       RECORD;
  v_reason     TEXT;
  v_considered INTEGER := 0;
  v_has_reject BOOLEAN;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['lead_sightings', 'lead_sighting_bids', 'achieve_evaluations'] LOOP
    -- Only lead_sightings and lead_sighting_bids can set a row aside (#427).
    -- Read from the catalogue rather than listed, so a table that gains the
    -- column is covered by the same check without an edit here.
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = format('public.%I', v_parent)::regclass
        AND attname = 'export_rejected_at' AND NOT attisdropped
    ) INTO v_has_reject;

    FOR v_part IN
      SELECT child.oid AS oid,
             child.relname AS name,
             (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'FROM \(''([^'']+)''\)'))[1]::timestamp AS from_ts,
             (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO \(''([^'']+)''\)'))[1]::timestamp   AS to_ts
      FROM pg_inherits i
      JOIN pg_class child  ON child.oid  = i.inhrelid
      JOIN pg_namespace n  ON n.oid      = child.relnamespace
      WHERE i.inhparent = format('public.%I', v_parent)::regclass
        AND n.nspname = 'public'
        AND child.relkind = 'r'
      ORDER BY child.relname
    LOOP
      -- A bound that does not parse (a DEFAULT partition has none) is never a
      -- candidate: it cannot be shown to be in the past.
      CONTINUE WHEN v_part.from_ts IS NULL OR v_part.to_ts IS NULL;
      CONTINUE WHEN v_part.to_ts > v_month_start;
      v_considered := v_considered + 1;

      -- The most specific reason first, so the log says what would need doing.
      v_reason := NULL;
      IF v_has_reject THEN
        EXECUTE format('SELECT CASE WHEN EXISTS (SELECT 1 FROM %s WHERE export_rejected_at IS NOT NULL) THEN %L END',
                       v_part.oid::regclass, 'set_aside') INTO v_reason;
      END IF;
      IF v_reason IS NULL THEN
        EXECUTE format('SELECT CASE WHEN EXISTS (SELECT 1 FROM %s WHERE exported_at IS NULL) THEN %L END',
                       v_part.oid::regclass, 'unexported') INTO v_reason;
      END IF;
      IF v_reason IS NULL THEN
        EXECUTE format('SELECT CASE WHEN EXISTS (SELECT 1 FROM %s WHERE exported_at >= $1) THEN %L END',
                       v_part.oid::regclass, 'within_grace') USING v_cutoff INTO v_reason;
      END IF;

      IF v_reason IS NOT NULL THEN
        INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome, reason)
        VALUES (v_run, 'sightings-partition-drop', v_parent, v_part.from_ts::date, v_part.name, 'refused_non_empty', v_reason);
        parent := v_parent; partition_name := v_part.name; outcome := 'refused_non_empty'; reason := v_reason;
        RETURN NEXT;
        CONTINUE;
      END IF;

      BEGIN
        -- Hold the partition first, then check again under the lock: a row can
        -- land in a past month (the admin backfill writes original timestamps)
        -- between the check above and the drop.
        EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', v_part.oid::regclass);
        EXECUTE format('SELECT CASE WHEN EXISTS (SELECT 1 FROM %s WHERE exported_at IS NULL OR exported_at >= $1) THEN %L END',
                       v_part.oid::regclass, 'unexported') USING v_cutoff INTO v_reason;
        IF v_reason IS NULL AND v_has_reject THEN
          EXECUTE format('SELECT CASE WHEN EXISTS (SELECT 1 FROM %s WHERE export_rejected_at IS NOT NULL) THEN %L END',
                         v_part.oid::regclass, 'set_aside') INTO v_reason;
        END IF;
        IF v_reason IS NOT NULL THEN
          INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome, reason)
          VALUES (v_run, 'sightings-partition-drop', v_parent, v_part.from_ts::date, v_part.name, 'refused_non_empty',
                  v_reason || ' (a row arrived during the drop)');
          parent := v_parent; partition_name := v_part.name; outcome := 'refused_non_empty'; reason := v_reason;
          RETURN NEXT;
          CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', format('public.%I', v_parent)::regclass, v_part.oid::regclass);
        EXECUTE format('DROP TABLE %s', v_part.oid::regclass);
        INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome)
        VALUES (v_run, 'sightings-partition-drop', v_parent, v_part.from_ts::date, v_part.name, 'dropped');
        parent := v_parent; partition_name := v_part.name; outcome := 'dropped'; reason := NULL;
        RETURN NEXT;
      EXCEPTION
        WHEN lock_not_available THEN
          INSERT INTO public.purge_run_log (run_id, job, parent, archive_day, partition_name, outcome, reason)
          VALUES (v_run, 'sightings-partition-drop', v_parent, v_part.from_ts::date, v_part.name, 'gave_up_locked',
                  'the lock was not granted within 5s; retried next night');
          parent := v_parent; partition_name := v_part.name; outcome := 'gave_up_locked'; reason := 'lock_timeout';
          RETURN NEXT;
      END;
    END LOOP;
  END LOOP;

  IF v_considered = 0 THEN
    INSERT INTO public.purge_run_log (run_id, job, outcome)
    VALUES (v_run, 'sightings-partition-drop', 'nothing_expired');
  END IF;
END;
$$;

COMMENT ON FUNCTION public.drop_exported_sighting_partitions(INTERVAL) IS
  'Drops a past month partition of lead_sightings, lead_sighting_bids or achieve_evaluations once no row in it is unexported, set aside, or exported within the grace (#464). Logs every decision to purge_run_log as sightings-partition-drop. A dropped month cannot be backfilled until its partition is recreated.';

REVOKE ALL ON FUNCTION public.drop_exported_sighting_partitions(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drop_exported_sighting_partitions(INTERVAL) TO service_role;

-- Nightly at 08:10 UTC, the quietest hour for live writes to these parents.
DO $$ BEGIN PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'drop-exported-sighting-partitions'; END $$;
SELECT cron.schedule(
  'drop-exported-sighting-partitions',
  '10 8 * * *',
  'SELECT public.drop_exported_sighting_partitions()'
);
