-- The only writers of the buyer profile tables and of buyer_sales, and the two
-- partner_configs operations that need an actor the row trigger cannot see
-- (#1409). Every function is a FUNCTION and not a PROCEDURE so PostgREST exposes
-- it and the live objects probe can verify anon is refused; every SECURITY
-- DEFINER one is revoked from PUBLIC, anon and authenticated and granted to
-- service_role, which is the shape security-definer-grants.test.ts enforces.
--
-- Named refusals use SQLSTATE class BP (Bidspoke), so a route can map each one
-- without matching message text: BP409 a version or state conflict, BP422 a
-- refused input, BP023 a refused write that would break an integrity rule.
-- P0002 (no_data_found) is a missing record.
--
-- Expand only: new functions nothing calls yet.

-- ── Helpers ──────────────────────────────────────────────────────────────────

-- The profile as one document: the row plus its children, children sorted so two
-- documents of the same profile compare equal whatever order the rows came in.
CREATE OR REPLACE FUNCTION public.buyer_profile_document(p_partner uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'partner_id', p.partner_id,
    'version', p.version,
    'is_enabled', p.is_enabled,
    'priority', p.priority,
    'allowed_states', to_jsonb((SELECT coalesce(array_agg(s ORDER BY s), '{}'::text[]) FROM unnest(p.allowed_states) s)),
    'debt_min', p.debt_min,
    'debt_max', p.debt_max,
    'loan_amount_min', p.loan_amount_min,
    'hourly_lead_cap', p.hourly_lead_cap,
    'daily_lead_cap', p.daily_lead_cap,
    'hourly_spend_cap_cents', p.hourly_spend_cap_cents,
    'daily_spend_cap_cents', p.daily_spend_cap_cents,
    'windows', coalesce((
      SELECT jsonb_agg(jsonb_build_object('day_of_week', w.day_of_week, 'opens_minute', w.opens_minute, 'closes_minute', w.closes_minute) ORDER BY w.day_of_week, w.opens_minute)
      FROM buyer_operating_windows w WHERE w.partner_id = p.partner_id), '[]'::jsonb),
    'blackout_dates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('date', b.blackout_date, 'note', b.note) ORDER BY b.blackout_date)
      FROM buyer_blackout_dates b WHERE b.partner_id = p.partner_id), '[]'::jsonb),
    'tiers', coalesce((
      SELECT jsonb_agg(jsonb_build_object('population', t.population, 'debt_from', t.debt_from, 'debt_to', t.debt_to, 'multiplier', t.multiplier) ORDER BY t.population, t.debt_from)
      FROM buyer_pricing_tiers t WHERE t.partner_id = p.partner_id), '[]'::jsonb)
  )
  FROM buyer_profiles p WHERE p.partner_id = p_partner
