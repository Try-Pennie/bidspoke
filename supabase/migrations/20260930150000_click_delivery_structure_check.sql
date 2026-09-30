-- The table itself refuses a malformed click delivery (#1639, review of PR #1673).
--
-- 20260930140000 checked a delivery's structure only inside save_buyer_profile,
-- and its CHECK asked only that the value be an object. A row written any other
-- way (a hand UPDATE, a future writer) could hold routes that are not a list,
-- which every reader of the enabled profiles would then have to survive. The
-- structure check is now the table's own CHECK, so nothing malformed can be
-- stored however it is written.
--
-- click_delivery_problem becomes truly IMMUTABLE, as a CHECK requires: its
-- messages are built with || rather than format(), which is only STABLE. It
-- also refuses a route name with spaces around it, because the history and the
-- form's diff key a route by its name exactly as stored.
--
-- Expand only (docs/adr/0007): CREATE OR REPLACE of one function with an
-- unchanged signature, and a new CHECK every existing row satisfies (every
-- click_delivery is null as this is written, measured 2026-09-30: 2 profiles,
-- 0 with a delivery).

CREATE OR REPLACE FUNCTION public.click_delivery_problem(p_delivery jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r jsonb;
  s text;
  v_name text;
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
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN 'a route is not an object'; END IF;
    IF jsonb_typeof(r->'name') IS DISTINCT FROM 'string' OR btrim(r->>'name') = '' THEN RETURN 'a route has no name'; END IF;
    v_name := r->>'name';
    IF v_name <> btrim(v_name) THEN RETURN 'route ' || v_name || ' has spaces around its name'; END IF;
    IF v_name = ANY (v_names) THEN RETURN 'two routes are named ' || v_name; END IF;
    v_names := v_names || v_name;
    IF jsonb_typeof(r->'url') IS DISTINCT FROM 'string' OR (r->>'url') !~ '^https://[^/[:space:]]+' THEN RETURN 'route ' || v_name || ' has no https address'; END IF;
    IF jsonb_typeof(r->'states') IS DISTINCT FROM 'array' THEN RETURN 'route ' || v_name || ' has no states list'; END IF;
    IF jsonb_array_length(r->'states') = 0 THEN v_catch_alls := v_catch_alls + 1; END IF;
    FOR s IN SELECT DISTINCT value FROM jsonb_array_elements_text(r->'states') LOOP
      IF NOT (s = ANY (v_known)) THEN RETURN 'route ' || v_name || ' lists ' || s || ', which is not a state'; END IF;
      IF s = ANY (v_states) THEN RETURN s || ' is in more than one route'; END IF;
      v_states := v_states || s;
    END LOOP;
  END LOOP;
  IF v_catch_alls <> 1 THEN RETURN v_catch_alls::text || ' routes have no states, and exactly one must'; END IF;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION public.click_delivery_problem(jsonb) IS 'The first structural problem with a click buyer''s delivery, or null (#1639). save_buyer_profile refuses click_delivery_invalid with it, and buyer_profiles_click_delivery_well_formed refuses any other write.';
REVOKE ALL ON FUNCTION public.click_delivery_problem(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.click_delivery_problem(jsonb) TO service_role;

ALTER TABLE public.buyer_profiles
  ADD CONSTRAINT buyer_profiles_click_delivery_well_formed CHECK (click_delivery IS NULL OR public.click_delivery_problem(click_delivery) IS NULL);
