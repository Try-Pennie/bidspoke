-- Versioned partner saves (#2132, part of #2114).
--
-- Until now a partner save sent the whole form and the Worker wrote every field
-- in it, so a save made on top of someone else's newer save silently put their
-- change back the way it was. This gives partner_configs a version that every
-- writer moves, and one function that writes only the fields a save names, and
-- refuses by name when the version it was made from is no longer the stored one.
--
-- 1. partner_configs.version, moved by a BEFORE UPDATE row trigger whenever any
--    column outside partner_configs_unversioned_columns() changes. The trigger,
--    not the caller, owns it, so the API, rename_partner_step_namespace and hand
--    run SQL all move it, and a hand UPDATE cannot set it to anything else.
-- 2. partner_configs_unversioned_columns(): the one list of bookkeeping columns.
--    The audit trigger now reads its excluded list from it, so audit and
--    versioning agree on what a change is, and a new column is versioned and
--    audited by default (L657).
-- 3. last_save_id on partner_configs and buyer_profiles (L747): the id of the
--    save press that last wrote the row, so a retry of a press whose answer was
--    lost can tell its own landed save from someone else's.
-- 4. The audit row names its actor as of the write (L37): _actor { name, email }
--    read from users for the resolved actor id, falling back to the
--    bidspoke.actor_name and bidspoke.actor_email settings when the users row is
--    missing. Never from NEW.updated_by_name: rename_partner_step_namespace sets
--    neither that column nor bidspoke.actor_name, so the column still holds the
--    previous editor's name on a rename caused row.
-- 5. buyer_profiles.version moves for writes outside save_buyer_profile: one
--    statement level trigger per event on buyer_profiles and its three child
--    tables (Postgres refuses transition tables on a multi event trigger).
-- 6. save_partner_config, the Worker's only partner UPDATE (service role only).
--
-- Expand only: two nullable or defaulted columns, new functions and triggers,
-- and two trigger functions replaced with their behaviour kept. The release
-- before reads neither new column and never calls the new function.

-- ── Columns ──────────────────────────────────────────────────────────────────

ALTER TABLE public.partner_configs ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE public.partner_configs ADD COLUMN IF NOT EXISTS last_save_id uuid NULL;
ALTER TABLE public.buyer_profiles ADD COLUMN IF NOT EXISTS last_save_id uuid NULL;

COMMENT ON COLUMN public.partner_configs.version IS
  'Moved by the partner_configs_bump_version trigger on every change to a column outside partner_configs_unversioned_columns() (#2132). save_partner_config refuses a save made from any other version.';
COMMENT ON COLUMN public.partner_configs.last_save_id IS
  'The save press that last wrote this row through save_partner_config (#2132), so a retried press can recognise its own landed save.';
COMMENT ON COLUMN public.buyer_profiles.last_save_id IS
  'The save press that last wrote this profile (#2132). Written by the one page save from #2114 PR2 on; null until then.';

-- ── The one list of bookkeeping columns ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_configs_unversioned_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT ARRAY['updated_at', 'updated_by', 'updated_by_email', 'updated_by_name', 'last_probe_response', 'version', 'last_save_id']
$$;
COMMENT ON FUNCTION public.partner_configs_unversioned_columns() IS
  'The partner_configs columns that are bookkeeping about a change rather than the change (#2132): neither audited nor versioned. Every other column is both, by default.';
REVOKE ALL ON FUNCTION public.partner_configs_unversioned_columns() FROM PUBLIC, anon, authenticated;
-- The audit and version triggers call it as whoever wrote the row, and the
-- Worker writes as service_role.
GRANT EXECUTE ON FUNCTION public.partner_configs_unversioned_columns() TO service_role;

-- ── The version trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_configs_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_unversioned text[] := public.partner_configs_unversioned_columns();
BEGIN
  IF (to_jsonb(NEW) - v_unversioned) IS DISTINCT FROM (to_jsonb(OLD) - v_unversioned) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.partner_configs_bump_version() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS partner_configs_bump_version ON public.partner_configs;
CREATE TRIGGER partner_configs_bump_version
  BEFORE UPDATE ON public.partner_configs
  FOR EACH ROW EXECUTE FUNCTION public.partner_configs_bump_version();

-- ── The audit trigger: the shared list, and the actor named at write time ────
-- As in 20260921221008, with two changes: the excluded list is
-- partner_configs_unversioned_columns(), and a row whose actor is resolved
-- carries _actor { name, email } as of this write.

CREATE OR REPLACE FUNCTION public.partner_configs_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_excluded text[] := public.partner_configs_unversioned_columns();
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_changes jsonb;
  v_actor uuid;
  v_actor_name text;
  v_actor_email text;
  v_reason text;
  v_context jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(keys.k, jsonb_build_object('old', v_old -> keys.k, 'new', v_new -> keys.k)), '{}'::jsonb)
  INTO v_changes
  FROM (
    SELECT DISTINCT x.k FROM (
      SELECT jsonb_object_keys(coalesce(v_old, '{}'::jsonb)) AS k
      UNION ALL
      SELECT jsonb_object_keys(coalesce(v_new, '{}'::jsonb))
    ) x
  ) keys
  WHERE keys.k <> ALL (v_excluded)
    AND coalesce(v_old -> keys.k, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new -> keys.k, 'null'::jsonb);

  IF v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  v_actor := nullif(current_setting('bidspoke.actor_id', true), '')::uuid;
  IF v_actor IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_actor := NEW.updated_by;
    ELSIF TG_OP = 'UPDATE' THEN
      v_actor := nullif(current_setting('bidspoke.updated_by_actor', true), '')::uuid;
    END IF;
  END IF;
  IF v_actor IS NULL THEN
    v_changes := v_changes || jsonb_build_object('_source', 'direct_sql');
  ELSE
    -- The name and address of THIS write's actor, as they are now (L37). Never
    -- NEW.updated_by_name, which a rename leaves holding the previous editor.
    SELECT u.display_name, u.email INTO v_actor_name, v_actor_email FROM public.users u WHERE u.id = v_actor;
    IF NOT FOUND THEN
      v_actor_name := nullif(current_setting('bidspoke.actor_name', true), '');
      v_actor_email := nullif(current_setting('bidspoke.actor_email', true), '');
    END IF;
    v_changes := v_changes || jsonb_build_object('_actor', jsonb_build_object('name', v_actor_name, 'email', v_actor_email));
  END IF;

  v_reason := nullif(current_setting('bidspoke.audit_reason', true), '');
  IF v_reason IS NOT NULL THEN
    v_changes := v_changes || jsonb_build_object('reason', v_reason);
  END IF;
  v_context := nullif(current_setting('bidspoke.audit_context', true), '')::jsonb;
  IF v_context IS NOT NULL AND jsonb_typeof(v_context) = 'object' THEN
    v_changes := v_changes || (v_context - 'reason');
  END IF;

  INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES (
    coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id')::uuid,
    'partner_config',
    coalesce(v_new ->> 'id', v_old ->> 'id')::uuid,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
    v_actor,
    v_changes
  );

  -- The captured updated_by belongs to this statement only.
  PERFORM set_config('bidspoke.updated_by_actor', '', true);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.partner_configs_audit() FROM PUBLIC, anon, authenticated;

