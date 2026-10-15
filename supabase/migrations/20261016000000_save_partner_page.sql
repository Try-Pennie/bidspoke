-- One transaction for the whole page save (#2133, part of #2114).
--
-- The partners page saved a buyer partner in two calls: the partner record
-- through save_partner_config, then the buyer profile through
-- save_buyer_profile. A profile the database refused left the partner half
-- saved, and the page had to say "Partner saved. The buyer profile was not
-- saved". save_partner_page writes both halves in one transaction, at the pair
-- of versions the page was edited from, or neither.
--
-- 1. _apply_buyer_profile: the body of save_buyer_profile, extracted. Internal:
--    its caller holds the locks and has compared the version; no grant.
-- 2. save_buyer_profile: a thin wrapper with the same signature and behaviour.
--    It now locks the partner row before the profile row, the order
--    save_partner_page locks them in, so the two can never deadlock, and its
--    audit row is tagged _route 'legacy_buyer_profile': its only caller is the
--    old PUT /partners/:id/buyer-profile route, kept one release, and the tag is
--    the durable record of whether that route is still called (L171).
--    set_config('bidspoke.audit_handled', 'save_buyer_profile') stays in the
--    wrapper, so a page save's own value is never overwritten.
-- 3. buyer_profile_tables_direct_sql_audit: 'save_partner_page' joins the skip
--    list, so the profile children a page save rewrites are not reported as
--    hand writes.
-- 4. save_partner_page (service role only): locks partner_configs then
--    buyer_profiles, compares both versions before writing anything and refuses
--    any mismatch with one BP409 carrying both halves, applies the patch through
--    save_partner_config (the one list of editable fields), then the profile,
--    records the press on both rows, and returns both documents and versions.
--
-- Expand only (docs/adr/0007): one new function, one internal function, and
-- two functions replaced with their signatures kept (save_buyer_profile and
-- buyer_profile_tables_direct_sql_audit). The release before calls
-- save_buyer_profile and save_partner_config exactly as it did.

-- ── _apply_buyer_profile ─────────────────────────────────────────────────────
-- save_buyer_profile's body as of 20260930140000, from the kind onwards, plus
-- p_audit_extra merged into the audit row it writes (only when it writes one).
-- The caller has locked the partner row and the profile row, in that order, and
-- has compared the profile version; nothing here locks or compares.
CREATE OR REPLACE FUNCTION public._apply_buyer_profile(
  p_org uuid,
  p_partner uuid,
  p_profile jsonb,
  p_actor uuid,
  p_actor_email text,
  p_audit_extra jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_exists boolean;
  v_stored_sold_on text;
  v_sold_on text;
  v_stored_delivery jsonb;
  v_delivery jsonb;
  v_delivery_problem text;
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
  SELECT sold_on, click_delivery INTO v_stored_sold_on, v_stored_delivery FROM buyer_profiles WHERE partner_id = p_partner;
  v_exists := FOUND;

  -- The kind. Absent keeps what is stored, so a caller that predates the column
  -- cannot flip a click buyer back to offer by omission.
  v_sold_on := coalesce(p_profile->>'sold_on', v_stored_sold_on, 'offer');
  IF v_sold_on NOT IN ('offer', 'click') THEN
    RAISE EXCEPTION 'sold_on_invalid' USING ERRCODE = 'BP422', DETAIL = v_sold_on;
  END IF;
  IF v_exists AND v_sold_on IS DISTINCT FROM v_stored_sold_on AND (
    EXISTS (SELECT 1 FROM buyer_pricing_tiers WHERE partner_id = p_partner)
    OR EXISTS (SELECT 1 FROM partner_configs WHERE id = p_partner AND jsonb_typeof(accept_signals) = 'array' AND jsonb_array_length(accept_signals) > 0)
  ) THEN
    RAISE EXCEPTION 'sold_on_locked' USING ERRCODE = 'BP422',
      DETAIL = format('%s cannot become %s while pricing tiers or accept rules are stored. Remove them and save first.', v_stored_sold_on, v_sold_on);
  END IF;
  IF v_sold_on = 'click' THEN
    IF jsonb_array_length(coalesce(p_profile->'tiers', '[]'::jsonb)) > 0 THEN
      RAISE EXCEPTION 'click_buyer_priced' USING ERRCODE = 'BP422', DETAIL = 'A click sold buyer is quoted at the Engine bid and has no pricing tiers.';
    END IF;
    IF (p_profile->>'hourly_lead_cap') IS NOT NULL OR (p_profile->>'hourly_spend_cap_cents') IS NOT NULL OR (p_profile->>'daily_spend_cap_cents') IS NOT NULL THEN
      RAISE EXCEPTION 'click_buyer_cap_unsupported' USING ERRCODE = 'BP422', DETAIL = 'A click sold buyer is capped by clicks per day only.';
    END IF;
  END IF;

  -- A click buyer's delivery (#1639). Absent keeps what is stored, so a caller
  -- that predates the column cannot blank it by omission; a JSON null clears it.
  v_delivery := CASE WHEN p_profile ? 'click_delivery' THEN nullif(p_profile->'click_delivery', 'null'::jsonb) ELSE v_stored_delivery END;
  IF v_delivery IS NOT NULL THEN
    IF v_sold_on <> 'click' THEN
      RAISE EXCEPTION 'click_delivery_on_offer_buyer' USING ERRCODE = 'BP422', DETAIL = 'Only a buyer sold on the click has click delivery. Remove it before selling this buyer on the offer.';
    END IF;
    v_delivery_problem := click_delivery_problem(v_delivery);
    IF v_delivery_problem IS NOT NULL THEN
      RAISE EXCEPTION 'click_delivery_invalid' USING ERRCODE = 'BP422', DETAIL = v_delivery_problem;
    END IF;
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
    partner_id, organization_id, sold_on, click_delivery, is_enabled, priority, allowed_states,
    debt_min, debt_max, loan_amount_min,
    hourly_lead_cap, daily_lead_cap, hourly_spend_cap_cents, daily_spend_cap_cents,
    updated_by, updated_by_email, updated_by_name
  ) VALUES (
    p_partner, p_org, v_sold_on, v_delivery,
    coalesce((p_profile->>'is_enabled')::boolean, false),
    (p_profile->>'priority')::integer,
    coalesce((SELECT array_agg(s) FROM jsonb_array_elements_text(coalesce(p_profile->'allowed_states', '[]'::jsonb)) s), '{}'::text[]),
    v_debt_min, v_debt_max, (p_profile->>'loan_amount_min')::numeric,
    (p_profile->>'hourly_lead_cap')::integer, (p_profile->>'daily_lead_cap')::integer,
    (p_profile->>'hourly_spend_cap_cents')::bigint, (p_profile->>'daily_spend_cap_cents')::bigint,
    p_actor, p_actor_email, v_actor_name
  )
  ON CONFLICT (partner_id) DO UPDATE SET
    sold_on = EXCLUDED.sold_on,
    click_delivery = EXCLUDED.click_delivery,
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

  -- The caller's bookkeeping keys (_actor, _route) ride beside the changed
  -- paths; every key it names starts with an underscore, so none can collide
  -- with a path buyer_profile_flatten produces.
  INSERT INTO audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES (p_org, 'buyer_profile', p_partner, CASE WHEN v_exists THEN 'updated' ELSE 'created' END, p_actor,
          v_changes || coalesce(p_audit_extra, '{}'::jsonb));

  RETURN buyer_profile_document(p_partner);
END
$$;
COMMENT ON FUNCTION public._apply_buyer_profile(uuid, uuid, jsonb, uuid, text, jsonb) IS
  'The body of a buyer profile save (#2133): the kind and delivery rules, the rows, tier contiguity, the version bump and one audit row of changed paths plus p_audit_extra. Internal: its caller holds the partner and profile row locks, in that order, and has compared the version. Called by save_buyer_profile and save_partner_page only.';
-- service_role too: the platform's default privileges grant every new function
-- in public to it, and this one skips the locks and the version comparison.
REVOKE ALL ON FUNCTION public._apply_buyer_profile(uuid, uuid, jsonb, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ── save_buyer_profile ───────────────────────────────────────────────────────
-- The same signature, refusals and document as before. Two changes: the partner
-- row is locked first (it was only checked for), so this and save_partner_page
-- take their locks in one order; and its audit row is tagged as the legacy
-- route's, which is its only caller.
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
  v_version integer;
BEGIN
  PERFORM 1 FROM partner_configs WHERE id = p_partner AND organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Stays here, never in _apply_buyer_profile, so a page save's own value is
  -- the one its statements run under.
  PERFORM set_config('bidspoke.audit_handled', 'save_buyer_profile', true);

  SELECT version INTO v_version FROM buyer_profiles WHERE partner_id = p_partner FOR UPDATE;
  IF NOT FOUND THEN v_version := 0; END IF;
  IF v_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'stale_version' USING ERRCODE = 'BP409',
      DETAIL = coalesce(buyer_profile_document(p_partner)::text, '{}');
  END IF;

  RETURN _apply_buyer_profile(p_org, p_partner, p_profile, p_actor, p_actor_email, jsonb_build_object('_route', 'legacy_buyer_profile'));
END
$$;
COMMENT ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) IS
  'The buyer profile save of the old PUT /partners/:id/buyer-profile route (#1409), kept one release beside save_partner_page (#2133): versioned, transactional, one audit row of changed paths tagged _route legacy_buyer_profile. Locks the partner row, then the profile row. Refuses stale_version (BP409, detail holds the current document), tiers_gap, population_not_wired, sold_on_invalid, sold_on_locked, click_buyer_priced, click_buyer_cap_unsupported (BP422, #1541), click_delivery_on_offer_buyer and click_delivery_invalid (BP422, #1639), partner_not_found (P0002). A document without click_delivery keeps the stored one.';
REVOKE ALL ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) TO service_role;

