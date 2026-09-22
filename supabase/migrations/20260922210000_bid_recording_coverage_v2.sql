-- bid_recording_coverage_v2: the coverage counts plus the ATTEMPT rows (#1413,
-- Phase 6, L683, L220, L367).
--
-- The too few bids monitor judges bid rows per sighting against a stored
-- baseline. On Engine, nine bid rows in ten are `skipped` rows: tripoint_ping
-- writes one for every lead it bails on without calling anyone, so the ratio
-- there mostly measures rows that appear whether or not a real attempt was
-- recorded. Stage C of the buyer_select cutover removes those rows, which would
-- drop the measured ratio about tenfold against a baseline near 56 percent and
-- page falsely (#1414). The unit the monitor counts therefore changes to
-- attempt rows, bid rows whose skip_reason is distinct from 'skipped', and
-- this function returns them beside the old count.
--
-- Additive: the old function stays until a later release removes it, and the
-- monitor moves to this one with a new baseline key, because old readings must
-- not be compared with new ones.
--
-- Same shape and grants as bid_recording_coverage (20260904200000).
CREATE OR REPLACE FUNCTION public.bid_recording_coverage_v2(
  p_org_id UUID,
  p_since  TIMESTAMPTZ
)
RETURNS TABLE (
  workflow_id   UUID,
  workflow_name TEXT,
  is_active     BOOLEAN,
  sightings     BIGINT,
  bid_rows      BIGINT,
  attempt_rows  BIGINT,
  winners       BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ls.workflow_id,
    w.name::TEXT                                                          AS workflow_name,
    w.is_active,
    count(*)::BIGINT                                                      AS sightings,
    COALESCE(sum(bc.n), 0)::BIGINT                                        AS bid_rows,
    COALESCE(sum(bc.attempts), 0)::BIGINT                                 AS attempt_rows,
    count(*) FILTER (WHERE ls.winning_partner_slug IS NOT NULL)::BIGINT   AS winners
  FROM public.lead_sightings ls
  JOIN public.workflows w ON w.id = ls.workflow_id
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE b.skip_reason IS DISTINCT FROM 'skipped') AS attempts
    FROM public.lead_sighting_bids b
    WHERE b.sighting_id = ls.id
      AND b.attempted_at_utc >= p_since
      AND b.is_test = false
  ) bc ON TRUE
  WHERE w.organization_id = p_org_id
    AND w.deleted_at IS NULL
    AND ls.execution_started_at_utc >= p_since
    AND ls.is_test = false
  GROUP BY ls.workflow_id, w.name, w.is_active
$$;

COMMENT ON FUNCTION public.bid_recording_coverage_v2(UUID, TIMESTAMPTZ) IS
  'bid_recording_coverage plus attempt_rows, the bid rows whose skip_reason is distinct from skipped (#1413). Read by the too few bids monitor, which judges attempts per sighting so the removal of Engine''s skipped rows at Stage C cannot page falsely.';

REVOKE ALL ON ROUTINE public.bid_recording_coverage_v2(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON ROUTINE public.bid_recording_coverage_v2(UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON ROUTINE public.bid_recording_coverage_v2(UUID, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON ROUTINE public.bid_recording_coverage_v2(UUID, TIMESTAMPTZ) TO service_role;