$$;
COMMENT ON FUNCTION public.buyer_profile_document(uuid) IS 'A buyer profile and its children as one sorted document (#1409). What save_buyer_profile returns and diffs.';
REVOKE ALL ON FUNCTION public.buyer_profile_document(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_document(uuid) TO service_role;

-- The document as flat paths, so a diff names the one thing that changed: a tier
-- by population and lower bound, a window by day and opening minute, a blackout
-- by date, and the state list as one value.
CREATE OR REPLACE FUNCTION public.buyer_profile_flatten(p_doc jsonb)
RETURNS TABLE (path text, value jsonb)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT k, p_doc -> k FROM jsonb_object_keys(p_doc) k
  WHERE k NOT IN ('partner_id', 'version', 'windows', 'blackout_dates', 'tiers')
  UNION ALL
  SELECT 'windows.' || (w->>'day_of_week') || '.' || (w->>'opens_minute'), w -> 'closes_minute'
  FROM jsonb_array_elements(coalesce(p_doc->'windows', '[]'::jsonb)) w
  UNION ALL
  SELECT 'blackout_dates.' || (b->>'date'), coalesce(b -> 'note', 'null'::jsonb)
  FROM jsonb_array_elements(coalesce(p_doc->'blackout_dates', '[]'::jsonb)) b
  UNION ALL
  SELECT 'tiers.' || (t->>'population') || '.' || trim_scale((t->>'debt_from')::numeric)::text || '.debt_to', coalesce(t -> 'debt_to', 'null'::jsonb)
  FROM jsonb_array_elements(coalesce(p_doc->'tiers', '[]'::jsonb)) t
  UNION ALL
  SELECT 'tiers.' || (t->>'population') || '.' || trim_scale((t->>'debt_from')::numeric)::text || '.multiplier', t -> 'multiplier'
  FROM jsonb_array_elements(coalesce(p_doc->'tiers', '[]'::jsonb)) t
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_flatten(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_flatten(jsonb) TO service_role;

-- The status order record_buyer_sale enforces: a later status may only move a
-- row forward. reserved, then any resolution, then accepted, which is final.
CREATE OR REPLACE FUNCTION public.buyer_sale_status_rank(p_status text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'reserved' THEN 0
    WHEN 'released' THEN 1
    WHEN 'declined' THEN 1
    WHEN 'unresolved' THEN 1
    WHEN 'accepted' THEN 2
    ELSE -1
  END
$$;
REVOKE ALL ON FUNCTION public.buyer_sale_status_rank(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_sale_status_rank(text) TO service_role;

-- ── save_buyer_profile ───────────────────────────────────────────────────────
-- One transaction: lock the row, refuse a stale version with the current
-- document in the refusal, replace the children, re-check the tier rules the
-- form also checks, and write ONE audit row holding only the paths that differ
-- (L580, L529). A save that changes nothing writes no audit row and leaves the
-- version alone. Sets bidspoke.audit_handled so the direct SQL detector on the
-- profile tables stays quiet for this statement.
CREATE OR REPLACE FUNCTION public.save_buyer_profile(
  p_org uuid,
  p_partner uuid,
  p_expected_version integer,
  p_profile jsonb,
  p_actor uuid,
  p_actor_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_exists boolean;
  v_version integer;
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_actor_name text;
  v_pop text;
  v_prev_to numeric;
  v_first boolean;
  v_debt_min numeric := (p_profile->>'debt_min')::numeric;
  v_debt_max numeric := (p_profile->>'debt_max')::numeric;
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM partner_configs WHERE id = p_partner AND organization_id = p_org) THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('bidspoke.audit_handled', 'save_buyer_profile', true);

  SELECT version INTO v_version FROM buyer_profiles WHERE partner_id = p_partner FOR UPDATE;
  v_exists := FOUND;
  IF NOT v_exists THEN v_version := 0; END IF;
  IF v_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'stale_version' USING ERRCODE = 'BP409',
      DETAIL = coalesce(buyer_profile_document(p_partner)::text, '{}');
  END IF;

  -- Named refusal ahead of the CHECK constraint, so the route can say which rule.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(p_profile->'tiers', '[]'::jsonb)) t
    WHERE (t->>'population') IS NULL OR (t->>'population') NOT IN ('engine')
  ) THEN
    RAISE EXCEPTION 'population_not_wired' USING ERRCODE = 'BP422';
  END IF;

  IF v_exists THEN v_old := buyer_profile_document(p_partner); END IF;
  SELECT display_name INTO v_actor_name FROM users WHERE id = p_actor;

  INSERT INTO buyer_profiles (
    partner_id, organization_id, is_enabled, priority, allowed_states,
    debt_min, debt_max, loan_amount_min,
    hourly_lead_cap, daily_lead_cap, hourly_spend_cap_cents, daily_spend_cap_cents,
    updated_by, updated_by_email, updated_by_name
  ) VALUES (
    p_partner, p_org,
    coalesce((p_profile->>'is_enabled')::boolean, false),
    (p_profile->>'priority')::integer,
    coalesce((SELECT array_agg(s) FROM jsonb_array_elements_text(coalesce(p_profile->'allowed_states', '[]'::jsonb)) s), '{}'::text[]),
    v_debt_min, v_debt_max, (p_profile->>'loan_amount_min')::numeric,
    (p_profile->>'hourly_lead_cap')::integer, (p_profile->>'daily_lead_cap')::integer,
    (p_profile->>'hourly_spend_cap_cents')::bigint, (p_profile->>'daily_spend_cap_cents')::bigint,
    p_actor, p_actor_email, v_actor_name
  )
  ON CONFLICT (partner_id) DO UPDATE SET
    is_enabled = EXCLUDED.is_enabled,
    priority = EXCLUDED.priority,
    allowed_states = EXCLUDED.allowed_states,
    debt_min = EXCLUDED.debt_min,
    debt_max = EXCLUDED.debt_max,
    loan_amount_min = EXCLUDED.loan_amount_min,
    hourly_lead_cap = EXCLUDED.hourly_lead_cap,
    daily_lead_cap = EXCLUDED.daily_lead_cap,
    hourly_spend_cap_cents = EXCLUDED.hourly_spend_cap_cents,
    daily_spend_cap_cents = EXCLUDED.daily_spend_cap_cents,
    updated_by = EXCLUDED.updated_by,
    updated_by_email = EXCLUDED.updated_by_email,
    updated_by_name = EXCLUDED.updated_by_name;

  DELETE FROM buyer_operating_windows WHERE partner_id = p_partner;
  INSERT INTO buyer_operating_windows (partner_id, organization_id, day_of_week, opens_minute, closes_minute)
  SELECT p_partner, p_org, (w->>'day_of_week')::smallint, (w->>'opens_minute')::smallint, (w->>'closes_minute')::smallint
  FROM jsonb_array_elements(coalesce(p_profile->'windows', '[]'::jsonb)) w;

  DELETE FROM buyer_blackout_dates WHERE partner_id = p_partner;
  INSERT INTO buyer_blackout_dates (partner_id, organization_id, blackout_date, note)
  SELECT p_partner, p_org,
         (CASE WHEN jsonb_typeof(b) = 'string' THEN b #>> '{}' ELSE b->>'date' END)::date,
         CASE WHEN jsonb_typeof(b) = 'object' THEN b->>'note' END
  FROM jsonb_array_elements(coalesce(p_profile->'blackout_dates', '[]'::jsonb)) b;

  DELETE FROM buyer_pricing_tiers WHERE partner_id = p_partner;
  INSERT INTO buyer_pricing_tiers (partner_id, organization_id, population, debt_from, debt_to, multiplier)
  SELECT p_partner, p_org, t->>'population', (t->>'debt_from')::numeric, (t->>'debt_to')::numeric, (t->>'multiplier')::numeric
  FROM jsonb_array_elements(coalesce(p_profile->'tiers', '[]'::jsonb)) t;

  -- Tier contiguity inside the accepted debt range, per population. Overlaps are
  -- already refused by the exclusion constraint on insert above.
  FOR v_pop IN SELECT DISTINCT population FROM buyer_pricing_tiers WHERE partner_id = p_partner LOOP
    v_prev_to := NULL;
    v_first := true;
    FOR r IN SELECT debt_from, debt_to FROM buyer_pricing_tiers WHERE partner_id = p_partner AND population = v_pop ORDER BY debt_from LOOP
      IF v_first THEN
        v_first := false;
        IF v_debt_min IS NOT NULL AND r.debt_from > v_debt_min THEN
          RAISE EXCEPTION 'tiers_gap' USING ERRCODE = 'BP422', DETAIL = format('%s: the first tier starts at %s, above the debt minimum %s', v_pop, r.debt_from, v_debt_min);
        END IF;
      ELSIF v_prev_to IS NULL OR r.debt_from > v_prev_to THEN
        RAISE EXCEPTION 'tiers_gap' USING ERRCODE = 'BP422', DETAIL = format('%s: nothing covers %s to %s', v_pop, v_prev_to, r.debt_from);
      END IF;
      v_prev_to := r.debt_to;
    END LOOP;
    IF v_prev_to IS NOT NULL AND v_debt_max IS NOT NULL AND v_prev_to <= v_debt_max THEN
      RAISE EXCEPTION 'tiers_gap' USING ERRCODE = 'BP422', DETAIL = format('%s: the last tier ends at %s, at or below the debt maximum %s', v_pop, v_prev_to, v_debt_max);
    END IF;
  END LOOP;

  v_new := buyer_profile_document(p_partner);

  IF v_exists THEN
    SELECT coalesce(jsonb_object_agg(d.path, jsonb_build_object('old', d.o, 'new', d.n)), '{}'::jsonb) INTO v_changes
    FROM (
      SELECT coalesce(a.path, b.path) AS path, a.value AS o, b.value AS n
      FROM buyer_profile_flatten(v_old) a
      FULL OUTER JOIN buyer_profile_flatten(v_new) b ON a.path = b.path
      WHERE coalesce(a.value, 'null'::jsonb) IS DISTINCT FROM coalesce(b.value, 'null'::jsonb)
    ) d;
    IF v_changes = '{}'::jsonb THEN
      RETURN v_new;
    END IF;
    UPDATE buyer_profiles SET version = version + 1 WHERE partner_id = p_partner;
  ELSE
    SELECT coalesce(jsonb_object_agg(f.path, jsonb_build_object('old', NULL, 'new', f.value)), '{}'::jsonb) INTO v_changes
    FROM buyer_profile_flatten(v_new) f
    WHERE coalesce(f.value, 'null'::jsonb) IS DISTINCT FROM 'null'::jsonb;
  END IF;

  INSERT INTO audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES (p_org, 'buyer_profile', p_partner, CASE WHEN v_exists THEN 'updated' ELSE 'created' END, p_actor, v_changes);

  RETURN buyer_profile_document(p_partner);
END
$$;
COMMENT ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) IS
  'The only writer of a buyer profile (#1409): versioned, transactional, one audit row of changed paths. Refuses stale_version (BP409, detail holds the current document), tiers_gap and population_not_wired (BP422), partner_not_found (P0002).';
REVOKE ALL ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) TO service_role;

-- ── record_buyer_sale ────────────────────────────────────────────────────────
-- Upserts one full row. Every call carries the same key set, so a row written
-- by the inline mirror and a row written by the minute drain cannot differ in
-- which columns they touch (L685, L705). The status rank guard means a late
-- reserved can never overwrite accepted. Returns the stored row, so the caller
-- confirms what landed rather than what it sent (L581).
CREATE OR REPLACE FUNCTION public.record_buyer_sale(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_required text[] := ARRAY[
    'id', 'partner_id', 'organization_id', 'lead_key', 'population', 'kind', 'status', 'payout_cents', 'debt', 'multiplier',
    'et_day', 'hour_bucket', 'workflow_id', 'execution_id', 'trace_id', 'http_status', 'result_code', 'buyer_reference',
    'live_percent_in_force', 'caps_in_force', 'resolution_source', 'resolved_by'
  ];
  k text;
  v_constraint text;
  v_out jsonb;
BEGIN
  FOREACH k IN ARRAY v_required LOOP
    IF NOT (p_row ? k) THEN
      RAISE EXCEPTION 'missing_key' USING ERRCODE = 'BP422', DETAIL = k;
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO buyer_sales AS s (
      id, partner_id, organization_id, lead_key, population, kind, status, payout_cents, debt, multiplier,
      et_day, hour_bucket, workflow_id, execution_id, trace_id, http_status, result_code, buyer_reference,
      live_percent_in_force, caps_in_force, resolution_source, resolved_by, resolved_at
    ) VALUES (
      (p_row->>'id')::uuid, (p_row->>'partner_id')::uuid, (p_row->>'organization_id')::uuid,
      p_row->>'lead_key', p_row->>'population', p_row->>'kind', p_row->>'status',
      (p_row->>'payout_cents')::bigint, (p_row->>'debt')::numeric, (p_row->>'multiplier')::numeric,
      (p_row->>'et_day')::date, (p_row->>'hour_bucket')::timestamptz,
      (p_row->>'workflow_id')::uuid, (p_row->>'execution_id')::uuid, p_row->>'trace_id',
      (p_row->>'http_status')::integer, p_row->>'result_code', p_row->>'buyer_reference',
      (p_row->>'live_percent_in_force')::integer, p_row->'caps_in_force', p_row->>'resolution_source', (p_row->>'resolved_by')::uuid,
      CASE WHEN p_row->>'status' IN ('accepted', 'declined', 'released') THEN now() END
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      payout_cents = EXCLUDED.payout_cents,
      http_status = EXCLUDED.http_status,
      result_code = EXCLUDED.result_code,
      buyer_reference = EXCLUDED.buyer_reference,
      live_percent_in_force = EXCLUDED.live_percent_in_force,
      caps_in_force = EXCLUDED.caps_in_force,
      resolution_source = EXCLUDED.resolution_source,
      resolved_by = EXCLUDED.resolved_by,
      resolved_at = coalesce(EXCLUDED.resolved_at, s.resolved_at)
    WHERE buyer_sale_status_rank(EXCLUDED.status) >= buyer_sale_status_rank(s.status);
  EXCEPTION WHEN unique_violation OR exclusion_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'buyer_sales_one_accepted_live_per_lead' THEN
      RAISE EXCEPTION 'duplicate_accepted_sale' USING ERRCODE = 'BP023', DETAIL = format('lead %s in %s is already sold live', p_row->>'lead_key', p_row->>'population');
    END IF;
    RAISE EXCEPTION 'sale_key_conflict' USING ERRCODE = 'BP422', DETAIL = v_constraint;
  END;

  SELECT to_jsonb(s) INTO v_out FROM buyer_sales s WHERE s.id = (p_row->>'id')::uuid;
  RETURN v_out;
END
$$;
COMMENT ON FUNCTION public.record_buyer_sale(jsonb) IS
  'Upsert one buyer_sales row with the full key set every time and a status rank guard (#1409). Refuses duplicate_accepted_sale (BP023), missing_key and sale_key_conflict (BP422). Returns the stored row.';
REVOKE ALL ON FUNCTION public.record_buyer_sale(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_buyer_sale(jsonb) TO service_role;

-- ── settle_buyer_sale ────────────────────────────────────────────────────────
-- A person resolves an unresolved sale: it counted as sold (accepted) or it
-- frees its slot (released). Only an unresolved row can be settled, and the
-- settlement is its own audit row with the old and new status.
CREATE OR REPLACE FUNCTION public.settle_buyer_sale(p_id uuid, p_org uuid, p_outcome text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_status text;
  v_out jsonb;
  v_constraint text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'released') THEN
    RAISE EXCEPTION 'settle_outcome_invalid' USING ERRCODE = 'BP422', DETAIL = coalesce(p_outcome, '<null>');
  END IF;
  SELECT status INTO v_status FROM buyer_sales WHERE id = p_id AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sale_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IS DISTINCT FROM 'unresolved' THEN
    RAISE EXCEPTION 'not_unresolved' USING ERRCODE = 'BP409', DETAIL = v_status;
  END IF;
  BEGIN
    UPDATE buyer_sales
    SET status = p_outcome, resolved_at = now(), resolved_by = p_actor, resolution_source = 'settled'
    WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION 'duplicate_accepted_sale' USING ERRCODE = 'BP023', DETAIL = v_constraint;
  END;
  INSERT INTO audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES (p_org, 'buyer_sale', p_id, 'updated', p_actor, jsonb_build_object('status', jsonb_build_object('old', v_status, 'new', p_outcome)));
  SELECT to_jsonb(s) INTO v_out FROM buyer_sales s WHERE s.id = p_id;
  RETURN v_out;
END
$$;
COMMENT ON FUNCTION public.settle_buyer_sale(uuid, uuid, text, uuid) IS
  'Settle an unresolved buyer_sales row as accepted or released, with its own audit row (#1409). Refuses not_unresolved (BP409), settle_outcome_invalid (BP422), sale_not_found (P0002).';
REVOKE ALL ON FUNCTION public.settle_buyer_sale(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_buyer_sale(uuid, uuid, text, uuid) TO service_role;

-- ── delete_partner_config ────────────────────────────────────────────────────
-- A delete sets no column, so the row trigger cannot learn who did it from the
-- row. This carries the actor in a transaction local setting the trigger reads,
-- and turns a foreign key refusal into a named one that says what blocks it.
CREATE OR REPLACE FUNCTION public.delete_partner_config(p_org uuid, p_id uuid, p_actor uuid, p_actor_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_detail text;
  v_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM partner_configs WHERE id = p_id AND organization_id = p_org) THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.audit_handled', 'delete_partner_config', true);
  BEGIN
    DELETE FROM partner_configs WHERE id = p_id AND organization_id = p_org;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_table = TABLE_NAME;
    RAISE EXCEPTION 'partner_has_dependents' USING ERRCODE = 'BP023', DETAIL = coalesce(v_detail, v_table, 'a dependent row');
  END;
END
$$;
COMMENT ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text) IS
  'Delete a partner with the actor recorded on its audit row (#1409). Refuses partner_has_dependents (BP023, detail names the table) and partner_not_found (P0002). The profile cascades; sales block.';
REVOKE ALL ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_partner_config(uuid, uuid, uuid, text) TO service_role;

-- ── rename_partner_step_namespace ────────────────────────────────────────────
-- The step id rename rewrites the formula columns of every partner that
-- references the old namespace (workflows.ts rename-apply). Only those two
-- columns may be written through here, and the reason and context ride on the
-- audit row the trigger writes.
CREATE OR REPLACE FUNCTION public.rename_partner_step_namespace(
  p_org uuid,
  p_partner uuid,
  p_columns jsonb,
  p_actor uuid,
  p_actor_email text,
  p_context jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  k text;
  v_n integer;
BEGIN
  FOR k IN SELECT jsonb_object_keys(coalesce(p_columns, '{}'::jsonb)) LOOP
    IF k NOT IN ('bid_formula', 'bid_resolver_config') THEN
      RAISE EXCEPTION 'column_not_renameable' USING ERRCODE = 'BP422', DETAIL = k;
    END IF;
  END LOOP;
  PERFORM set_config('bidspoke.actor_id', p_actor::text, true);
  PERFORM set_config('bidspoke.actor_email', coalesce(p_actor_email, ''), true);
  PERFORM set_config('bidspoke.audit_reason', coalesce(p_context->>'reason', 'step_id_renamed'), true);
  PERFORM set_config('bidspoke.audit_context', coalesce(p_context, '{}'::jsonb)::text, true);
  UPDATE partner_configs
  SET bid_formula = CASE WHEN p_columns ? 'bid_formula' THEN p_columns->>'bid_formula' ELSE bid_formula END,
      bid_resolver_config = CASE WHEN p_columns ? 'bid_resolver_config' THEN p_columns->'bid_resolver_config' ELSE bid_resolver_config END,
      updated_by = p_actor,
      updated_by_email = p_actor_email
  WHERE id = p_partner AND organization_id = p_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
COMMENT ON FUNCTION public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb) IS
  'Rewrite bid_formula and bid_resolver_config on one partner for a step id rename, carrying the actor, reason and context onto the audit row (#1409). Refuses any other column (BP422 column_not_renameable). Returns rows updated.';
REVOKE ALL ON FUNCTION public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_partner_step_namespace(uuid, uuid, jsonb, uuid, text, jsonb) TO service_role;
