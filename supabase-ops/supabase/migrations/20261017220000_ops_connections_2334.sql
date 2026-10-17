-- Ops connection storage and the ops Salesforce pool (#2334, phase 4 of #1689,
-- plan: discussion #2329, part 1, Phase 4a). The FIRST of the phase's two
-- deploys: everything here is new and nothing calls it yet, so applying it
-- changes no running behaviour. The second deploy replaces the live run engine
-- functions (resource_wait, uncharged_attempts, the widened status reasons and
-- the lease sweep, finding F122) and is a migration of its own.
--
-- WHAT.
--   connection_copies   the last copy of each ops connection the bidding Worker
--                  served: its sealed envelope (ciphertext only), public config,
--                  declared target and generation. A COPY: the bidding row's
--                  credential_enc is the one home (L83). Each carries
--                  serve_until, at most 6 hours after it was served (Dan's
--                  decision 3, 2026-10-17), held by a CHECK, so a removal
--                  reaches ops within 6 hours even while bidding is down (L625).
--   connection_tombstones_ops  one row per removed connection. A copy whose
--                  generation a tombstone covers is refused and deleted, so a
--                  late list cannot restore it. A tombstone expires 7 hours
--                  after the removal: the 6 hour serve window plus 1 hour of
--                  margin, after which every copy served before the removal is
--                  past its serve_until and refused on arrival anyway.
--   connection_health   one column per writer (L53): the still valid check's
--                  (last_check_ok_at, last_check_failed_at, last_check_cause),
--                  a mint or refresh failure's (needs_reauth_at,
--                  needs_reauth_cause), Reconnect's (reauth_cleared_at). Each
--                  writer is its own function and writes only its own columns.
--                  connection_status derives what is shown: needs_reauth holds
--                  while needs_reauth_at > reauth_cleared_at, whatever the check
--                  says.
--   connection_measured_identity  the Salesforce org a connection's credential
--                  really authenticates as, written only by verify from
--                  /services/oauth2/userinfo, never from the declared target
--                  (L83). One row per connection and generation.
--   sf_pool_caps, sf_bootstrap_caps, sf_budget_readings, sf_leases  the ops
--                  Salesforce pool. Salesforce's concurrency limit and daily
--                  allocation belong to the Salesforce org, so the pool, the
--                  per workflow share and the reading are keyed on the MEASURED
--                  org id (L66, L1005): two connections to one org share one
--                  pool, whichever Bidspoke organization owns them.
--
-- THE BOOTSTRAP (findings F118 and F127). A new connection's org is unknown
-- until verify has measured it, and verify's userinfo call is itself a
-- Salesforce call that needs a slot. So the bootstrap slot has its OWN approval
-- key: sf_bootstrap_caps, one row per declared instance host (cap 1), which Dan
-- approves alongside the org caps (Decision 11). acquire_sf_lease grants a
-- connection with no measured row exactly one thing: a verify, naming its
-- declared host, against that host's approved slot. Every other call is
-- refused with sf_org_unmeasured, and a host with no approved row with
-- sf_cap_unset. Once verify has written the measured row, every call (a later
-- verify included) goes through the org's pool and its approved cap. The
-- bootstrap call is not held to the budget floor: there is no org to read a
-- budget for yet, and it is one call per new connection and generation.
--
-- CAPS ARE STATED, NEVER DEFAULTED (L72). sf_pool_caps and sf_bootstrap_caps
-- have no row until Dan approves a number, and no function writes them:
-- service_role may only read them, so a cap arrives by an approval migration,
-- reviewed like any other. A missing cap is refused by name (sf_cap_unset),
-- never read as no limit.
--
-- THE BUDGET. A reading older than 15 minutes is refused as sf_budget_unmeasured
-- (L567), and one below the org's approved budget_floor as sf_budget_floor. The
-- sf_limits read that writes the readings takes a pool slot but is exempt from
-- both (L665): otherwise an org with no fresh reading would refuse every call
-- and so never get one. Salesforce's daily allocation is a rolling 24 hours with
-- no reset instant, so a refusal answers retry_at, the earliest time its answer
-- can change, and never claims a reset.
--
-- ORGANIZATION (finding F117). Every table carries organization_id uuid NOT
-- NULL (the live privilege check refuses one that does not). A copy, a
-- tombstone, a health row, a measured identity and a lease belong to their
-- connection's organization, and every function that writes one matches the
-- organization it is given against the stored row. A cap, a bootstrap cap and a
-- reading belong to a Salesforce org, not to any Bidspoke organization, so they
-- are lane rows on the nil uuid, held there by a CHECK, as ops_lane_sweeps is.
--
-- SWEEPS. claim_ops_sweep gains tombstone_expiry (this phase), connection_check
-- (Phase 10) and sf_limits (Phase 6): the CHECK on ops_lane_sweeps.sweep is
-- widened and the function replaced with the same list. Nothing runs them yet.
--
-- Additive only (ADR 0007): new tables and functions, a widened CHECK, and
-- claim_ops_sweep replaced with a wider list. Guarded by
-- supabase-ops/supabase/tests/connection_storage.test.sql.

SET lock_timeout = '5s';

