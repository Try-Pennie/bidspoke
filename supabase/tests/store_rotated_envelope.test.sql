-- store_rotated_envelope: the compare and set that hands a person bound
-- connection's rotated login back to its declared home (#2335, PR 5 of phase 5
-- of #1689), migration 20261018191000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The envelopes below
-- are planted placeholders shaped like the seal's, not ciphertext of anything.
--
-- WHY: the ops ConnectionTokenObject refreshes a person bound login, and a
-- provider that rotates refresh tokens makes the old one dead the moment it
-- answers. The object writes the rotated login to its own storage first, then
-- hands it to service_connections.credential_enc through the OpsGateway method
-- storeRotatedEnvelope, which calls this. Only a write that finds the row at the
-- generation the object last knew may land (L33), so a Reconnect or a removal in
-- the meantime is never overwritten, and the object learns which.
--
-- WHAT IT PROVES:
--   A. stored: the row at the expected generation takes the envelope and the new
--      generation, and nothing else of the row moves.
--   B. already_stored: the same call again (an answer lost on the way back)
--      changes nothing and says so.
--   C. moved: a row at another generation is not written, and the answer names
--      the row's generation and its envelope's iv, which is how the object tells
--      its own earlier write from a Reconnect.
--   D. not_found: another organization's row, a bidding_ring row and an ops row
--      that is not person bound are each refused without being written.
--   E. A new generation not above the expected one, and an envelope that is not
--      the seal's shape, are refused by name and write nothing.
--   F. The audit row names the rotation as its source (never direct_sql), and
--      records only that credential_enc changed, never its value; the source
--      setting does not outlive the call.
--   G. Only service_role may call it; the browser roles may not.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS sre_cases (name text PRIMARY KEY);
DELETE FROM sre_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112335a', 'SRE Org', 'sre-org-2335') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112335b', 'SRE Org B', 'sre-org-2335b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222222335a', '11111111-1111-1111-1111-11111112335a', 'sre2335@example.test', 'SRE Owner')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112335a', '11111111-1111-1111-1111-11111112335b');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112335a', '11111111-1111-1111-1111-11111112335b');
END
$do$;

-- A planted envelope of the seal's shape, told apart by its iv.
CREATE OR REPLACE FUNCTION pg_temp.sre_envelope(p_iv text)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object('v', 1, 'kid', 'ops-test-1', 'wrapped_key', 'cGxhbnRlZC13cmFwcGVk', 'iv', p_iv, 'ct', 'cGxhbnRlZC1jdA==')
$fn$;

-- The rows every case starts from: org A's person bound ops row at generation 3,
-- org A's ops row that is not person bound, org A's Slack alert row, and org B's
-- person bound ops row. Called inside each case's rolled back block.
CREATE OR REPLACE FUNCTION pg_temp.sre_rows()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.service_connections
    (id, organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, person_bound, credential_generation, user_id, target)
  VALUES
    ('33333333-3333-3333-3333-33333333c001', '11111111-1111-1111-1111-11111112335a', 'salesforce', 'sre person', 'oauth_user', NULL,
     NULL, pg_temp.sre_envelope('aXYtZ2VuLTMtcm93')::text, 'ops_key', true, 3, '22222222-2222-2222-2222-22222222335a', '{"instance_url":"https://example.my.salesforce.com"}'),
    -- Another service type: the old one row per service unique still holds.
    ('33333333-3333-3333-3333-33333333c002', '11111111-1111-1111-1111-11111112335a', 'snowflake', 'sre shared', 'key_pair', NULL,
     NULL, pg_temp.sre_envelope('aXYtc2hhcmVkLXJvdw')::text, 'ops_key', false, 3, NULL, NULL),
    ('33333333-3333-3333-3333-33333333c003', '11111111-1111-1111-1111-11111112335a', 'slack', 'slack', 'oauth', NULL,
     '{"bot_token":"planted-bot-token-2335"}', 'planted-ciphertext-2335', 'bidding_ring', true, 3, NULL, NULL),
    ('33333333-3333-3333-3333-33333333c004', '11111111-1111-1111-1111-11111112335b', 'salesforce', 'sre person b', 'oauth_user', NULL,
     NULL, pg_temp.sre_envelope('aXYtb3JnLWItcm93')::text, 'ops_key', true, 3, NULL, NULL);
