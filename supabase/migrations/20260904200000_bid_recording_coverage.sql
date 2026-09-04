-- ============================================================
-- Per workflow bid recording coverage (#1157)
-- ============================================================
-- Lead Economy ran 41,747 times and wrote ZERO rows to lead_sighting_bids, with
-- a null winning_partner_slug on every sighting. The workflow itself succeeded
-- throughout, so nothing anywhere reported the gap: the bidding data simply did
-- not exist for one of the busiest partner relationships, and it was found while
-- scoping an unrelated issue.
--
-- Nothing could have reported it, because no query in the system compared what a
-- workflow WROTE as sightings against what it wrote as bids. The existing
-- detectors sit either side of the gap: field-presence watches fields inside a
-- step's output, and the volume checks watch run counts. A derivation that runs
-- between the two and produces nothing is invisible to both.
--
-- This function answers the comparison for one organization. The alerting rule
-- lives in apps/worker/src/lib/bid-recording-coverage.ts.
--
-- SHAPE, measured rather than assumed. The obvious form counts the sightings and
-- the bid rows in one LEFT JOIN, which needs count(DISTINCT ls.id) because a
-- sighting with three bids appears three times. Measured on production over a 24
-- hour window (112,345 sightings, 5 workflows), that form runs in 1.77 s and
-- spills the distinct sort to disk at 4 MB. The LATERAL form below keeps one row
-- per sighting, so a plain count(*) is correct and no distinct sort exists: 1.36 s
-- on the same window. Both are well inside the Worker's 30 s statement timeout,
-- and this runs once a day per organization.
--
-- The cost grows with sightings in the window, since the bids index is probed
-- once per sighting. At three times today's volume expect roughly 4 s. If that
-- ever matters, the fix is a per-execution counter written at finalize, which is
-- what 20260814000003 did for the email drop rate, NOT a wider window.
--
-- Both time bounds are partition keys (lead_sightings.execution_started_at_utc,
-- lead_sighting_bids.attempted_at_utc), so each side prunes. The bids bound is
-- deliberately applied INSIDE the lateral rather than in a WHERE clause: on the
-- outer query it would turn the left join into an inner one and a workflow with
-- no bid rows, which is the entire case this exists to find, would vanish from
-- the result instead of reporting zero.
--
-- Column names verified against the live schema before writing this, not guessed.
CREATE OR REPLACE FUNCTION public.bid_recording_coverage(
  p_org_id UUID,
  p_since  TIMESTAMPTZ
)
RETURNS TABLE (
  workflow_id   UUID,
  workflow_name TEXT,
  is_active     BOOLEAN,
  sightings     BIGINT,
  bid_rows      BIGINT,
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
    count(*) FILTER (WHERE ls.winning_partner_slug IS NOT NULL)::BIGINT   AS winners
  FROM public.lead_sightings ls
  JOIN public.workflows w ON w.id = ls.workflow_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS n
    FROM public.lead_sighting_bids b
    WHERE b.sighting_id = ls.id
      AND b.attempted_at_utc >= p_since
      AND b.is_test = false
  ) bc ON TRUE
  WHERE w.organization_id = p_org_id
    -- Soft deleted workflows keep their rows, so without this a workflow nobody
    -- can act on any more would be reported every day (workflows.deleted_at).
    AND w.deleted_at IS NULL
    AND ls.execution_started_at_utc >= p_since
    AND ls.is_test = false
  GROUP BY ls.workflow_id, w.name, w.is_active
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, AND Supabase's default
-- privileges grant it to anon and authenticated, so revoking from PUBLIC alone is
-- not enough: that is exactly how field_presence_window shipped callable by anon
-- (20260902160127, LESSONS L124, L541). All three are revoked explicitly.
--
-- It matters here because the function takes the organization as a parameter, is
-- SECURITY DEFINER, and returns per workflow lead volume, which is internal
-- structure the anon key in the client bundle must never reach.
REVOKE ALL ON ROUTINE public.bid_recording_coverage(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON ROUTINE public.bid_recording_coverage(UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON ROUTINE public.bid_recording_coverage(UUID, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON ROUTINE public.bid_recording_coverage(UUID, TIMESTAMPTZ) TO service_role;
