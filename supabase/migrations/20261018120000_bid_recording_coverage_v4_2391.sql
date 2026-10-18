-- bid_recording_coverage_v4: v3's counts with a buyer's own refusals counted
-- apart from the attempts (#2391).
--
-- Engine Bidding Workflow version 110 (2026-10-15) made tripoint_ping refuse a
-- sell off lead whose loan amount is under Tripoint's 2,000 minimum
-- (loan_amount_below_min) or is not a positive number (missing_lead_field). Those
-- leads had been Tripoint attempts. Their bid rows said only 'skipped', so the too
-- few bids monitor saw its attempts per lead halve with nothing broken, and paged
-- every day. The Worker now records each such refusal by its reason on the bid
-- row, and this version counts the loan minimum refusals as refusal_rows, which
-- the monitor counts beside the attempts as recorded.
--
-- attempt_rows keeps its meaning: a bid row whose skip_reason is neither
-- 'skipped' nor a written refusal. Without that exclusion v3 would count every
-- refusal row as an attempt, because its predicate is IS DISTINCT FROM 'skipped'.
--
-- missing_lead_field is written to the row but counted as NEITHER an attempt nor
-- a refusal. It is also what a fault looks like: a loan amount path that stops
-- resolving makes every sell off lead read missing_lead_field, and counted as
-- recorded that would hold the monitor's ratio steady while Tripoint got nothing
-- (L367). Counted as neither, the ratio collapses and the monitor pages.
--
-- The written list is BID_ROW_REFUSAL_REASONS and the counted list is
-- RECORDED_REFUSAL_REASONS, both in apps/worker/src/engine/bid-log.ts, and a web
-- guard (bid-refusal-reasons-match-sql.test.ts) fails if either differs from the
-- lists here. A reason added there needs a new version here.
--
-- Additive (ADR 0007): v3 stays until a later release drops it, so a Worker still
-- reading v3 keeps working during the deploy. v2 stays for the six hour silence
-- check, which reads only bid_rows. Same window, shape and grants as v3
-- (20261009150000), plus the one column.

CREATE OR REPLACE FUNCTION public.bid_recording_coverage_v4(
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
  refusal_rows  BIGINT,
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
    COALESCE(sum(bc.refusals), 0)::BIGINT                                 AS refusal_rows,
    count(*) FILTER (WHERE ls.winning_partner_slug IS NOT NULL)::BIGINT   AS winners
  FROM public.lead_sightings ls
  JOIN public.workflows w ON w.id = ls.workflow_id
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS n,
      count(*) FILTER (
        WHERE b.skip_reason IS NULL
           OR b.skip_reason NOT IN ('skipped', 'loan_amount_below_min', 'missing_lead_field')
      ) AS attempts,
      count(*) FILTER (
        WHERE b.skip_reason IN ('loan_amount_below_min')
      ) AS refusals
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

COMMENT ON FUNCTION public.bid_recording_coverage_v4(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'bid_recording_coverage_v3 with refusal_rows (#2391): bid rows recording Tripoint''s loan minimum refusal (loan_amount_below_min), counted apart from attempt_rows. missing_lead_field rows are in neither count. Read by the too few bids monitor over a day ending ten minutes ago.';

REVOKE ALL ON ROUTINE public.bid_recording_coverage_v4(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON ROUTINE public.bid_recording_coverage_v4(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON ROUTINE public.bid_recording_coverage_v4(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON ROUTINE public.bid_recording_coverage_v4(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