-- ── Profile tables: the direct SQL detector learns the version bump ──────────
-- As in 20260921221008, with 'buyer_profile_version_bump' on the skip list, so
-- the bump's own UPDATE of buyer_profiles is not reported as a second hand write.

CREATE OR REPLACE FUNCTION public.buyer_profile_tables_direct_sql_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_handled text := nullif(current_setting('bidspoke.audit_handled', true), '');
  v_action text := CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END;
BEGIN
  IF v_handled IN ('save_buyer_profile', 'delete_partner_config', 'buyer_profile_version_bump') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    FOR r IN SELECT partner_id, organization_id, count(*) AS n FROM old_rows GROUP BY 1, 2 LOOP
      INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
      VALUES (r.organization_id, 'buyer_profile', r.partner_id, v_action, NULL,
              jsonb_build_object('_source', 'direct_sql', 'table', TG_TABLE_NAME, 'op', TG_OP, 'rows', r.n));
    END LOOP;
  ELSE
    FOR r IN SELECT partner_id, organization_id, count(*) AS n FROM new_rows GROUP BY 1, 2 LOOP
      INSERT INTO public.audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
      VALUES (r.organization_id, 'buyer_profile', r.partner_id, v_action, NULL,
              jsonb_build_object('_source', 'direct_sql', 'table', TG_TABLE_NAME, 'op', TG_OP, 'rows', r.n));
    END LOOP;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_tables_direct_sql_audit() FROM PUBLIC, anon, authenticated;

