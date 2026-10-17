-- The partner delete that knows up front (#2140, PR9 of #2114).
--
-- Proves, against migrations replayed from empty:
--  1. partner_delete_dependents() names exactly the tables the Worker labels
--     (apps/worker/src/partner-delete/labels/dependents.json), each with the
--     right kind, so a new foreign key to partner_configs cannot reach the
--     delete box unlabelled, and a label cannot outlive its table;
--  2. partner_delete_check and partner_delete_dependents are STABLE, and the
--     grants are exact: anon and authenticated execute none of the new or
--     replaced functions, and service_role only the check, the two deletes and
--     change_partner_uuid, never the dependency walk, the counter or the
--     shared delete body;
--  3. the same rule as the delete: for each fixture partner the check reports a
--     blocker exactly when delete_partner_config raises BP023;
--  4. every row the delete removes is from a table the check reported, in the
--     number it reported, and its two sub-account IDs are gone with it (another
--     organization's mapping of the same slug is not);
--  5. the reviewed consequence is the one that runs: a sub-account ID added
--     after the check, a workflow changed, added or soft deleted after it, each
--     refuse BP024 and delete nothing; a malformed fingerprint refuses BP422;
--  6. the four argument delete of the release before deletes the sub-account
--     IDs too;
--  7. change_partner_uuid's add waits on a delete in flight and then refuses
--     partner_not_found, rather than leaving a mapping to a gone slug (a second
--     session through dblink).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds. Fixed ids, deleted first, so a rerun starts clean. No real identity.
--
-- Mutations tried (each turned its case red, then was put back):
--  - the partner_uuid_map arm removed from partner_delete_dependents: case 1
--    red (a label for a table that is no longer a dependent);
--  - the recursion limited to depth 1: case 1 red (no bid_matrix_rows,
--    bid_config_history or buyer profile child tables);
--  - the uuid map delete removed from _delete_partner_config: case 4 red
--    (partner_uuid_map lost 0, reported 2);
--  - the counts comparison removed: case 5 red (a sub-account ID added after
--    the check was deleted without a refusal);
--  - the workflows comparison removed: case 5 red;
--  - change_partner_uuid's FOR KEY SHARE removed: case 7 red (the add did not
--    wait, and left a mapping to the deleted slug);
--  - a label (held_click_claims) removed from the container's copy of
--    dependents.json: case 1 red (a dependent with no label).

\if :{?self_host}
\else
  \echo 'partner_delete.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  \quit
\endif
SELECT set_config('pd_test.self_host', :'self_host', false) AS self_host_set \gset

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Org A: 00002140-...-0001. Org B (the same slug, another organization): -0002.
DO $do$
DECLARE o uuid;
BEGIN
  FOREACH o IN ARRAY ARRAY['11111111-1111-1111-1111-000021400001'::uuid, '11111111-1111-1111-1111-000021400002'::uuid] LOOP
    DELETE FROM public.buyer_sales WHERE organization_id = o;
    DELETE FROM public.held_click_claims WHERE organization_id = o;
    DELETE FROM public.partner_uuid_map WHERE org_id = o;
    DELETE FROM public.partner_configs WHERE organization_id = o;
    DELETE FROM public.workflows WHERE organization_id = o;
    DELETE FROM public.audit_log WHERE organization_id = o;
    DELETE FROM public.users WHERE organization_id = o;
    DELETE FROM public.organizations WHERE id = o;
  END LOOP;
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('11111111-1111-1111-1111-000021400001', 'Delete Org A', 'delete-org-a'),
  ('11111111-1111-1111-1111-000021400002', 'Delete Org B', 'delete-org-b');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES
  ('22222222-2222-2222-2222-000021400001', '11111111-1111-1111-1111-000021400001', 'dana@example.test', 'Dana');

-- Builds one partner with every kind of dependent, under org A unless told.
CREATE FUNCTION pg_temp.full_partner(p_id uuid, p_slug text, p_org uuid DEFAULT '11111111-1111-1111-1111-000021400001') RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_config uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, cf_secret_key)
  VALUES (p_id, p_org, initcap(p_slug), p_slug, 'buyer', true, upper(replace(p_slug, '-', '_')) || '_SECRET');
  INSERT INTO public.buyer_profiles (partner_id, organization_id, is_enabled) VALUES (p_id, p_org, false);
  INSERT INTO public.buyer_pricing_tiers (partner_id, organization_id, population, debt_from, debt_to, multiplier) VALUES
    (p_id, p_org, 'engine', 10000, 20000, 0.001), (p_id, p_org, 'engine', 20000, NULL, 0.002);
  INSERT INTO public.buyer_operating_windows (partner_id, organization_id, day_of_week, opens_minute, closes_minute) VALUES (p_id, p_org, 1, 540, 1020);
  INSERT INTO public.buyer_blackout_dates (partner_id, organization_id, blackout_date) VALUES (p_id, p_org, '2030-12-25');
  INSERT INTO public.partner_daily_counts (partner_id, date, count) VALUES (p_id, '2026-10-14', 3), (p_id, '2026-10-15', 4);
  INSERT INTO public.partner_bid_configs (id, organization_id, partner_id, slug, name) VALUES (v_config, p_org, p_id, p_slug || '-matrix', 'Matrix');
  INSERT INTO public.bid_matrix_rows (config_id, bid_amount) VALUES (v_config, 10), (v_config, 20), (v_config, 30);
  INSERT INTO public.bid_config_history (config_id, source, diff) VALUES (v_config, 'user_edit', '{}'::jsonb);
  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid) VALUES (p_org, p_slug, p_slug || '-sub-1'), (p_org, p_slug, p_slug || '-sub-2');