END
$fn$;

-- ── A. stored ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  row_after record;
BEGIN
  BEGIN
    PERFORM pg_temp.sre_rows();
    SELECT * INTO r FROM public.store_rotated_envelope('11111111-1111-1111-1111-11111112335a', '33333333-3333-3333-3333-33333333c001', 3, 4, pg_temp.sre_envelope('aXYtcm90YXRlZC00'));
    IF r.outcome IS DISTINCT FROM 'stored' OR r.current_generation IS DISTINCT FROM 4 OR r.current_iv IS DISTINCT FROM 'aXYtcm90YXRlZC00' THEN
      RAISE EXCEPTION 'stored: answered (%, %, %)', r.outcome, r.current_generation, r.current_iv;
    END IF;
    SELECT credential_generation, credential_enc::jsonb AS env, sealed_for, person_bound, name, target, user_id INTO row_after
    FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333c001';
    IF row_after.credential_generation <> 4 OR row_after.env <> pg_temp.sre_envelope('aXYtcm90YXRlZC00') THEN
      RAISE EXCEPTION 'stored: the row holds generation % and %', row_after.credential_generation, row_after.env;
    END IF;
    IF row_after.sealed_for <> 'ops_key' OR NOT row_after.person_bound OR row_after.name <> 'sre person'
       OR row_after.user_id <> '22222222-2222-2222-2222-22222222335a' OR row_after.target->>'instance_url' <> 'https://example.my.salesforce.com' THEN
      RAISE EXCEPTION 'stored: a column other than the credential moved';
    END IF;
    RAISE EXCEPTION 'sre_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sre_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sre_cases VALUES ('a row at the expected generation takes the envelope and the new generation, and nothing else moves');
END
$do$;

-- ── B. already_stored ────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.sre_rows();
    PERFORM public.store_rotated_envelope('11111111-1111-1111-1111-11111112335a', '33333333-3333-3333-3333-33333333c001', 3, 4, pg_temp.sre_envelope('aXYtcm90YXRlZC00'));
    SELECT count(*) INTO n FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333c001' AND action = 'updated';
    SELECT * INTO r FROM public.store_rotated_envelope('11111111-1111-1111-1111-11111112335a', '33333333-3333-3333-3333-33333333c001', 3, 4, pg_temp.sre_envelope('aXYtcm90YXRlZC00'));
    IF r.outcome IS DISTINCT FROM 'already_stored' OR r.current_generation IS DISTINCT FROM 4 OR r.current_iv IS DISTINCT FROM 'aXYtcm90YXRlZC00' THEN
      RAISE EXCEPTION 'already_stored: answered (%, %, %)', r.outcome, r.current_generation, r.current_iv;
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333c001' AND action = 'updated') <> n THEN
      RAISE EXCEPTION 'already_stored: the repeat wrote the row again';
    END IF;
    RAISE EXCEPTION 'sre_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sre_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sre_cases VALUES ('the same call again answers already_stored and writes nothing');
END
$do$;