-- ── connection_copies ─────────────────────────────────────────────────────────
CREATE TABLE public.connection_copies (
  connection_id    uuid PRIMARY KEY,
  organization_id  uuid NOT NULL,
  service          text NOT NULL CONSTRAINT connection_copies_service_check CHECK (service ~ '^[a-z][a-z0-9_]{0,63}$'),
  generation       bigint NOT NULL CONSTRAINT connection_copies_generation_check CHECK (generation >= 1),
  -- The seal's envelope (packages/connection-seal): {v, kid, wrapped_key, iv, ct} and nothing else.
  envelope         jsonb NOT NULL,
  public_config    jsonb NOT NULL,
  target           jsonb,
  -- The bidding Worker's clock when it served the newest list that named this copy.
  served_at        timestamptz NOT NULL,
  serve_until      timestamptz NOT NULL,
  -- The served_at of the complete list that stopped naming it.
  withdrawn_at     timestamptz,
  received_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connection_copies_envelope_shape CHECK (
    jsonb_typeof(envelope) = 'object' AND envelope ?& ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct']
    AND envelope - ARRAY['v', 'kid', 'wrapped_key', 'iv', 'ct'] = '{}'::jsonb
    AND envelope->'v' = '1'::jsonb AND octet_length(envelope::text) <= 65536),
  CONSTRAINT connection_copies_public_config_shape CHECK (jsonb_typeof(public_config) = 'object' AND octet_length(public_config::text) <= 16384),
  CONSTRAINT connection_copies_target_shape CHECK (target IS NULL OR (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 16384)),
  -- Dan's decision 3: a copy is served for at most 6 hours.
  CONSTRAINT connection_copies_serve_window CHECK (serve_until > served_at AND serve_until <= served_at + interval '6 hours')
);
CREATE INDEX connection_copies_organization_idx ON public.connection_copies (organization_id, connection_id);

-- ── connection_tombstones_ops ─────────────────────────────────────────────────
CREATE TABLE public.connection_tombstones_ops (
  connection_id    uuid PRIMARY KEY,
  organization_id  uuid NOT NULL,
  -- Every generation up to this one is removed.
  generation       bigint NOT NULL CONSTRAINT connection_tombstones_ops_generation_check CHECK (generation >= 1),
  removed_at       timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  -- The 6 hour serve window plus 1 hour of margin (see the header).
  CONSTRAINT connection_tombstones_ops_outlives_copies CHECK (expires_at >= removed_at + interval '7 hours')
);
CREATE INDEX connection_tombstones_ops_expires_idx ON public.connection_tombstones_ops (expires_at);

-- ── connection_health ─────────────────────────────────────────────────────────
CREATE TABLE public.connection_health (
  connection_id         uuid PRIMARY KEY,
  organization_id       uuid NOT NULL,
  -- Written only by record_connection_check (the still valid cron).
  last_check_ok_at      timestamptz,
  last_check_failed_at  timestamptz,
  last_check_cause      text CONSTRAINT connection_health_check_cause_length CHECK (length(last_check_cause) BETWEEN 1 AND 200),
  -- Written only by record_connection_needs_reauth (a mint or refresh failure).
  needs_reauth_at       timestamptz,
  needs_reauth_cause    text CONSTRAINT connection_health_reauth_cause_length CHECK (length(needs_reauth_cause) BETWEEN 1 AND 200),
  -- Written only by record_connection_reauth_cleared (Reconnect).
  reauth_cleared_at     timestamptz,
  CONSTRAINT connection_health_check_cause_pair CHECK ((last_check_failed_at IS NULL) = (last_check_cause IS NULL)),
  CONSTRAINT connection_health_reauth_cause_pair CHECK ((needs_reauth_at IS NULL) = (needs_reauth_cause IS NULL))
);

-- ── connection_measured_identity ──────────────────────────────────────────────
CREATE TABLE public.connection_measured_identity (
  connection_id    uuid NOT NULL,
  generation       bigint NOT NULL CONSTRAINT connection_measured_identity_generation_check CHECK (generation >= 1),
  organization_id  uuid NOT NULL,
  -- The 18 character id userinfo answers. A 15 character form of the same org
  -- would key a second pool, so only the 18 character form is stored.
  sf_org_id        text NOT NULL CONSTRAINT connection_measured_identity_sf_org_id_check CHECK (sf_org_id ~ '^00D[A-Za-z0-9]{15}$'),
  username         text NOT NULL CONSTRAINT connection_measured_identity_username_check CHECK (length(username) BETWEEN 1 AND 320),
  measured_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, generation)
);

-- ── the Salesforce pool ───────────────────────────────────────────────────────
CREATE TABLE public.sf_pool_caps (
  sf_org_id        text PRIMARY KEY CONSTRAINT sf_pool_caps_sf_org_id_check CHECK (sf_org_id ~ '^00D[A-Za-z0-9]{15}$'),
  -- A Salesforce org's row, never an organization's (see ORGANIZATION above).
  organization_id  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
    CONSTRAINT sf_pool_caps_lane_row CHECK (organization_id = '00000000-0000-0000-0000-000000000000'),
  -- No defaults: each number is Dan's (Decision 11).
  cap              integer NOT NULL CONSTRAINT sf_pool_caps_cap_check CHECK (cap BETWEEN 1 AND 100),
  workflow_share   integer NOT NULL,
  budget_floor     integer NOT NULL CONSTRAINT sf_pool_caps_budget_floor_check CHECK (budget_floor >= 0),
  approved_at      timestamptz NOT NULL,
  approved_by      text NOT NULL CONSTRAINT sf_pool_caps_approved_by_check CHECK (length(approved_by) BETWEEN 1 AND 200),
  CONSTRAINT sf_pool_caps_share_check CHECK (workflow_share BETWEEN 1 AND cap)
);

