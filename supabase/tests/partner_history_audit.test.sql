-- The audit rows the partners page History reads (#2141, PR10 of #2114).
--
-- Proves, against migration 20261016176000:
--  - a sub-account ID added or removed through change_partner_uuid (the Worker's
--    only path) writes exactly one audit row, naming the person and the partner;
--  - a hand SQL insert, update or delete of a mapping writes exactly one row with
--    no actor, _source direct_sql, and never a person;
--  - a write made under bidspoke.actor_job is credited to the job on every
--    audit trigger (partner settings, the profile tables, sub-account IDs), and a
--    write with neither actor nor job reads as direct_sql, never a person;
--  - a person's partner settings write still carries _actor as before;
--  - a profile save audited by its own function is not recorded twice;
--  - the Worker's role still writes the profile tables and sub-account IDs with
--    every trigger firing as it;
--  - bid_config_history.changed_by refuses an id that names no users row.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds. Everything runs in one transaction that is rolled back, because a
-- partner_uuid_map write also sends PR4's notice and the realtime auth test
-- needs today's partition to be absent.
--
-- Mutations tried (each turned its case red, then the migration was put back):
-- - the Worker's audit write kept beside the trigger, modelled by a second
--   audit_log insert after the add: case 1 red (2 rows);
-- - change_partner_uuid without its set_config of bidspoke.actor_id: case 1 red
--   (the row read direct_sql, with no person);
-- - the bidspoke.actor_job branch removed from audit_actor_stamp: case 3 red;
-- - SECURITY DEFINER removed from buyer_profile_tables_direct_sql_audit: case 6
--   red (permission denied for function audit_actor_stamp as service_role);
-- - the foreign key on bid_config_history.changed_by left out: case 7 red;
-- - MAINTAIN revoked from service_role on bid_config_history: case 8 red.

BEGIN;

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

CREATE FUNCTION pg_temp.reset_settings() RETURNS void LANGUAGE sql AS $$
  SELECT set_config(k, '', true) FROM unnest(ARRAY['bidspoke.actor_id', 'bidspoke.actor_email', 'bidspoke.actor_name', 'bidspoke.actor_job',
    'bidspoke.audit_handled', 'bidspoke.updated_by_actor', 'bidspoke.notice_updated_by', 'bidspoke.audit_reason', 'bidspoke.audit_context']) k;
  SELECT NULL::void;
$$;

-- Rows written since the last mark. Every row of one transaction carries the
-- same changed_at, so "newest" cannot be read by time here.
CREATE TEMP TABLE seen_audit (id uuid PRIMARY KEY);
CREATE FUNCTION pg_temp.mark() RETURNS void LANGUAGE sql AS $$
  INSERT INTO seen_audit SELECT id FROM public.audit_log ON CONFLICT DO NOTHING;
  SELECT NULL::void;
$$;
CREATE FUNCTION pg_temp.new_row(p_type text, p_entity uuid, p_case text) RETURNS public.audit_log LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  r public.audit_log;
BEGIN
  SELECT count(*) INTO n FROM public.audit_log a WHERE a.entity_type = p_type AND a.entity_id = p_entity AND a.id NOT IN (SELECT id FROM seen_audit);
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION '%: expected exactly 1 new % audit row, found %', p_case, p_type, n; END IF;
  SELECT * INTO r FROM public.audit_log a WHERE a.entity_type = p_type AND a.entity_id = p_entity AND a.id NOT IN (SELECT id FROM seen_audit);
  PERFORM pg_temp.mark();
  RETURN r;
END
$$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021410001', 'History Org', 'history-org-2141');
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-000021410002', 'Other History Org', 'other-history-org-2141');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-00002141000a', '11111111-1111-1111-1111-000021410001', 'erin@example.test', 'Erin Suite');
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active)
VALUES ('33333333-3333-3333-3333-000021410001', '11111111-1111-1111-1111-000021410001', 'History Buyer', 'history-buyer-2141', 'buyer', true),
       ('33333333-3333-3333-3333-000021410002', '11111111-1111-1111-1111-000021410001', 'History Buyer Two', 'history-buyer-2141-two', 'buyer', true);
