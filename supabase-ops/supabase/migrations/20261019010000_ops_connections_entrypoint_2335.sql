-- The OpsConnections entrypoint's two database needs (#2335, PR 8 of phase 5 of
-- #1689; plan: discussion #2329, part 2). Applied to the ops project ("Bidspoke
-- Ops"), never the bidding one.
--
-- 1. A CANDIDATE'S MEASUREMENT IS NOT A COMMITTED ONE (findings F116, F126).
--    verify and Reconnect measure a credential bidding has not committed yet
--    (a candidate, held in memory only: nothing is written to
--    connection_copies). Salesforce's verify writes what that credential
--    authenticates as through record_measured_identity, keyed on the
--    connection and the candidate's generation, because the ops Salesforce
--    pool is keyed on the measured org and a committed generation with no
--    measured row is refused every call but verify (sf_org_unmeasured).
--    Before this migration a second measurement of the same generation that
--    named another identity answered identity_changed and wrote nothing. That
--    is right for a generation ops already holds as its copy (the credential
--    has not changed, so something else has, and a person must look), and
--    wrong for a candidate's: when bidding's compare and set never ran (the
--    request died after ops answered), bidding's row stays at generation N
--    and the next Reconnect seals a different login under N+1 again. Its
--    verify would be refused identity_changed for ever, a failed Reconnect
--    blocking the next one (F126's test 3, L5). So record_measured_identity
--    now REPLACES the measurement of a generation the connection's copy does
--    not hold yet (no copy, or a copy at a lower generation) and answers
--    replaced; a generation the copy holds is still never overwritten.
--
-- 2. THE PER ORGANIZATION RATE CAP ON SCHEMA LOOKUPS (the plan: "Lookups sit
--    behind a per organization rate cap"). Each dropdown of the ops step form
--    asks OpsConnections.lookup, which reaches the connected service through
--    connectionFetch; the Salesforce pool already caps how many Salesforce
--    calls run at once, but nothing caps how many lookups one organization
--    sends a minute to Snowflake, Supabase or Salesforce's daily allocation.
--      connection_lookup_windows  one row per organization: the start of its
--                   current one minute window and how many lookups it has
--                   taken in it. An organization's row (never the nil uuid).
--      take_lookup_allowance(org, per_minute)  one lookup's allowance:
--                   allowed (used counts this one), or rate_limited with
--                   retry_at, the end of the window. A fixed window, so a
--                   burst can reach twice the cap across a window's edge; the
--                   cap bounds sustained load, not a burst. The cap itself
--                   is the caller's stated constant (LOOKUP_RATE_PER_MINUTE in
--                   apps/worker/src/lib/ops-connections-contract.ts), held here
--                   to 1 to 600 so a wrong one cannot lift it.
--
-- SAFE TO APPLY BEFORE ITS CODE (L640). Nothing calls take_lookup_allowance
-- until the OpsConnections deploy, and no binding reaches that until PR 9. The
-- replaced record_measured_identity keeps its signature and every answer it
-- gave; the deployed code that calls it (none in production: verify is this
-- PR's) reads replaced as an identity outcome.
--
-- Additive (ADR 0007): a new table, a new function, and record_measured_identity
-- replaced in place with the same signature. Guarded by
-- supabase-ops/supabase/tests/ops_connections_entrypoint.test.sql.

SET lock_timeout = '5s';

-- ── record_measured_identity: a candidate's measurement is replaced ──────────
CREATE OR REPLACE FUNCTION public.record_measured_identity(p_organization_id uuid, p_connection_id uuid, p_generation bigint, p_sf_org_id text, p_username text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_old public.connection_measured_identity%ROWTYPE;
  v_org uuid;
  v_held bigint;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL OR p_generation IS NULL OR p_generation < 1 THEN
    RAISE EXCEPTION 'record_measured_identity: organization, connection and a generation of at least 1 are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_sf_org_id IS NULL OR p_sf_org_id !~ '^00D[A-Za-z0-9]{15}$' THEN
    RAISE EXCEPTION 'record_measured_identity: % is not an 18 character Salesforce org id', p_sf_org_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_username IS NULL OR length(p_username) NOT BETWEEN 1 AND 320 THEN
    RAISE EXCEPTION 'record_measured_identity: a username of 1 to 320 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT coalesce(t.organization_id, c.organization_id) INTO v_org
  FROM (SELECT 1) one
  LEFT JOIN public.connection_tombstones_ops t ON t.connection_id = p_connection_id
  LEFT JOIN public.connection_copies c ON c.connection_id = p_connection_id;
  IF v_org IS NOT NULL AND v_org <> p_organization_id THEN
    RAISE EXCEPTION 'record_measured_identity: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id AND t.generation >= p_generation) THEN
    RETURN 'connection_removed';
  END IF;

  INSERT INTO public.connection_measured_identity (connection_id, generation, organization_id, sf_org_id, username)
  VALUES (p_connection_id, p_generation, p_organization_id, p_sf_org_id, p_username)
  ON CONFLICT (connection_id, generation) DO NOTHING;
  IF FOUND THEN RETURN 'recorded'; END IF;
  SELECT * INTO v_old FROM public.connection_measured_identity m
  WHERE m.connection_id = p_connection_id AND m.generation = p_generation
  FOR UPDATE;
  IF v_old.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'record_measured_identity: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_old.sf_org_id = p_sf_org_id AND v_old.username = p_username THEN RETURN 'confirmed'; END IF;
  -- Another identity for this generation. A generation the copy holds is the
  -- committed credential's, never overwritten; one it does not hold yet is a
  -- candidate's, which the next candidate at that generation measures afresh.
  SELECT c.generation INTO v_held FROM public.connection_copies c WHERE c.connection_id = p_connection_id;
  IF v_held IS NOT NULL AND v_held >= p_generation THEN RETURN 'identity_changed'; END IF;
  UPDATE public.connection_measured_identity m
  SET sf_org_id = p_sf_org_id, username = p_username, measured_at = now()
  WHERE m.connection_id = p_connection_id AND m.generation = p_generation;
  RETURN 'replaced';
END
$fn$;

-- ── connection_lookup_windows ─────────────────────────────────────────────────
CREATE TABLE public.connection_lookup_windows (
  organization_id  uuid PRIMARY KEY
    CONSTRAINT connection_lookup_windows_organization_check CHECK (organization_id <> '00000000-0000-0000-0000-000000000000'),
  window_start     timestamptz NOT NULL,
  used             integer NOT NULL CONSTRAINT connection_lookup_windows_used_check CHECK (used BETWEEN 0 AND 600)
);

ALTER TABLE public.connection_lookup_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connection_lookup_windows FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.connection_lookup_windows FROM service_role;
GRANT SELECT ON public.connection_lookup_windows TO service_role;

-- ── take_lookup_allowance ─────────────────────────────────────────────────────
-- One lookup's allowance for one organization, under its row's lock, so two
-- concurrent lookups cannot both take the last one.
CREATE FUNCTION public.take_lookup_allowance(p_organization_id uuid, p_per_minute integer)
RETURNS TABLE (outcome text, used integer, retry_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_row public.connection_lookup_windows%ROWTYPE;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id = '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION 'take_lookup_allowance: an organization is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_per_minute IS NULL OR p_per_minute NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'take_lookup_allowance: the cap must be 1 to 600 a minute, not %', p_per_minute USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.connection_lookup_windows (organization_id, window_start, used)
  VALUES (p_organization_id, v_now, 0)
  ON CONFLICT (organization_id) DO NOTHING;
  SELECT * INTO v_row FROM public.connection_lookup_windows w WHERE w.organization_id = p_organization_id FOR UPDATE;

  IF v_row.window_start + interval '1 minute' <= v_now THEN
    UPDATE public.connection_lookup_windows w SET window_start = v_now, used = 1 WHERE w.organization_id = p_organization_id;
    RETURN QUERY SELECT 'allowed'::text, 1, NULL::timestamptz;
  ELSIF v_row.used < p_per_minute THEN
    UPDATE public.connection_lookup_windows w SET used = w.used + 1 WHERE w.organization_id = p_organization_id;
    RETURN QUERY SELECT 'allowed'::text, v_row.used + 1, NULL::timestamptz;
  ELSE
    RETURN QUERY SELECT 'rate_limited'::text, v_row.used, v_row.window_start + interval '1 minute';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.take_lookup_allowance(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_lookup_allowance(uuid, integer) TO service_role;

RESET lock_timeout;