-- ── C. moved ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  BEGIN
    PERFORM pg_temp.sre_rows();
    -- The object last knew generation 2; the row is at 3 (a Reconnect, say).
    SELECT * INTO r FROM public.store_rotated_envelope('11111111-1111-1111-1111-11111112335a', '33333333-3333-3333-3333-33333333c001', 2, 3, pg_temp.sre_envelope('aXYtc3RhbGUtMw'));
    IF r.outcome IS DISTINCT FROM 'moved' OR r.current_generation IS DISTINCT FROM 3 OR r.current_iv IS DISTINCT FROM 'aXYtZ2VuLTMtcm93' THEN
      RAISE EXCEPTION 'moved: answered (%, %, %)', r.outcome, r.current_generation, r.current_iv;
    END IF;
    IF (SELECT credential_enc::jsonb->>'iv' FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333c001') <> 'aXYtZ2VuLTMtcm93' THEN
      RAISE EXCEPTION 'moved: the row was written';
    END IF;
    -- A row whose credential is not JSON is still answered, with no iv.
    UPDATE public.service_connections SET credential_enc = 'not json' WHERE id = '33333333-3333-3333-3333-33333333c001';
    SELECT * INTO r FROM public.store_rotated_envelope('11111111-1111-1111-1111-11111112335a', '33333333-3333-3333-3333-33333333c001', 2, 3, pg_temp.sre_envelope('aXYtc3RhbGUtMw'));
    IF r.outcome IS DISTINCT FROM 'moved' OR r.current_generation IS DISTINCT FROM 3 OR r.current_iv IS NOT NULL THEN
      RAISE EXCEPTION 'moved, unreadable credential: answered (%, %, %)', r.outcome, r.current_generation, r.current_iv;
    END IF;
    RAISE EXCEPTION 'sre_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sre_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sre_cases VALUES ('a row at another generation is not written, and the answer names its generation and iv');
END
$do$;

-- ── D. not_found ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  probe record;
BEGIN
  BEGIN
    PERFORM pg_temp.sre_rows();
    FOR probe IN
      SELECT * FROM (VALUES
        ('11111111-1111-1111-1111-11111112335b'::uuid, '33333333-3333-3333-3333-33333333c001'::uuid, 'another organization''s row'),
        ('11111111-1111-1111-1111-11111112335a'::uuid, '33333333-3333-3333-3333-33333333c002'::uuid, 'an ops row that is not person bound'),
        ('11111111-1111-1111-1111-11111112335a'::uuid, '33333333-3333-3333-3333-33333333c003'::uuid, 'a bidding_ring row'),
        ('11111111-1111-1111-1111-11111112335a'::uuid, '33333333-3333-3333-3333-33333333cfff'::uuid, 'a connection that does not exist')
      ) AS p(org, conn, what)
    LOOP
      SELECT * INTO r FROM public.store_rotated_envelope(probe.org, probe.conn, 3, 4, pg_temp.sre_envelope('aXYtcHJvYmU'));
      IF r.outcome IS DISTINCT FROM 'not_found' OR r.current_generation IS NOT NULL OR r.current_iv IS NOT NULL THEN
        RAISE EXCEPTION 'not_found, %: answered (%, %, %)', probe.what, r.outcome, r.current_generation, r.current_iv;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.service_connections
               WHERE organization_id IN ('11111111-1111-1111-1111-11111112335a', '11111111-1111-1111-1111-11111112335b')
                 AND (credential_generation <> 3 OR credential_enc LIKE '%aXYtcHJvYmU%')) THEN
      RAISE EXCEPTION 'not_found: a refused row was written';
    END IF;
    RAISE EXCEPTION 'sre_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sre_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sre_cases VALUES ('another organization, a bidding_ring row and a shared ops row are each not_found and not written');
END
$do$;

-- ── E. Refused input ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  bad record;
  refused boolean;
