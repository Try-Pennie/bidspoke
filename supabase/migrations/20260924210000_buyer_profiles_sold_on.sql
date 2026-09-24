-- A click sold buyer kind on buyer profiles (#1541, milestone "Click sold buyers").
--
-- A click sold buyer (Liberty1 first, EvaFi later) is never called when the
-- offer is made: the offer quotes the Engine bid, and the buyer is posted to
-- only when the person clicks. So the rules an offer buyer needs do not fit it:
-- no priority (buyer_select never ranks it), no pricing tiers, no accept rules,
-- and no hourly or spend caps (nothing counts them; the click counter counts
-- clicks per day, #1542).
--
-- sold_on is 'offer' (every existing profile, sold through buyer_select) or
-- 'click'. The database refuses what nothing would honour for a click buyer:
-- an hourly cap or a spend cap (CHECK), and pricing tiers (save_buyer_profile,
-- by name), because a click buyer with engine tiers would be SOLD by
-- buyer_select. With no tiers it falls out there as no_pricing_for_population.
--
-- The kind cannot be switched while tiers or accept rules are stored: an offer
-- buyer's sales were priced and judged by them, and switching would leave them
-- stored and unread (L46), or bring a click buyer into buyer_select.
--
-- Expand only (docs/adr/0007): a column with a default every existing row
-- satisfies; a CHECK that is LOOSER than the one it replaces (enabled needs a
-- priority only for an offer buyer), added before the old one is dropped so no
-- moment exists with neither; a new CHECK every existing row satisfies (every
-- row is 'offer'); and CREATE OR REPLACE of two functions with unchanged
-- signatures. A save that sends no sold_on (a Worker deployed before this
-- change) keeps the stored kind, and a first save without one is 'offer', so
-- old code keeps working against the new schema.

ALTER TABLE public.buyer_profiles
  ADD COLUMN sold_on text NOT NULL DEFAULT 'offer'
    CONSTRAINT buyer_profiles_sold_on_known CHECK (sold_on IN ('offer', 'click'));

COMMENT ON COLUMN public.buyer_profiles.sold_on IS
  'offer: sold through buyer_select, priced by tiers, judged by accept rules. click: quoted at the Engine bid and posted to the buyer only on the click, counted per day on clicks (#1541).';

ALTER TABLE public.buyer_profiles
  ADD CONSTRAINT buyer_profiles_enabled_offer_has_priority CHECK (NOT is_enabled OR priority IS NOT NULL OR sold_on = 'click');
ALTER TABLE public.buyer_profiles
  DROP CONSTRAINT IF EXISTS buyer_profiles_enabled_has_priority;

ALTER TABLE public.buyer_profiles
  ADD CONSTRAINT buyer_profiles_click_has_daily_cap_only CHECK (
    sold_on = 'offer' OR (hourly_lead_cap IS NULL AND hourly_spend_cap_cents IS NULL AND daily_spend_cap_cents IS NULL)
  );

-- ── buyer_profile_document ───────────────────────────────────────────────────
-- As before, plus sold_on.
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
COMMENT ON FUNCTION public.buyer_profile_document(uuid) IS 'A buyer profile and its children as one sorted document (#1409), with its sold_on kind (#1541). What save_buyer_profile returns and diffs.';
REVOKE ALL ON FUNCTION public.buyer_profile_document(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_document(uuid) TO service_role;

-- ── save_buyer_profile ───────────────────────────────────────────────────────
-- As in 20260921221007, plus sold_on: resolved from the document, else the
-- stored kind, else 'offer'; refused by name when unknown, when it switches
-- while tiers or accept rules are stored, and for a click buyer carrying tiers
-- or an hourly or spend cap. The audit diff picks sold_on up through
-- buyer_profile_flatten, which flattens every top level scalar.
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

  SELECT version, sold_on INTO v_version, v_stored_sold_on FROM buyer_profiles WHERE partner_id = p_partner FOR UPDATE;
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
    partner_id, organization_id, sold_on, is_enabled, priority, allowed_states,
    debt_min, debt_max, loan_amount_min,
    hourly_lead_cap, daily_lead_cap, hourly_spend_cap_cents, daily_spend_cap_cents,
    updated_by, updated_by_email, updated_by_name
  ) VALUES (
    p_partner, p_org, v_sold_on,
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
  'The only writer of a buyer profile (#1409): versioned, transactional, one audit row of changed paths. Refuses stale_version (BP409, detail holds the current document), tiers_gap, population_not_wired, sold_on_invalid, sold_on_locked, click_buyer_priced and click_buyer_cap_unsupported (BP422, #1541), partner_not_found (P0002).';
REVOKE ALL ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) TO service_role;