-- ── Profile tables: the version moves for a write outside save_buyer_profile ──
-- save_buyer_profile and delete_partner_config announce themselves through
-- bidspoke.audit_handled and move (or remove) the version themselves, so any
-- statement made while it is set is theirs. The bump's own UPDATE runs with the
-- setting set to 'buyer_profile_version_bump' (so neither this trigger nor the
-- detector above reads it as another hand write) and puts the previous value
-- back afterwards, so a second hand statement in the same transaction is still
-- seen. pg_trigger_depth() > 1 returns at once for anything a trigger wrote.

CREATE OR REPLACE FUNCTION public.buyer_profile_tables_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_prev text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  v_prev := current_setting('bidspoke.audit_handled', true);
  IF nullif(v_prev, '') IS NOT NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('bidspoke.audit_handled', 'buyer_profile_version_bump', true);
  IF TG_OP = 'DELETE' THEN
    UPDATE public.buyer_profiles SET version = version + 1 WHERE partner_id IN (SELECT DISTINCT partner_id FROM old_rows);
  ELSE
    UPDATE public.buyer_profiles SET version = version + 1 WHERE partner_id IN (SELECT DISTINCT partner_id FROM new_rows);
  END IF;
  PERFORM set_config('bidspoke.audit_handled', coalesce(v_prev, ''), true);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_tables_bump_version() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS buyer_profiles_bump_version_ins ON public.buyer_profiles;
DROP TRIGGER IF EXISTS buyer_profiles_bump_version_upd ON public.buyer_profiles;
DROP TRIGGER IF EXISTS buyer_operating_windows_bump_version_ins ON public.buyer_operating_windows;
DROP TRIGGER IF EXISTS buyer_operating_windows_bump_version_upd ON public.buyer_operating_windows;
DROP TRIGGER IF EXISTS buyer_operating_windows_bump_version_del ON public.buyer_operating_windows;
DROP TRIGGER IF EXISTS buyer_blackout_dates_bump_version_ins ON public.buyer_blackout_dates;
DROP TRIGGER IF EXISTS buyer_blackout_dates_bump_version_upd ON public.buyer_blackout_dates;
DROP TRIGGER IF EXISTS buyer_blackout_dates_bump_version_del ON public.buyer_blackout_dates;
DROP TRIGGER IF EXISTS buyer_pricing_tiers_bump_version_ins ON public.buyer_pricing_tiers;
DROP TRIGGER IF EXISTS buyer_pricing_tiers_bump_version_upd ON public.buyer_pricing_tiers;
DROP TRIGGER IF EXISTS buyer_pricing_tiers_bump_version_del ON public.buyer_pricing_tiers;

-- A hand INSERT of a profile row moves its own version too (it then starts one
-- above where save_buyer_profile would have started it, which is harmless: the
-- version only has to differ). A DELETE of the profile row leaves no row to move.
CREATE TRIGGER buyer_profiles_bump_version_ins AFTER INSERT ON public.buyer_profiles
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();
CREATE TRIGGER buyer_profiles_bump_version_upd AFTER UPDATE ON public.buyer_profiles
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();

CREATE TRIGGER buyer_operating_windows_bump_version_ins AFTER INSERT ON public.buyer_operating_windows
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();
CREATE TRIGGER buyer_operating_windows_bump_version_upd AFTER UPDATE ON public.buyer_operating_windows
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();
CREATE TRIGGER buyer_operating_windows_bump_version_del AFTER DELETE ON public.buyer_operating_windows
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();

CREATE TRIGGER buyer_blackout_dates_bump_version_ins AFTER INSERT ON public.buyer_blackout_dates
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();
CREATE TRIGGER buyer_blackout_dates_bump_version_upd AFTER UPDATE ON public.buyer_blackout_dates
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();
CREATE TRIGGER buyer_blackout_dates_bump_version_del AFTER DELETE ON public.buyer_blackout_dates
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();

CREATE TRIGGER buyer_pricing_tiers_bump_version_ins AFTER INSERT ON public.buyer_pricing_tiers
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();
CREATE TRIGGER buyer_pricing_tiers_bump_version_upd AFTER UPDATE ON public.buyer_pricing_tiers
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();
CREATE TRIGGER buyer_pricing_tiers_bump_version_del AFTER DELETE ON public.buyer_pricing_tiers
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.buyer_profile_tables_bump_version();