END
$$;

SELECT pg_temp.full_partner('33333333-3333-3333-3333-000021400001', 'delete-full');
SELECT pg_temp.full_partner('33333333-3333-3333-3333-000021400002', 'delete-sold');
SELECT pg_temp.full_partner('33333333-3333-3333-3333-000021400003', 'delete-held');
SELECT pg_temp.full_partner('33333333-3333-3333-3333-000021400004', 'delete-race');
SELECT pg_temp.full_partner('33333333-3333-3333-3333-000021400005', 'delete-legacy');
-- Another organization's partner naming the same Worker secret (slugs are unique
-- across organizations), and two mappings of the slug delete-full held by that
-- organization, which A's delete must not touch.
SELECT pg_temp.full_partner('33333333-3333-3333-3333-000021400006', 'delete-other', '11111111-1111-1111-1111-000021400002');
UPDATE public.partner_configs SET cf_secret_key = 'DELETE_FULL_SECRET' WHERE id = '33333333-3333-3333-3333-000021400006';
INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid) VALUES
  ('11111111-1111-1111-1111-000021400002', 'delete-full', 'org-b-sub-1'), ('11111111-1111-1111-1111-000021400002', 'delete-full', 'org-b-sub-2');
-- A bare partner, with no dependent rows at all.
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active)
VALUES ('33333333-3333-3333-3333-000021400007', '11111111-1111-1111-1111-000021400001', 'Delete Bare', 'delete-bare', 'source', true);
-- A sale for delete-sold, a held click for delete-held.
INSERT INTO public.buyer_sales (id, partner_id, organization_id, lead_key, population, kind, status, payout_cents, et_day, hour_bucket)
VALUES ('55555555-5555-5555-5555-000021400001', '33333333-3333-3333-3333-000021400002', '11111111-1111-1111-1111-000021400001', 'lead-1', 'engine', 'live', 'accepted', 2500, '2026-10-15', '2026-10-15T16:00:00Z');
INSERT INTO public.held_click_claims (organization_id, partner_id, prospect_id, reason, detail, execution_id, last_execution_id)
VALUES ('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400003', 'a0B000000002140AAA', 'outcome_unknown', 'timed out', 'exec-1', 'exec-1');
INSERT INTO public.workflows (id, organization_id, name) VALUES
  ('44444444-4444-4444-4444-000021400001', '11111111-1111-1111-1111-000021400001', 'Delete Flow One'),
  ('44444444-4444-4444-4444-000021400002', '11111111-1111-1111-1111-000021400001', 'Delete Flow Two');

