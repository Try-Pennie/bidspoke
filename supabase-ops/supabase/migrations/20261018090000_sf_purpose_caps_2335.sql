-- Per purpose shares of the ops Salesforce pool (#2335, phase 5 of #1689,
-- finding F125; plan: discussion #2329, part 2).
--
-- WHY. connectionFetch takes a Salesforce lease for every request, steps and
-- the calls that are not steps alike: the lookups behind every dropdown,
-- verify, Reconnect, the still valid check and the sf_limits read. The plan
-- gives each non step purpose "its own sub cap", and the phase 4 schema had no
-- home for one: sf_pool_caps holds a single workflow_share per Salesforce org,
-- and acquire_sf_lease counted every purpose against that one number. So a
-- flood of lookups could take as many slots as a workflow may, and the number
-- each purpose may take was nowhere a person could approve.
--
-- WHAT.
--   sf_purpose_caps   one row per Salesforce org and non step purpose: how many
--                     of the org's slots that purpose may hold at once. A
--                     step's share stays sf_pool_caps.workflow_share, per
--                     workflow. Like the org caps, STATED, NEVER DEFAULTED
--                     (L72): no row until Dan approves a number (Decision 11),
--                     service_role may only read it, and a purpose with no row
--                     is refused by its own name, sf_purpose_cap_unset, never
--                     read as no limit. A row needs its org's approved cap
--                     (a foreign key), and the org's cap binds whatever the
--                     shares add up to, because the pool is counted first.
--   acquire_sf_lease  replaced with the same signature and the same answers,
--                     plus two: purpose_share_full (the purpose's share is
--                     held) and sf_purpose_cap_unset. Both are answered only to
--                     a purpose other than step, so a run's resource wait never
--                     carries either (run-vocabulary.ts NON_STEP_LEASE_OUTCOMES).
--                     Order: the org's cap, then the purpose's share, then the
--                     budget, then the counts. Everything else is unchanged:
--                     the bootstrap slot, the budget rules, the advisory lock.
--
-- SAFE TO APPLY BEFORE ITS CODE (L640). Nothing calls acquire_sf_lease yet: its
-- first caller is connectionFetch, which nothing calls in the deploy that adds
-- it. No cap is set by this migration, so every acquire after it, as before it,
-- is refused until Dan approves the numbers.
--
-- Additive (ADR 0007): a new table, and a function replaced in place with the
-- same arguments and result columns. Guarded by
-- supabase-ops/supabase/tests/sf_purpose_caps.test.sql, and
-- connection_storage.test.sql's pool cases now approve the shares they use.

SET lock_timeout = '5s';

CREATE TABLE public.sf_purpose_caps (
  sf_org_id        text NOT NULL CONSTRAINT sf_purpose_caps_sf_org_id_check CHECK (sf_org_id ~ '^00D[A-Za-z0-9]{15}$')
    CONSTRAINT sf_purpose_caps_org_cap_fkey REFERENCES public.sf_pool_caps (sf_org_id),
  -- Every purpose but step, whose share is its workflow's (sf_pool_caps.workflow_share).
  purpose          text NOT NULL CONSTRAINT sf_purpose_caps_purpose_check CHECK (purpose IN ('lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits')),
  -- A Salesforce org's row, never an organization's, as sf_pool_caps is.
  organization_id  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
    CONSTRAINT sf_purpose_caps_lane_row CHECK (organization_id = '00000000-0000-0000-0000-000000000000'),
  -- No default: each number is Dan's (Decision 11). The org's cap binds over it.
  share            integer NOT NULL CONSTRAINT sf_purpose_caps_share_check CHECK (share BETWEEN 1 AND 100),
  approved_at      timestamptz NOT NULL,
  approved_by      text NOT NULL CONSTRAINT sf_purpose_caps_approved_by_check CHECK (length(approved_by) BETWEEN 1 AND 200),
  PRIMARY KEY (sf_org_id, purpose)
);

ALTER TABLE public.sf_purpose_caps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sf_purpose_caps FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.sf_purpose_caps FROM service_role;
GRANT SELECT ON public.sf_purpose_caps TO service_role;

-- ── acquire_sf_lease ──────────────────────────────────────────────────────────
-- As in 20261017220000_ops_connections_2334.sql, with each non step purpose
-- counted against its own approved share. Answers one row:
--   granted               lease_id and expires_at; pool is org or bootstrap
--   pool_full             retry_at is when the soonest lease in the pool lapses
--   workflow_share_full   a step's workflow holds its share; retry_at likewise
--   purpose_share_full    a non step purpose holds its share; retry_at likewise
--   sf_budget_floor       the latest reading is under the org's floor; retry_at is when the next reading is due
--   sf_budget_unmeasured  no reading, or one older than 15 minutes
--   sf_org_unmeasured     no measured row for this connection and generation, and not a bootstrap verify
--   sf_cap_unset          no approved cap for the org (or for the host, on the bootstrap path)
--   sf_purpose_cap_unset  no approved share for this non step purpose of the org
CREATE OR REPLACE FUNCTION public.acquire_sf_lease(
  p_organization_id  uuid,
  p_connection_id    uuid,
  p_generation       bigint,
  p_purpose          text,
  p_workflow_id      uuid,
  p_holder           text,
  p_ttl_seconds      integer,
  p_bootstrap_host   text DEFAULT NULL
) RETURNS TABLE (outcome text, lease_id uuid, expires_at timestamptz, retry_at timestamptz, pool text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_held public.sf_leases%ROWTYPE;
  v_measured public.connection_measured_identity%ROWTYPE;
  v_host text;
  v_bootstrap_cap integer;
  v_cap public.sf_pool_caps%ROWTYPE;
  v_share integer;
  v_reading public.sf_budget_readings%ROWTYPE;
  v_id uuid;
  v_expires timestamptz;
  v_in_pool integer;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL OR p_generation IS NULL OR p_generation < 1 THEN
    RAISE EXCEPTION 'acquire_sf_lease: organization, connection and a generation of at least 1 are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('step', 'lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits') THEN
    RAISE EXCEPTION 'acquire_sf_lease: % is not a purpose', p_purpose USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_purpose = 'step') <> (p_workflow_id IS NOT NULL) THEN
    RAISE EXCEPTION 'acquire_sf_lease: a step names its workflow, and no other purpose does' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_bootstrap_host IS NOT NULL AND p_purpose <> 'verify' THEN
    RAISE EXCEPTION 'acquire_sf_lease: only verify takes the bootstrap slot' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_holder IS NULL OR length(p_holder) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'acquire_sf_lease: a holder of 1 to 200 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'acquire_sf_lease: ttl must be 5 to 300 seconds, not %', p_ttl_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_expires := v_now + make_interval(secs => p_ttl_seconds);

  -- The same holder again: its lease, if it still holds one.
  SELECT * INTO v_held FROM public.sf_leases l WHERE l.holder = p_holder FOR UPDATE;
  IF FOUND THEN
    IF v_held.organization_id <> p_organization_id THEN
      RAISE EXCEPTION 'acquire_sf_lease: holder % belongs to another organization', p_holder USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_held.expires_at > v_now THEN
      IF v_held.connection_id <> p_connection_id OR v_held.generation <> p_generation OR v_held.purpose <> p_purpose
          OR v_held.workflow_id IS DISTINCT FROM p_workflow_id THEN
        RAISE EXCEPTION 'acquire_sf_lease: holder % already holds a lease for another call', p_holder USING ERRCODE = 'invalid_parameter_value';
      END IF;
      RETURN QUERY SELECT 'granted'::text, v_held.id, v_held.expires_at, NULL::timestamptz,
        CASE WHEN v_held.sf_org_id IS NOT NULL THEN 'org' ELSE 'bootstrap' END;
      RETURN;
    END IF;
    DELETE FROM public.sf_leases l WHERE l.id = v_held.id;
  END IF;

  SELECT * INTO v_measured FROM public.connection_measured_identity m WHERE m.connection_id = p_connection_id AND m.generation = p_generation;
  IF FOUND AND v_measured.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'acquire_sf_lease: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT FOUND THEN
    -- Nothing measured: only verify's own userinfo call, against its declared host's approved slot. No share applies.
    IF p_purpose <> 'verify' OR p_bootstrap_host IS NULL THEN
      RETURN QUERY SELECT 'sf_org_unmeasured'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::text;
      RETURN;
    END IF;
    v_host := lower(p_bootstrap_host);
    PERFORM pg_advisory_xact_lock(hashtextextended('sf_bootstrap:' || v_host, 0));
    SELECT b.cap INTO v_bootstrap_cap FROM public.sf_bootstrap_caps b WHERE b.instance_host = v_host;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'sf_cap_unset'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, 'bootstrap'::text;
      RETURN;
    END IF;
    INSERT INTO public.sf_leases (organization_id, holder, connection_id, generation, bootstrap_host, purpose, acquired_at, expires_at)
    SELECT p_organization_id, p_holder, p_connection_id, p_generation, v_host, 'verify', v_now, v_expires
    WHERE (SELECT count(*) FROM public.sf_leases l WHERE l.bootstrap_host = v_host AND l.expires_at > v_now) < v_bootstrap_cap
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT 'granted'::text, v_id, v_expires, NULL::timestamptz, 'bootstrap'::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'pool_full'::text, NULL::uuid, NULL::timestamptz,
      (SELECT min(l.expires_at) FROM public.sf_leases l WHERE l.bootstrap_host = v_host AND l.expires_at > v_now), 'bootstrap'::text;
    RETURN;
  END IF;

  -- The measured org's pool: one lock per Salesforce org, whichever connection asks.
  PERFORM pg_advisory_xact_lock(hashtextextended('sf_pool:' || v_measured.sf_org_id, 0));
  SELECT * INTO v_cap FROM public.sf_pool_caps c WHERE c.sf_org_id = v_measured.sf_org_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'sf_cap_unset'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, 'org'::text;
    RETURN;
  END IF;
  -- The share: a step's is its workflow's; every other purpose's is its own approved row (F125).
  IF p_purpose = 'step' THEN
    v_share := v_cap.workflow_share;
  ELSE
    SELECT pc.share INTO v_share FROM public.sf_purpose_caps pc WHERE pc.sf_org_id = v_measured.sf_org_id AND pc.purpose = p_purpose;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'sf_purpose_cap_unset'::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz, 'org'::text;
      RETURN;
    END IF;
  END IF;
  IF p_purpose <> 'sf_limits' THEN
    SELECT * INTO v_reading FROM public.sf_budget_readings r WHERE r.sf_org_id = v_measured.sf_org_id;
    IF NOT FOUND OR v_reading.measured_at < v_now - interval '15 minutes' THEN
      RETURN QUERY SELECT 'sf_budget_unmeasured'::text, NULL::uuid, NULL::timestamptz, v_now + interval '1 minute', 'org'::text;
      RETURN;
    END IF;
    IF v_reading.daily_api_remaining < v_cap.budget_floor THEN
      RETURN QUERY SELECT 'sf_budget_floor'::text, NULL::uuid, NULL::timestamptz,
        greatest(v_reading.measured_at + interval '5 minutes', v_now + interval '1 minute'), 'org'::text;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.sf_leases (organization_id, holder, connection_id, generation, sf_org_id, purpose, workflow_id, acquired_at, expires_at)
  SELECT p_organization_id, p_holder, p_connection_id, p_generation, v_measured.sf_org_id, p_purpose, p_workflow_id, v_now, v_expires
  WHERE (SELECT count(*) FROM public.sf_leases l WHERE l.sf_org_id = v_measured.sf_org_id AND l.expires_at > v_now) < v_cap.cap
    AND (SELECT count(*) FROM public.sf_leases l WHERE l.sf_org_id = v_measured.sf_org_id AND l.expires_at > v_now
           AND l.purpose = p_purpose AND l.workflow_id IS NOT DISTINCT FROM p_workflow_id) < v_share
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT 'granted'::text, v_id, v_expires, NULL::timestamptz, 'org'::text;
    RETURN;
  END IF;

  SELECT count(*) INTO v_in_pool FROM public.sf_leases l WHERE l.sf_org_id = v_measured.sf_org_id AND l.expires_at > v_now;
  IF v_in_pool >= v_cap.cap THEN
    RETURN QUERY SELECT 'pool_full'::text, NULL::uuid, NULL::timestamptz,
      (SELECT min(l.expires_at) FROM public.sf_leases l WHERE l.sf_org_id = v_measured.sf_org_id AND l.expires_at > v_now), 'org'::text;
    RETURN;
  END IF;
  IF p_purpose = 'step' THEN
    RETURN QUERY SELECT 'workflow_share_full'::text, NULL::uuid, NULL::timestamptz,
      (SELECT min(l.expires_at) FROM public.sf_leases l WHERE l.sf_org_id = v_measured.sf_org_id AND l.expires_at > v_now
         AND l.purpose = p_purpose AND l.workflow_id IS NOT DISTINCT FROM p_workflow_id), 'org'::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'purpose_share_full'::text, NULL::uuid, NULL::timestamptz,
    (SELECT min(l.expires_at) FROM public.sf_leases l WHERE l.sf_org_id = v_measured.sf_org_id AND l.expires_at > v_now
       AND l.purpose = p_purpose), 'org'::text;
END
$fn$;

-- CREATE OR REPLACE keeps the function's privileges; restated so this file says them.
REVOKE ALL ON FUNCTION public.acquire_sf_lease(uuid, uuid, bigint, text, uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_sf_lease(uuid, uuid, bigint, text, uuid, text, integer, text) TO service_role;

RESET lock_timeout;