SELECT pg_temp.reset_settings();

-- ── 6. The Worker's role writes with every trigger firing as it ─────────────
-- FIRST, before any other statement here fires an audit trigger: PL/pgSQL
-- checks the EXECUTE privilege of a function call once per transaction, when it
-- first evaluates the expression, and production gives every Worker request a
-- transaction of its own. Run later, this case would reuse a check made as the
-- superuser and could not see a trigger the Worker's role cannot run (it did:
-- the SECURITY INVOKER mutation survived until this case moved here).
DO $do$
DECLARE
  v_row jsonb;
  n integer;
BEGIN
  PERFORM pg_temp.reset_settings();
  EXECUTE 'SET ROLE service_role';
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021410001', '33333333-3333-3333-3333-000021410002', 0,
    '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    '22222222-2222-2222-2222-00002141000a', 'erin@example.test');
  PERFORM set_config('bidspoke.audit_handled', '', true);
  PERFORM set_config('bidspoke.actor_id', '', true);
  UPDATE public.buyer_pricing_tiers SET multiplier = 0.04 WHERE partner_id = '33333333-3333-3333-3333-000021410002';
  v_row := public.change_partner_uuid('11111111-1111-1111-1111-000021410001', 'history-buyer-2141', 'uuid-2141-role', 'add',
    '22222222-2222-2222-2222-00002141000a', 'erin@example.test', 'Erin From Token');
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-000021410002'
    AND changes ->> 'table' = 'buyer_pricing_tiers' AND changes ->> '_source' = 'direct_sql';
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'case 6: a service_role hand write of a tier should write 1 direct audit row, wrote %', n; END IF;
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = (v_row ->> 'id')::uuid;
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'case 6: a service_role add should write 1 audit row, wrote %', n; END IF;
  PERFORM pg_temp.reset_settings();
  INSERT INTO suite_cases(name) VALUES ('service role writes');
END
$do$;

-- ── 1. An API add and an API remove each write exactly one row, naming the person ──
DO $do$
DECLARE
  v_row jsonb;
  n integer;
  a record;
BEGIN
  v_row := public.change_partner_uuid('11111111-1111-1111-1111-000021410001', 'history-buyer-2141', 'uuid-2141-a', 'add',
    '22222222-2222-2222-2222-00002141000a', 'erin@example.test', 'Erin From Token');
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = (v_row ->> 'id')::uuid;
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'case 1: an API add should write exactly 1 audit row, wrote %', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = (v_row ->> 'id')::uuid;
  IF a.action IS DISTINCT FROM 'created' OR a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-00002141000a'::uuid
     OR a.organization_id IS DISTINCT FROM '11111111-1111-1111-1111-000021410001'::uuid THEN
    RAISE EXCEPTION 'case 1: the add row is wrong: % % %', a.action, a.changed_by, a.organization_id;
  END IF;
  IF a.changes ->> 'partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-000021410001'
     OR a.changes -> '_actor' ->> 'name' IS DISTINCT FROM 'Erin Suite'
     OR a.changes ? '_source'
     OR a.changes -> 'uuid' IS DISTINCT FROM '{"old": null, "new": "uuid-2141-a"}'::jsonb
     OR a.changes -> 'partner_slug' IS DISTINCT FROM '{"old": null, "new": "history-buyer-2141"}'::jsonb THEN
    RAISE EXCEPTION 'case 1: the add row changes are wrong: %', a.changes;
  END IF;
  PERFORM pg_temp.reset_settings();

  PERFORM public.change_partner_uuid('11111111-1111-1111-1111-000021410001', 'history-buyer-2141', 'uuid-2141-a', 'remove',
    '22222222-2222-2222-2222-00002141000a', 'erin@example.test', 'Erin From Token');
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = (v_row ->> 'id')::uuid AND action = 'deleted';
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'case 1: an API remove should write exactly 1 audit row, wrote %', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = (v_row ->> 'id')::uuid AND action = 'deleted';
  IF a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-00002141000a'::uuid
     OR a.changes ->> 'partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-000021410001'
     OR a.changes -> 'uuid' IS DISTINCT FROM '{"old": "uuid-2141-a", "new": null}'::jsonb THEN
    RAISE EXCEPTION 'case 1: the remove row is wrong: % %', a.changed_by, a.changes;
  END IF;
  PERFORM pg_temp.reset_settings();
  INSERT INTO suite_cases(name) VALUES ('api add and remove audited once with the person');
