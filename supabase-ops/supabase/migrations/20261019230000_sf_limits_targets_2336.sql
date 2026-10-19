-- The sf_limits sweep's list of measured Salesforce orgs (#2336, phase 6 of #1689).
--
-- WHY. acquire_sf_lease refuses every ops Salesforce call but the sf_limits read
-- as sf_budget_unmeasured once an org's sf_budget_readings row is missing or
-- older than 15 minutes. The sf_limits sweep (apps/worker/src/ops/sf-limits.ts)
-- reads each measured org's /limits every few minutes so the reading stays
-- fresh whether or not any other ops call is reaching that org. To do that it
-- needs, per Salesforce org, one connection it can read through.
--
-- WHAT. sf_limits_targets(p_limit): one row per Salesforce org that a
-- connection MEASURED as (connection_measured_identity, written only by verify,
-- never the declared target: L66, L83), naming one connection of it whose copy
-- can serve the read now: service salesforce, the copy's generation is the
-- measured one, not withdrawn, not past serve_until, and not covered by a
-- tombstone (the same order connection_copy judges, so connectionFetch would
-- not refuse it as removed, withdrawn or expired). Of several, a connection
-- not in needs_reauth first, then the one measured most recently, then by id,
-- so the choice is stable. With only a needs_reauth connection left, the org is
-- still returned, so the sweep reports that refusal by name rather than going
-- quiet about the org. Each row carries the copy's target (the instance_url
-- the read is sent to, checked again by connectionFetch against the declared
-- hosts), the org's last reading time from sf_budget_readings (null when it has
-- none), and the database clock, so the sweep judges a reading's age on one
-- clock.
--
-- Lane wide, like workflow_copies: the list spans Bidspoke organizations, each
-- row carrying its own, and every later call (connectionFetch's copy read and
-- lease) is made under that row's organization. At most p_limit rows, in org
-- order, so the caller can tell a full page (L24).
--
-- Additive only (ADR 0007): one new read only function, nothing else changes.
-- Nothing calls it until the ops Worker that carries the sweep deploys, and
-- that Worker refuses no other work if it is missing (the sweep reports its
-- own failure by name). Guarded by supabase-ops/supabase/tests/sf_limits_targets.test.sql.

SET lock_timeout = '5s';

CREATE FUNCTION public.sf_limits_targets(p_limit integer)
RETURNS TABLE (sf_org_id text, organization_id uuid, connection_id uuid, generation bigint, target jsonb, reading_measured_at timestamptz, db_now timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'sf_limits_targets: limit must be 1 to 100, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT chosen.sf_org_id, chosen.organization_id, chosen.connection_id, chosen.generation, chosen.target, r.measured_at, now()
  FROM (
    SELECT DISTINCT ON (m.sf_org_id) m.sf_org_id, c.organization_id, c.connection_id, c.generation, c.target
    FROM public.connection_measured_identity m
    JOIN public.connection_copies c
      ON c.connection_id = m.connection_id AND c.generation = m.generation AND c.organization_id = m.organization_id
    LEFT JOIN public.connection_tombstones_ops t ON t.connection_id = c.connection_id
    LEFT JOIN public.connection_health h ON h.connection_id = c.connection_id AND h.organization_id = c.organization_id
    WHERE c.service = 'salesforce'
      AND c.withdrawn_at IS NULL
      AND c.serve_until > now()
      AND (t.connection_id IS NULL OR t.generation < c.generation)
    ORDER BY m.sf_org_id,
      -- false sorts first: a connection not in needs_reauth (connection_status's first rule).
      coalesce(h.needs_reauth_at > coalesce(h.reauth_cleared_at, '-infinity'::timestamptz), false),
      m.measured_at DESC,
      c.connection_id
  ) chosen
  LEFT JOIN public.sf_budget_readings r ON r.sf_org_id = chosen.sf_org_id
  ORDER BY chosen.sf_org_id
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.sf_limits_targets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_limits_targets(integer) TO service_role;

RESET lock_timeout;
