-- bid_recording_coverage_v3: the v2 counts over a window with an END (#1929).
--
-- The too few bids monitor read v2 over the six hours before its 13:00 UTC run,
-- which are the six overnight hours. RML (GigFi) takes leads only from 13:00 to
-- 23:00 UTC, so on 2026-10-09 its window held nothing but its first minute: six
-- leads, four of them validation rejects and one still running, and it paged at
-- 17 percent against a "normal" built from readings just as thin.
--
-- The monitor now reads a day, from the purge horizon to ten minutes ago. The
-- end is what this version adds: a lead that started in the last few minutes
-- has a sighting but not yet its bid row, so it must not be counted (L696).
-- Leads are counted when execution_started_at_utc is in [p_since, p_until);
-- their bid rows are counted whenever they were logged after p_since, because a
-- lead started just before the end logs its bid just after it.
--
-- Additive: v2 stays, because the six hour silence check still reads it.
-- Same shape and grants as v2 (20260922210000).

CREATE OR REPLACE FUNCTION public.bid_recording_coverage_v3(
  p_org_id UUID,
  p_since  TIMESTAMPTZ,
  p_until  TIMESTAMPTZ
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
    AND ls.execution_started_at_utc <  p_until
    AND ls.is_test = false
  GROUP BY ls.workflow_id, w.name, w.is_active
$$;

COMMENT ON FUNCTION public.bid_recording_coverage_v3(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'bid_recording_coverage_v2 over leads started in [p_since, p_until) (#1929). Read by the too few bids monitor over a day ending ten minutes ago, so a lead still running is not counted as one with no bid.';

REVOKE ALL ON ROUTINE public.bid_recording_coverage_v3(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON ROUTINE public.bid_recording_coverage_v3(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON ROUTINE public.bid_recording_coverage_v3(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON ROUTINE public.bid_recording_coverage_v3(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