-- ── save_partner_config ──────────────────────────────────────────────────────
-- The Worker's only partner UPDATE. Locks the row, refuses a save made from a
-- version that is no longer stored (BP409, DETAIL the current row, its
-- last_save_id and the last editor), writes only the keys the patch names and
-- refuses any key outside the editable list by name (BP422), so a save that
-- omits a field leaves it exactly as stored.

CREATE OR REPLACE FUNCTION public.save_partner_config(
  p_org uuid,
  p_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_save_id uuid,
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
  -- The fields a partner save may write: the PUT route's list before #2132.
  v_editable text[] := ARRAY[
    'name', 'api_endpoint', 'cf_secret_key', 'daily_cap', 'min_bid',
    'bid_formula', 'bid_resolver_type', 'bid_resolver_config', 'outbound_field_mapping',
    'bid_mode', 'bid_comparison_source', 'extra_extraction', 'last_probe_response',
    'dedup_endpoint', 'response_classification', 'accept_signals', 'duplicate_signals', 'external_routing_code', 'alert_config',
    'circuit_error_threshold', 'circuit_window_seconds', 'circuit_cooldown_seconds',
    'circuit_enabled', 'confirmation_window_ms', 'is_active', 'priority',
    'sell_off_offer_title', 'sell_off_offer_details',
    'click_url', 'partner_type', 'sub_account_min_bids'
  ];
  v_row public.partner_configs%ROWTYPE;
  v_key text;
  v_sets text := '';
  v_last_name text;
  v_last_at timestamptz;
  v_out jsonb;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch_not_object' USING ERRCODE = 'BP422';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'expected_version_invalid' USING ERRCODE = 'BP422';
  END IF;

  SELECT * INTO v_row FROM partner_configs WHERE id = p_id AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.version IS DISTINCT FROM p_expected_version THEN
    -- The last editor: the newest audit row's actor by name, falling back to the
    -- name it stamped at the time. A hand write has neither, and says so.
    SELECT coalesce(u.display_name, a.changes -> '_actor' ->> 'name'), a.changed_at
    INTO v_last_name, v_last_at
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.changed_by
    WHERE a.organization_id = p_org AND a.entity_type = 'partner_config' AND a.entity_id = p_id
    ORDER BY a.changed_at DESC
    LIMIT 1;
    RAISE EXCEPTION 'stale_version' USING ERRCODE = 'BP409',
      DETAIL = jsonb_build_object(
        'current', to_jsonb(v_row),
        'last_save_id', v_row.last_save_id,
        'changed_by_name', v_last_name,
        'changed_at', coalesce(v_last_at, v_row.updated_at)
      )::text;
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (v_key = ANY (v_editable)) THEN
      RAISE EXCEPTION 'field_not_editable' USING ERRCODE = 'BP422', DETAIL = v_key;
    END IF;
    v_sets := v_sets || format('%I = r.%I, ', v_key, v_key);
  END LOOP;

  PERFORM set_config('bidspoke.actor_id', coalesce(p_actor::text, ''), true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.actor_name', coalesce(p_actor_name, ''), true);

  -- Each value is typed by the column through jsonb_populate_record, so a JSON
  -- null clears a column and a value of the wrong type is refused by Postgres.
  EXECUTE format(
    'UPDATE public.partner_configs p SET %s updated_by = $3, updated_by_email = $4, updated_by_name = nullif($5, ''''), last_save_id = $6
       FROM jsonb_populate_record(NULL::public.partner_configs, $1) r
      WHERE p.id = $2 AND p.organization_id = $7
      RETURNING to_jsonb(p.*)',
    v_sets
  )
  INTO v_out
  USING p_patch, p_id, p_actor, p_actor_email, p_actor_name, p_save_id, p_org;

  RETURN v_out;
END
$$;
COMMENT ON FUNCTION public.save_partner_config(uuid, uuid, integer, jsonb, uuid, uuid, text, text) IS
  'The partner save (#2132): writes only the keys in p_patch, from the editable list, when the stored version is p_expected_version, and records p_save_id. Refuses stale_version (BP409, DETAIL a JSON object: current row, last_save_id, changed_by_name, changed_at), field_not_editable (BP422, DETAIL the key), patch_not_object and expected_version_invalid (BP422), partner_not_found (P0002). Returns the row.';
REVOKE ALL ON FUNCTION public.save_partner_config(uuid, uuid, integer, jsonb, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_partner_config(uuid, uuid, integer, jsonb, uuid, uuid, text, text) TO service_role;
