-- Retire the ops Salesforce lease purpose reconnect (#2336, phase 6 of #1689).
--
-- WHY. Reconnect takes no lease of its own: clearReauth (the OpsConnections
-- entrypoint, apps/worker/src/ops/connections/ops-connections.ts) takes its
-- lease as verify, because only verify gets the bootstrap slot a new
-- generation needs (#2456). So reconnect was a purpose nothing takes, and
-- sf_purpose_caps would have asked Dan to approve a share of the pool
-- (Decision 11) for nothing. It leaves the code's vocabulary
-- (run-vocabulary.ts SF_LEASE_PURPOSES) in the same change.
--
-- WHAT.
--   the refusal       if any row of sf_leases or sf_purpose_caps holds
--                     reconnect, this migration RAISES naming the counts and
--                     changes nothing. It never deletes such a row, and never
--                     leaves it to fail on the narrowed constraint, because a
--                     row would mean something does take the purpose and the
--                     premise of this change is wrong.
--   sf_leases_purpose_check        narrowed to step, lookup, verify,
--                                  connection_check, sf_limits.
--   sf_purpose_caps_purpose_check  narrowed to lookup, verify,
--                                  connection_check, sf_limits.
--   acquire_sf_lease  replaced with the same signature, answers and body as in
--                     20261018090000_sf_purpose_caps_2335.sql, with reconnect
--                     gone from its purpose guard, so it refuses reconnect as
--                     not a purpose, as it does any other unknown one.
--
-- SAFE TO RE-RUN. The guard reads the current rows, each constraint is dropped
-- and added under the same name, and the function is replaced in place.
--
-- SAFE TO APPLY BEFORE ITS CODE (L640). The code deployed when this is applied
-- still lists reconnect, but nothing in it passes that purpose: clearReauth
-- and verify pass verify, lookups pass lookup, and no other caller exists. So
-- no write that code makes is refused by the narrower lists.
--
-- A contract change of two CHECKs and one guard (ADR 0007): no object is
-- dropped and no column changes. Guarded by
-- supabase-ops/supabase/tests/retire_reconnect_purpose.test.sql, which also
-- runs this file against tables still holding a reconnect row.

SET LOCAL lock_timeout = '5s';

-- The guard and the narrowing are one statement, so they are one transaction
-- however this file is run (the CLI wraps it in one; a psql replay does not),
-- and both tables are held from the count to the narrowing, so no reconnect
-- row can arrive between the two.
DO $retire$
DECLARE
  v_leases bigint;
  v_caps bigint;
BEGIN
  SET LOCAL lock_timeout = '5s';
  LOCK TABLE public.sf_leases, public.sf_purpose_caps IN ACCESS EXCLUSIVE MODE;

  SELECT count(*) INTO v_leases FROM public.sf_leases WHERE purpose = 'reconnect';
  SELECT count(*) INTO v_caps FROM public.sf_purpose_caps WHERE purpose = 'reconnect';
  IF v_leases > 0 OR v_caps > 0 THEN
    RAISE EXCEPTION 'retire reconnect (#2336): % sf_leases and % sf_purpose_caps rows hold the purpose reconnect, so something takes it; nothing was changed', v_leases, v_caps
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Find what wrote those rows before retiring the purpose. This migration never deletes them.';
  END IF;

  ALTER TABLE public.sf_leases DROP CONSTRAINT sf_leases_purpose_check;
  ALTER TABLE public.sf_leases ADD CONSTRAINT sf_leases_purpose_check CHECK (purpose IN ('step', 'lookup', 'verify', 'connection_check', 'sf_limits'));

  ALTER TABLE public.sf_purpose_caps DROP CONSTRAINT sf_purpose_caps_purpose_check;
  ALTER TABLE public.sf_purpose_caps ADD CONSTRAINT sf_purpose_caps_purpose_check CHECK (purpose IN ('lookup', 'verify', 'connection_check', 'sf_limits'));
END
$retire$;

-- ── acquire_sf_lease ──────────────────────────────────────────────────────────
-- As in 20261018090000_sf_purpose_caps_2335.sql, but for the purpose guard.
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
  IF p_purpose IS NULL OR p_purpose NOT IN ('step', 'lookup', 'verify', 'connection_check', 'sf_limits') THEN
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