CREATE TABLE public.sf_bootstrap_caps (
  -- The declared instance_url host, lower case, a Salesforce host only.
  instance_host    text PRIMARY KEY CONSTRAINT sf_bootstrap_caps_host_check CHECK (
    length(instance_host) <= 253 AND instance_host ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+salesforce\.com$'),
  organization_id  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
    CONSTRAINT sf_bootstrap_caps_lane_row CHECK (organization_id = '00000000-0000-0000-0000-000000000000'),
  -- One verify at a time per host, as the plan states.
  cap              integer NOT NULL CONSTRAINT sf_bootstrap_caps_cap_check CHECK (cap = 1),
  approved_at      timestamptz NOT NULL,
  approved_by      text NOT NULL CONSTRAINT sf_bootstrap_caps_approved_by_check CHECK (length(approved_by) BETWEEN 1 AND 200)
);

CREATE TABLE public.sf_budget_readings (
  sf_org_id            text PRIMARY KEY CONSTRAINT sf_budget_readings_sf_org_id_check CHECK (sf_org_id ~ '^00D[A-Za-z0-9]{15}$'),
  organization_id      uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'
    CONSTRAINT sf_budget_readings_lane_row CHECK (organization_id = '00000000-0000-0000-0000-000000000000'),
  daily_api_max        integer NOT NULL CONSTRAINT sf_budget_readings_max_check CHECK (daily_api_max > 0),
  -- Below zero when the org has run past its allocation, which Salesforce allows for a while.
  daily_api_remaining  integer NOT NULL,
  source               text NOT NULL CONSTRAINT sf_budget_readings_source_check CHECK (source IN ('limits', 'sforce_limit_info')),
  measured_at          timestamptz NOT NULL
);

CREATE TABLE public.sf_leases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The organization of the connection the lease was taken for.
  organization_id  uuid NOT NULL,
  -- Who holds it: release is by holder, and one holder holds one lease.
  holder           text NOT NULL CONSTRAINT sf_leases_holder_key UNIQUE CONSTRAINT sf_leases_holder_check CHECK (length(holder) BETWEEN 1 AND 200),
  connection_id    uuid NOT NULL,
  generation       bigint NOT NULL CONSTRAINT sf_leases_generation_check CHECK (generation >= 1),
  -- Exactly one pool: the measured org's, or the bootstrap slot of a declared host.
  sf_org_id        text,
  bootstrap_host   text,
  purpose          text NOT NULL CONSTRAINT sf_leases_purpose_check CHECK (purpose IN ('step', 'lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits')),
  workflow_id      uuid,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  CONSTRAINT sf_leases_one_pool CHECK (num_nonnulls(sf_org_id, bootstrap_host) = 1),
  CONSTRAINT sf_leases_bootstrap_is_verify CHECK (bootstrap_host IS NULL OR purpose = 'verify'),
  CONSTRAINT sf_leases_step_names_workflow CHECK ((purpose = 'step') = (workflow_id IS NOT NULL)),
  CONSTRAINT sf_leases_expiry_check CHECK (expires_at > acquired_at)
);
CREATE INDEX sf_leases_org_pool_idx ON public.sf_leases (sf_org_id, expires_at) WHERE sf_org_id IS NOT NULL;
CREATE INDEX sf_leases_bootstrap_pool_idx ON public.sf_leases (bootstrap_host, expires_at) WHERE bootstrap_host IS NOT NULL;
CREATE INDEX sf_leases_expires_idx ON public.sf_leases (expires_at);

-- ── privileges: the choke point, as for the run engine's tables ──────────────
ALTER TABLE public.connection_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones_ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_measured_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sf_pool_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sf_bootstrap_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sf_budget_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sf_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connection_copies, public.connection_tombstones_ops, public.connection_health, public.connection_measured_identity,
  public.sf_pool_caps, public.sf_bootstrap_caps, public.sf_budget_readings, public.sf_leases FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.connection_copies, public.connection_tombstones_ops, public.connection_health, public.connection_measured_identity,
  public.sf_pool_caps, public.sf_bootstrap_caps, public.sf_budget_readings, public.sf_leases FROM service_role;
GRANT SELECT ON public.connection_copies, public.connection_tombstones_ops, public.connection_health, public.connection_measured_identity,
  public.sf_pool_caps, public.sf_bootstrap_caps, public.sf_budget_readings, public.sf_leases TO service_role;

-- ── the widened sweeps ────────────────────────────────────────────────────────
-- The three live rows (lease_expiry, run_expiry, queue_agreement) satisfy the
-- wider CHECK, so validating it reads three rows.
ALTER TABLE public.ops_lane_sweeps DROP CONSTRAINT ops_lane_sweeps_sweep_check;
ALTER TABLE public.ops_lane_sweeps ADD CONSTRAINT ops_lane_sweeps_sweep_check CHECK (sweep IN
  ('lease_expiry', 'run_expiry', 'queue_agreement', 'tombstone_expiry', 'connection_check', 'sf_limits'));

