-- Drop partner_configs.bid_mode (#2182, the contract step after PM-9, part of #2114).
--
-- The expand half is live: since #2237 no Worker route, engine node or page
-- reads or writes bid_mode, per docs/adr/0007-expand-contract-migrations.md.
--
-- What is lost: one stored value. Production at 2026-10-16 held 10 partner
-- rows, 9 at the default 'commit' and AmOne (58d50fe7-3e86-4d71-85c7-4533ab08acb0)
-- at 'ping_only', recorded on #2182. Dan approved the drop.
--
-- Dependencies measured on production (read only, 2026-10-16): no view, index
-- or publication column list names the column; the CHECK constraint
-- partner_configs_bid_mode_check goes with the column; the only function whose
-- source names it is save_partner_config, replaced below without it, so a patch
-- naming bid_mode is refused as field_not_editable (BP422) rather than failing
-- on a missing column (42703).
--
-- save_partner_config's body is 20261015010000_partner_configs_version.sql's,
-- which production runs byte for byte (md5 1283f11d3f18fb6cf308b3258a3752c5 on
-- 2026-10-16), with 'bid_mode' removed from v_editable.

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
  -- The fields a partner save may write: the PUT route's list before #2132,
  -- less the column retired and dropped below (#2182).
  v_editable text[] := ARRAY[
    'name', 'api_endpoint', 'cf_secret_key', 'daily_cap', 'min_bid',
    'bid_formula', 'bid_resolver_type', 'bid_resolver_config', 'outbound_field_mapping',
    'bid_comparison_source', 'extra_extraction', 'last_probe_response',
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

ALTER TABLE public.partner_configs DROP COLUMN IF EXISTS bid_mode;
