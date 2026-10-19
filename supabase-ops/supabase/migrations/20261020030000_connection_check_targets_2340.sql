-- The connection_check sweep's list of ops connections, and the login states
-- the ops minute tick reports to the bidding Worker (#2340, phase 10 of #1689;
-- plan: discussion #2329).
--
-- WHY. Two readers need every ops connection across organizations at once:
--   the connection_check sweep (apps/worker/src/ops/connection-check.ts), which
--     probes each servable connection's identity through connectionFetch and
--     writes the result with record_connection_check (the last_check_* columns
--     only), and needs the identity verify measured to compare it with;
--   the tick's login states (the same module, judgeConnectionLogins), which
--     page needs_reauth at once and refresh_failing once Dan's decision 2 bound
--     is met (5 failures, the first at least 15 minutes old), and so need the
--     refresh streak, which connection_status does not return.
-- connection_status answers one organization and none of the streak, so it
-- serves neither. This is its lane wide sibling.
--
-- WHAT. connection_check_targets(p_limit): one row per connection copy that is
-- not withdrawn and not covered by a tombstone (the rules connection_copy and
-- sf_limits_targets judge removal by), across Bidspoke organizations, each row
-- carrying its own, with:
--   servable   serve_until is still ahead. A copy past it cannot be used (bidding
--              has been unreachable for 6 hours), so the sweep does not probe
--              it, but it is still listed: a needs_reauth it holds must not be
--              read as cleared just because bidding is down.
--   status     the same CASE connection_status derives (supabase-ops migration
--              20261018170000), which connection_check_targets.test.sql holds
--              equal row for row.
--   the check's columns, needs_reauth's time and cause, the refresh streak's
--              count and start, the identity verify measured for the copy's
--              generation (Salesforce only; null when none), and the database
--              clock, so every age is judged on one clock (L736).
-- The least recently checked first (never checked before any), then by id, so a
-- sweep held to its limit reaches every connection in turn. At most p_limit
-- rows, so the caller can tell a full page (L24).
--
-- Additive only (ADR 0007): one new read only function, nothing else changes.
-- Nothing calls it until the ops Worker that carries the sweep deploys, and that
-- Worker refuses no other work if it is missing: the sweep and the login states
-- each report their own failure by name. Guarded by
-- supabase-ops/supabase/tests/connection_check_targets.test.sql.

SET lock_timeout = '5s';

CREATE FUNCTION public.connection_check_targets(p_limit integer)
RETURNS TABLE (organization_id uuid, connection_id uuid, service text, generation bigint, target jsonb, public_config jsonb, servable boolean,
  status text, last_check_ok_at timestamptz, last_check_failed_at timestamptz, needs_reauth_at timestamptz, needs_reauth_cause text,
  refresh_failures integer, refresh_failing_since timestamptz, measured_sf_org_id text, measured_username text, db_now timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'connection_check_targets: limit must be 1 to 500, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.organization_id, c.connection_id, c.service, c.generation, c.target, c.public_config, c.serve_until > now(),
    -- connection_status's derivation, unchanged (connection_check_targets.test.sql compares the two).
    CASE
      WHEN h.needs_reauth_at > coalesce(h.reauth_cleared_at, '-infinity'::timestamptz) THEN 'needs_reauth'
      WHEN h.refresh_failures > 0 AND h.refresh_failing_since > coalesce(h.reauth_cleared_at, '-infinity'::timestamptz) THEN 'refresh_failing'
      WHEN h.last_check_failed_at > coalesce(h.last_check_ok_at, '-infinity'::timestamptz) THEN 'check_failing'
      WHEN h.last_check_ok_at IS NOT NULL THEN 'healthy'
      ELSE 'unchecked'
    END,
    h.last_check_ok_at, h.last_check_failed_at, h.needs_reauth_at, h.needs_reauth_cause,
    coalesce(h.refresh_failures, 0), h.refresh_failing_since,
    m.sf_org_id, m.username, now()
  FROM public.connection_copies c
  LEFT JOIN public.connection_tombstones_ops t ON t.connection_id = c.connection_id
  LEFT JOIN public.connection_health h ON h.connection_id = c.connection_id AND h.organization_id = c.organization_id
  LEFT JOIN public.connection_measured_identity m
    ON m.connection_id = c.connection_id AND m.generation = c.generation AND m.organization_id = c.organization_id
  WHERE c.withdrawn_at IS NULL
    AND (t.connection_id IS NULL OR t.generation < c.generation)
  ORDER BY greatest(h.last_check_ok_at, h.last_check_failed_at) ASC NULLS FIRST, c.connection_id
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.connection_check_targets(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connection_check_targets(integer) TO service_role;

RESET lock_timeout;
