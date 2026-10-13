-- Count where a field's key appeared, apart from where it carried a value (#2018).
--
-- The dead field tier paged Liberty1 Click Handler's sale markers every morning as
-- "the reference path is wrong", because the per run map folded an empty value and
-- a missing key into one false. The engine now writes true for a value, null for
-- empty and false only for a path that names a key some object lacks, and stamps
-- each run with field_presence_version 2. This migration gives the rollup the two
-- counts the tier needs:
--
--   key_present_count   runs at version 2 where the field was not a wrong path
--                       (a value, or empty)
--   key_measured_count  runs at version 2
--
-- Both count ONLY version 2 runs. A run written before the engine change has its
-- empty values recorded as false, so counting it would read an empty by design
-- field as a wrong path, the bug this fixes. A day is judged for key presence only
-- where key_measured_count equals ran_count; a mixed day (the deploy day, or a
-- rollback) is not judged. The stamp is in the data, not a date in the code, so a
-- slow deploy or a rollback cannot mislead the tier.
--
-- Expand/contract (ADR 0007): additive. A nullable column with no default on
-- workflow_executions and two NOT NULL DEFAULT 0 columns on field_presence_daily
-- are all metadata only. 0 on every existing rollup row means no run there was
-- measured, which is true. The two refresh functions are the #1150 bodies with the
-- two counts added; nothing else changes. Applied to prod BEFORE the engine change
-- merges, because the engine writes field_presence_version on every finalize.
--
-- Guarded by supabase/tests/field_presence_key_counts.test.sql.

SET lock_timeout = '5s';

ALTER TABLE public.workflow_executions
  ADD COLUMN IF NOT EXISTS field_presence_version smallint;

COMMENT ON COLUMN public.workflow_executions.field_presence_version IS
  'Meaning of field_presence (#2018): null or 1, an empty value and a missing key are both false; 2, true a value, null empty, false a path naming a key some object lacks.';

ALTER TABLE public.field_presence_daily
  ADD COLUMN IF NOT EXISTS key_present_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS key_measured_count bigint NOT NULL DEFAULT 0;

RESET lock_timeout;