-- As in 20261017090000_ops_tick_1949.sql, with the three new sweeps on its list.
CREATE OR REPLACE FUNCTION public.claim_ops_sweep(p_sweep text, p_owner text, p_every_seconds integer)
RETURNS TABLE (owned boolean, db_now timestamptz, last_started_at timestamptz, last_owner text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_row record;
BEGIN
  IF p_sweep IS NULL OR p_sweep NOT IN ('lease_expiry', 'run_expiry', 'queue_agreement', 'tombstone_expiry', 'connection_check', 'sf_limits') THEN
    RAISE EXCEPTION 'claim_ops_sweep: % is not a sweep', p_sweep USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_owner IS NULL OR length(p_owner) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'claim_ops_sweep: an owner of 1 to 200 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_every_seconds IS NULL OR p_every_seconds NOT BETWEEN 10 AND 86400 THEN
    RAISE EXCEPTION 'claim_ops_sweep: every must be 10 to 86400 seconds, not %', p_every_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('ops_sweep:' || p_sweep, 0)) THEN
    SELECT s.last_started_at, s.last_owner INTO v_row FROM public.ops_lane_sweeps s WHERE s.sweep = p_sweep;
    RETURN QUERY SELECT false, v_now, v_row.last_started_at, v_row.last_owner;
    RETURN;
  END IF;

  INSERT INTO public.ops_lane_sweeps (sweep) VALUES (p_sweep) ON CONFLICT (sweep) DO NOTHING;
  UPDATE public.ops_lane_sweeps s SET last_started_at = v_now, last_owner = p_owner
  WHERE s.sweep = p_sweep AND (s.last_started_at IS NULL OR s.last_started_at <= v_now - make_interval(secs => p_every_seconds))
  RETURNING s.last_started_at, s.last_owner INTO v_row;
  IF FOUND THEN
    RETURN QUERY SELECT true, v_now, v_row.last_started_at, v_row.last_owner;
    RETURN;
  END IF;
  SELECT s.last_started_at, s.last_owner INTO v_row FROM public.ops_lane_sweeps s WHERE s.sweep = p_sweep;
  RETURN QUERY SELECT false, v_now, v_row.last_started_at, v_row.last_owner;
END
$fn$;