BEGIN
  BEGIN
    PERFORM pg_temp.sre_rows();
    FOR bad IN
      SELECT * FROM (VALUES
        (3::bigint, 3::bigint, pg_temp.sre_envelope('aXYtYmFk'), 'a new generation equal to the expected one'),
        (3::bigint, 2::bigint, pg_temp.sre_envelope('aXYtYmFk'), 'a new generation below the expected one'),
        (0::bigint, 4::bigint, pg_temp.sre_envelope('aXYtYmFk'), 'an expected generation below 1'),
        (3::bigint, 4::bigint, pg_temp.sre_envelope('aXYtYmFk') || '{"extra":"field"}'::jsonb, 'an envelope with a field the seal has not'),
        (3::bigint, 4::bigint, pg_temp.sre_envelope('aXYtYmFk') - 'ct', 'an envelope missing ct'),
        (3::bigint, 4::bigint, jsonb_set(pg_temp.sre_envelope('aXYtYmFk'), '{v}', '2'), 'an envelope of another version'),
        (3::bigint, 4::bigint, '"a string"'::jsonb, 'an envelope that is not an object')
      ) AS b(expected, gen, env, what)
    LOOP
      refused := false;
      BEGIN
        PERFORM public.store_rotated_envelope('11111111-1111-1111-1111-11111112335a', '33333333-3333-3333-3333-33333333c001', bad.expected, bad.gen, bad.env);
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE 'rotated_envelope_refused:%' THEN RAISE EXCEPTION '%: refused as "%", not by name', bad.what, SQLERRM; END IF;
        refused := true;
      END;
      IF NOT refused THEN RAISE EXCEPTION '% was accepted', bad.what; END IF;
    END LOOP;
    IF (SELECT credential_generation FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333c001') <> 3 THEN
      RAISE EXCEPTION 'refused input wrote the row';
    END IF;
    RAISE EXCEPTION 'sre_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sre_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sre_cases VALUES ('a generation not above the expected one and an envelope not of the seal''s shape are refused by name');
END
$do$;

-- ── F. The audit names the rotation and records no value ─────────────────────
DO $do$
DECLARE
  a record;
BEGIN
  BEGIN
    PERFORM pg_temp.sre_rows();
    PERFORM public.store_rotated_envelope('11111111-1111-1111-1111-11111112335a', '33333333-3333-3333-3333-33333333c001', 3, 4, pg_temp.sre_envelope('aXYtYXVkaXQtNA'));
    SELECT * INTO a FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333c001' AND action = 'updated';
    IF a.changes->>'_source' IS DISTINCT FROM 'ops_token_rotation' THEN
      RAISE EXCEPTION 'audit: the source is %, not ops_token_rotation', a.changes->>'_source';
    END IF;
    IF a.changes->'credential_enc' <> '{"changed": true, "old_present": true, "new_present": true}'::jsonb THEN
      RAISE EXCEPTION 'audit: credential_enc recorded as %', a.changes->'credential_enc';
    END IF;
    IF a.changes->'credential_generation' <> '{"old": 3, "new": 4}'::jsonb THEN
      RAISE EXCEPTION 'audit: credential_generation recorded as %', a.changes->'credential_generation';
    END IF;
    IF a.changes::text LIKE '%aXYtYXVkaXQtNA%' OR a.changes::text LIKE '%cGxhbnRlZC1jdA%' THEN
      RAISE EXCEPTION 'audit: the envelope reached the audit row';
    END IF;
    IF coalesce(current_setting('bidspoke.sc_source', true), '') <> '' THEN
      RAISE EXCEPTION 'audit: the source setting outlived the call';
    END IF;
    -- A direct write afterwards is labelled direct_sql again, not as a rotation.
    UPDATE public.service_connections SET name = 'sre renamed' WHERE id = '33333333-3333-3333-3333-33333333c001';
    IF (SELECT changes->>'_source' FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333c001' AND action = 'updated' AND changes ? 'name') IS DISTINCT FROM 'direct_sql' THEN
      RAISE EXCEPTION 'audit: a later direct write was not labelled direct_sql';
    END IF;
    RAISE EXCEPTION 'sre_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'sre_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO sre_cases VALUES ('the audit names the rotation as its source and records no envelope, and the source does not outlive the call');
END
$do$;

-- ── G. Grants ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    IF has_function_privilege(r, 'public.store_rotated_envelope(uuid, uuid, bigint, bigint, jsonb)', 'EXECUTE') THEN
      RAISE EXCEPTION '% may call store_rotated_envelope', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.store_rotated_envelope(uuid, uuid, bigint, bigint, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role may not call store_rotated_envelope';
  END IF;
  INSERT INTO sre_cases VALUES ('only service_role may call store_rotated_envelope');
END
$do$;

DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112335a', '11111111-1111-1111-1111-11111112335b');
DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112335a', '11111111-1111-1111-1111-11111112335b');

DO $do$
DECLARE
  n int := (SELECT count(*) FROM sre_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE 'store_rotated_envelope.test.sql: % cases passed', n;
END
$do$;
