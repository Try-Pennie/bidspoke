-- The zone a buyer profile's hours are shown in (#2143, PM-10, part of #2114).
--
-- The partners page shows a buyer's operating hours, and the moment its click
-- count resets, in a zone the person chooses per buyer profile: Eastern,
-- Central, Mountain or Pacific. It is a display choice only. The hours stay
-- stored and judged in Eastern, the click count still resets at midnight
-- Pacific, and nothing that judges a lead reads this column
-- (display-time-zone-is-display-only.test.ts).
--
-- 1. buyer_profiles.display_time_zone: text, NULL meaning never chosen (shown in
--    Eastern), with a CHECK naming the four zones. The list is DISPLAY_TIME_ZONES
--    in packages/buyer-profile/src/clock.ts; buyer_profile_display_time_zone.test.sql
--    reads the CHECK's values out of pg_constraint and compares them with the
--    generated fixture of that constant (L41).
-- 2. _apply_buyer_profile, the one body of save_buyer_profile and
--    save_partner_page: an absent key keeps the stored zone, null clears it,
--    and a zone outside the list is refused by name (display_time_zone_invalid,
--    BP422) ahead of the CHECK. Replaced from 20261016000000, which is the body
--    production runs (its prosrc md5 matched the replayed migration on
--    2026-10-15); every line but the zone's is unchanged.
-- 3. buyer_profile_document returns it. Replaced from 20260930140000, likewise
--    matched against production. buyer_profile_flatten is NOT replaced: it
--    already passes through every scalar key of the document, so the zone is a
--    path of its own in the history (flatten-cases.json pins that).
--
-- Expand only (docs/adr/0007): one nullable column, two functions replaced with
-- their signatures kept. The release before never sends the key, so its saves
-- keep the stored zone, and its parser drops the key from the document it reads.

-- ── 1. The column ────────────────────────────────────────────────────────────
ALTER TABLE public.buyer_profiles
  ADD COLUMN IF NOT EXISTS display_time_zone text NULL
  CONSTRAINT buyer_profiles_display_time_zone_check
  CHECK (display_time_zone IN ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'));
COMMENT ON COLUMN public.buyer_profiles.display_time_zone IS
  'The zone the partners page shows this buyer''s hours and click count reset in (#2143). Display only: the hours are stored and judged in Eastern and the click count resets at midnight Pacific whatever it says. NULL means never chosen, shown in Eastern. The CHECK is DISPLAY_TIME_ZONES in packages/buyer-profile/src/clock.ts.';

-- ── 2. _apply_buyer_profile ──────────────────────────────────────────────────
-- As in 20261016000000, plus the display time zone.
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
  v_stored_tz text;
  v_tz text;
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
  SELECT sold_on, click_delivery, display_time_zone INTO v_stored_sold_on, v_stored_delivery, v_stored_tz FROM buyer_profiles WHERE partner_id = p_partner;
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

  -- The zone the page shows the hours in (#2143). Absent keeps what is stored,
  -- so a caller that predates the column cannot blank it by omission; a JSON
  -- null clears it back to Eastern. Refused by name ahead of the CHECK, which
  -- holds the same list (buyer_profile_display_time_zone.test.sql compares both
  -- with DISPLAY_TIME_ZONES).
  v_tz := CASE WHEN p_profile ? 'display_time_zone' THEN p_profile->>'display_time_zone' ELSE v_stored_tz END;
  IF v_tz IS NOT NULL AND v_tz NOT IN ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles') THEN
    RAISE EXCEPTION 'display_time_zone_invalid' USING ERRCODE = 'BP422', DETAIL = v_tz;
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
    partner_id, organization_id, sold_on, click_delivery, display_time_zone, is_enabled, priority, allowed_states,
    debt_min, debt_max, loan_amount_min,
    hourly_lead_cap, daily_lead_cap, hourly_spend_cap_cents, daily_spend_cap_cents,
    updated_by, updated_by_email, updated_by_name
  ) VALUES (
    p_partner, p_org, v_sold_on, v_delivery, v_tz,
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
    display_time_zone = EXCLUDED.display_time_zone,
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
  'The body of a buyer profile save (#2133): the kind, delivery and display time zone (#2143) rules, the rows, tier contiguity, the version bump and one audit row of changed paths plus p_audit_extra. Internal: its caller holds the partner and profile row locks, in that order, and has compared the version. Called by save_buyer_profile and save_partner_page only.';
-- service_role too: this one skips the locks and the version comparison, and
-- the Worker must reach it only through save_buyer_profile and save_partner_page.
REVOKE ALL ON FUNCTION public._apply_buyer_profile(uuid, uuid, jsonb, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. buyer_profile_document ────────────────────────────────────────────────
-- As in 20260930140000, plus display_time_zone.
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
    'display_time_zone', p.display_time_zone,
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
COMMENT ON FUNCTION public.buyer_profile_document(uuid) IS 'A buyer profile and its children as one sorted document (#1409), with its sold_on kind (#1541) and a click buyer''s delivery, null when none (#1639), and the zone its hours are shown in, null when never chosen (#2143). What save_buyer_profile and save_partner_page return and diff.';
REVOKE ALL ON FUNCTION public.buyer_profile_document(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_profile_document(uuid) TO service_role;

-- ── save_buyer_profile's description names the new refusal ────────────────────
COMMENT ON FUNCTION public.save_buyer_profile(uuid, uuid, integer, jsonb, uuid, text) IS
  'The buyer profile save of the old PUT /partners/:id/buyer-profile route (#1409), kept one release beside save_partner_page (#2133): versioned, transactional, one audit row of changed paths tagged _route legacy_buyer_profile. Locks the partner row, then the profile row. Refuses stale_version (BP409, detail holds the current document), tiers_gap, population_not_wired, sold_on_invalid, sold_on_locked, click_buyer_priced, click_buyer_cap_unsupported (BP422, #1541), click_delivery_on_offer_buyer and click_delivery_invalid (BP422, #1639), display_time_zone_invalid (BP422, #2143), partner_not_found (P0002). A document without click_delivery or display_time_zone keeps the stored one.';