-- ── save_connection_copies ────────────────────────────────────────────────────
-- Saves one list the bidding Worker served, as save_workflow_copies does for
-- workflows. p_copies is a JSON array of at most 1,000 objects:
--   {connection_id, organization_id, service, generation, envelope,
--    public_config, target, serve_until}
-- A lower generation than the one stored is refused (refused_older). An equal
-- one confirms, and takes the envelope, config and target of the later served
-- list (a reseal keeps the generation and changes the envelope's kid). A copy
-- already past serve_until is refused (refused_expired), and so is one a
-- tombstone covers (refused_removed). p_complete says the list names every ops
-- connection, so one it omits is withdrawn, and only a later list brings it
-- back. Lane wide: each copy is matched against its stored organization. Rows
-- are taken in connection order, so two saves at once lock in the same order.
CREATE FUNCTION public.save_connection_copies(p_served_at timestamptz, p_complete boolean, p_copies jsonb)
RETURNS TABLE (inserted integer, updated integer, confirmed integer, refused_older integer, refused_expired integer,
  refused_removed integer, withdrawn integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_copy record;
  v_old public.connection_copies%ROWTYPE;
  v_tomb public.connection_tombstones_ops%ROWTYPE;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_confirmed integer := 0;
  v_older integer := 0;
  v_expired integer := 0;
  v_removed integer := 0;
  v_withdrawn integer := 0;
  v_ids uuid[];
BEGIN
  IF p_served_at IS NULL OR p_complete IS NULL THEN
    RAISE EXCEPTION 'save_connection_copies: served_at and complete are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_copies IS NULL OR jsonb_typeof(p_copies) <> 'array' THEN
    RAISE EXCEPTION 'save_connection_copies: the copies must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_copies) > 1000 THEN
    RAISE EXCEPTION 'save_connection_copies: at most 1000 copies in one call, not %', jsonb_array_length(p_copies) USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_copy IN
    SELECT (e->>'connection_id')::uuid AS connection_id, (e->>'organization_id')::uuid AS organization_id, e->>'service' AS service,
      (e->>'generation')::bigint AS generation, e->'envelope' AS envelope, e->'public_config' AS public_config,
      CASE WHEN jsonb_typeof(e->'target') = 'object' THEN e->'target' END AS target, (e->>'serve_until')::timestamptz AS serve_until
    FROM jsonb_array_elements(p_copies) e
    ORDER BY (e->>'connection_id')::uuid
  LOOP
    IF v_copy.connection_id IS NULL OR v_copy.organization_id IS NULL OR v_copy.service IS NULL OR v_copy.generation IS NULL
        OR v_copy.envelope IS NULL OR v_copy.public_config IS NULL OR v_copy.serve_until IS NULL THEN
      RAISE EXCEPTION 'save_connection_copies: a copy needs its connection, organization, service, generation, envelope, public config and serve_until'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_ids := v_ids || v_copy.connection_id;

    SELECT * INTO v_tomb FROM public.connection_tombstones_ops t WHERE t.connection_id = v_copy.connection_id;
    IF FOUND THEN
      IF v_tomb.organization_id <> v_copy.organization_id THEN
        RAISE EXCEPTION 'save_connection_copies: connection % belongs to another organization', v_copy.connection_id USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF v_tomb.generation >= v_copy.generation THEN
        v_removed := v_removed + 1;
        CONTINUE;
      END IF;
    END IF;
    IF v_copy.serve_until <= v_now THEN
      v_expired := v_expired + 1;
      CONTINUE;
    END IF;

    SELECT * INTO v_old FROM public.connection_copies c WHERE c.connection_id = v_copy.connection_id FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.connection_copies (connection_id, organization_id, service, generation, envelope, public_config, target,
        served_at, serve_until, received_at, confirmed_at)
      VALUES (v_copy.connection_id, v_copy.organization_id, v_copy.service, v_copy.generation, v_copy.envelope, v_copy.public_config,
        v_copy.target, p_served_at, v_copy.serve_until, v_now, v_now)
      ON CONFLICT (connection_id) DO NOTHING;
      IF FOUND THEN
        v_inserted := v_inserted + 1;
        CONTINUE;
      END IF;
      -- Another save inserted it between the read and the insert: take it as it now is.
      SELECT * INTO v_old FROM public.connection_copies c WHERE c.connection_id = v_copy.connection_id FOR UPDATE;
    END IF;

    IF v_old.organization_id <> v_copy.organization_id THEN
      RAISE EXCEPTION 'save_connection_copies: connection % belongs to another organization', v_copy.connection_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_old.service <> v_copy.service THEN
      RAISE EXCEPTION 'save_connection_copies: connection % is a % connection, not %', v_copy.connection_id, v_old.service, v_copy.service
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_copy.generation > v_old.generation
        OR (v_copy.generation = v_old.generation AND p_served_at > v_old.served_at) THEN
      UPDATE public.connection_copies c
      SET generation = v_copy.generation, envelope = v_copy.envelope, public_config = v_copy.public_config, target = v_copy.target,
          served_at = p_served_at, serve_until = v_copy.serve_until,
          withdrawn_at = CASE WHEN v_old.withdrawn_at IS NOT NULL AND p_served_at <= v_old.withdrawn_at THEN v_old.withdrawn_at END,
          received_at = CASE WHEN v_copy.generation > v_old.generation THEN v_now ELSE v_old.received_at END,
          confirmed_at = v_now
      WHERE c.connection_id = v_copy.connection_id;
      IF v_copy.generation > v_old.generation THEN v_updated := v_updated + 1; ELSE v_confirmed := v_confirmed + 1; END IF;
    ELSIF v_copy.generation = v_old.generation THEN
      UPDATE public.connection_copies c SET confirmed_at = v_now WHERE c.connection_id = v_copy.connection_id;
      v_confirmed := v_confirmed + 1;
    ELSE
      v_older := v_older + 1;
    END IF;
  END LOOP;

  IF p_complete THEN
    -- Bounded: the copies are the ops connections.
    WITH gone AS (
      SELECT c.connection_id FROM public.connection_copies c
      WHERE c.withdrawn_at IS NULL AND c.served_at < p_served_at AND c.connection_id <> ALL (coalesce(v_ids, ARRAY[]::uuid[]))
      ORDER BY c.connection_id
      LIMIT 1000
      FOR UPDATE
    )
    UPDATE public.connection_copies c SET withdrawn_at = p_served_at
    FROM gone WHERE c.connection_id = gone.connection_id;
    GET DIAGNOSTICS v_withdrawn = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_inserted, v_updated, v_confirmed, v_older, v_expired, v_removed, v_withdrawn;
END
$fn$;

-- ── connection_copy ───────────────────────────────────────────────────────────
-- One connection's copy, and whether it may be used now, in connectionFetch's
-- order (plan Phase 5): a tombstone first, then withdrawal, then serve_until.
-- state is usable, connection_removed, connection_withdrawn,
-- connection_copy_expired or not_found; the envelope is returned only when it
-- is usable. Read only.
CREATE FUNCTION public.connection_copy(p_organization_id uuid, p_connection_id uuid)
RETURNS TABLE (state text, connection_id uuid, service text, generation bigint, envelope jsonb, public_config jsonb, target jsonb,
  served_at timestamptz, serve_until timestamptz, db_now timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_copy public.connection_copies%ROWTYPE;
  v_tomb public.connection_tombstones_ops%ROWTYPE;
  v_state text;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL THEN
    RAISE EXCEPTION 'connection_copy: organization and connection are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_tomb FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id;
  SELECT * INTO v_copy FROM public.connection_copies c WHERE c.connection_id = p_connection_id;
  IF coalesce(v_copy.organization_id, v_tomb.organization_id, p_organization_id) <> p_organization_id
      OR coalesce(v_tomb.organization_id, p_organization_id) <> p_organization_id THEN
    RAISE EXCEPTION 'connection_copy: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_state := CASE
    WHEN v_tomb.connection_id IS NOT NULL AND (v_copy.connection_id IS NULL OR v_tomb.generation >= v_copy.generation) THEN 'connection_removed'
    WHEN v_copy.connection_id IS NULL THEN 'not_found'
    WHEN v_copy.withdrawn_at IS NOT NULL THEN 'connection_withdrawn'
    WHEN v_copy.serve_until <= now() THEN 'connection_copy_expired'
    ELSE 'usable' END;
  RETURN QUERY SELECT v_state, p_connection_id, v_copy.service, v_copy.generation,
    CASE WHEN v_state = 'usable' THEN v_copy.envelope END, v_copy.public_config, v_copy.target, v_copy.served_at, v_copy.serve_until, now();
END
$fn$;

-- ── record_connection_tombstone ───────────────────────────────────────────────
-- A removal (revoke, or a tombstone the bidding Worker served). Deletes the copy
-- of every generation it covers, the measured identities of those generations,
-- and the health row once no copy is left. A repeat never lowers the
-- generation. removed_at is the bidding Worker's clock; a removal more than 5
-- minutes in the future is refused.
CREATE FUNCTION public.record_connection_tombstone(p_organization_id uuid, p_connection_id uuid, p_generation bigint, p_removed_at timestamptz)
RETURNS TABLE (outcome text, copies_removed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_old public.connection_tombstones_ops%ROWTYPE;
  v_outcome text;
  v_generation bigint;
  v_removed integer := 0;
  v_copy_org uuid;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL OR p_generation IS NULL OR p_generation < 1 OR p_removed_at IS NULL THEN
    RAISE EXCEPTION 'record_connection_tombstone: organization, connection, a generation of at least 1 and removed_at are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_removed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'record_connection_tombstone: removed_at % is in the future', p_removed_at USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT c.organization_id INTO v_copy_org FROM public.connection_copies c WHERE c.connection_id = p_connection_id FOR UPDATE;
  IF v_copy_org IS NOT NULL AND v_copy_org <> p_organization_id THEN
    RAISE EXCEPTION 'record_connection_tombstone: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.connection_tombstones_ops (connection_id, organization_id, generation, removed_at, expires_at)
  VALUES (p_connection_id, p_organization_id, p_generation, p_removed_at, p_removed_at + interval '7 hours')
  ON CONFLICT (connection_id) DO NOTHING;
  IF FOUND THEN
    v_outcome := 'recorded';
    v_generation := p_generation;
  ELSE
    SELECT * INTO v_old FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id FOR UPDATE;
    IF v_old.organization_id <> p_organization_id THEN
      RAISE EXCEPTION 'record_connection_tombstone: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_generation > v_old.generation THEN
      UPDATE public.connection_tombstones_ops t
      SET generation = p_generation, removed_at = greatest(v_old.removed_at, p_removed_at),
          expires_at = greatest(v_old.expires_at, p_removed_at + interval '7 hours'), recorded_at = now()
      WHERE t.connection_id = p_connection_id;
      v_outcome := 'recorded';
      v_generation := p_generation;
    ELSE
      v_outcome := 'already_recorded';
      v_generation := v_old.generation;
    END IF;
  END IF;

  DELETE FROM public.connection_copies c WHERE c.connection_id = p_connection_id AND c.generation <= v_generation;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  DELETE FROM public.connection_measured_identity m WHERE m.connection_id = p_connection_id AND m.generation <= v_generation;
  IF NOT EXISTS (SELECT 1 FROM public.connection_copies c WHERE c.connection_id = p_connection_id) THEN
    DELETE FROM public.connection_health h WHERE h.connection_id = p_connection_id;
  END IF;
  RETURN QUERY SELECT v_outcome, v_removed;
END
$fn$;

-- ── purge_expired_connection_tombstones ───────────────────────────────────────
-- The tombstone_expiry sweep: deletes only tombstones past expires_at, at most
-- p_limit, in expiry order. more says a full page was taken.
CREATE FUNCTION public.purge_expired_connection_tombstones(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_purged integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_expired_connection_tombstones: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH expired AS (
    SELECT t.connection_id FROM public.connection_tombstones_ops t
    WHERE t.expires_at <= now()
    ORDER BY t.expires_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.connection_tombstones_ops t USING expired WHERE t.connection_id = expired.connection_id;
  GET DIAGNOSTICS v_purged = ROW_COUNT;
  RETURN QUERY SELECT v_purged, v_purged = p_limit;
END
$fn$;

-- ── health: one function per writer ───────────────────────────────────────────
-- Each answers recorded, or connection_removed when a tombstone stands for the
-- connection (health is never written back for a removed one). Each matches
-- the organization against the copy and the health row. The times are the
-- database's clock (clock_timestamp, so two writes in one transaction still
-- order), never a Worker's.
CREATE FUNCTION public.record_connection_check(p_organization_id uuid, p_connection_id uuid, p_ok boolean, p_cause text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_at timestamptz := clock_timestamp();
  v_org uuid;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL OR p_ok IS NULL THEN
    RAISE EXCEPTION 'record_connection_check: organization, connection and the result are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ok AND p_cause IS NOT NULL THEN
    RAISE EXCEPTION 'record_connection_check: a passing check carries no cause' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT p_ok AND (p_cause IS NULL OR length(p_cause) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'record_connection_check: a failed check needs a cause of 1 to 200 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id) THEN
    SELECT t.organization_id INTO v_org FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id;
    IF v_org <> p_organization_id THEN
      RAISE EXCEPTION 'record_connection_check: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN 'connection_removed';
  END IF;
  SELECT coalesce(c.organization_id, h.organization_id) INTO v_org
  FROM (SELECT 1) one
  LEFT JOIN public.connection_copies c ON c.connection_id = p_connection_id
  LEFT JOIN public.connection_health h ON h.connection_id = p_connection_id;
  IF v_org IS NOT NULL AND v_org <> p_organization_id THEN
    RAISE EXCEPTION 'record_connection_check: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.connection_health AS h (connection_id, organization_id, last_check_ok_at, last_check_failed_at, last_check_cause)
  VALUES (p_connection_id, p_organization_id, CASE WHEN p_ok THEN v_at END, CASE WHEN NOT p_ok THEN v_at END, CASE WHEN NOT p_ok THEN p_cause END)
  ON CONFLICT (connection_id) DO UPDATE
  SET last_check_ok_at = CASE WHEN p_ok THEN v_at ELSE h.last_check_ok_at END,
      last_check_failed_at = CASE WHEN p_ok THEN h.last_check_failed_at ELSE v_at END,
      last_check_cause = CASE WHEN p_ok THEN h.last_check_cause ELSE p_cause END
  WHERE h.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_connection_check: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN 'recorded';
END
$fn$;

CREATE FUNCTION public.record_connection_needs_reauth(p_organization_id uuid, p_connection_id uuid, p_cause text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_at timestamptz := clock_timestamp();
  v_org uuid;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL OR p_cause IS NULL OR length(p_cause) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'record_connection_needs_reauth: organization, connection and a cause of 1 to 200 characters are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id) THEN
    SELECT t.organization_id INTO v_org FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id;
    IF v_org <> p_organization_id THEN
      RAISE EXCEPTION 'record_connection_needs_reauth: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN 'connection_removed';
  END IF;
  SELECT coalesce(c.organization_id, h.organization_id) INTO v_org
  FROM (SELECT 1) one
  LEFT JOIN public.connection_copies c ON c.connection_id = p_connection_id
  LEFT JOIN public.connection_health h ON h.connection_id = p_connection_id;
  IF v_org IS NOT NULL AND v_org <> p_organization_id THEN
    RAISE EXCEPTION 'record_connection_needs_reauth: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.connection_health AS h (connection_id, organization_id, needs_reauth_at, needs_reauth_cause)
  VALUES (p_connection_id, p_organization_id, v_at, p_cause)
  ON CONFLICT (connection_id) DO UPDATE SET needs_reauth_at = v_at, needs_reauth_cause = p_cause
  WHERE h.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_connection_needs_reauth: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN 'recorded';
END
$fn$;

CREATE FUNCTION public.record_connection_reauth_cleared(p_organization_id uuid, p_connection_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_at timestamptz := clock_timestamp();
  v_org uuid;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL THEN
    RAISE EXCEPTION 'record_connection_reauth_cleared: organization and connection are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id) THEN
    SELECT t.organization_id INTO v_org FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id;
    IF v_org <> p_organization_id THEN
      RAISE EXCEPTION 'record_connection_reauth_cleared: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN 'connection_removed';
  END IF;
  SELECT coalesce(c.organization_id, h.organization_id) INTO v_org
  FROM (SELECT 1) one
  LEFT JOIN public.connection_copies c ON c.connection_id = p_connection_id
  LEFT JOIN public.connection_health h ON h.connection_id = p_connection_id;
  IF v_org IS NOT NULL AND v_org <> p_organization_id THEN
    RAISE EXCEPTION 'record_connection_reauth_cleared: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.connection_health AS h (connection_id, organization_id, reauth_cleared_at)
  VALUES (p_connection_id, p_organization_id, v_at)
  ON CONFLICT (connection_id) DO UPDATE SET reauth_cleared_at = v_at
  WHERE h.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_connection_reauth_cleared: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN 'recorded';
END
$fn$;

-- ── connection_status ─────────────────────────────────────────────────────────
-- The shown status of each of one organization's connections, derived here and
-- nowhere else: needs_reauth while needs_reauth_at is after reauth_cleared_at,
-- whatever the check columns say (L53); then check_failing while the last
-- check failed; healthy after a passing one; unchecked before any. Read only;
-- at most p_limit rows, in connection order.
CREATE FUNCTION public.connection_status(p_organization_id uuid, p_limit integer)
RETURNS TABLE (connection_id uuid, service text, generation bigint, status text, last_check_ok_at timestamptz, last_check_failed_at timestamptz,
  last_check_cause text, needs_reauth_at timestamptz, needs_reauth_cause text, reauth_cleared_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'connection_status: an organization is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'connection_status: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.connection_id, c.service, c.generation,
    CASE
      WHEN h.needs_reauth_at > coalesce(h.reauth_cleared_at, '-infinity'::timestamptz) THEN 'needs_reauth'
      WHEN h.last_check_failed_at > coalesce(h.last_check_ok_at, '-infinity'::timestamptz) THEN 'check_failing'
      WHEN h.last_check_ok_at IS NOT NULL THEN 'healthy'
      ELSE 'unchecked'
    END,
    h.last_check_ok_at, h.last_check_failed_at, h.last_check_cause, h.needs_reauth_at, h.needs_reauth_cause, h.reauth_cleared_at
  FROM public.connection_copies c
  LEFT JOIN public.connection_health h ON h.connection_id = c.connection_id AND h.organization_id = c.organization_id
  WHERE c.organization_id = p_organization_id AND c.withdrawn_at IS NULL
  ORDER BY c.connection_id
  LIMIT p_limit;
END
$fn$;

-- ── record_measured_identity ──────────────────────────────────────────────────
-- Written only by verify, from userinfo. recorded the first time for a
-- connection and generation, confirmed on a repeat of the same org, and
-- identity_changed, writing nothing, when the same generation measures another
-- org: the measured row is never overwritten (the credential has not changed,
-- so something else has, and a person must look).
CREATE FUNCTION public.record_measured_identity(p_organization_id uuid, p_connection_id uuid, p_generation bigint, p_sf_org_id text, p_username text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_old public.connection_measured_identity%ROWTYPE;
  v_org uuid;
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
  SELECT * INTO v_old FROM public.connection_measured_identity m WHERE m.connection_id = p_connection_id AND m.generation = p_generation;
  IF v_old.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'record_measured_identity: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_old.sf_org_id <> p_sf_org_id OR v_old.username <> p_username THEN RETURN 'identity_changed'; END IF;
  RETURN 'confirmed';
END
$fn$;

-- ── acquire_sf_lease ──────────────────────────────────────────────────────────
-- One Salesforce call's slot. p_purpose is step (with its workflow), lookup,
-- verify, reconnect, connection_check or sf_limits; a step's share is its
-- workflow's, every other purpose's share is the purpose's own, each up to the
-- org's workflow_share. p_bootstrap_host, the declared instance_url host, is
-- taken only by verify and used only while the connection has no measured
-- row (see THE BOOTSTRAP in the header). Answers one row:
--   granted               lease_id and expires_at; pool is org or bootstrap
--   pool_full             retry_at is when the soonest lease in the pool lapses
--   workflow_share_full   retry_at likewise, within the share
--   sf_budget_floor       the latest reading is under the org's floor; retry_at is when the next reading is due
--   sf_budget_unmeasured  no reading, or one older than 15 minutes
--   sf_org_unmeasured     no measured row for this connection and generation, and not a bootstrap verify
--   sf_cap_unset          no approved cap for the org (or for the host, on the bootstrap path)
-- Under the pool's advisory lock, the pool and the share are counted and the
-- lease inserted in one statement (L117). A lease that lapsed stops counting at
-- once, whether or not the sweep has deleted it (L409). The same holder asking
-- again gets the lease it already holds.
CREATE FUNCTION public.acquire_sf_lease(
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
    -- Nothing measured: only verify's own userinfo call, against its declared host's approved slot.
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
           AND l.purpose = p_purpose AND l.workflow_id IS NOT DISTINCT FROM p_workflow_id) < v_cap.workflow_share
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
  RETURN QUERY SELECT 'workflow_share_full'::text, NULL::uuid, NULL::timestamptz,
    (SELECT min(l.expires_at) FROM public.sf_leases l WHERE l.sf_org_id = v_measured.sf_org_id AND l.expires_at > v_now
       AND l.purpose = p_purpose AND l.workflow_id IS NOT DISTINCT FROM p_workflow_id), 'org'::text;
END
$fn$;

-- ── release_sf_lease ──────────────────────────────────────────────────────────
-- Idempotent by holder: released, or not_held when it holds nothing (already
-- released, or swept). Run in a finally after every call.
CREATE FUNCTION public.release_sf_lease(p_organization_id uuid, p_holder text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_org uuid;
BEGIN
  IF p_organization_id IS NULL OR p_holder IS NULL THEN
    RAISE EXCEPTION 'release_sf_lease: organization and holder are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT l.organization_id INTO v_org FROM public.sf_leases l WHERE l.holder = p_holder FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_held'; END IF;
  IF v_org <> p_organization_id THEN
    RAISE EXCEPTION 'release_sf_lease: holder % belongs to another organization', p_holder USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.sf_leases l WHERE l.holder = p_holder;
  RETURN 'released';
END
$fn$;

-- ── sweep_sf_leases ───────────────────────────────────────────────────────────
-- Deletes leases whose holder died without releasing them. They stopped
-- counting when they lapsed; this only keeps the table small.
CREATE FUNCTION public.sweep_sf_leases(p_limit integer)
RETURNS TABLE (swept integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_swept integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'sweep_sf_leases: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH lapsed AS (
    SELECT l.id FROM public.sf_leases l
    WHERE l.expires_at <= now()
    ORDER BY l.expires_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.sf_leases l USING lapsed WHERE l.id = lapsed.id;
  GET DIAGNOSTICS v_swept = ROW_COUNT;
  RETURN QUERY SELECT v_swept, v_swept = p_limit;
END
$fn$;

-- ── record_sf_budget_reading ──────────────────────────────────────────────────
-- The org's daily API allocation and what is left of it, from a /limits read
-- (the sf_limits sweep) or a response's Sforce-Limit-Info header. One row per
-- org, the latest; measured_at is the database's clock.
CREATE FUNCTION public.record_sf_budget_reading(p_sf_org_id text, p_daily_api_max integer, p_daily_api_remaining integer, p_source text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_at timestamptz := clock_timestamp();
BEGIN
  IF p_sf_org_id IS NULL OR p_sf_org_id !~ '^00D[A-Za-z0-9]{15}$' THEN
    RAISE EXCEPTION 'record_sf_budget_reading: % is not an 18 character Salesforce org id', p_sf_org_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_daily_api_max IS NULL OR p_daily_api_max < 1 OR p_daily_api_remaining IS NULL THEN
    RAISE EXCEPTION 'record_sf_budget_reading: a positive allocation and a remaining count are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('limits', 'sforce_limit_info') THEN
    RAISE EXCEPTION 'record_sf_budget_reading: % is not a reading source', p_source USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.sf_budget_readings AS r (sf_org_id, daily_api_max, daily_api_remaining, source, measured_at)
  VALUES (p_sf_org_id, p_daily_api_max, p_daily_api_remaining, p_source, v_at)
  ON CONFLICT (sf_org_id) DO UPDATE
  SET daily_api_max = excluded.daily_api_max, daily_api_remaining = excluded.daily_api_remaining, source = excluded.source, measured_at = excluded.measured_at
  WHERE excluded.measured_at >= r.measured_at;
  RETURN 'recorded';
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'claim_ops_sweep', 'save_connection_copies', 'connection_copy', 'record_connection_tombstone', 'purge_expired_connection_tombstones',
      'record_connection_check', 'record_connection_needs_reauth', 'record_connection_reauth_cleared', 'connection_status',
      'record_measured_identity', 'acquire_sf_lease', 'release_sf_lease', 'sweep_sf_leases', 'record_sf_budget_reading')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

RESET lock_timeout;
