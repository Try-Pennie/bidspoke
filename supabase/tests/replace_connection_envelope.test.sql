-- replace_connection_envelope: the compare and set that moves one ops
-- connection's sealed login to the current ops key during a rotation (#2333,
-- the reseal), migration 20261019160000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The envelopes below
-- are planted placeholders shaped like the seal's, not ciphertext of anything.
--
-- WHY: the ops Worker's resealConnections opens an envelope under the old kid,
-- seals the same login to the new kid at the same generation, and hands it back
-- through the OpsGateway method replaceConnectionEnvelope, which calls this.
-- Only a write that finds the row still at the generation and kid the reseal
-- read may land, so a Reconnect, a rotated login, a removal or another reseal in
-- the meantime is never overwritten, and running the reseal twice changes
-- nothing the second time.
--
-- WHAT IT PROVES:
--   A. replaced: the row at the expected generation and kid takes the envelope,
--      keeps its generation, and nothing else of the row moves; a person bound
--      row is resealed too.
--   B. already_replaced: the same call again (an answer lost on the way back)
--      changes nothing and says so, and a second reseal of the old kid then
--      answers moved: running twice reseals nothing new.
--   C. moved: a row at another generation, or naming another kid, or holding a
--      credential that is not JSON, is not written, and the answer names its
--      generation and kid.
--   D. not_found: another organization's row, a bidding_ring row and a row that
--      does not exist are each refused without being written.
--   E. Refused input by name: an envelope not of the seal's shape, one naming
--      the kid it replaces, an expected kid that is not a kid, an expected
--      generation below 1.
--   F. The audit row names the reseal as its source (never direct_sql), records
--      only that credential_enc changed, never its value, and the source setting
--      does not outlive the call.
--   G. Only service_role may call it; the browser roles may not.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS rce_cases (name text PRIMARY KEY);
DELETE FROM rce_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112333a', 'RCE Org', 'rce-org-2333') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112333b', 'RCE Org B', 'rce-org-2333b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222222333a', '11111111-1111-1111-1111-11111112333a', 'rce2333@example.test', 'RCE Owner')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');
END
$do$;

-- A planted envelope of the seal's shape, under a kid, told apart by its iv.
CREATE OR REPLACE FUNCTION pg_temp.rce_envelope(p_kid text, p_iv text)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object('v', 1, 'kid', p_kid, 'wrapped_key', 'planted', 'iv', p_iv, 'ct', 'cGxhbnRlZC1jdA==')
$fn$;

-- The rows every case starts from, all at generation 3 and sealed under the old
-- kid: org A's shared ops row, org A's person bound ops row, org A's Slack alert
-- row, and org B's shared ops row. Called inside each case's rolled back block.
CREATE OR REPLACE FUNCTION pg_temp.rce_rows()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO public.service_connections
    (id, organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for, person_bound, credential_generation, user_id, target)
  VALUES
    ('33333333-3333-3333-3333-33333333d001', '11111111-1111-1111-1111-11111112333a', 'snowflake', 'rce shared', 'key_pair', NULL,
     NULL, pg_temp.rce_envelope('ops-old', 'aXYtc2hhcmVkLW9sZA')::text, 'ops_key', false, 3, NULL, '{"account":"example"}'),
    ('33333333-3333-3333-3333-33333333d002', '11111111-1111-1111-1111-11111112333a', 'salesforce', 'rce person', 'oauth_user', NULL,
     NULL, pg_temp.rce_envelope('ops-old', 'aXYtcGVyc29uLW9sZA')::text, 'ops_key', true, 3, '22222222-2222-2222-2222-22222222333a', '{"instance_url":"https://example.my.salesforce.com"}'),
    ('33333333-3333-3333-3333-33333333d003', '11111111-1111-1111-1111-11111112333a', 'slack', 'slack', 'oauth', NULL,
     '{"bot_token":"planted-bot-token-2333"}', 'planted-ciphertext-2333', 'bidding_ring', false, 3, NULL, NULL),
    ('33333333-3333-3333-3333-33333333d004', '11111111-1111-1111-1111-11111112333b', 'snowflake', 'rce shared b', 'key_pair', NULL,
     NULL, pg_temp.rce_envelope('ops-old', 'aXYtb3JnLWItb2xk')::text, 'ops_key', false, 3, NULL, NULL);
END
$fn$;

-- ── A. replaced ──────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  row_after record;
  conn uuid;
