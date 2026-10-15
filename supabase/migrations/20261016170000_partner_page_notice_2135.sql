-- The partners page hears about another person's save (#2135, PR4 of #2114).
--
-- PR0 (#2131, docs/adr/0012) proved the database sender on production: a
-- realtime.send from a trigger reaches every browser of the organization on the
-- private topic partners:<organization id>, and no browser of another. This
-- migration is that sender, plus what the delivery monitor and the sub-account
-- ID writes need.
--
-- 1. organizations.is_synthetic: the one predicate (L261) that marks the
--    delivery monitor's organization, so every job listing partners or buyer
--    profiles across organizations can skip it.
-- 2. partner_page_notice_tables(): the one list of the tables the page shows.
--    supabase/tests/partner_page_notice.test.sql asserts each carries the three
--    notice triggers (and the version trigger where it has one), and that every
--    other table keyed to a partner is on a written exclusion list.
-- 3. notify_partner_page: builds the notice and calls realtime.send. The payload
--    carries ids, versions, column names and whether the change had no actor,
--    never a field value. A failure of any kind is turned into a WARNING, so a
--    notice can never fail the save it describes (a missing realtime.messages
--    partition already is, inside realtime.send).
-- 4. Three AFTER STATEMENT triggers per page table (Postgres refuses transition
--    tables on a multi event trigger), sending once per partner per statement,
--    only when a version moved, a partner or profile came or went, or (for
--    partner_uuid_map, which has no version) a row changed. A change to
--    last_probe_response alone moves no version and sends nothing.
-- 5. save_partner_page gains p_client_id (a new overload; the ten argument one
--    calls it with NULL, so the release before keeps working) and sends the one
--    notice for the whole save at its end. Its statements run under
--    bidspoke.audit_handled = 'save_partner_page', which keeps the triggers quiet.
-- 6. change_partner_uuid: the sub-account ID add and remove in one RPC that sets
--    bidspoke.actor_* first, because a trigger cannot see who made a single
--    PostgREST insert or delete. A notice from partner_uuid_map is therefore
--    direct (no actor) only for a hand run SQL write.
-- 7. monitor_partner_page_ping: the delivery monitor's send. It calls
--    notify_partner_page for a synthetic organization only, so the monitor adds
--    no audit row and moves no version every five minutes, and it reports
--    whether today's and tomorrow's realtime.messages partitions exist.
-- 8. partner_page_live_misses: what a page posts when its versions probe finds
--    a save it was not told about, the data the miss threshold will be set from
--    (#2135 ships no threshold; the activating issue is filed with it, L65).
--
-- Expand only (docs/adr/0007): one defaulted column, one table, new functions
-- and triggers, one new overload, and two functions replaced with their
-- signatures kept: the ten argument save_partner_page, now a SQL wrapper that
-- calls the eleven argument overload with p_client_id NULL (the same save, plus
-- the one notice), and partner_configs_capture_actor, which also keeps a copy of
-- the statement's editor for the notice trigger.

-- ── 1. The synthetic organization predicate ─────────────────────────────────

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.organizations.is_synthetic IS
  'True only for an organization that exists to be measured, such as the partners page delivery monitor''s (#2135). Every job that lists partners or buyer profiles across organizations skips one; monitor_partner_page_ping refuses any other.';

-- ── 2. The page tables ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_page_notice_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT ARRAY['partner_configs', 'buyer_profiles', 'buyer_operating_windows', 'buyer_blackout_dates', 'buyer_pricing_tiers', 'partner_uuid_map']
$$;
COMMENT ON FUNCTION public.partner_page_notice_tables() IS
  'The tables the partners page shows (#2135). Each carries an INSERT, an UPDATE and a DELETE notice trigger; partner_page_notice.test.sql holds the list against pg_trigger and against every other table keyed to a partner.';
REVOKE ALL ON FUNCTION public.partner_page_notice_tables() FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. The sender ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_partner_page(
  p_org uuid,
  p_partner_id uuid,
  p_kind text,
  p_changed_columns text[],
  p_direct boolean,
  p_save_id uuid,
  p_client_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_partner_version integer;
  v_profile_version integer;
BEGIN
  BEGIN
    -- The versions as they stand when the notice is sent, so a page compares
    -- them with the pair it holds. Null when the partner (or its profile) is gone.
    SELECT version INTO v_partner_version FROM partner_configs WHERE id = p_partner_id AND organization_id = p_org;
    SELECT version INTO v_profile_version FROM buyer_profiles WHERE partner_id = p_partner_id AND organization_id = p_org;
    PERFORM realtime.send(
      jsonb_build_object(
        'partner_id', p_partner_id,
        'partner_version', v_partner_version,
        'profile_version', v_profile_version,
        'save_id', p_save_id,
        'client_id', p_client_id,
        'kind', p_kind,
        'changed_columns', to_jsonb(p_changed_columns),
        'direct', coalesce(p_direct, false)
      ),
      'partner_changed',
      'partners:' || p_org::text,
      true
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never fail the write this notice describes. The delivery monitor is what
    -- finds a channel that stopped working.
    RAISE WARNING 'PartnerPageNoticeFailed: % (partner %, kind %)', SQLERRM, p_partner_id, p_kind;
  END;
END
$$;
COMMENT ON FUNCTION public.notify_partner_page(uuid, uuid, text, text[], boolean, uuid, uuid) IS
  'Sends one partners page notice (#2135) on the private topic partners:<p_org>, event partner_changed: partner_id, partner_version, profile_version, save_id, client_id, kind, changed_columns, direct. No field values. Any failure becomes a WARNING. Called by the page table triggers, save_partner_page and monitor_partner_page_ping only.';
REVOKE ALL ON FUNCTION public.notify_partner_page(uuid, uuid, text, text[], boolean, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ── 4a. partner_configs ──────────────────────────────────────────────────────
-- Who made an UPDATE is known to the row triggers only (the statement's SET
-- list), and the audit trigger clears its copy per row. The capture trigger now
-- also keeps a copy for the notice trigger, which clears it once read.

CREATE OR REPLACE FUNCTION public.partner_configs_capture_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Fires only when the statement set updated_by. Cleared by the audit trigger.
  PERFORM set_config('bidspoke.updated_by_actor', coalesce(NEW.updated_by::text, ''), true);
  -- The statement's copy for the page notice (#2135), cleared by its trigger.
  PERFORM set_config('bidspoke.notice_updated_by', coalesce(NEW.updated_by::text, ''), true);
  RETURN NEW;
END
$$;
-- A trigger function; it never had its default grant taken away (#2135).
REVOKE ALL ON FUNCTION public.partner_configs_capture_actor() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.partner_configs_page_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  v_unversioned text[] := public.partner_configs_unversioned_columns();
  v_actor text := nullif(current_setting('bidspoke.actor_id', true), '');
  v_set_actor text := nullif(current_setting('bidspoke.notice_updated_by', true), '');
  v_columns text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM set_config('bidspoke.notice_updated_by', '', true);
  END IF;
  -- The page save sends its own one notice at its end.
  IF current_setting('bidspoke.audit_handled', true) = 'save_partner_page' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n.organization_id, n.id, to_jsonb(n) AS nj, to_jsonb(o) AS oj, n.last_save_id AS new_save, o.last_save_id AS old_save
      FROM new_rows n JOIN old_rows o ON o.id = n.id
      WHERE n.version IS DISTINCT FROM o.version
    LOOP
      SELECT coalesce(array_agg(k ORDER BY k), '{}') INTO v_columns
      FROM jsonb_object_keys(r.nj) k
      WHERE k <> ALL (v_unversioned) AND (r.nj -> k) IS DISTINCT FROM (r.oj -> k);
      PERFORM notify_partner_page(r.organization_id, r.id, 'partner', v_columns,
        v_actor IS NULL AND v_set_actor IS NULL,
        CASE WHEN r.new_save IS DISTINCT FROM r.old_save THEN r.new_save END, NULL);
    END LOOP;
  ELSIF TG_OP = 'INSERT' THEN
    FOR r IN SELECT organization_id, id, updated_by FROM new_rows LOOP
      PERFORM notify_partner_page(r.organization_id, r.id, 'created', NULL, v_actor IS NULL AND r.updated_by IS NULL, NULL, NULL);
    END LOOP;
  ELSE
    FOR r IN SELECT organization_id, id FROM old_rows LOOP
      PERFORM notify_partner_page(r.organization_id, r.id, 'deleted', NULL, v_actor IS NULL, NULL, NULL);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.partner_configs_page_notice() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS partner_configs_page_notice_ins ON public.partner_configs;
DROP TRIGGER IF EXISTS partner_configs_page_notice_upd ON public.partner_configs;
DROP TRIGGER IF EXISTS partner_configs_page_notice_del ON public.partner_configs;
CREATE TRIGGER partner_configs_page_notice_ins AFTER INSERT ON public.partner_configs
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.partner_configs_page_notice();
CREATE TRIGGER partner_configs_page_notice_upd AFTER UPDATE ON public.partner_configs
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.partner_configs_page_notice();
CREATE TRIGGER partner_configs_page_notice_del AFTER DELETE ON public.partner_configs
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.partner_configs_page_notice();

-- ── 4b. buyer_profiles and its three child tables ────────────────────────────
-- Which statement moved the profile version decides who sends:
--  - a hand write (bidspoke.audit_handled unset): the bump trigger has already
--    moved the version (its triggers are named so they fire first, and the
--    suite asserts the version in the notice is the moved one), so this sends,
--    direct unless bidspoke.actor_id is set;
--  - save_buyer_profile: its own UPDATE of buyer_profiles.version sends; the
--    child rows it rewrites move nothing and send nothing;
--  - save_partner_page sends one notice at its end; a partner delete sends its
--    own 'deleted', and the profile rows its cascade removes are skipped as
--    rows of a partner that no longer exists (a cascade runs at trigger depth
--    1, so depth cannot tell it from a hand write: measured in the suite);
--  - the bump trigger's own UPDATE runs under 'buyer_profile_version_bump'.

CREATE OR REPLACE FUNCTION public.buyer_profile_tables_page_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  v_handled text := nullif(current_setting('bidspoke.audit_handled', true), '');
  v_direct boolean := nullif(current_setting('bidspoke.actor_id', true), '') IS NULL;
BEGIN
  IF v_handled IN ('save_partner_page', 'buyer_profile_version_bump') THEN
    RETURN NULL;
  END IF;

  IF v_handled IS NULL THEN
    -- A hand write: every partner it touched, once.
    IF TG_OP = 'DELETE' THEN
      FOR r IN SELECT DISTINCT o.organization_id, o.partner_id FROM old_rows o
               WHERE EXISTS (SELECT 1 FROM partner_configs p WHERE p.id = o.partner_id) LOOP
        PERFORM notify_partner_page(r.organization_id, r.partner_id, 'profile', ARRAY[TG_TABLE_NAME], v_direct, NULL, NULL);
      END LOOP;
    ELSE
      FOR r IN SELECT DISTINCT organization_id, partner_id FROM new_rows LOOP
        PERFORM notify_partner_page(r.organization_id, r.partner_id, 'profile', ARRAY[TG_TABLE_NAME], v_direct, NULL, NULL);
      END LOOP;
    END IF;
    RETURN NULL;
  END IF;

  -- A function that owns the profile (save_buyer_profile): only the profile
  -- row's own creation, removal or version move is a change.
  IF TG_TABLE_NAME <> 'buyer_profiles' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR r IN
      SELECT n.organization_id, n.partner_id, n.last_save_id AS new_save, o.last_save_id AS old_save
      FROM new_rows n JOIN old_rows o ON o.partner_id = n.partner_id
      WHERE n.version IS DISTINCT FROM o.version
    LOOP
      PERFORM notify_partner_page(r.organization_id, r.partner_id, 'profile', ARRAY[TG_TABLE_NAME], false,
        CASE WHEN r.new_save IS DISTINCT FROM r.old_save THEN r.new_save END, NULL);
    END LOOP;
  ELSIF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT organization_id, partner_id FROM new_rows LOOP
      PERFORM notify_partner_page(r.organization_id, r.partner_id, 'profile', ARRAY[TG_TABLE_NAME], false, NULL, NULL);
    END LOOP;
  ELSE
    FOR r IN SELECT DISTINCT o.organization_id, o.partner_id FROM old_rows o
               WHERE EXISTS (SELECT 1 FROM partner_configs p WHERE p.id = o.partner_id) LOOP
      PERFORM notify_partner_page(r.organization_id, r.partner_id, 'profile', ARRAY[TG_TABLE_NAME], false, NULL, NULL);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_tables_page_notice() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS buyer_profiles_page_notice_ins ON public.buyer_profiles;
DROP TRIGGER IF EXISTS buyer_profiles_page_notice_upd ON public.buyer_profiles;
DROP TRIGGER IF EXISTS buyer_profiles_page_notice_del ON public.buyer_profiles;
CREATE TRIGGER buyer_profiles_page_notice_ins AFTER INSERT ON public.buyer_profiles
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_profiles_page_notice_upd AFTER UPDATE ON public.buyer_profiles
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_profiles_page_notice_del AFTER DELETE ON public.buyer_profiles
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();

DROP TRIGGER IF EXISTS buyer_operating_windows_page_notice_ins ON public.buyer_operating_windows;
DROP TRIGGER IF EXISTS buyer_operating_windows_page_notice_upd ON public.buyer_operating_windows;
DROP TRIGGER IF EXISTS buyer_operating_windows_page_notice_del ON public.buyer_operating_windows;
CREATE TRIGGER buyer_operating_windows_page_notice_ins AFTER INSERT ON public.buyer_operating_windows
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_operating_windows_page_notice_upd AFTER UPDATE ON public.buyer_operating_windows
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_operating_windows_page_notice_del AFTER DELETE ON public.buyer_operating_windows
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();

DROP TRIGGER IF EXISTS buyer_blackout_dates_page_notice_ins ON public.buyer_blackout_dates;
DROP TRIGGER IF EXISTS buyer_blackout_dates_page_notice_upd ON public.buyer_blackout_dates;
DROP TRIGGER IF EXISTS buyer_blackout_dates_page_notice_del ON public.buyer_blackout_dates;
CREATE TRIGGER buyer_blackout_dates_page_notice_ins AFTER INSERT ON public.buyer_blackout_dates
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_blackout_dates_page_notice_upd AFTER UPDATE ON public.buyer_blackout_dates
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_blackout_dates_page_notice_del AFTER DELETE ON public.buyer_blackout_dates
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();

DROP TRIGGER IF EXISTS buyer_pricing_tiers_page_notice_ins ON public.buyer_pricing_tiers;
DROP TRIGGER IF EXISTS buyer_pricing_tiers_page_notice_upd ON public.buyer_pricing_tiers;
DROP TRIGGER IF EXISTS buyer_pricing_tiers_page_notice_del ON public.buyer_pricing_tiers;
CREATE TRIGGER buyer_pricing_tiers_page_notice_ins AFTER INSERT ON public.buyer_pricing_tiers
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_pricing_tiers_page_notice_upd AFTER UPDATE ON public.buyer_pricing_tiers
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();
CREATE TRIGGER buyer_pricing_tiers_page_notice_del AFTER DELETE ON public.buyer_pricing_tiers
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_page_notice();

-- ── 4c. partner_uuid_map ─────────────────────────────────────────────────────
-- No version: any row changed is a change. The slug resolves to a partner of the
-- same organization; a mapping whose slug names no partner has no page to tell.

CREATE OR REPLACE FUNCTION public.partner_uuid_map_page_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  v_direct boolean := nullif(current_setting('bidspoke.actor_id', true), '') IS NULL;
BEGIN
  FOR r IN
    SELECT DISTINCT p.organization_id, p.id
    FROM (
      SELECT org_id, partner_slug FROM new_rows WHERE TG_OP IN ('INSERT', 'UPDATE')
      UNION
      SELECT org_id, partner_slug FROM old_rows WHERE TG_OP IN ('UPDATE', 'DELETE')
    ) m
    JOIN partner_configs p ON p.organization_id = m.org_id AND p.slug = m.partner_slug
  LOOP
    PERFORM notify_partner_page(r.organization_id, r.id, 'uuids', ARRAY['partner_uuid_map'], v_direct, NULL, NULL);
  END LOOP;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.partner_uuid_map_page_notice() FROM PUBLIC, anon, authenticated, service_role;

-- A transition table named in the body must exist for every event, so each
-- trigger names both where Postgres allows it, and the INSERT and DELETE
-- triggers get a function of their own that reads only the one they have.
CREATE OR REPLACE FUNCTION public.partner_uuid_map_page_notice_one_side()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record;
  v_direct boolean := nullif(current_setting('bidspoke.actor_id', true), '') IS NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN
      SELECT DISTINCT p.organization_id, p.id FROM new_rows m
      JOIN partner_configs p ON p.organization_id = m.org_id AND p.slug = m.partner_slug
    LOOP
      PERFORM notify_partner_page(r.organization_id, r.id, 'uuids', ARRAY['partner_uuid_map'], v_direct, NULL, NULL);
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT p.organization_id, p.id FROM old_rows m
      JOIN partner_configs p ON p.organization_id = m.org_id AND p.slug = m.partner_slug
    LOOP
      PERFORM notify_partner_page(r.organization_id, r.id, 'uuids', ARRAY['partner_uuid_map'], v_direct, NULL, NULL);
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.partner_uuid_map_page_notice_one_side() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS partner_uuid_map_page_notice_ins ON public.partner_uuid_map;
DROP TRIGGER IF EXISTS partner_uuid_map_page_notice_upd ON public.partner_uuid_map;
DROP TRIGGER IF EXISTS partner_uuid_map_page_notice_del ON public.partner_uuid_map;
CREATE TRIGGER partner_uuid_map_page_notice_ins AFTER INSERT ON public.partner_uuid_map
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.partner_uuid_map_page_notice_one_side();
CREATE TRIGGER partner_uuid_map_page_notice_upd AFTER UPDATE ON public.partner_uuid_map
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.partner_uuid_map_page_notice();
CREATE TRIGGER partner_uuid_map_page_notice_del AFTER DELETE ON public.partner_uuid_map
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.partner_uuid_map_page_notice_one_side();

-- ── 5. save_partner_page with the press's tab ────────────────────────────────
-- The body of 20261016000000, with p_client_id, and one notice at the end when
-- either version moved. The ten argument form calls this one with NULL.

CREATE OR REPLACE FUNCTION public.save_partner_page(
  p_org uuid,
  p_partner_id uuid,
  p_expected_partner_version integer,
  p_patch jsonb,
  p_expected_profile_version integer,
  p_profile jsonb,
  p_save_id uuid,
  p_client_id uuid,
  p_actor uuid,
  p_actor_email text,
  p_actor_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_partner public.partner_configs%ROWTYPE;
  v_profile_version integer;
  v_last_name text;
  v_last_at timestamptz;
  v_actor_name text;
  v_actor_email text;
  v_partner_out jsonb;
  v_profile_out jsonb;
  v_new_partner_version integer;
  v_new_profile_version integer;
  v_columns text[];
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch_not_object' USING ERRCODE = 'BP422';
  END IF;
  IF p_expected_partner_version IS NULL OR p_expected_partner_version < 0 THEN
    RAISE EXCEPTION 'expected_version_invalid' USING ERRCODE = 'BP422', DETAIL = 'expected_partner_version';
  END IF;
  IF p_profile IS NOT NULL AND jsonb_typeof(p_profile) <> 'object' THEN
    RAISE EXCEPTION 'profile_not_object' USING ERRCODE = 'BP422';
  END IF;
  IF (p_profile IS NOT NULL AND p_expected_profile_version IS NULL) OR p_expected_profile_version < 0 THEN
    RAISE EXCEPTION 'expected_version_invalid' USING ERRCODE = 'BP422', DETAIL = 'expected_profile_version';
  END IF;
  IF p_save_id IS NULL THEN
    RAISE EXCEPTION 'save_id_required' USING ERRCODE = 'BP422';
  END IF;

  -- The partner row, then the profile row: the order save_buyer_profile takes them in.
  SELECT * INTO v_partner FROM partner_configs WHERE id = p_partner_id AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT version INTO v_profile_version FROM buyer_profiles WHERE partner_id = p_partner_id FOR UPDATE;
  IF NOT FOUND THEN v_profile_version := 0; END IF;

  IF v_partner.version IS DISTINCT FROM p_expected_partner_version
     OR (p_expected_profile_version IS NOT NULL AND v_profile_version IS DISTINCT FROM p_expected_profile_version) THEN
    SELECT coalesce(u.display_name, a.changes -> '_actor' ->> 'name'), a.changed_at
    INTO v_last_name, v_last_at
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.changed_by
    WHERE a.organization_id = p_org AND a.entity_type IN ('partner_config', 'buyer_profile') AND a.entity_id = p_partner_id
    ORDER BY a.changed_at DESC
    LIMIT 1;
    RAISE EXCEPTION 'stale_version' USING ERRCODE = 'BP409',
      DETAIL = jsonb_build_object(
        'partner', to_jsonb(v_partner),
        'profile', buyer_profile_document(p_partner_id),
        'partner_version', v_partner.version,
        'profile_version', v_profile_version,
        'last_save_id', v_partner.last_save_id,
        'changed_by_name', v_last_name,
        'changed_at', coalesce(v_last_at, v_partner.updated_at)
      )::text;
  END IF;

  PERFORM set_config('bidspoke.audit_handled', 'save_partner_page', true);
  PERFORM set_config('bidspoke.actor_id', coalesce(p_actor::text, ''), true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.actor_name', coalesce(p_actor_name, ''), true);

  v_partner_out := save_partner_config(p_org, p_partner_id, p_expected_partner_version, p_patch, p_save_id, p_actor, p_actor_email, p_actor_name);

  IF p_profile IS NOT NULL THEN
    SELECT u.display_name, u.email INTO v_actor_name, v_actor_email FROM users u WHERE u.id = p_actor;
    v_actor_name := coalesce(nullif(v_actor_name, ''), nullif(p_actor_name, ''));
    v_actor_email := coalesce(nullif(v_actor_email, ''), nullif(p_actor_email, ''));
    PERFORM _apply_buyer_profile(p_org, p_partner_id, p_profile, p_actor, p_actor_email,
      jsonb_build_object('_actor', jsonb_build_object('name', v_actor_name, 'email', v_actor_email)));
    UPDATE buyer_profiles SET last_save_id = p_save_id WHERE partner_id = p_partner_id;
  END IF;
  v_profile_out := buyer_profile_document(p_partner_id);

  v_new_partner_version := (v_partner_out ->> 'version')::integer;
  v_new_profile_version := coalesce((v_profile_out ->> 'version')::integer, 0);

  -- One notice for the whole save (#2135), only when something moved: a save
  -- that changed nothing tells nobody anything. A new profile starts at version
  -- 1 against the 0 an absent one reads as, so its creation counts as a move.
  IF v_new_partner_version IS DISTINCT FROM v_partner.version OR v_new_profile_version IS DISTINCT FROM v_profile_version THEN
    -- The partner columns this save actually changed, not every key it sent.
    SELECT coalesce(array_agg(k ORDER BY k), '{}') INTO v_columns
    FROM jsonb_object_keys(v_partner_out) k
    WHERE k <> ALL (partner_configs_unversioned_columns()) AND (v_partner_out -> k) IS DISTINCT FROM (to_jsonb(v_partner) -> k);
    IF v_new_profile_version IS DISTINCT FROM v_profile_version THEN
      v_columns := v_columns || ARRAY['buyer_profiles'];
    END IF;
    PERFORM notify_partner_page(p_org, p_partner_id, 'page', v_columns, false, p_save_id, p_client_id);
  END IF;

  RETURN jsonb_build_object(
    'partner', v_partner_out,
    'profile', v_profile_out,
    'partner_version', v_new_partner_version,
    'profile_version', v_new_profile_version
  );
END
$$;
COMMENT ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, uuid, text, text) IS
  'The partners page save (#2133, #2135): the partner patch (through save_partner_config) and the buyer profile in one transaction, when the stored versions are the pair the page was edited from, recording p_save_id on both rows, and one partners page notice carrying p_save_id and p_client_id when either version moved. p_profile NULL saves the partner alone, and p_expected_profile_version NULL skips the profile comparison. Refuses stale_version (BP409, DETAIL a JSON object: partner, profile, partner_version, profile_version, last_save_id, changed_by_name, changed_at), every refusal of save_partner_config and of a profile save (BP422), patch_not_object, profile_not_object, expected_version_invalid and save_id_required (BP422), partner_not_found (P0002). Returns partner, profile, partner_version and profile_version.';
REVOKE ALL ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, uuid, text, text) TO service_role;

-- The ten argument form, kept for the release before this one: the same save,
-- with no tab to name.
CREATE OR REPLACE FUNCTION public.save_partner_page(
  p_org uuid,
  p_partner_id uuid,
  p_expected_partner_version integer,
  p_patch jsonb,
  p_expected_profile_version integer,
  p_profile jsonb,
  p_save_id uuid,
  p_actor uuid,
  p_actor_email text,
  p_actor_name text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT public.save_partner_page(p_org, p_partner_id, p_expected_partner_version, p_patch, p_expected_profile_version, p_profile, p_save_id, NULL::uuid, p_actor, p_actor_email, p_actor_name)
$$;
COMMENT ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text) IS
  'The partners page save as the release before #2135 calls it: the eleven argument save_partner_page with no p_client_id.';
REVOKE ALL ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text) TO service_role;

-- ── 6. change_partner_uuid ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.change_partner_uuid(
  p_org uuid,
  p_slug text,
  p_uuid text,
  p_action text,
  p_actor uuid,
  p_actor_email text,
  p_actor_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_row jsonb;
BEGIN
  IF p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'action_invalid' USING ERRCODE = 'BP422', DETAIL = coalesce(p_action, 'null');
  END IF;
  IF nullif(p_slug, '') IS NULL OR nullif(p_uuid, '') IS NULL THEN
    RAISE EXCEPTION 'slug_and_uuid_required' USING ERRCODE = 'BP422';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = 'BP422';
  END IF;

  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.actor_name', coalesce(p_actor_name, ''), true);

  IF p_action = 'add' THEN
    -- A mapping names a partner of this organization; another organization's
    -- slug is refused as no such partner.
    IF NOT EXISTS (SELECT 1 FROM partner_configs WHERE organization_id = p_org AND slug = p_slug) THEN
      RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002', DETAIL = p_slug;
    END IF;
    INSERT INTO partner_uuid_map (org_id, partner_slug, uuid)
    VALUES (p_org, p_slug, p_uuid)
    RETURNING to_jsonb(partner_uuid_map.*) INTO v_row;
  ELSE
    -- Only this organization's mapping; a mapping whose partner has since gone
    -- can still be removed.
    DELETE FROM partner_uuid_map
    WHERE org_id = p_org AND partner_slug = p_slug AND uuid = p_uuid
    RETURNING to_jsonb(partner_uuid_map.*) INTO v_row;
    IF v_row IS NULL THEN
      RAISE EXCEPTION 'uuid_not_found' USING ERRCODE = 'P0002', DETAIL = p_uuid;
    END IF;
  END IF;
  RETURN v_row;
END
$$;
COMMENT ON FUNCTION public.change_partner_uuid(uuid, text, text, text, uuid, text, text) IS
  'Adds or removes one sub-account ID mapping (#2135) with bidspoke.actor_* set first, so the partner_uuid_map triggers see who made it. add refuses a slug that names no partner of p_org (partner_not_found, P0002) and a taken uuid (23505); remove refuses a mapping p_org does not hold (uuid_not_found, P0002). action_invalid, slug_and_uuid_required, actor_required (BP422). Returns the row.';
REVOKE ALL ON FUNCTION public.change_partner_uuid(uuid, text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_partner_uuid(uuid, text, text, text, uuid, text, text) TO service_role;

-- ── 7. The delivery monitor's send ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.monitor_partner_page_ping(p_org uuid, p_save_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_synthetic boolean;
  v_partners integer;
  v_partner uuid;
  v_profiles integer;
  v_workflows integer;
  v_connections integer;
  v_env integer;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_partition_today boolean;
  v_partition_tomorrow boolean;
BEGIN
  IF p_save_id IS NULL THEN
    RAISE EXCEPTION 'save_id_required' USING ERRCODE = 'BP422';
  END IF;
  SELECT is_synthetic INTO v_synthetic FROM organizations WHERE id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_synthetic THEN
    RAISE EXCEPTION 'organization_not_synthetic' USING ERRCODE = 'BP403',
      DETAIL = 'The delivery monitor sends only to an organization marked is_synthetic.';
  END IF;

  -- The monitor org holds one source partner and nothing a job lists across
  -- organizations (#2135). Refused by name rather than sent from, so a monitor
  -- org that drifted is reported, never silently measured.
  SELECT count(*), min(id::text)::uuid INTO v_partners, v_partner FROM partner_configs WHERE organization_id = p_org;
  SELECT count(*) INTO v_profiles FROM buyer_profiles WHERE organization_id = p_org;
  SELECT count(*) INTO v_workflows FROM workflows WHERE organization_id = p_org;
  SELECT count(*) INTO v_connections FROM service_connections WHERE organization_id = p_org;
  SELECT count(*) INTO v_env FROM environment_variables WHERE organization_id = p_org;
  IF v_partners <> 1 OR v_profiles <> 0 OR v_workflows <> 0 OR v_connections <> 0 OR v_env <> 0
     OR NOT EXISTS (SELECT 1 FROM partner_configs WHERE id = v_partner AND partner_type = 'source') THEN
    RAISE EXCEPTION 'monitor_organization_misconfigured' USING ERRCODE = 'BP422',
      DETAIL = jsonb_build_object('partners', v_partners, 'source_partner', EXISTS (SELECT 1 FROM partner_configs WHERE id = v_partner AND partner_type = 'source'),
        'buyer_profiles', v_profiles, 'workflows', v_workflows, 'service_connections', v_connections, 'environment_variables', v_env)::text;
  END IF;

  -- Realtime makes a day's partition on its own schedule (ADR 0012): a send into
  -- a day without one is lost with a WARNING, which the monitor must not read as
  -- a failed channel, so it is told.
  SELECT
    EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = 'realtime.messages'::regclass AND c.relname = 'messages_' || to_char(v_today, 'YYYY_MM_DD')),
    EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = 'realtime.messages'::regclass AND c.relname = 'messages_' || to_char(v_today + 1, 'YYYY_MM_DD'))
  INTO v_partition_today, v_partition_tomorrow;

  PERFORM notify_partner_page(p_org, v_partner, 'monitor', NULL, false, p_save_id, NULL);

  RETURN jsonb_build_object(
    'partner_id', v_partner,
    'partition_today', v_partition_today,
    'partition_tomorrow', v_partition_tomorrow,
    'sent_at', clock_timestamp()
  );
END
$$;
COMMENT ON FUNCTION public.monitor_partner_page_ping(uuid, uuid) IS
  'The partners page delivery monitor''s send (#2135): one notice of kind monitor carrying p_save_id on partners:<p_org>, without writing a setting. Refuses an organization that is not is_synthetic (organization_not_synthetic, BP403), a missing one (P0002), and a monitor organization holding anything but one source partner (monitor_organization_misconfigured, BP422, DETAIL the counts). Returns partner_id, partition_today, partition_tomorrow (realtime.messages, UTC days) and sent_at.';
REVOKE ALL ON FUNCTION public.monitor_partner_page_ping(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monitor_partner_page_ping(uuid, uuid) TO service_role;

-- ── 8. Live misses ───────────────────────────────────────────────────────────
-- Volume: one row per miss a page observes while a draft is open, expected to
-- be a handful a day. No retention job: the table is the measurement the miss
-- threshold will be set from, and it is read whole for that.

CREATE TABLE IF NOT EXISTS public.partner_page_live_misses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- No foreign key: a miss on a partner deleted since is still a miss.
  partner_id uuid NOT NULL,
  reported_by uuid NULL,
  cause text NOT NULL CHECK (cause IN ('delivery', 'direct_sql')),
  noticed_partner_version integer NULL,
  noticed_profile_version integer NULL,
  observed_partner_version integer NULL,
  observed_profile_version integer NULL,
  -- How long the page had gone without a notice when the probe found the gap.
  since_last_notice_ms integer NULL CHECK (since_last_notice_ms IS NULL OR since_last_notice_ms >= 0),
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_page_live_misses_observed_idx ON public.partner_page_live_misses (observed_at DESC);
COMMENT ON TABLE public.partner_page_live_misses IS
  'A partners page that found, by its versions probe, a save it was never told about (#2135). cause direct_sql when the change had no actor (a hand run SQL write, which the database sender does tell, so still a miss), delivery otherwise. Written by POST /api/partners/live-miss; read to set the miss threshold.';
ALTER TABLE public.partner_page_live_misses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_page_live_misses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.partner_page_live_misses TO service_role;