-- ── The child table detector learns the page save ────────────────────────────
-- As in 20261015010000, with 'save_partner_page' on the skip list.
CREATE OR REPLACE FUNCTION public.buyer_profile_tables_direct_sql_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_handled text := nullif(current_setting('bidspoke.audit_handled', true), '');
  v_action text := CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END;
BEGIN
  IF v_handled IN ('save_buyer_profile', 'save_partner_page', 'delete_partner_config', 'buyer_profile_version_bump') THEN
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

-- ── save_partner_page ────────────────────────────────────────────────────────
-- The page's one save. The concurrency token is the pair of versions, and this
-- function is its one home (L83): both are compared under both row locks before
-- anything is written. p_profile NULL saves the partner record alone, and then
-- p_expected_profile_version may be NULL too: a page that never read the
-- profile (a source partner, or a profile read that failed) neither writes it
-- nor can be stale about it.
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
    -- The last editor of either half: the newest audit row's actor by name,
    -- falling back to the name it stamped at the time. A hand write has neither.
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

  -- The partner half through the one list of editable fields. The version it
  -- is handed is the one just compared under this lock, so it cannot refuse it.
  v_partner_out := save_partner_config(p_org, p_partner_id, p_expected_partner_version, p_patch, p_save_id, p_actor, p_actor_email, p_actor_name);

  IF p_profile IS NOT NULL THEN
    -- The actor as of this write (L37), resolved as the partner audit trigger
    -- resolves it: the users row, falling back to what the caller carried in.
    SELECT u.display_name, u.email INTO v_actor_name, v_actor_email FROM users u WHERE u.id = p_actor;
    v_actor_name := coalesce(nullif(v_actor_name, ''), nullif(p_actor_name, ''));
    v_actor_email := coalesce(nullif(v_actor_email, ''), nullif(p_actor_email, ''));
    PERFORM _apply_buyer_profile(p_org, p_partner_id, p_profile, p_actor, p_actor_email,
      jsonb_build_object('_actor', jsonb_build_object('name', v_actor_name, 'email', v_actor_email)));
    -- The press on the profile row too. audit_handled is set, so the version
    -- bump trigger leaves this bookkeeping write alone.
    UPDATE buyer_profiles SET last_save_id = p_save_id WHERE partner_id = p_partner_id;
  END IF;
  v_profile_out := buyer_profile_document(p_partner_id);

  RETURN jsonb_build_object(
    'partner', v_partner_out,
    'profile', v_profile_out,
    'partner_version', (v_partner_out ->> 'version')::integer,
    'profile_version', coalesce((v_profile_out ->> 'version')::integer, 0)
  );
END
$$;
COMMENT ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text) IS
  'The partners page save (#2133): the partner patch (through save_partner_config) and the buyer profile in one transaction, when the stored versions are the pair the page was edited from, recording p_save_id on both rows. p_profile NULL saves the partner alone, and p_expected_profile_version NULL skips the profile comparison. Refuses stale_version (BP409, DETAIL a JSON object: partner, profile, partner_version, profile_version, last_save_id, changed_by_name, changed_at), every refusal of save_partner_config and of a profile save (BP422), patch_not_object, profile_not_object, expected_version_invalid and save_id_required (BP422), partner_not_found (P0002). Returns partner, profile, partner_version and profile_version.';
REVOKE ALL ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_partner_page(uuid, uuid, integer, jsonb, integer, jsonb, uuid, uuid, text, text) TO service_role;