-- The fingerprint the Worker builds from the check and the workflows it read.
CREATE FUNCTION pg_temp.fingerprint(p_org uuid, p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'counts', (SELECT coalesce(jsonb_object_agg(d ->> 'table', (d ->> 'rows')::bigint), '{}'::jsonb) FROM jsonb_array_elements(public.partner_delete_check(p_org, p_id) -> 'dependents') d),
    'workflows', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'updated_at', w.updated_at)), '[]'::jsonb) FROM public.workflows w WHERE w.organization_id = p_org AND w.deleted_at IS NULL)
  )
$$;

-- ── 1. The dependents are exactly the labelled tables, with the right kinds ──
DO $do$
DECLARE
  v_labels jsonb := pg_read_file('/sql-suite-fixtures/partner-delete/dependents.json')::jsonb -> 'tables';
  v_unlabelled text;
  v_stale text;
  v_kinds jsonb;
BEGIN
  SELECT string_agg(DISTINCT d.table_name, ', ') INTO v_unlabelled FROM public.partner_delete_dependents() d WHERE NOT v_labels ? d.table_name;
  IF v_unlabelled IS NOT NULL THEN RAISE EXCEPTION 'case 1: dependents with no label in dependents.json: %', v_unlabelled; END IF;
  SELECT string_agg(k, ', ') INTO v_stale FROM jsonb_object_keys(v_labels) k WHERE NOT EXISTS (SELECT 1 FROM public.partner_delete_dependents() d WHERE d.table_name = k);
  IF v_stale IS NOT NULL THEN RAISE EXCEPTION 'case 1: labels for tables that are no longer dependents: %', v_stale; END IF;

  SELECT jsonb_object_agg(c.table_name, c.kind) INTO v_kinds FROM public.partner_delete_counts('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400001', false) c;
  IF v_kinds IS DISTINCT FROM '{
    "buyer_sales": "blocks", "held_click_claims": "blocks",
    "buyer_profiles": "deleted", "buyer_pricing_tiers": "deleted", "buyer_operating_windows": "deleted", "buyer_blackout_dates": "deleted",
    "partner_daily_counts": "deleted", "partner_bid_configs": "deleted", "bid_matrix_rows": "deleted", "bid_config_history": "deleted",
    "partner_uuid_map": "deleted"}'::jsonb THEN
    RAISE EXCEPTION 'case 1: kinds %', v_kinds;
  END IF;

  -- A scratch child of a cascaded table is found, and a scratch restrict key
  -- to the partner blocks, on every run, so the walk cannot rot.
  BEGIN
    CREATE TABLE public.scratch_2140_grandchild (id uuid PRIMARY KEY, row_id uuid REFERENCES public.bid_matrix_rows(id) ON DELETE CASCADE);
    CREATE TABLE public.scratch_2140_blocker (id uuid PRIMARY KEY, p uuid REFERENCES public.partner_configs(id));
    SELECT jsonb_object_agg(d.table_name, d.on_delete || ':' || d.depth) INTO v_kinds FROM public.partner_delete_dependents() d WHERE d.table_name LIKE 'scratch_2140_%';
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'scratch_undo', DETAIL = coalesce(v_kinds::text, '{}');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_stale = PG_EXCEPTION_DETAIL;
    IF v_stale::jsonb IS DISTINCT FROM '{"scratch_2140_grandchild": "cascade:3", "scratch_2140_blocker": "no action:1"}'::jsonb THEN
      RAISE EXCEPTION 'case 1: the scratch keys were walked as %', v_stale;
    END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('dependents are the labelled tables');
END
$do$;

-- ── 2. STABLE, and exact grants ──────────────────────────────────────────────
DO $do$
DECLARE
  fn text;
  bad text[] := '{}';