BEGIN
  BEGIN
    PERFORM pg_temp.rce_rows();
    FOREACH conn IN ARRAY ARRAY['33333333-3333-3333-3333-33333333d001', '33333333-3333-3333-3333-33333333d002']::uuid[] LOOP
      SELECT * INTO r FROM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', conn, 'ops-old', 3, pg_temp.rce_envelope('ops-new', 'aXYtbmV3'));
      IF r.outcome IS DISTINCT FROM 'replaced' OR r.current_generation IS DISTINCT FROM 3 OR r.current_kid IS DISTINCT FROM 'ops-new' THEN
        RAISE EXCEPTION 'replaced %: answered (%, %, %)', conn, r.outcome, r.current_generation, r.current_kid;
      END IF;
      SELECT credential_generation, credential_enc::jsonb AS env INTO row_after FROM public.service_connections WHERE id = conn;
      IF row_after.credential_generation <> 3 OR row_after.env <> pg_temp.rce_envelope('ops-new', 'aXYtbmV3') THEN
        RAISE EXCEPTION 'replaced %: the row holds generation % and %', conn, row_after.credential_generation, row_after.env;
      END IF;
    END LOOP;
    SELECT sealed_for, person_bound, name, target, user_id, service_type INTO row_after FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333d002';
    IF row_after.sealed_for <> 'ops_key' OR NOT row_after.person_bound OR row_after.name <> 'rce person' OR row_after.service_type <> 'salesforce'
       OR row_after.user_id <> '22222222-2222-2222-2222-22222222333a' OR row_after.target->>'instance_url' <> 'https://example.my.salesforce.com' THEN
      RAISE EXCEPTION 'replaced: a column other than the credential moved';
    END IF;
    RAISE EXCEPTION 'rce_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rce_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO rce_cases VALUES ('a row at the expected generation and kid takes the envelope and keeps its generation, shared or person bound');
END
$do$;

