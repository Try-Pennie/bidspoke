-- The measurement columns the bounded orphan count and the per-hour counts
-- produce (#872, Phase A4).
--
-- Additive. `pg_orphan_step_count` is deliberately LEFT IN PLACE rather than
-- dropped in the same release that stops writing it (expand/contract, ADR 0007).
-- It is superseded by the pair below: an exact count of orphan EXECUTIONS, plus
-- a lower bound on their steps taken from a bounded sample, because counting
-- every orphan step timed out at 30 s on the worst day, which is the day the
-- measurement exists to report.

ALTER TABLE public.execution_archive_days
  ADD COLUMN IF NOT EXISTS orphan_execution_count  BIGINT,
  ADD COLUMN IF NOT EXISTS orphan_step_count_seen  BIGINT,
  ADD COLUMN IF NOT EXISTS orphan_sample_size      BIGINT,
  ADD COLUMN IF NOT EXISTS hours_recorded          BIGINT,
  ADD COLUMN IF NOT EXISTS hours_execution_count   BIGINT;

COMMENT ON COLUMN public.execution_archive_days.pg_orphan_step_count IS
  'SUPERSEDED by orphan_execution_count and orphan_step_count_seen (#872). No longer written; kept for one release per expand/contract.';
COMMENT ON COLUMN public.execution_archive_days.orphan_step_count_seen IS
  'A LOWER BOUND: step rows across at most orphan_sample_size orphan executions, never a total.';
COMMENT ON COLUMN public.execution_archive_days.hours_execution_count IS
  'The archiver''s own per-hour execution counts summed. Differs from pg_execution_count only when executions were written after their hour was archived.';

DROP FUNCTION IF EXISTS public.record_archive_day_measurement(
  DATE, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BOOLEAN, TEXT
);

CREATE FUNCTION public.record_archive_day_measurement(
  p_day                     DATE,
  p_pg_execution_count      BIGINT,
  p_pg_step_count           BIGINT,
  p_orphan_execution_count  BIGINT,
  p_orphan_step_count_seen  BIGINT,
  p_orphan_sample_size      BIGINT,
  p_hours_recorded          BIGINT,
  p_hours_execution_count   BIGINT,
  p_sf_execution_count      BIGINT,
  p_sf_step_count           BIGINT,
  p_erased_execution_count  BIGINT,
  p_incomplete_count        BIGINT,
  p_probe_sampled           INTEGER,
  p_probe_ok                BOOLEAN,
  p_probe_failure_reason    TEXT
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO execution_archive_days AS d (
    archive_day, pg_execution_count, pg_step_count,
    orphan_execution_count, orphan_step_count_seen, orphan_sample_size,
    hours_recorded, hours_execution_count,
    sf_execution_count, sf_step_count, erased_execution_count, incomplete_count,
    probe_sampled, probe_ok, probe_failure_reason, measured_at, first_measured_at
  ) VALUES (
    p_day, p_pg_execution_count, p_pg_step_count,
    p_orphan_execution_count, p_orphan_step_count_seen, p_orphan_sample_size,
    p_hours_recorded, p_hours_execution_count,
    p_sf_execution_count, p_sf_step_count, p_erased_execution_count, p_incomplete_count,
    p_probe_sampled, p_probe_ok, p_probe_failure_reason, NOW(), NOW()
  )
  ON CONFLICT (archive_day) DO UPDATE SET
    pg_execution_count     = EXCLUDED.pg_execution_count,
    pg_step_count          = EXCLUDED.pg_step_count,
    orphan_execution_count = EXCLUDED.orphan_execution_count,
    orphan_step_count_seen = EXCLUDED.orphan_step_count_seen,
    orphan_sample_size     = EXCLUDED.orphan_sample_size,
    hours_recorded         = EXCLUDED.hours_recorded,
    hours_execution_count  = EXCLUDED.hours_execution_count,
    sf_execution_count     = EXCLUDED.sf_execution_count,
    sf_step_count          = EXCLUDED.sf_step_count,
    erased_execution_count = EXCLUDED.erased_execution_count,
    incomplete_count       = EXCLUDED.incomplete_count,
    probe_sampled          = EXCLUDED.probe_sampled,
    probe_ok               = EXCLUDED.probe_ok,
    probe_failure_reason   = EXCLUDED.probe_failure_reason,
    measured_at            = EXCLUDED.measured_at,
    -- Preserved by the DATABASE rather than by whoever writes the caller: how
    -- long a day has been failing to reconcile is the number that says whether
    -- this is a blip or a standing problem, and an upsert that overwrote it
    -- would reset that clock on every attempt.
    first_measured_at      = d.first_measured_at;
$$;

REVOKE ALL ON FUNCTION public.record_archive_day_measurement(
  DATE, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