BEGIN
  FOREACH fn IN ARRAY ARRAY['partner_delete_check', 'partner_delete_dependents'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = fn AND provolatile = 's') THEN
      bad := array_append(bad, fn || ' is not STABLE');
    END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY[
    'public.partner_delete_dependents()', 'public.partner_delete_counts(uuid, uuid, boolean)', 'public.partner_delete_check(uuid, uuid)',
    'public._delete_partner_config(uuid, uuid, uuid, text, jsonb)', 'public.delete_partner_config(uuid, uuid, uuid, text, jsonb)',
    'public.change_partner_uuid(uuid, text, text, text, uuid, text, text)'
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') THEN bad := array_append(bad, 'anon executes ' || fn); END IF;
    IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN bad := array_append(bad, 'authenticated executes ' || fn); END IF;
    IF has_function_privilege('service_role', fn, 'EXECUTE') IS DISTINCT FROM (fn NOT IN ('public.partner_delete_dependents()', 'public.partner_delete_counts(uuid, uuid, boolean)', 'public._delete_partner_config(uuid, uuid, uuid, text, jsonb)')) THEN
      bad := array_append(bad, 'service_role grant wrong on ' || fn);
    END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'case 2: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('stable and exact grants');
END
$do$;

-- ── 3. A blocker is reported exactly when the delete refuses BP023 ───────────
DO $do$
DECLARE
  p uuid;
  v_check jsonb;
  v_blocked boolean;
  v_refused boolean;
  v_detail text;
BEGIN
  FOREACH p IN ARRAY ARRAY['33333333-3333-3333-3333-000021400002'::uuid, '33333333-3333-3333-3333-000021400003'::uuid, '33333333-3333-3333-3333-000021400007'::uuid] LOOP
    v_check := public.partner_delete_check('11111111-1111-1111-1111-000021400001', p);
    v_blocked := EXISTS (SELECT 1 FROM jsonb_array_elements(v_check -> 'dependents') d WHERE (d ->> 'blocking_rows')::bigint > 0);
    BEGIN
      -- In a block that is always undone, so a delete that goes through is rolled back.
      BEGIN
        PERFORM public.delete_partner_config('11111111-1111-1111-1111-000021400001', p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', pg_temp.fingerprint('11111111-1111-1111-1111-000021400001', p));
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'went_through';
      EXCEPTION WHEN SQLSTATE 'BP023' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        v_refused := true;
      END;
    EXCEPTION WHEN raise_exception THEN
      v_refused := false;
    END;
    IF v_blocked IS DISTINCT FROM v_refused THEN
      RAISE EXCEPTION 'case 3: partner % check blocked=% but delete refused=% (%)', p, v_blocked, v_refused, v_check;
    END IF;
  END LOOP;
  -- The sold one names its table and count in the refusal.
  BEGIN
    PERFORM public.delete_partner_config('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400002', '22222222-2222-2222-2222-000021400001', 'dana@example.test', pg_temp.fingerprint('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400002'));
    RAISE EXCEPTION 'case 3: a partner with a sale was deleted';
  EXCEPTION WHEN SQLSTATE 'BP023' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail IS DISTINCT FROM '1 rows in buyer_sales' THEN RAISE EXCEPTION 'case 3: refusal detail %', v_detail; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021400007') THEN
    RAISE EXCEPTION 'case 3: the undone delete of the bare partner was kept';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('blocked exactly when refused');
END
$do$;

-- ── 4. The delete removes exactly what the check reported ────────────────────
CREATE TEMP TABLE pd_counts_before (t text PRIMARY KEY, n bigint);
CREATE TEMP TABLE pd_counts_after (t text PRIMARY KEY, n bigint);
CREATE FUNCTION pg_temp.count_all(p_into text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; n bigint;
BEGIN
  EXECUTE format('DELETE FROM %I', p_into);
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.relname) INTO n;
    EXECUTE format('INSERT INTO %I VALUES ($1, $2)', p_into) USING r.relname, n;
  END LOOP;
END
$$;

DO $do$
DECLARE
  v_check jsonb;
  v_reported jsonb;
  v_wrong text;
BEGIN
  v_check := public.partner_delete_check('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400001');
  SELECT jsonb_object_agg(d ->> 'table', (d ->> 'rows')::bigint) INTO v_reported FROM jsonb_array_elements(v_check -> 'dependents') d;
  IF v_reported IS DISTINCT FROM '{"buyer_sales": 0, "held_click_claims": 0, "buyer_profiles": 1, "buyer_pricing_tiers": 2, "buyer_operating_windows": 1,
      "buyer_blackout_dates": 1, "partner_daily_counts": 2, "partner_bid_configs": 1, "bid_matrix_rows": 3, "bid_config_history": 1, "partner_uuid_map": 2}'::jsonb THEN
    RAISE EXCEPTION 'case 4: the check reported %', v_reported;
  END IF;
  IF v_check -> 'secret' IS DISTINCT FROM '{"name": "DELETE_FULL_SECRET", "other_partners": 1}'::jsonb THEN
    RAISE EXCEPTION 'case 4: secret %', v_check -> 'secret';
  END IF;

  PERFORM pg_temp.count_all('pd_counts_before');
  PERFORM public.delete_partner_config('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400001', '22222222-2222-2222-2222-000021400001', 'dana@example.test', pg_temp.fingerprint('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400001'));
  PERFORM pg_temp.count_all('pd_counts_after');

  -- Every table that lost rows lost exactly what was reported (the partner row
  -- itself apart); every reported table lost exactly that; audit_log only grows.
  SELECT string_agg(format('%s lost %s, reported %s', b.t, b.n - a.n, coalesce(v_reported ->> b.t, 'nothing')), '; ') INTO v_wrong
  FROM pd_counts_before b JOIN pd_counts_after a USING (t)
  WHERE b.t <> 'partner_configs'
    AND (b.n - a.n) IS DISTINCT FROM coalesce((v_reported ->> b.t)::bigint, 0)
    AND NOT (b.t = 'audit_log' AND a.n >= b.n);
  IF v_wrong IS NOT NULL THEN RAISE EXCEPTION 'case 4: %', v_wrong; END IF;
  IF (SELECT b.n - a.n FROM pd_counts_before b JOIN pd_counts_after a USING (t) WHERE t = 'partner_configs') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'case 4: partner_configs did not lose exactly one row';
  END IF;

  -- Its two sub-account IDs are gone; org B's mapping of the same slug is not.
  IF EXISTS (SELECT 1 FROM public.partner_uuid_map WHERE org_id = '11111111-1111-1111-1111-000021400001' AND partner_slug = 'delete-full') THEN
    RAISE EXCEPTION 'case 4: the sub-account IDs survived the delete';
  END IF;
  IF (SELECT count(*) FROM public.partner_uuid_map WHERE org_id = '11111111-1111-1111-1111-000021400002' AND partner_slug = 'delete-full') IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'case 4: another organization''s mapping of the same slug was touched';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('removes exactly what was reported');
END
$do$;

-- ── 5. The reviewed consequence is the one that runs ─────────────────────────
DO $do$
DECLARE
  v_fp jsonb;
  v_detail text;
  v_msg text;
  org uuid := '11111111-1111-1111-1111-000021400001';
  p uuid := '33333333-3333-3333-3333-000021400004';
BEGIN
  -- A sub-account ID added after the check.
  v_fp := pg_temp.fingerprint(org, p);
  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid) VALUES (org, 'delete-race', 'delete-race-sub-3');
  BEGIN
    PERFORM public.delete_partner_config(org, p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', v_fp);
    RAISE EXCEPTION 'case 5: deleted after a sub-account ID was added';
  EXCEPTION WHEN SQLSTATE 'BP024' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_msg IS DISTINCT FROM 'partner_delete_consequence_changed' OR v_detail IS DISTINCT FROM 'counts' THEN RAISE EXCEPTION 'case 5: refusal % %', v_msg, v_detail; END IF;
  END;

  -- A workflow changed after the check (it starts reading the partner's click URL).
  v_fp := pg_temp.fingerprint(org, p);
  UPDATE public.workflows SET definition = '{"nodes": [{"type": "code", "config": {"code": "constants.DeleteRaceClickUrl"}}]}'::jsonb WHERE id = '44444444-4444-4444-4444-000021400001';
  BEGIN
    PERFORM public.delete_partner_config(org, p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', v_fp);
    RAISE EXCEPTION 'case 5: deleted after a workflow changed';
  EXCEPTION WHEN SQLSTATE 'BP024' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail IS DISTINCT FROM 'workflows' THEN RAISE EXCEPTION 'case 5: workflow change refusal %', v_detail; END IF;
  END;

  -- A workflow added, and one soft deleted, after the check.
  v_fp := pg_temp.fingerprint(org, p);
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-000021400003', org, 'Delete Flow Three');
  BEGIN
    PERFORM public.delete_partner_config(org, p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', v_fp);
    RAISE EXCEPTION 'case 5: deleted after a workflow was added';
  EXCEPTION WHEN SQLSTATE 'BP024' THEN NULL;
  END;
  v_fp := pg_temp.fingerprint(org, p);
  UPDATE public.workflows SET deleted_at = now() WHERE id = '44444444-4444-4444-4444-000021400003';
  BEGIN
    PERFORM public.delete_partner_config(org, p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', v_fp);
    RAISE EXCEPTION 'case 5: deleted after a workflow was soft deleted';
  EXCEPTION WHEN SQLSTATE 'BP024' THEN NULL;
  END;

  -- Malformed fingerprints are refused by name, never a cast error.
  FOREACH v_fp IN ARRAY ARRAY['{}'::jsonb, '{"counts": {}, "workflows": [{"id": "not-a-uuid", "updated_at": "2026-10-16T00:00:00Z"}]}'::jsonb,
                               '{"counts": {}, "workflows": [{"id": "44444444-4444-4444-4444-000021400001", "updated_at": "yesterday-ish"}]}'::jsonb] LOOP
    BEGIN
      PERFORM public.delete_partner_config(org, p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', v_fp);
      RAISE EXCEPTION 'case 5: a malformed fingerprint deleted';
    EXCEPTION WHEN SQLSTATE 'BP422' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg IS DISTINCT FROM 'expected_consequence_invalid' THEN RAISE EXCEPTION 'case 5: malformed refusal %', v_msg; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.delete_partner_config(org, p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', NULL);
    RAISE EXCEPTION 'case 5: a delete with no fingerprint went through';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.partner_configs WHERE id = p) THEN RAISE EXCEPTION 'case 5: a refused delete deleted'; END IF;

  -- A fresh check, and it goes through.
  PERFORM public.delete_partner_config(org, p, '22222222-2222-2222-2222-000021400001', 'dana@example.test', pg_temp.fingerprint(org, p));
  IF EXISTS (SELECT 1 FROM public.partner_configs WHERE id = p) OR EXISTS (SELECT 1 FROM public.partner_uuid_map WHERE org_id = org AND partner_slug = 'delete-race') THEN
    RAISE EXCEPTION 'case 5: the delete after a fresh check did not remove the partner and its three sub-account IDs';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('the reviewed consequence runs');
END
$do$;

-- ── 6. Only the reviewed delete exists, and it refuses a partner already gone ──
-- The release before's four argument form, which deleted without a reviewed
-- consequence, is dropped (#2254).
DO $do$
BEGIN
  IF to_regprocedure('public.delete_partner_config(uuid, uuid, uuid, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'case 6: the four argument delete_partner_config still exists';
  END IF;
  PERFORM public.delete_partner_config('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400005', '22222222-2222-2222-2222-000021400001', 'dana@example.test',
    pg_temp.fingerprint('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400005'));
  IF EXISTS (SELECT 1 FROM public.partner_uuid_map WHERE org_id = '11111111-1111-1111-1111-000021400001' AND partner_slug = 'delete-legacy') THEN
    RAISE EXCEPTION 'case 6: the delete left the sub-account IDs';
  END IF;
  BEGIN
    PERFORM public.delete_partner_config('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400005', '22222222-2222-2222-2222-000021400001', 'dana@example.test',
      '{"counts": {}, "workflows": []}'::jsonb);
    RAISE EXCEPTION 'case 6: deleting a deleted partner did not refuse';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  -- Another organization cannot delete org A's partner.
  BEGIN
    PERFORM public.delete_partner_config('11111111-1111-1111-1111-000021400002', '33333333-3333-3333-3333-000021400007', '22222222-2222-2222-2222-000021400001', 'dana@example.test',
      pg_temp.fingerprint('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400007'));
    RAISE EXCEPTION 'case 6: another organization deleted the partner';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM public.partner_delete_check('11111111-1111-1111-1111-000021400002', '33333333-3333-3333-3333-000021400007');
    RAISE EXCEPTION 'case 6: another organization read the check';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  INSERT INTO suite_cases(name) VALUES ('legacy delete and organization scope');
END
$do$;

-- ── 7. An add racing a delete waits for it, then refuses ─────────────────────
DO $do$
DECLARE
  created boolean := NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink');
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('pd_test.self_host'));
  v_pid integer;
  v_waiting boolean := false;
  i integer;
BEGIN
  IF created THEN CREATE EXTENSION dblink; END IF;
  -- Remembered for the next block, which drops it only if this run created it.
  PERFORM set_config('pd_test.created_dblink', created::text, false);
  PERFORM dblink_connect('pd_b', conn);
  SELECT pid INTO v_pid FROM dblink('pd_b', 'SELECT pg_backend_pid()') AS t(pid integer);
  -- This transaction holds the partner as the delete does.
  PERFORM 1 FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021400007' FOR UPDATE;
  PERFORM dblink_send_query('pd_b', $q$SELECT public.change_partner_uuid('11111111-1111-1111-1111-000021400001', 'delete-bare', 'delete-bare-late', 'add', '22222222-2222-2222-2222-000021400001', 'dana@example.test', 'Dana')$q$);
  -- Wait on the condition: the other session blocked on a lock.
  FOR i IN 1..200 LOOP
    SELECT wait_event_type = 'Lock' INTO v_waiting FROM pg_stat_activity WHERE pid = v_pid;
    EXIT WHEN v_waiting;
    PERFORM pg_sleep(0.05);
  END LOOP;
  IF NOT coalesce(v_waiting, false) THEN
    PERFORM dblink_cancel_query('pd_b');
    PERFORM dblink_disconnect('pd_b');
    RAISE EXCEPTION 'case 7: the add did not wait for the partner in delete';
  END IF;
  PERFORM public.delete_partner_config('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400007', '22222222-2222-2222-2222-000021400001', 'dana@example.test',
    pg_temp.fingerprint('11111111-1111-1111-1111-000021400001', '33333333-3333-3333-3333-000021400007'));
END
$do$;

DO $do$
DECLARE
  v_err text;
BEGIN
  BEGIN
    PERFORM * FROM dblink_get_result('pd_b', true) AS t(r jsonb);
    v_err := 'none';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  PERFORM dblink_disconnect('pd_b');
  IF current_setting('pd_test.created_dblink', true) = 'true' THEN DROP EXTENSION dblink; END IF;
  IF v_err NOT LIKE '%partner_not_found%' THEN RAISE EXCEPTION 'case 7: the late add answered %', v_err; END IF;
  IF EXISTS (SELECT 1 FROM public.partner_uuid_map WHERE partner_slug = 'delete-bare') THEN
    RAISE EXCEPTION 'case 7: a mapping to the deleted slug was left';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('an add racing a delete refuses');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 7 THEN RAISE EXCEPTION 'partner_delete.test.sql: expected 7 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_delete.test.sql: % cases passed', n;
END
$do$;
