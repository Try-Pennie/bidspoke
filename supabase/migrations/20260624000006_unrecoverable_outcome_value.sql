-- ============================================================
-- Give unrecoverable strands a non-null outcome ('unrecoverable')
-- ============================================================
-- finalize_unrecoverable_stranded (migration ...05) left outcome NULL, which is
-- the first time a FINALIZED lead_sightings row carries a null outcome — every
-- normal finalize and the old sweep set a non-null value. The Snowflake export
-- MERGEs these rows, and if the warehouse's outcome column is NOT NULL the
-- ~72.6K strand_unrecoverable rows would fail to export and never purge. Use a
-- non-null honest value instead; reject_reason='strand_unrecoverable' still
-- carries the provenance. (No CHECK constraint exists on lead_sightings.outcome,
-- so a new value is safe.)

CREATE OR REPLACE FUNCTION public.finalize_unrecoverable_stranded(p_min_age_hours int DEFAULT 26)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  UPDATE lead_sightings
  SET outcome_state = 'finalized',
      outcome = 'unrecoverable',
      reject_reason = 'strand_unrecoverable',
      updated_at = now()
  WHERE outcome_state = 'in_flight'
    AND is_test = false
    AND execution_started_at_utc < now() - make_interval(hours => p_min_age_hours)
    AND execution_started_at_utc >= now() - interval '95 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'finalize_unrecoverable_stranded: labeled % unrecoverable sighting(s)', n;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.finalize_unrecoverable_stranded(int) TO service_role;
