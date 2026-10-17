-- The partners page notice (#2135, PR4 of #2114).
--
-- Every write to a table the partners page shows sends one private broadcast on
-- partners:<organization id> per partner per statement, from the database, so a
-- hand run SQL edit is heard as well as a save (ADR 0012). This proves, against
-- the realtime stub in scripts/sql-suite/bootstrap.sql:
--  - each page table carries its three notice triggers, and each versioned one
--    (all but partner_uuid_map, which has no version) its version trigger,
--    and every other table keyed to a partner is on the written exclusion list
--    below, found by state (foreign key, column name, and the columns a
--    production sample found holding a partner id or slug), not by one spelling
--    (L96, L247); and (case 2b, #2140) each such table is one a partner delete
--    removes or is refused by (partner_delete_dependents()), or is left by the
--    delete with a written reason;
--  - what a notice carries: ids, versions, column names, whether the change had
--    no actor, and never a field value;
--  - who sends: a hand write, save_partner_config, the legacy profile save, the
--    page save (exactly one notice, with its save_id and client_id), a partner
--    delete (one, and the cascade and its sub-account IDs are silent), change_partner_uuid (not direct),
--    and nothing for a last_probe_response only change or a save that changed
--    nothing;
--  - a missing realtime.messages partition never fails the write;
--  - monitor_partner_page_ping sends for a synthetic organization only, writes
--    no setting, and reports the partitions.
--
-- WHAT IT DOES NOT PROVE: delivery. The stub stores the row Realtime would
-- deliver; whether Realtime delivers it is what the Worker's delivery monitor
-- measures on production every five minutes.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds. Everything runs in one transaction that is rolled back, because the
-- realtime auth test after it needs today's partition to be absent.
--
-- Mutations tried. Each was applied by running the migration file, with that
-- one passage changed, over a suite container already built by run.sh, then
-- running this file against it (each turned its case red), then running the
-- unchanged migration again to put it back (it is idempotent):
-- - partner_configs_page_notice_upd dropped: case 1 red (0 UPDATE triggers);
-- - the notice_updated_by copy left out of partner_configs_capture_actor, and
--   the copy never cleared: case 4 red both ways;
-- - the version comparison removed from the partner_configs UPDATE branch:
--   case 6 red (a last_probe_response change sent a notice);
-- - 'buyer_profile_version_bump' off the profile trigger's skip list: case 9
--   red (the bump's own UPDATE sent a second notice);
-- - the partner exists filter removed from the profile DELETE branches: case 8
--   (delete_partner_config) and case 11 (a hand delete) red, the cascade sent a
--   second notice. A cascade runs at trigger depth 1, so pg_trigger_depth()
--   cannot tell it from a hand write: a depth check was tried first and survived;
-- - partner_uuid_map matched by slug alone: case 13 red;
-- - save_partner_page's skip removed from the partner trigger: case 12 red;
-- - a page save that moved nothing still notifying: case 12 red;
-- - change_partner_uuid without its set_config of bidspoke.actor_id: case 14
--   red; its add check not scoped to the organization: case 13 red;
-- - the is_synthetic check removed from monitor_partner_page_ping: case 16 red;
-- - (#2140) _delete_partner_config deleting the sub-account IDs before the
--   partner row: case 8 red (a second, direct uuids notice).
-- Case 2b's own mutation (a scratch table keyed by partner_slug) runs inside it.
-- The guard's own mutations (a scratch child table with a foreign key, a scratch
-- table keyed by partner_slug with none, a scratch column named
-- winner_partner_ref, a scratch partition of an excluded parent) are run by
-- case 2 itself on every run, so they cannot rot.

BEGIN;

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

-- Every bidspoke.* setting a writer leaves for the rest of its transaction. One
-- transaction holds every case here, where production gives each RPC its own.
CREATE FUNCTION pg_temp.reset_settings() RETURNS void LANGUAGE sql AS $$
  SELECT set_config(k, '', true) FROM unnest(ARRAY['bidspoke.actor_id', 'bidspoke.actor_email', 'bidspoke.actor_name', 'bidspoke.audit_handled',
    'bidspoke.updated_by_actor', 'bidspoke.notice_updated_by', 'bidspoke.audit_reason', 'bidspoke.audit_context']) k;
  SELECT NULL::void;
$$;
CREATE FUNCTION pg_temp.clear_notices() RETURNS void LANGUAGE sql AS $$
  DELETE FROM realtime.messages WHERE topic LIKE 'partners:%';
  SELECT pg_temp.reset_settings();
$$;
CREATE FUNCTION pg_temp.notices(p_org uuid) RETURNS SETOF jsonb LANGUAGE sql AS $$
  SELECT payload FROM realtime.messages
  WHERE topic = 'partners:' || p_org::text AND extension = 'broadcast' AND event = 'partner_changed' AND private IS TRUE;
$$;
CREATE FUNCTION pg_temp.one_notice(p_org uuid, p_case text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  v jsonb;
BEGIN
  SELECT count(*), min(x::text)::jsonb INTO n, v FROM pg_temp.notices(p_org) x;
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '%: expected exactly 1 notice on partners:%, got % (%)', p_case, p_org, n,
      (SELECT string_agg(x::text, ' | ') FROM pg_temp.notices(p_org) x);
  END IF;
  RETURN v;
END
$$;
CREATE FUNCTION pg_temp.notice_count(p_org uuid) RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::integer FROM pg_temp.notices(p_org);
$$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021350001', 'Notice Org', 'notice-org-2135');
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021350002', 'Other Notice Org', 'other-notice-org-2135');
INSERT INTO public.organizations (id, name, slug, is_synthetic) VALUES ('11111111-1111-1111-1111-000021350003', 'Monitor Org', 'monitor-org-2135', true);
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-00002135000a', '11111111-1111-1111-1111-000021350001', 'erin@example.test', 'Erin Suite');

DO $do$
DECLARE
  n integer;
BEGIN
  FOR n IN 1..5 LOOP
    INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email, updated_by_name)
    VALUES (format('33333333-3333-3333-3333-00002135000%s', n)::uuid, '11111111-1111-1111-1111-000021350001', format('Notice Buyer %s', n), format('notice-buyer-2135-%s', n),
            'buyer', true, '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
  END LOOP;
  INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active)
  VALUES ('33333333-3333-3333-3333-0000213500b1', '11111111-1111-1111-1111-000021350002', 'Other Buyer', 'other-buyer-2135', 'buyer', true);
  INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active)
  VALUES ('33333333-3333-3333-3333-0000213500c1', '11111111-1111-1111-1111-000021350003', 'Monitor Source', 'monitor-source-2135', 'source', true);
  -- Partners 3 and 4 carry a profile, saved through the legacy function.
  FOR n IN 3..4 LOOP
    PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021350001', format('33333333-3333-3333-3333-00002135000%s', n)::uuid, 0,
      '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
      '22222222-2222-2222-2222-00002135000a', 'erin@example.test');
  END LOOP;
  PERFORM pg_temp.reset_settings();
END
$do$;

-- ── 0. No partition for today: the write still lands, and nothing is stored ──
DO $do$
DECLARE
  v_day date := (now()::timestamp)::date;
  v_before integer;
  v_after integer;
  v_ping jsonb;
BEGIN
  PERFORM 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = 'realtime.messages'::regclass AND c.relname = 'messages_' || to_char(v_day, 'YYYY_MM_DD');
  IF FOUND THEN RAISE EXCEPTION 'case 0: a partition for % exists before the test made one; the missing partition case cannot be measured', v_day; END IF;

  PERFORM pg_temp.reset_settings();
  SELECT version INTO v_before FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021350001';
  UPDATE public.partner_configs SET name = 'Notice Buyer 1 renamed by hand' WHERE id = '33333333-3333-3333-3333-000021350001';
  SELECT version INTO v_after FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021350001';
  IF v_after IS DISTINCT FROM v_before + 1 THEN RAISE EXCEPTION 'case 0: the hand write did not land (version % to %)', v_before, v_after; END IF;
  IF (SELECT count(*) FROM realtime.messages) IS DISTINCT FROM 0::bigint THEN RAISE EXCEPTION 'case 0: a notice was stored with no partition'; END IF;

  v_ping := public.monitor_partner_page_ping('11111111-1111-1111-1111-000021350003', gen_random_uuid());
  IF (v_ping ->> 'partition_today')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'case 0: the ping reported today''s partition present: %', v_ping; END IF;
  INSERT INTO suite_cases(name) VALUES ('a missing partition never fails the write');
END
$do$;

SELECT sql_suite.create_realtime_partition((now()::timestamp)::date);

-- ── 1. Each page table carries its notice triggers and its version trigger ──
DO $do$
DECLARE
  t text;
  ev text;
  bit integer;
  n integer;
  bad text[] := '{}';
BEGIN
  IF public.partner_page_notice_tables() IS DISTINCT FROM ARRAY['partner_configs', 'buyer_profiles', 'buyer_operating_windows', 'buyer_blackout_dates', 'buyer_pricing_tiers', 'partner_uuid_map'] THEN
    RAISE EXCEPTION 'case 1: partner_page_notice_tables() is %', public.partner_page_notice_tables();
  END IF;
  FOREACH t IN ARRAY public.partner_page_notice_tables() LOOP
    FOR ev, bit IN SELECT * FROM (VALUES ('INSERT', 4), ('DELETE', 8), ('UPDATE', 16)) v(e, b) LOOP
      -- AFTER (bit 2 clear), FOR EACH STATEMENT (bit 1 clear), this event only,
      -- calling a page notice function.
      SELECT count(*) INTO n FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
      WHERE g.tgrelid = format('public.%I', t)::regclass AND NOT g.tgisinternal AND g.tgenabled <> 'D'
        AND (g.tgtype & 1) = 0 AND (g.tgtype & 2) = 0 AND (g.tgtype & 28) = bit AND p.proname LIKE '%page_notice%';
      IF n IS DISTINCT FROM 1 THEN bad := array_append(bad, format('%s has %s %s notice triggers', t, n, ev)); END IF;
    END LOOP;
    IF t <> 'partner_uuid_map' THEN
      SELECT count(*) INTO n FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
      WHERE g.tgrelid = format('public.%I', t)::regclass AND NOT g.tgisinternal AND g.tgenabled <> 'D'
        AND p.proname IN ('partner_configs_bump_version', 'buyer_profile_tables_bump_version');
      IF n = 0 THEN bad := array_append(bad, format('%s has no version trigger', t)); END IF;
    END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'case 1: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('page tables carry their triggers');
END
$do$;

-- ── 2. Every other table keyed to a partner is excluded by name, with a reason ─
-- Candidates, enumerated by state on PARENT tables only (a partition of an
-- excluded parent is covered by its parent):
--  (a) a foreign key to partner_configs or buyer_profiles;
--  (b) a column whose name contains partner, slug or buyer;
--  (c) the columns a production sample found holding a partner id or slug that
--      (a) and (b) miss (2026-10-15, TABLESAMPLE over every uuid and text
--      column of every public parent table, read only), named here.
-- (c), written once: the guard reads it, and case 2 checks each still exists.
CREATE TEMP TABLE measured_partner_columns (t text NOT NULL, col text NOT NULL);
INSERT INTO measured_partner_columns VALUES
  ('api_sources', 'name'),
  ('source_workflow_assignments', 'source_name'),
  ('webhook_endpoints', 'source_name'),
  ('webhook_endpoints', 'subdomain'),
  ('workflow_executions', 'source'),
  ('audit_log', 'entity_id');

-- The candidates, once, for both guards: this one (the page's notices) and
-- case 2b (the partner delete, #2140).
CREATE FUNCTION pg_temp.partner_keyed_candidates() RETURNS TABLE (t text, col text) LANGUAGE sql AS $$
    SELECT c.relname::text AS t, NULL::text AS col
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND k.contype = 'f' AND NOT c.relispartition
      AND k.confrelid IN ('public.partner_configs'::regclass, 'public.buyer_profiles'::regclass)
    UNION
    SELECT c.relname::text, a.attname::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND a.attname ~ '(partner|slug|buyer)'
    UNION
    SELECT m.t, m.col FROM measured_partner_columns m
$$;

-- Columns that hold a partner's name or id as a VALUE rather than a key, with
-- the reason, written once for both guards (case 2 and case 2b): neither the
-- page's notices nor a partner delete has anything to do with them.
CREATE TEMP TABLE partner_value_columns (t text NOT NULL, col text NOT NULL, reason text NOT NULL);
INSERT INTO partner_value_columns VALUES
  ('lead_sightings', 'winning_partner_slug', 'the sighting''s recorded outcome, history kept by design'),
  ('lead_sightings', 'external_partner_name', 'the sighting''s recorded outcome, history kept by design'),
  ('lead_sightings', 'partners_attempted', 'the sighting''s recorded outcome, history kept by design'),
  ('lead_sightings', 'partners_responded', 'the sighting''s recorded outcome, history kept by design'),
  ('organizations', 'slug', 'an organization, not a partner'),
  ('service_presets', 'slug', 'a service preset, not a partner'),
  ('sf_bid_matrix_audit', 'partner_flags', 'a snapshot of the Salesforce bid matrix, not a partner setting'),
  ('api_sources', 'name', 'an API source''s own name, which a source partner''s slug can equal'),
  ('source_workflow_assignments', 'source_name', 'an API source''s name, which a source partner''s slug can equal'),
  ('webhook_endpoints', 'source_name', 'an API source''s name, which a source partner''s slug can equal'),
  ('webhook_endpoints', 'subdomain', 'an endpoint''s host name, which a source partner''s slug can equal'),
  ('workflow_executions', 'source', 'the run''s recorded source, history kept by design');
-- A column excluded by its name on whatever table holds it, with its reason.
CREATE TEMP TABLE partner_value_column_names (col text NOT NULL, reason text NOT NULL);
INSERT INTO partner_value_column_names VALUES
  ('buyer_reference', 'the buyer''s own lead id, a value rather than a key to a partner'),
  ('partner_lead_id', 'the buyer''s own lead id, a value rather than a key to a partner');

CREATE FUNCTION pg_temp.partner_page_unregistered() RETURNS TABLE (candidate text) LANGUAGE sql AS $$
  WITH candidates AS (
    SELECT k.t, k.col FROM pg_temp.partner_keyed_candidates() k
  ),
  excluded_tables(t, reason) AS (VALUES
    ('buyer_sales', 'sale records, not settings'),
    ('held_click_claims', 'sale records, not settings (partner_lead_id is the buyer''s own lead id)'),
    ('partner_daily_counts', 'counts written by the daily cap Durable Object'),
    ('partner_bid_configs', 'the Bid Group tab, with its own writers; its slug names the config, not a partner'),
    ('lead_sighting_bids', 'monthly partitioned bid attempt history keyed by partner_slug'),
    ('partner_page_live_misses', 'observations of this channel''s delivery, not settings'),
    ('audit_log', 'the history of changes, written by the triggers this page reads')
  )
  SELECT c.t || coalesce('.' || c.col, ' (foreign key)')
  FROM candidates c
  WHERE c.t <> ALL (public.partner_page_notice_tables())
    AND NOT EXISTS (SELECT 1 FROM excluded_tables e WHERE e.t = c.t)
    AND NOT EXISTS (SELECT 1 FROM partner_value_columns e WHERE e.t = c.t AND e.col = c.col)
    AND NOT EXISTS (SELECT 1 FROM partner_value_column_names e WHERE e.col = c.col)
  ORDER BY 1;
$$;

DO $do$
DECLARE
  v_found text;
  m record;
BEGIN
  -- Each measured column must still exist, so a rename is noticed rather than
  -- leaving a name here that guards nothing.
  IF (SELECT count(*) FROM measured_partner_columns) = 0 THEN RAISE EXCEPTION 'case 2: the measured column list is empty'; END IF;
  FOR m IN SELECT t, col FROM measured_partner_columns LOOP
    PERFORM 1 FROM pg_attribute WHERE attrelid = format('public.%I', m.t)::regclass AND attname = m.col AND NOT attisdropped;
    IF NOT FOUND THEN RAISE EXCEPTION 'case 2: the measured column %.% no longer exists; re-measure and update this list', m.t, m.col; END IF;
  END LOOP;

  SELECT string_agg(candidate, ', ') INTO v_found FROM pg_temp.partner_page_unregistered();
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'case 2: tables keyed to a partner that are neither page tables nor excluded with a reason: %', v_found;
  END IF;

  -- The guard's own mutations, on every run. Each scratch table must be reported,
  -- then the block is undone by raising.
  BEGIN
    CREATE TABLE public.scratch_2135_child (id uuid PRIMARY KEY, p uuid REFERENCES public.partner_configs(id));
    CREATE TABLE public.scratch_2135_keyed (id uuid PRIMARY KEY, partner_slug text);
    CREATE TABLE public.scratch_2135_named (id uuid PRIMARY KEY, winner_partner_ref text);
    SELECT string_agg(candidate, ', ') INTO v_found FROM pg_temp.partner_page_unregistered();
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'scratch_undo', DETAIL = coalesce(v_found, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_found = PG_EXCEPTION_DETAIL;
    IF v_found NOT LIKE '%scratch_2135_child (foreign key)%' THEN RAISE EXCEPTION 'case 2: a scratch child table with a foreign key was not reported (%)', v_found; END IF;
    IF v_found NOT LIKE '%scratch_2135_keyed.partner_slug%' THEN RAISE EXCEPTION 'case 2: a scratch table keyed by partner_slug was not reported (%)', v_found; END IF;
    IF v_found NOT LIKE '%scratch_2135_named.winner_partner_ref%' THEN RAISE EXCEPTION 'case 2: a scratch winner_partner_ref column was not reported (%)', v_found; END IF;
  END;
  BEGIN
    -- A new monthly partition of an excluded parent never trips the guard.
    CREATE TABLE public.lead_sighting_bids_scratch_2135 PARTITION OF public.lead_sighting_bids FOR VALUES FROM ('2099-01-01') TO ('2099-02-01');
    SELECT string_agg(candidate, ', ') INTO v_found FROM pg_temp.partner_page_unregistered();
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'scratch_undo', DETAIL = coalesce(v_found, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_found = PG_EXCEPTION_DETAIL;
    IF v_found <> '' THEN RAISE EXCEPTION 'case 2: a partition of an excluded parent was reported: %', v_found; END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('every partner keyed table is a page table or excluded');
END
$do$;

-- ── 2b. Every table keyed to a partner is a delete dependent or excluded ─────
-- The partner delete (#2140) removes or is refused by exactly what
-- partner_delete_dependents() names (supabase/tests/partner_delete.test.sql
-- proves that). This holds every other table keyed to a partner, found by the
-- same candidates as case 2, to a written reason why a delete leaves it.
CREATE FUNCTION pg_temp.partner_delete_unregistered() RETURNS TABLE (candidate text) LANGUAGE sql AS $$
  WITH excluded_tables(t, reason) AS (VALUES
    ('lead_sighting_bids', 'bid attempt history, kept by design when a partner is deleted'),
    ('partner_page_live_misses', 'observations of the live channel''s delivery, not the partner''s'),
    ('audit_log', 'the history of changes, kept by design, the delete''s own row included')
  )
  SELECT DISTINCT k.t || coalesce('.' || k.col, ' (foreign key)')
  FROM pg_temp.partner_keyed_candidates() k
  WHERE NOT EXISTS (SELECT 1 FROM public.partner_delete_dependents() d WHERE d.table_name = k.t)
    AND k.t <> 'partner_configs'
    AND NOT EXISTS (SELECT 1 FROM excluded_tables e WHERE e.t = k.t)
    AND NOT EXISTS (SELECT 1 FROM partner_value_columns e WHERE e.t = k.t AND e.col = k.col)
    AND NOT EXISTS (SELECT 1 FROM partner_value_column_names e WHERE e.col = k.col)
  ORDER BY 1;
$$;

DO $do$
DECLARE
  v_found text;
BEGIN
  SELECT string_agg(candidate, ', ') INTO v_found FROM pg_temp.partner_delete_unregistered();
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'case 2b: tables keyed to a partner that a delete neither removes, is refused by, nor leaves with a written reason: %', v_found;
  END IF;
  -- Its own mutation, on every run: a scratch table keyed by partner_slug is reported.
  BEGIN
    CREATE TABLE public.scratch_2140_keyed (id uuid PRIMARY KEY, partner_slug text);
    SELECT string_agg(candidate, ', ') INTO v_found FROM pg_temp.partner_delete_unregistered();
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'scratch_undo', DETAIL = coalesce(v_found, '');
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_found = PG_EXCEPTION_DETAIL;
    IF v_found NOT LIKE '%scratch_2140_keyed.partner_slug%' THEN RAISE EXCEPTION 'case 2b: a scratch table keyed by partner_slug was not reported (%)', v_found; END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('every partner keyed table is a delete dependent or excluded');
END
$do$;

-- ── 3. A hand write: one notice, direct, versions, column names, no values ───
DO $do$
DECLARE
  v jsonb;
BEGIN
  PERFORM pg_temp.clear_notices();
  UPDATE public.partner_configs SET min_bid = 7.5 WHERE id = '33333333-3333-3333-3333-000021350002';
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 3');
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v) k) IS DISTINCT FROM
     ARRAY['changed_columns', 'client_id', 'direct', 'id', 'kind', 'partner_id', 'partner_version', 'profile_version', 'save_id'] THEN
    RAISE EXCEPTION 'case 3: the notice carries keys %', (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v) k);
  END IF;
  IF v ->> 'partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-000021350002' OR v ->> 'kind' IS DISTINCT FROM 'partner'
     OR (v ->> 'direct')::boolean IS DISTINCT FROM true OR v -> 'changed_columns' IS DISTINCT FROM '["min_bid"]'::jsonb
     OR (v ->> 'partner_version')::integer IS DISTINCT FROM (SELECT version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021350002')
     OR v -> 'profile_version' IS DISTINCT FROM 'null'::jsonb OR v -> 'save_id' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'case 3: unexpected notice %', v;
  END IF;
  IF v::text LIKE '%7.5%' THEN RAISE EXCEPTION 'case 3: the notice carries a field value: %', v; END IF;
  INSERT INTO suite_cases(name) VALUES ('hand write: one direct notice, no values');
END
$do$;

-- ── 4. save_partner_config: not direct, carries its save id ──────────────────
DO $do$
DECLARE
  v jsonb;
  v_save uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.clear_notices();
  PERFORM public.save_partner_config('11111111-1111-1111-1111-000021350001', '33333333-3333-3333-3333-000021350002',
    (SELECT version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021350002'),
    '{"daily_cap": 40}'::jsonb, v_save, '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 4');
  IF (v ->> 'direct')::boolean IS DISTINCT FROM false OR (v ->> 'save_id')::uuid IS DISTINCT FROM v_save OR v -> 'changed_columns' IS DISTINCT FROM '["daily_cap"]'::jsonb THEN
    RAISE EXCEPTION 'case 4: unexpected notice %', v;
  END IF;

  -- An UPDATE that names its editor in updated_by has an actor, as its audit
  -- row says, though no function set bidspoke.actor_id.
  PERFORM pg_temp.clear_notices();
  UPDATE public.partner_configs SET daily_cap = 41, updated_by = '22222222-2222-2222-2222-00002135000a' WHERE id = '33333333-3333-3333-3333-000021350002';
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 4 updated_by');
  IF (v ->> 'direct')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'case 4: an update naming its editor read as direct: %', v; END IF;
  IF (SELECT changed_by FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-000021350002' AND changes -> 'daily_cap' ->> 'new' = '41') IS NULL THEN
    RAISE EXCEPTION 'case 4: the audit row disagrees: it has no actor';
  END IF;
  -- And the copy is the statement's own: the next hand write is direct again.
  -- Only the stored notices are cleared here, never the settings.
  DELETE FROM realtime.messages WHERE topic LIKE 'partners:%';
  UPDATE public.partner_configs SET daily_cap = 42 WHERE id = '33333333-3333-3333-3333-000021350002';
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 4 next');
  IF (v ->> 'direct')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'case 4: the editor of the previous statement leaked into the next: %', v; END IF;
  INSERT INTO suite_cases(name) VALUES ('save_partner_config: not direct, its save id');
END
$do$;

-- ── 5. One notice per partner per statement, on each partner's own topic ─────
DO $do$
BEGIN
  PERFORM pg_temp.clear_notices();
  UPDATE public.partner_configs SET priority = priority + 1
  WHERE id IN ('33333333-3333-3333-3333-000021350001', '33333333-3333-3333-3333-000021350002', '33333333-3333-3333-3333-0000213500b1');
  IF pg_temp.notice_count('11111111-1111-1111-1111-000021350001') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'case 5: % notices for the two partners of org A', pg_temp.notice_count('11111111-1111-1111-1111-000021350001');
  END IF;
  IF (SELECT count(DISTINCT x ->> 'partner_id') FROM pg_temp.notices('11111111-1111-1111-1111-000021350001') x) IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'case 5: org A''s two notices do not name its two partners';
  END IF;
  IF (pg_temp.one_notice('11111111-1111-1111-1111-000021350002', 'case 5') ->> 'partner_id') IS DISTINCT FROM '33333333-3333-3333-3333-0000213500b1' THEN
    RAISE EXCEPTION 'case 5: org B''s notice names another partner';
  END IF;
  INSERT INTO suite_cases(name) VALUES ('one per partner per statement, own topic');
END
$do$;

-- ── 6. last_probe_response alone sends nothing ───────────────────────────────
DO $do$
BEGIN
  PERFORM pg_temp.clear_notices();
  UPDATE public.partner_configs SET last_probe_response = '{"probe": true}'::jsonb WHERE id = '33333333-3333-3333-3333-000021350001';
  IF pg_temp.notice_count('11111111-1111-1111-1111-000021350001') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'case 6: a last_probe_response change sent % notices', pg_temp.notice_count('11111111-1111-1111-1111-000021350001');
  END IF;
  INSERT INTO suite_cases(name) VALUES ('last_probe_response alone sends nothing');
END
$do$;

-- ── 7. A partner created: by an editor (not direct) and by hand (direct) ─────
DO $do$
DECLARE
  v jsonb;
BEGIN
  PERFORM pg_temp.clear_notices();
  INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, updated_by)
  VALUES ('33333333-3333-3333-3333-000021350006', '11111111-1111-1111-1111-000021350001', 'Created', 'notice-created-2135', 'buyer', '22222222-2222-2222-2222-00002135000a');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 7 editor');
  IF v ->> 'kind' IS DISTINCT FROM 'created' OR (v ->> 'direct')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'case 7: editor create %', v; END IF;

  PERFORM pg_temp.clear_notices();
  INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type)
  VALUES ('33333333-3333-3333-3333-000021350007', '11111111-1111-1111-1111-000021350001', 'Created by hand', 'notice-created-hand-2135', 'buyer');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 7 hand');
  IF v ->> 'kind' IS DISTINCT FROM 'created' OR (v ->> 'direct')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'case 7: hand create %', v; END IF;
  INSERT INTO suite_cases(name) VALUES ('a created partner');
END
$do$;

-- ── 8. delete_partner_config: one notice, the profile cascade silent ─────────
-- Since #2140 the delete also removes the partner's sub-account IDs, after the
-- partner row, so their trigger finds no partner and adds no notice.
DO $do$
DECLARE
  v jsonb;
BEGIN
  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid) VALUES
    ('11111111-1111-1111-1111-000021350001', 'notice-buyer-2135-4', 'notice-sub-1'), ('11111111-1111-1111-1111-000021350001', 'notice-buyer-2135-4', 'notice-sub-2');
  PERFORM pg_temp.clear_notices();
  -- The shared delete body (#2254): this case is about the notice a delete sends.
  PERFORM public._delete_partner_config('11111111-1111-1111-1111-000021350001', '33333333-3333-3333-3333-000021350004', '22222222-2222-2222-2222-00002135000a', 'erin@example.test', NULL);
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 8');
  IF EXISTS (SELECT 1 FROM public.partner_uuid_map WHERE partner_slug = 'notice-buyer-2135-4') THEN RAISE EXCEPTION 'case 8: the sub-account IDs survived'; END IF;
  IF v ->> 'kind' IS DISTINCT FROM 'deleted' OR (v ->> 'direct')::boolean IS DISTINCT FROM false OR v -> 'partner_version' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'case 8: unexpected notice %', v;
  END IF;
  INSERT INTO suite_cases(name) VALUES ('a deleted partner, silent cascade');
END
$do$;

-- ── 9. Hand writes to the profile and each child table ───────────────────────
DO $do$
DECLARE
  v jsonb;
  v_before integer;
BEGIN
  PERFORM pg_temp.clear_notices();
  SELECT version INTO v_before FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021350003';
  INSERT INTO public.buyer_blackout_dates (partner_id, organization_id, blackout_date) VALUES ('33333333-3333-3333-3333-000021350003', '11111111-1111-1111-1111-000021350001', '2030-01-01');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 9 child insert');
  IF v ->> 'kind' IS DISTINCT FROM 'profile' OR (v ->> 'direct')::boolean IS DISTINCT FROM true
     OR v -> 'changed_columns' IS DISTINCT FROM '["buyer_blackout_dates"]'::jsonb
     OR (v ->> 'profile_version')::integer IS DISTINCT FROM v_before + 1 THEN
    -- The version in the notice is the one the bump trigger moved to, which
    -- holds only while the bump triggers fire before the notice triggers.
    RAISE EXCEPTION 'case 9: child insert % (version before %)', v, v_before;
  END IF;

  PERFORM pg_temp.clear_notices();
  DELETE FROM public.buyer_operating_windows WHERE partner_id = '33333333-3333-3333-3333-000021350003';
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 9 child delete');
  IF (v ->> 'profile_version')::integer IS DISTINCT FROM v_before + 2 THEN RAISE EXCEPTION 'case 9: child delete %', v; END IF;

  PERFORM pg_temp.clear_notices();
  UPDATE public.buyer_profiles SET debt_min = 12000 WHERE partner_id = '33333333-3333-3333-3333-000021350003';
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 9 profile update');
  IF (v ->> 'profile_version')::integer IS DISTINCT FROM v_before + 3 OR (v ->> 'direct')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'case 9: profile update %', v; END IF;
  INSERT INTO suite_cases(name) VALUES ('hand writes to the profile tables');
END
$do$;

-- ── 10. The legacy profile save: exactly one notice ──────────────────────────
DO $do$
DECLARE
  v jsonb;
  v_version integer;
BEGIN
  PERFORM pg_temp.clear_notices();
  SELECT version INTO v_version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021350003';
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021350001', '33333333-3333-3333-3333-000021350003', v_version,
    '{"sold_on":"offer","is_enabled":false,"priority":2,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    '22222222-2222-2222-2222-00002135000a', 'erin@example.test');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 10');
  IF v ->> 'kind' IS DISTINCT FROM 'profile' OR (v ->> 'direct')::boolean IS DISTINCT FROM false OR (v ->> 'profile_version')::integer IS DISTINCT FROM v_version + 1 THEN
    RAISE EXCEPTION 'case 10: unexpected notice %', v;
  END IF;
  INSERT INTO suite_cases(name) VALUES ('legacy profile save: one notice');
END
$do$;

-- ── 11. A profile created by the legacy save: one notice ─────────────────────
DO $do$
DECLARE
  v jsonb;
BEGIN
  PERFORM pg_temp.clear_notices();
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021350001', '33333333-3333-3333-3333-000021350005', 0,
    '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[],"blackout_dates":[],"tiers":[]}'::jsonb,
    '22222222-2222-2222-2222-00002135000a', 'erin@example.test');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 11');
  IF (v ->> 'profile_version')::integer IS DISTINCT FROM 1 OR (v ->> 'direct')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'case 11: unexpected notice %', v; END IF;

  -- A hand delete of that partner: one direct 'deleted', and the profile rows
  -- the cascade removes say nothing of their own.
  PERFORM pg_temp.clear_notices();
  DELETE FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021350005';
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 11 hand delete');
  IF v ->> 'kind' IS DISTINCT FROM 'deleted' OR (v ->> 'direct')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'case 11: hand delete %', v; END IF;
  INSERT INTO suite_cases(name) VALUES ('legacy profile create: one notice');
END
$do$;

-- ── 12. The page save: exactly one notice, with its save id and client id ────
DO $do$
DECLARE
  v jsonb;
  v_out jsonb;
  v_save uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_doc jsonb := '{"sold_on":"offer","is_enabled":false,"priority":3,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":2,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb;
BEGIN
  PERFORM pg_temp.clear_notices();
  v_out := public.save_partner_page('11111111-1111-1111-1111-000021350001', '33333333-3333-3333-3333-000021350003',
    (SELECT version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021350003'), '{"name": "Page saved"}'::jsonb,
    (SELECT version FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021350003'), v_doc,
    v_save, v_client, '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 12');
  IF v ->> 'kind' IS DISTINCT FROM 'page' OR (v ->> 'save_id')::uuid IS DISTINCT FROM v_save OR (v ->> 'client_id')::uuid IS DISTINCT FROM v_client
     OR (v ->> 'direct')::boolean IS DISTINCT FROM false
     OR (v ->> 'partner_version')::integer IS DISTINCT FROM (v_out ->> 'partner_version')::integer
     OR (v ->> 'profile_version')::integer IS DISTINCT FROM (v_out ->> 'profile_version')::integer
     OR v -> 'changed_columns' IS DISTINCT FROM '["name", "buyer_profiles"]'::jsonb THEN
    RAISE EXCEPTION 'case 12: unexpected notice % for save %', v, v_out;
  END IF;

  -- The same save again changes nothing and tells nobody anything.
  PERFORM pg_temp.clear_notices();
  PERFORM public.save_partner_page('11111111-1111-1111-1111-000021350001', '33333333-3333-3333-3333-000021350003',
    (v_out ->> 'partner_version')::integer, '{"name": "Page saved"}'::jsonb, (v_out ->> 'profile_version')::integer, v_doc,
    gen_random_uuid(), v_client, '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
  IF pg_temp.notice_count('11111111-1111-1111-1111-000021350001') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'case 12: a page save that changed nothing sent % notices', pg_temp.notice_count('11111111-1111-1111-1111-000021350001');
  END IF;

  -- The ten argument form of the release before: the same one notice, no tab.
  PERFORM pg_temp.clear_notices();
  PERFORM public.save_partner_page('11111111-1111-1111-1111-000021350001', '33333333-3333-3333-3333-000021350003',
    (v_out ->> 'partner_version')::integer, '{"name": "Page saved again"}'::jsonb, NULL::integer, NULL::jsonb,
    v_save, '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 12 ten arguments');
  IF v -> 'client_id' IS DISTINCT FROM 'null'::jsonb OR v -> 'changed_columns' IS DISTINCT FROM '["name"]'::jsonb THEN RAISE EXCEPTION 'case 12: ten argument notice %', v; END IF;
  INSERT INTO suite_cases(name) VALUES ('page save: one notice with save and client ids');
END
$do$;

-- ── 13. change_partner_uuid refuses another organization ─────────────────────
DO $do$
BEGIN
  PERFORM pg_temp.clear_notices();
  BEGIN
    PERFORM public.change_partner_uuid('11111111-1111-1111-1111-000021350001', 'other-buyer-2135', 'sub-other', 'add', '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
    RAISE EXCEPTION 'case 13: another organization''s slug was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid) VALUES ('11111111-1111-1111-1111-000021350002', 'other-buyer-2135', 'sub-of-b');
  PERFORM pg_temp.clear_notices();
  BEGIN
    PERFORM public.change_partner_uuid('11111111-1111-1111-1111-000021350001', 'other-buyer-2135', 'sub-of-b', 'remove', '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
    RAISE EXCEPTION 'case 13: another organization''s mapping was removed';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.partner_uuid_map WHERE uuid = 'sub-of-b') THEN RAISE EXCEPTION 'case 13: org B''s mapping is gone'; END IF;
  -- A mapping of org B naming org A's partner tells org A nothing.
  PERFORM pg_temp.clear_notices();
  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid) VALUES ('11111111-1111-1111-1111-000021350002', 'notice-buyer-2135-1', 'sub-b-names-a');
  IF pg_temp.notice_count('11111111-1111-1111-1111-000021350001') IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'case 13: org B''s mapping notified org A'; END IF;
  BEGIN
    PERFORM public.change_partner_uuid('11111111-1111-1111-1111-000021350001', 'notice-buyer-2135-1', 'x', 'rename', '22222222-2222-2222-2222-00002135000a', 'e', 'n');
    RAISE EXCEPTION 'case 13: an unknown action was accepted';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN NULL;
  END;
  INSERT INTO suite_cases(name) VALUES ('change_partner_uuid stays in its organization');
END
$do$;

-- ── 14. Sub-account IDs: through the RPC not direct, by hand direct ──────────
DO $do$
DECLARE
  v jsonb;
  v_row jsonb;
BEGIN
  PERFORM pg_temp.clear_notices();
  v_row := public.change_partner_uuid('11111111-1111-1111-1111-000021350001', 'notice-buyer-2135-1', 'sub-1', 'add', '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
  -- The trigger ran with the actor set: the notice is not direct.
  IF current_setting('bidspoke.actor_id', true) IS DISTINCT FROM '22222222-2222-2222-2222-00002135000a' THEN RAISE EXCEPTION 'case 14: actor_id not set by the RPC'; END IF;
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 14 add');
  IF v ->> 'kind' IS DISTINCT FROM 'uuids' OR (v ->> 'direct')::boolean IS DISTINCT FROM false OR v ->> 'partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-000021350001'
     OR (v ->> 'partner_version')::integer IS DISTINCT FROM (SELECT version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021350001') THEN
    RAISE EXCEPTION 'case 14: add notice %', v;
  END IF;
  IF v_row ->> 'uuid' IS DISTINCT FROM 'sub-1' THEN RAISE EXCEPTION 'case 14: the add returned %', v_row; END IF;

  PERFORM pg_temp.clear_notices();
  PERFORM public.change_partner_uuid('11111111-1111-1111-1111-000021350001', 'notice-buyer-2135-1', 'sub-1', 'remove', '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 14 remove');
  IF (v ->> 'direct')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'case 14: remove notice %', v; END IF;

  PERFORM pg_temp.clear_notices();
  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid) VALUES ('11111111-1111-1111-1111-000021350001', 'notice-buyer-2135-1', 'sub-hand');
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350001', 'case 14 hand');
  IF (v ->> 'direct')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'case 14: a hand insert is not direct: %', v; END IF;

  PERFORM pg_temp.clear_notices();
  UPDATE public.partner_uuid_map SET partner_slug = 'notice-buyer-2135-2' WHERE uuid = 'sub-hand';
  IF pg_temp.notice_count('11111111-1111-1111-1111-000021350001') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'case 14: moving a mapping between partners sent % notices, expected one for each', pg_temp.notice_count('11111111-1111-1111-1111-000021350001');
  END IF;
  INSERT INTO suite_cases(name) VALUES ('sub-account IDs: actor through the RPC');
END
$do$;

-- ── 15. A taken sub-account ID is refused by the unique key ──────────────────
DO $do$
BEGIN
  BEGIN
    PERFORM public.change_partner_uuid('11111111-1111-1111-1111-000021350001', 'notice-buyer-2135-3', 'sub-hand', 'add', '22222222-2222-2222-2222-00002135000a', 'erin@example.test', 'Erin Suite');
    RAISE EXCEPTION 'case 15: a taken uuid was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO suite_cases(name) VALUES ('a taken sub-account ID is refused');
END
$do$;

-- ── 16. The monitor ping: synthetic only, no setting written ─────────────────
DO $do$
DECLARE
  v jsonb;
  v_ping jsonb;
  v_save uuid := gen_random_uuid();
  v_audit bigint;
  v_version integer;
  v_detail text;
BEGIN
  BEGIN
    PERFORM public.monitor_partner_page_ping('11111111-1111-1111-1111-000021350001', gen_random_uuid());
    RAISE EXCEPTION 'case 16: a real organization was pinged';
  EXCEPTION WHEN SQLSTATE 'BP403' THEN NULL;
  END;

  PERFORM pg_temp.clear_notices();
  SELECT count(*) INTO v_audit FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021350003';
  SELECT version INTO v_version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-0000213500c1';
  v_ping := public.monitor_partner_page_ping('11111111-1111-1111-1111-000021350003', v_save);
  v := pg_temp.one_notice('11111111-1111-1111-1111-000021350003', 'case 16');
  IF v ->> 'kind' IS DISTINCT FROM 'monitor' OR (v ->> 'save_id')::uuid IS DISTINCT FROM v_save OR v ->> 'partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-0000213500c1' THEN
    RAISE EXCEPTION 'case 16: unexpected notice %', v;
  END IF;
  IF (v_ping ->> 'partition_today')::boolean IS DISTINCT FROM true OR (v_ping ->> 'partition_tomorrow')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'case 16: the partitions were reported as %', v_ping;
  END IF;
  IF (SELECT count(*) FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-000021350003') IS DISTINCT FROM v_audit
     OR (SELECT version FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-0000213500c1') IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'case 16: the ping wrote a setting';
  END IF;

  PERFORM sql_suite.create_realtime_partition((now()::timestamp)::date + 1);
  v_ping := public.monitor_partner_page_ping('11111111-1111-1111-1111-000021350003', gen_random_uuid());
  IF (v_ping ->> 'partition_tomorrow')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'case 16: tomorrow''s partition not seen: %', v_ping; END IF;

  -- A monitor organization holding a buyer is refused by name, never sent from.
  BEGIN
    INSERT INTO public.partner_configs (organization_id, name, slug, partner_type) VALUES ('11111111-1111-1111-1111-000021350003', 'Stray', 'monitor-stray-2135', 'buyer');
    PERFORM public.monitor_partner_page_ping('11111111-1111-1111-1111-000021350003', gen_random_uuid());
    RAISE EXCEPTION 'case 16: a monitor organization holding two partners was pinged';
  EXCEPTION WHEN SQLSTATE 'BP422' THEN
    GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
    IF v_detail IS DISTINCT FROM 'monitor_organization_misconfigured' THEN RAISE EXCEPTION 'case 16: refused as %', v_detail; END IF;
  END;
  INSERT INTO suite_cases(name) VALUES ('monitor ping: synthetic only, no setting written');
END
$do$;

-- ── 17. The live miss table is the Worker's alone ────────────────────────────
-- (The function grants are in partner_page_function_grants.test.sql.)
-- Each role's EXACT privilege set, never only the one it needs (L503: an
-- over broad grant is invisible because the code never attempts what it is not
-- meant to do). Production's default privileges grant service_role every table
-- privilege on a new table in public, and so does this suite's database
-- (scripts/sql-suite/bootstrap.sql keeps them): a migration that only GRANTs
-- SELECT and INSERT leaves UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and
-- MAINTAIN in place. Found on production's read back of 20261016170000.
DO $do$
DECLARE
  r text;
  priv text;
  held text[];
  expected text[];
  bad text[] := '{}';
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    held := '{}';
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege(r, 'public.partner_page_live_misses', priv) THEN held := held || priv; END IF;
    END LOOP;
    expected := CASE r WHEN 'service_role' THEN ARRAY['SELECT', 'INSERT'] ELSE '{}'::text[] END;
    IF held IS DISTINCT FROM expected THEN
      bad := bad || format('%s holds {%s}, expected {%s}', r, array_to_string(held, ','), array_to_string(expected, ','));
    END IF;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'case 17: partner_page_live_misses grants wrong: %', array_to_string(bad, '; ');
  END IF;
  INSERT INTO suite_cases(name) VALUES ('live misses are the Worker''s alone, SELECT and INSERT only');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 19 THEN RAISE EXCEPTION 'partner_page_notice.test.sql: expected 19 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_page_notice.test.sql: % cases passed', n;
END
$do$;

ROLLBACK;