-- ------------------------------------------------------------------
-- The reconcile (#1150 body plus the two counts)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_field_presence_daily(p_lookback_days INTEGER DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_from TIMESTAMPTZ := (CURRENT_DATE - p_lookback_days)::timestamptz;
  v_to   TIMESTAMPTZ := (CURRENT_DATE + 1)::timestamptz;
  v_max  TIMESTAMPTZ;
  v_ceiling TIMESTAMPTZ;
BEGIN
  SET LOCAL lock_timeout = '30s';
  PERFORM pg_advisory_xact_lock(883301, 2);

  -- The incremental's ceiling, read after the lock (see 20261013150000).
  v_ceiling := clock_timestamp() - interval '1 minute';

  -- A recount narrower than two days stops at the watermark (see 20261013150000).
  IF p_lookback_days < 2 THEN
    SELECT COALESCE(watermark, v_ceiling) INTO v_ceiling FROM field_presence_rollup_state WHERE id;
    v_ceiling := COALESCE(v_ceiling, clock_timestamp() - interval '1 minute');
  END IF;

  DELETE FROM field_presence_daily
  WHERE day >= (CURRENT_DATE - p_lookback_days);

  EXECUTE format($q$
    WITH src AS (
      SELECT we.workflow_id, we.started_at, we.is_test, we.completed_at, we.field_presence,
             COALESCE(we.field_presence_version, 1) >= 2 AS measured
      FROM workflow_executions we
      WHERE we.started_at >= %L
        AND we.started_at <  %L
        AND we.field_presence IS NOT NULL
        AND (we.completed_at IS NULL OR we.completed_at <= %L)
    ), ins AS (
      INSERT INTO field_presence_daily (
        workflow_id, field_path, day, is_test, ran_count, present_count,
        key_present_count, key_measured_count
      )
      SELECT
        src.workflow_id,
        je.key,
        (src.started_at AT TIME ZONE 'UTC')::date,
        src.is_test,
        count(*),
        count(*) FILTER (WHERE je.value = 'true'::jsonb),
        count(*) FILTER (WHERE src.measured AND je.value <> 'false'::jsonb),
        count(*) FILTER (WHERE src.measured)
      FROM src
      CROSS JOIN LATERAL jsonb_each(src.field_presence) AS je(key, value)
      GROUP BY
        src.workflow_id, je.key,
        (src.started_at AT TIME ZONE 'UTC')::date, src.is_test
      RETURNING 1
    )
    SELECT max(completed_at) FROM src
  $q$, v_from, v_to, v_ceiling) INTO v_max;

  IF p_lookback_days < 2 THEN
    RETURN;
  END IF;

  INSERT INTO field_presence_rollup_state (id, watermark, updated_at)
  VALUES (true, COALESCE(v_max, v_ceiling), now())
  ON CONFLICT (id) DO UPDATE
    SET watermark  = CASE
                       WHEN v_max IS NULL THEN field_presence_rollup_state.watermark
                       ELSE GREATEST(field_presence_rollup_state.watermark, v_max)
                     END,
        updated_at = now();
END;
$fn$;

-- ------------------------------------------------------------------
-- The incremental (#1150 body plus the two counts)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_field_presence_incremental()
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_last    TIMESTAMPTZ;
  v_ceiling TIMESTAMPTZ := now() - interval '1 minute';
  v_floor   TIMESTAMPTZ;
BEGIN
  SET LOCAL lock_timeout = '30s';
  PERFORM pg_advisory_xact_lock(883301, 2);

  SELECT watermark INTO v_last FROM field_presence_rollup_state WHERE id;
  IF v_last IS NULL THEN
    RAISE EXCEPTION 'field_presence_rollup_state has no watermark row; a reconcile must seed it first';
  END IF;

  IF v_ceiling <= v_last THEN
    RETURN;
  END IF;

  v_floor := v_last - interval '2 days';

  EXECUTE format($q$
    INSERT INTO field_presence_daily (
      workflow_id, field_path, day, is_test, ran_count, present_count,
      key_present_count, key_measured_count
    )
    SELECT
      we.workflow_id,
      je.key,
      (we.started_at AT TIME ZONE 'UTC')::date,
      we.is_test,
      count(*),
      count(*) FILTER (WHERE je.value = 'true'::jsonb),
      count(*) FILTER (WHERE COALESCE(we.field_presence_version, 1) >= 2 AND je.value <> 'false'::jsonb),
      count(*) FILTER (WHERE COALESCE(we.field_presence_version, 1) >= 2)
    FROM workflow_executions we
    CROSS JOIN LATERAL jsonb_each(we.field_presence) AS je(key, value)
    WHERE we.started_at  >= %L
      AND we.completed_at >  %L
      AND we.completed_at <= %L
      AND we.field_presence IS NOT NULL
    GROUP BY
      we.workflow_id, je.key,
      (we.started_at AT TIME ZONE 'UTC')::date, we.is_test
    ON CONFLICT (workflow_id, field_path, day, is_test) DO UPDATE
      SET ran_count          = field_presence_daily.ran_count          + EXCLUDED.ran_count,
          present_count      = field_presence_daily.present_count      + EXCLUDED.present_count,
          key_present_count  = field_presence_daily.key_present_count  + EXCLUDED.key_present_count,
          key_measured_count = field_presence_daily.key_measured_count + EXCLUDED.key_measured_count
  $q$, v_floor, v_last, v_ceiling);

  UPDATE field_presence_rollup_state
  SET watermark = v_ceiling, updated_at = now()
  WHERE id;
END;
$fn$;

REVOKE ALL ON FUNCTION refresh_field_presence_daily(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION refresh_field_presence_incremental() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION refresh_field_presence_daily(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_field_presence_incremental() TO service_role;