END
$do$;

-- ── 2. A hand write of a mapping is one row with no actor, never a person ─────
DO $do$
DECLARE
  v_id uuid;
  n integer;
  a record;
BEGIN
  PERFORM pg_temp.reset_settings();
  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid)
  VALUES ('11111111-1111-1111-1111-000021410001', 'history-buyer-2141', 'uuid-2141-hand') RETURNING id INTO v_id;
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = v_id;
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'case 2: a hand insert should write exactly 1 audit row, wrote %', n; END IF;
  SELECT * INTO a FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = v_id;
  IF a.changed_by IS NOT NULL OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' OR a.changes ? '_actor'
     OR a.changes ->> 'partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-000021410001' THEN
    RAISE EXCEPTION 'case 2: a hand insert row should be direct_sql with the partner and no person: % %', a.changed_by, a.changes;
  END IF;

  -- A hand update that moves the mapping to another partner names both.
  UPDATE public.partner_uuid_map SET partner_slug = 'history-buyer-2141-two' WHERE id = v_id;
  SELECT * INTO a FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = v_id AND action = 'updated';
  IF a.changes ->> 'partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-000021410002'
     OR a.changes ->> 'old_partner_id' IS DISTINCT FROM '33333333-3333-3333-3333-000021410001'
     OR a.changes ? 'uuid' OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' THEN
    RAISE EXCEPTION 'case 2: a hand move row is wrong: %', a.changes;
  END IF;

  -- An update that changes nothing records nothing.
  UPDATE public.partner_uuid_map SET uuid = uuid WHERE id = v_id;
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = v_id;
  IF n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'case 2: an update changing nothing was recorded (% rows)', n; END IF;

  DELETE FROM public.partner_uuid_map WHERE id = v_id;
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = v_id AND action = 'deleted' AND changed_by IS NULL;
  IF n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'case 2: a hand delete should write exactly 1 direct row, wrote %', n; END IF;
  INSERT INTO suite_cases(name) VALUES ('hand write audited once with no person');
END
$do$;

-- ── 3. A job is credited by name on every audit trigger ──────────────────────
DO $do$
DECLARE
  v_id uuid;
  a public.audit_log;
