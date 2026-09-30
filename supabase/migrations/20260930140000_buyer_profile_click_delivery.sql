-- A click buyer's delivery on its buyer profile (#1639, milestone "Click sold buyers").
--
-- Liberty1 moved its click endpoints three times in five days, and each move was
-- a script edit plus a workflow save, because the route URLs were literals in the
-- build_liberty1_request script and the success reply was the buyer_click_send
-- node's own setting. click_delivery puts both on the buyer profile, where a
-- change is versioned, audited and shown in the profile history:
--
--   {"routes": [{"name": "DV1", "url": "https://...", "states": ["WA", ...]},
--               {"name": "DI4", "url": "https://...", "states": []}],
--    "success_pattern": "...(?<id>...)..."}
--
-- A route with an empty states list is the catch-all, and exactly one route is.
-- buyer_click_send picks the route by the lead's state and matches the reply
-- with the success line; with no delivery stored the node keeps using its own
-- request_url and success_pattern, so nothing changes until a profile is filled.
--
-- The full rules (a pattern that compiles, with an id group) are the shared
-- validator's in packages/buyer-profile, which the form and the API both run.
-- Postgres cannot compile a JavaScript pattern, so the database re-checks the
-- structure only: routes a list, names set and distinct, https addresses, known
-- states each in at most one route, one catch-all, a success line set.
--
-- Expand only (docs/adr/0007): a nullable column no existing row fills, a CHECK
-- every existing row satisfies (all are null), one new function, and CREATE OR
-- REPLACE of three functions with unchanged signatures. A save that sends no
-- click_delivery (a Worker or form deployed before this change) keeps the
-- stored value, so old code cannot blank it. The document gains a key an older
-- Worker ignores.

ALTER TABLE public.buyer_profiles
  ADD COLUMN click_delivery jsonb
    CONSTRAINT buyer_profiles_click_delivery_click_only CHECK (click_delivery IS NULL OR (sold_on = 'click' AND jsonb_typeof(click_delivery) = 'object'));

COMMENT ON COLUMN public.buyer_profiles.click_delivery IS
  'A click buyer''s delivery (#1639): routes (name, https url, states; the one route with no states takes every other state) and the success_pattern that counts a reply as sold. Null: buyer_click_send uses its own request_url and success_pattern.';

-- ── click_delivery_problem ───────────────────────────────────────────────────
-- The first structural problem with a delivery, or null when it has none. The
-- sentence is the save's refusal detail.
CREATE OR REPLACE FUNCTION public.click_delivery_problem(p_delivery jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r jsonb;
  s text;
  v_names text[] := '{}';
  v_states text[] := '{}';
  v_catch_alls integer := 0;
  v_known constant text[] := ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
BEGIN
  IF jsonb_typeof(p_delivery) IS DISTINCT FROM 'object' THEN RETURN 'click_delivery is not an object'; END IF;
  IF jsonb_typeof(p_delivery->'routes') IS DISTINCT FROM 'array' THEN RETURN 'routes is not a list'; END IF;
  IF jsonb_typeof(p_delivery->'success_pattern') IS DISTINCT FROM 'string' OR btrim(p_delivery->>'success_pattern') = '' THEN
    RETURN 'the success line is not set';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_delivery->'routes') LOOP
    IF jsonb_typeof(r->'name') IS DISTINCT FROM 'string' OR btrim(r->>'name') = '' THEN RETURN 'a route has no name'; END IF;
    IF btrim(r->>'name') = ANY (v_names) THEN RETURN format('two routes are named %s', r->>'name'); END IF;
    v_names := v_names || btrim(r->>'name');
    IF jsonb_typeof(r->'url') IS DISTINCT FROM 'string' OR (r->>'url') !~ '^https://[^/[:space:]]+' THEN RETURN format('route %s has no https address', r->>'name'); END IF;
    IF jsonb_typeof(r->'states') IS DISTINCT FROM 'array' THEN RETURN format('route %s has no states list', r->>'name'); END IF;
    IF jsonb_array_length(r->'states') = 0 THEN v_catch_alls := v_catch_alls + 1; END IF;
    FOR s IN SELECT DISTINCT value FROM jsonb_array_elements_text(r->'states') LOOP
      IF NOT (s = ANY (v_known)) THEN RETURN format('route %s lists %s, which is not a state', r->>'name', s); END IF;
      IF s = ANY (v_states) THEN RETURN format('%s is in more than one route', s); END IF;
      v_states := v_states || s;
    END LOOP;
  END LOOP;
  IF v_catch_alls <> 1 THEN RETURN format('%s routes have no states, and exactly one must', v_catch_alls); END IF;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION public.click_delivery_problem(jsonb) IS 'The first structural problem with a click buyer''s delivery, or null (#1639). save_buyer_profile refuses click_delivery_invalid with it.';
