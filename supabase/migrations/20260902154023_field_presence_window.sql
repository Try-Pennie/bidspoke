-- #1101: per-field presence counts over a TRAILING WINDOW, not a calendar day.
--
-- The Tier-1 drought check judged today's cumulative rate from
-- field_presence_daily against a seven day daily baseline. A burst inside one
-- hour therefore healed itself as later good runs arrived, and the recovery
-- notice reported a duration set by the check's hourly tick rather than by the
-- event.
--
-- Measured 2026-09-02: Main Flow `trades_request.body.pennieLeadCalculations`
-- missed 168 of 261 runs in the single hour 12:00 to 13:00 UTC, because a
-- Salesforce Apex deploy broke the trades path from 12:20 to 12:50. The alert
-- fired at 13:00 and posted "back within normal range" at 14:00, when the day's
-- average had climbed back over the floor with nothing repaired, describing the
-- incident as one hour long against a real outage of thirty minutes.
--
-- The baseline still comes from the daily rollup, which is what makes a field
-- "stable" over days. Only the observed side moves to a window, and it is read
-- from workflow_executions directly rather than from a new rollup: the check
-- runs hourly and asks for one trailing hour, so there is nothing to precompute
-- and no second copy of the truth to go stale.
--
-- Expand/contract: additive. A new function, no schema change, nothing reads it
-- until the worker deploys, and the worker falls back to no rows rather than
-- failing if it deploys first.

CREATE OR REPLACE FUNCTION field_presence_window(
  p_workflow_ids UUID[],
  p_since        TIMESTAMPTZ
)
RETURNS TABLE (
  workflow_id   UUID,
  field_path    TEXT,
  ran_count     BIGINT,
  present_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    we.workflow_id,
    je.key AS field_path,
    count(*) AS ran_count,
    count(*) FILTER (WHERE je.value = 'true'::jsonb) AS present_count
  FROM workflow_executions we
  CROSS JOIN LATERAL jsonb_each(we.field_presence) AS je(key, value)
  WHERE we.workflow_id = ANY(p_workflow_ids)
    -- started_at is the partition key, so this prunes to the current partition.
    AND we.started_at >= p_since
    AND we.field_presence IS NOT NULL
    AND we.is_test = false
  GROUP BY we.workflow_id, je.key;
$$;

-- Same posture as the rollup refreshers (#762): the worker calls this as
-- service_role, and nothing else has any business reading it. Stated rather
-- than inherited, because the evidence of a missing REVOKE is an absence
-- (LESSONS L124), and this function can enumerate every watched field path on
-- every workflow in one call.
REVOKE ALL ON FUNCTION field_presence_window(UUID[], TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION field_presence_window(UUID[], TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION field_presence_window(UUID[], TIMESTAMPTZ) IS
  'Per-field ran/present counts over a trailing window, for the Tier-1 field presence drought check (#1101). Baseline stays on field_presence_daily; only the observed side is windowed.';