BEGIN
  PERFORM pg_temp.reset_settings();
  -- A profile for the buyer, saved by a person (its own audit row).
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021410001', '33333333-3333-3333-3333-000021410001', 0,
    '{"sold_on":"offer","is_enabled":false,"priority":1,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    '22222222-2222-2222-2222-00002141000a', 'erin@example.test');
  PERFORM pg_temp.reset_settings();

  PERFORM pg_temp.mark();
  PERFORM set_config('bidspoke.actor_job', 'suite_job_2141', true);
  UPDATE public.partner_configs SET daily_cap = 41 WHERE id = '33333333-3333-3333-3333-000021410001';
  a := pg_temp.new_row('partner_config', '33333333-3333-3333-3333-000021410001', 'case 3');
  IF a.changed_by IS NOT NULL OR a.changes ->> '_source' IS DISTINCT FROM 'job' OR a.changes ->> '_job' IS DISTINCT FROM 'suite_job_2141' OR a.changes ? '_actor' THEN
    RAISE EXCEPTION 'case 3: a partner settings write under a job should credit the job: % %', a.changed_by, a.changes;
  END IF;

  UPDATE public.buyer_pricing_tiers SET multiplier = 0.02 WHERE partner_id = '33333333-3333-3333-3333-000021410001';
  a := pg_temp.new_row('buyer_profile', '33333333-3333-3333-3333-000021410001', 'case 3');
  IF a.changes ->> '_source' IS DISTINCT FROM 'job' OR a.changes ->> '_job' IS DISTINCT FROM 'suite_job_2141' OR a.changed_by IS NOT NULL THEN
    RAISE EXCEPTION 'case 3: a profile table write under a job should credit the job: %', a.changes;
  END IF;

  INSERT INTO public.partner_uuid_map (org_id, partner_slug, uuid)
  VALUES ('11111111-1111-1111-1111-000021410001', 'history-buyer-2141', 'uuid-2141-job') RETURNING id INTO v_id;
  SELECT * INTO a FROM public.audit_log WHERE entity_type = 'partner_uuid' AND entity_id = v_id;
  IF a.changes ->> '_source' IS DISTINCT FROM 'job' OR a.changes ->> '_job' IS DISTINCT FROM 'suite_job_2141' THEN
    RAISE EXCEPTION 'case 3: a sub-account ID write under a job should credit the job: %', a.changes;
  END IF;
  PERFORM pg_temp.reset_settings();
  INSERT INTO suite_cases(name) VALUES ('job credited by name');
END
$do$;

-- ── 4. Neither actor nor job reads as direct_sql, never a person ─────────────
DO $do$
DECLARE
  a public.audit_log;
BEGIN
  PERFORM pg_temp.reset_settings();
  PERFORM pg_temp.mark();
  UPDATE public.partner_configs SET daily_cap = 42 WHERE id = '33333333-3333-3333-3333-000021410001';
  a := pg_temp.new_row('partner_config', '33333333-3333-3333-3333-000021410001', 'case 4');
  IF a.changed_by IS NOT NULL OR a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' OR a.changes ? '_actor' OR a.changes ? '_job' THEN
    RAISE EXCEPTION 'case 4: a write with no actor and no job should be direct_sql: % %', a.changed_by, a.changes;
  END IF;
  UPDATE public.buyer_pricing_tiers SET multiplier = 0.03 WHERE partner_id = '33333333-3333-3333-3333-000021410001';
  a := pg_temp.new_row('buyer_profile', '33333333-3333-3333-3333-000021410001', 'case 4');
  IF a.changes ->> '_source' IS DISTINCT FROM 'direct_sql' OR a.changes ? '_job' THEN
    RAISE EXCEPTION 'case 4: a profile table hand write should be direct_sql: %', a.changes;
  END IF;
  INSERT INTO suite_cases(name) VALUES ('no actor no job is direct');
END
$do$;

-- ── 5. A person is still named, and a self audited save is recorded once ─────
DO $do$
DECLARE
  a public.audit_log;
  n integer;
  v integer;