REVOKE ALL ON FUNCTION public.click_delivery_problem(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.click_delivery_problem(jsonb) TO service_role;

-- ── buyer_profile_flatten ────────────────────────────────────────────────────
-- As in 20260921221007, plus the delivery: the success line on its own path and
-- each route by its name, its address and its sorted states, keyed as the
-- package's diffProfileDocuments keys them, so the history names which route
-- moved. The delivery is never flattened as one value.
CREATE OR REPLACE FUNCTION public.buyer_profile_flatten(p_doc jsonb)
RETURNS TABLE (path text, value jsonb)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT k, p_doc -> k FROM jsonb_object_keys(p_doc) k
  WHERE k NOT IN ('partner_id', 'version', 'windows', 'blackout_dates', 'tiers', 'click_delivery')
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
  UNION ALL
  SELECT 'click_delivery.success_pattern', p_doc->'click_delivery'->'success_pattern'
  WHERE jsonb_typeof(p_doc->'click_delivery') = 'object'
  UNION ALL
  SELECT 'click_delivery.routes[' || (r->>'name') || ']',
         jsonb_build_object('url', r->'url', 'states', coalesce((SELECT jsonb_agg(s ORDER BY s) FROM jsonb_array_elements_text(r->'states') s), '[]'::jsonb))
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_doc->'click_delivery'->'routes') = 'array' THEN p_doc->'click_delivery'->'routes' ELSE '[]'::jsonb END) r
$$;
REVOKE ALL ON FUNCTION public.buyer_profile_flatten(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_flatten(jsonb) TO service_role;

-- ── buyer_profile_document ───────────────────────────────────────────────────
-- As in 20260924210000, plus click_delivery.
CREATE OR REPLACE FUNCTION public.buyer_profile_document(p_partner uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'partner_id', p.partner_id,
    'version', p.version,
    'sold_on', p.sold_on,
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
    'click_delivery', p.click_delivery,
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
COMMENT ON FUNCTION public.buyer_profile_document(uuid) IS 'A buyer profile and its children as one sorted document (#1409), with its sold_on kind (#1541) and a click buyer''s delivery, null when none (#1639). What save_buyer_profile returns and diffs.';
REVOKE ALL ON FUNCTION public.buyer_profile_document(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_document(uuid) TO service_role;

-- ── save_buyer_profile ───────────────────────────────────────────────────────
-- As in 20260924210000, plus click_delivery: absent keeps the stored value, null
-- clears it, refused by name on an offer buyer (including a switch to the offer
-- by a caller that omits the key) and when its structure is wrong.
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
  IF NOT EXISTS (SELECT 1 FROM partner_configs WHERE id = p_partner AND organization_id = p_org) THEN
    RAISE EXCEPTION 'partner_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('bidspoke.audit_handled', 'save_buyer_profile', true);

  SELECT version, sold_on, click_delivery INTO v_version, v_stored_sold_on, v_stored_delivery FROM buyer_profiles WHERE partner_id = p_partner FOR UPDATE;
  v_exists := FOUND;
  IF NOT v_exists THEN v_version := 0; END IF;
  IF v_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'stale_version' USING ERRCODE = 'BP409',
      DETAIL = coalesce(buyer_profile_document(p_partner)::text, '{}');
  END IF;

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

  INSERT INTO audit_log (organization_id, entity_type, entity_id, action, changed_by, changes)
  VALUES (p_org, 'buyer_profile', p_partner, CASE WHEN v_exists THEN 'updated' ELSE 'created' END, p_actor, v_changes);

  RETURN buyer_profile_document(p_partner);
END
$$;
COMMENT ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) IS
  'The only writer of a buyer profile (#1409): versioned, transactional, one audit row of changed paths. Refuses stale_version (BP409, detail holds the current document), tiers_gap, population_not_wired, sold_on_invalid, sold_on_locked, click_buyer_priced, click_buyer_cap_unsupported (BP422, #1541), click_delivery_on_offer_buyer and click_delivery_invalid (BP422, #1639), partner_not_found (P0002). A document without click_delivery keeps the stored one.';
REVOKE ALL ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) TO service_role;