-- ── B. already_replaced, and twice reseals nothing new ──────────────────────
DO $do$
DECLARE
  r record;
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.rce_rows();
    PERFORM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', 'ops-old', 3, pg_temp.rce_envelope('ops-new', 'aXYtbmV3'));
    SELECT count(*) INTO n FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333d001' AND action = 'updated';
    SELECT * INTO r FROM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', 'ops-old', 3, pg_temp.rce_envelope('ops-new', 'aXYtbmV3'));
    IF r.outcome IS DISTINCT FROM 'already_replaced' OR r.current_generation IS DISTINCT FROM 3 OR r.current_kid IS DISTINCT FROM 'ops-new' THEN
      RAISE EXCEPTION 'already_replaced: answered (%, %, %)', r.outcome, r.current_generation, r.current_kid;
    END IF;
    -- A second reseal of the same login (a fresh seal, so a fresh iv) finds the old kid gone.
    SELECT * INTO r FROM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', 'ops-old', 3, pg_temp.rce_envelope('ops-new', 'aXYtc2Vjb25k'));
    IF r.outcome IS DISTINCT FROM 'moved' OR r.current_kid IS DISTINCT FROM 'ops-new' THEN
      RAISE EXCEPTION 'second reseal: answered (%, %, %)', r.outcome, r.current_generation, r.current_kid;
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333d001' AND action = 'updated') <> n THEN
      RAISE EXCEPTION 'already_replaced: a repeat wrote the row again';
    END IF;
    IF (SELECT credential_enc::jsonb->>'iv' FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333d001') <> 'aXYtbmV3' THEN
      RAISE EXCEPTION 'second reseal: the row was written';
    END IF;
    RAISE EXCEPTION 'rce_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rce_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO rce_cases VALUES ('the same call again answers already_replaced, and a second reseal answers moved, each writing nothing');
END
$do$;

-- ── C. moved ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  BEGIN
    PERFORM pg_temp.rce_rows();
    -- The reseal read generation 2; the row is at 3 (a Reconnect, say).
    SELECT * INTO r FROM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', 'ops-old', 2, pg_temp.rce_envelope('ops-new', 'aXYtbmV3'));
    IF r.outcome IS DISTINCT FROM 'moved' OR r.current_generation IS DISTINCT FROM 3 OR r.current_kid IS DISTINCT FROM 'ops-old' THEN
      RAISE EXCEPTION 'moved, generation: answered (%, %, %)', r.outcome, r.current_generation, r.current_kid;
    END IF;
    -- The row names another kid than the reseal read.
    SELECT * INTO r FROM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', 'ops-older', 3, pg_temp.rce_envelope('ops-new', 'aXYtbmV3'));
    IF r.outcome IS DISTINCT FROM 'moved' OR r.current_generation IS DISTINCT FROM 3 OR r.current_kid IS DISTINCT FROM 'ops-old' THEN
      RAISE EXCEPTION 'moved, kid: answered (%, %, %)', r.outcome, r.current_generation, r.current_kid;
    END IF;
    IF (SELECT credential_enc::jsonb->>'iv' FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333d001') <> 'aXYtc2hhcmVkLW9sZA' THEN
      RAISE EXCEPTION 'moved: the row was written';
    END IF;
    -- A row whose credential is not JSON is answered moved, with no kid, and not written.
    UPDATE public.service_connections SET credential_enc = 'not json' WHERE id = '33333333-3333-3333-3333-33333333d001';
    SELECT * INTO r FROM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', 'ops-old', 3, pg_temp.rce_envelope('ops-new', 'aXYtbmV3'));
    IF r.outcome IS DISTINCT FROM 'moved' OR r.current_generation IS DISTINCT FROM 3 OR r.current_kid IS NOT NULL THEN
      RAISE EXCEPTION 'moved, unreadable credential: answered (%, %, %)', r.outcome, r.current_generation, r.current_kid;
    END IF;
    IF (SELECT credential_enc FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333d001') <> 'not json' THEN
      RAISE EXCEPTION 'moved, unreadable credential: the row was written';
    END IF;
    RAISE EXCEPTION 'rce_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rce_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO rce_cases VALUES ('a row at another generation, another kid or with an unreadable credential is not written, and the answer names its generation and kid');
END
$do$;

-- ── D. not_found ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  probe record;
BEGIN
  BEGIN
    PERFORM pg_temp.rce_rows();
    FOR probe IN
      SELECT * FROM (VALUES
        ('11111111-1111-1111-1111-11111112333b'::uuid, '33333333-3333-3333-3333-33333333d001'::uuid, 'another organization''s row'),
        ('11111111-1111-1111-1111-11111112333a'::uuid, '33333333-3333-3333-3333-33333333d004'::uuid, 'another organization''s row, the other way'),
        ('11111111-1111-1111-1111-11111112333a'::uuid, '33333333-3333-3333-3333-33333333d003'::uuid, 'a bidding_ring row'),
        ('11111111-1111-1111-1111-11111112333a'::uuid, '33333333-3333-3333-3333-33333333dfff'::uuid, 'a connection that does not exist')
      ) AS p(org, conn, what)
    LOOP
      SELECT * INTO r FROM public.replace_connection_envelope(probe.org, probe.conn, 'ops-old', 3, pg_temp.rce_envelope('ops-new', 'aXYtcHJvYmU'));
      IF r.outcome IS DISTINCT FROM 'not_found' OR r.current_generation IS NOT NULL OR r.current_kid IS NOT NULL THEN
        RAISE EXCEPTION 'not_found, %: answered (%, %, %)', probe.what, r.outcome, r.current_generation, r.current_kid;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.service_connections
               WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b')
                 AND (credential_generation <> 3 OR credential_enc LIKE '%aXYtcHJvYmU%')) THEN
      RAISE EXCEPTION 'not_found: a refused row was written';
    END IF;
    IF (SELECT credential_enc FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333d003') <> 'planted-ciphertext-2333' THEN
      RAISE EXCEPTION 'not_found: the Slack alert row was written';
    END IF;
    RAISE EXCEPTION 'rce_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rce_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO rce_cases VALUES ('another organization''s row, a bidding_ring row and a missing row are each not_found and not written');
END
$do$;

-- ── E. Refused input ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  bad record;
  refused boolean;
BEGIN
  BEGIN
    PERFORM pg_temp.rce_rows();
    FOR bad IN
      SELECT * FROM (VALUES
        ('ops-old', 3::bigint, pg_temp.rce_envelope('ops-old', 'aXYtYmFk'), 'an envelope naming the kid it replaces'),
        ('ops-old', 0::bigint, pg_temp.rce_envelope('ops-new', 'aXYtYmFk'), 'an expected generation below 1'),
        ('Not A Kid', 3::bigint, pg_temp.rce_envelope('ops-new', 'aXYtYmFk'), 'an expected kid that is not a kid'),
        ('ops-old', 3::bigint, pg_temp.rce_envelope('Not A Kid', 'aXYtYmFk'), 'an envelope whose kid is not a kid'),
        ('ops-old', 3::bigint, pg_temp.rce_envelope('ops-new', 'aXYtYmFk') || '{"extra":"field"}'::jsonb, 'an envelope with a field the seal has not'),
        ('ops-old', 3::bigint, pg_temp.rce_envelope('ops-new', 'aXYtYmFk') - 'ct', 'an envelope missing ct'),
        ('ops-old', 3::bigint, jsonb_set(pg_temp.rce_envelope('ops-new', 'aXYtYmFk'), '{v}', '2'), 'an envelope of another version'),
        ('ops-old', 3::bigint, '"a string"'::jsonb, 'an envelope that is not an object')
      ) AS b(kid, gen, env, what)
    LOOP
      refused := false;
      BEGIN
        PERFORM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', bad.kid, bad.gen, bad.env);
      EXCEPTION WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE 'envelope_replace_refused:%' THEN RAISE EXCEPTION '%: refused as "%", not by name', bad.what, SQLERRM; END IF;
        refused := true;
      END;
      IF NOT refused THEN RAISE EXCEPTION '% was accepted', bad.what; END IF;
    END LOOP;
    IF (SELECT credential_enc::jsonb->>'iv' FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333d001') <> 'aXYtc2hhcmVkLW9sZA' THEN
      RAISE EXCEPTION 'refused input wrote the row';
    END IF;
    RAISE EXCEPTION 'rce_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rce_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO rce_cases VALUES ('an envelope not of the seal''s shape or naming the kid it replaces, and an expected kid or generation that cannot be one, are refused by name');
END
$do$;

-- ── F. The audit names the reseal and records no value ───────────────────────
DO $do$
DECLARE
  a record;
BEGIN
  BEGIN
    PERFORM pg_temp.rce_rows();
    PERFORM public.replace_connection_envelope('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333d001', 'ops-old', 3, pg_temp.rce_envelope('ops-new', 'aXYtYXVkaXQ'));
    SELECT * INTO a FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333d001' AND action = 'updated';
    IF a.changes->>'_source' IS DISTINCT FROM 'ops_key_reseal' THEN
      RAISE EXCEPTION 'audit: the source is %, not ops_key_reseal', a.changes->>'_source';
    END IF;
    IF a.changes->'credential_enc' <> '{"changed": true, "old_present": true, "new_present": true}'::jsonb THEN
      RAISE EXCEPTION 'audit: credential_enc recorded as %', a.changes->'credential_enc';
    END IF;
    IF a.changes ? 'credential_generation' THEN
      RAISE EXCEPTION 'audit: the generation moved';
    END IF;
    IF a.changes::text LIKE '%aXYtYXVkaXQ%' OR a.changes::text LIKE '%cGxhbnRlZC1jdA%' THEN
      RAISE EXCEPTION 'audit: the envelope reached the audit row';
    END IF;
    IF coalesce(current_setting('bidspoke.sc_source', true), '') <> '' THEN
      RAISE EXCEPTION 'audit: the source setting outlived the call';
    END IF;
    UPDATE public.service_connections SET name = 'rce renamed' WHERE id = '33333333-3333-3333-3333-33333333d001';
    IF (SELECT changes->>'_source' FROM public.audit_log WHERE entity_id = '33333333-3333-3333-3333-33333333d001' AND action = 'updated' AND changes ? 'name') IS DISTINCT FROM 'direct_sql' THEN
      RAISE EXCEPTION 'audit: a later direct write was not labelled direct_sql';
    END IF;
    RAISE EXCEPTION 'rce_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rce_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO rce_cases VALUES ('the audit names the reseal as its source and records no envelope, and the source does not outlive the call');
END
$do$;

-- ── G. Grants ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    IF has_function_privilege(r, 'public.replace_connection_envelope(uuid, uuid, text, bigint, jsonb)', 'EXECUTE') THEN
      RAISE EXCEPTION '% may call replace_connection_envelope', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.replace_connection_envelope(uuid, uuid, text, bigint, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role may not call replace_connection_envelope';
  END IF;
  INSERT INTO rce_cases VALUES ('only service_role may call replace_connection_envelope');
END
$do$;

DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');
DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');

DO $do$
DECLARE
  n int := (SELECT count(*) FROM rce_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE 'replace_connection_envelope.test.sql: % cases passed', n;
END
$do$;