BEGIN
  PERFORM pg_temp.reset_settings();
  SELECT version INTO v FROM public.partner_configs WHERE id = '33333333-3333-3333-3333-000021410002';
  PERFORM pg_temp.mark();
  PERFORM public.save_partner_config('11111111-1111-1111-1111-000021410001', '33333333-3333-3333-3333-000021410002', v,
    '{"priority":4}'::jsonb, NULL, '22222222-2222-2222-2222-00002141000a', 'erin@example.test', 'Erin From Token');
  a := pg_temp.new_row('partner_config', '33333333-3333-3333-3333-000021410002', 'case 5');
  IF a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-00002141000a'::uuid OR a.changes -> '_actor' ->> 'name' IS DISTINCT FROM 'Erin Suite'
     OR a.changes -> '_actor' ->> 'email' IS DISTINCT FROM 'erin@example.test' OR a.changes ? '_source' THEN
    RAISE EXCEPTION 'case 5: a person''s save should carry _actor as before: % %', a.changed_by, a.changes;
  END IF;
  PERFORM pg_temp.reset_settings();

  SELECT version INTO v FROM public.buyer_profiles WHERE partner_id = '33333333-3333-3333-3333-000021410001';
  SELECT count(*) INTO n FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-000021410001';
  PERFORM public.save_buyer_profile('11111111-1111-1111-1111-000021410001', '33333333-3333-3333-3333-000021410001', v,
    '{"sold_on":"offer","is_enabled":false,"priority":2,"allowed_states":["CA"],"debt_min":10000,"debt_max":50000,"windows":[{"day_of_week":1,"opens_minute":540,"closes_minute":1020}],"blackout_dates":[],"tiers":[{"population":"engine","debt_from":10000,"debt_to":null,"multiplier":0.01}]}'::jsonb,
    '22222222-2222-2222-2222-00002141000a', 'erin@example.test');
  IF (SELECT count(*) FROM public.audit_log WHERE entity_type = 'buyer_profile' AND entity_id = '33333333-3333-3333-3333-000021410001') IS DISTINCT FROM (n + 1)::bigint THEN
    RAISE EXCEPTION 'case 5: a profile save should add exactly 1 audit row';
  END IF;
  PERFORM pg_temp.reset_settings();
  INSERT INTO suite_cases(name) VALUES ('person named and self audited save once');
END
$do$;

-- ── 7. A Sync now press names a users row ────────────────────────────────────
DO $do$
DECLARE
  v_config uuid;
  refused boolean := false;
BEGIN
  INSERT INTO public.partner_bid_configs (organization_id, partner_id, slug, name)
  VALUES ('11111111-1111-1111-1111-000021410001', '33333333-3333-3333-3333-000021410001', 'history-matrix-2141', 'History Matrix')
  RETURNING id INTO v_config;
  INSERT INTO public.bid_config_history (config_id, source, diff, changed_by)
  VALUES (v_config, 'salesforce_sync', '{}'::jsonb, '22222222-2222-2222-2222-00002141000a');
  INSERT INTO public.bid_config_history (config_id, source, diff) VALUES (v_config, 'salesforce_sync', '{}'::jsonb);
  BEGIN
    INSERT INTO public.bid_config_history (config_id, source, diff, changed_by)
    VALUES (v_config, 'salesforce_sync', '{}'::jsonb, '22222222-2222-2222-2222-0000214100ff');
  EXCEPTION WHEN foreign_key_violation THEN
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'case 7: a changed_by naming no users row was accepted'; END IF;
  INSERT INTO suite_cases(name) VALUES ('sync press names a user');
END
$do$;

-- ── 8. The tables this migration touches keep production's grants ───────────
-- bid_config_history gained a foreign key and partner_uuid_map three triggers;
-- neither grant set may move. The sets are production's, read 2026-10-16:
-- service_role holds everything, MAINTAIN and TRUNCATE included, by the
-- platform's default privileges; anon and authenticated everything but
-- TRUNCATE, with RLS doing the refusing.
DO $do$
DECLARE
  t text;
  r text;
  v_have text;
  v_want text;
  bad text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['public.bid_config_history', 'public.partner_uuid_map'] LOOP
    FOREACH r IN ARRAY ARRAY['service_role', 'anon', 'authenticated'] LOOP
      SELECT coalesce(string_agg(p, ',' ORDER BY p), '') INTO v_have
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
      WHERE has_table_privilege(r, t, p);
      v_want := CASE r WHEN 'service_role' THEN 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'
                       ELSE 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,UPDATE' END;
      IF v_have IS DISTINCT FROM v_want THEN bad := array_append(bad, format('%s on %s: %s, want %s', r, t, v_have, v_want)); END IF;
    END LOOP;
  END LOOP;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'case 8: table grants moved: %', array_to_string(bad, '; '); END IF;
  INSERT INTO suite_cases(name) VALUES ('table grants unchanged');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 8 THEN RAISE EXCEPTION 'partner_history_audit.test.sql: expected 8 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_history_audit.test.sql: % cases passed', n;
END
$do$;

ROLLBACK;
