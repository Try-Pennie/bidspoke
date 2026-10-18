-- delete_service_connection_by_id: the delete of ONE service_connections row
-- (#2332, phase 2 of #1689), migration 20261018150000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The tokens and the
-- ciphertexts below are planted placeholders, not credentials.
--
-- WHY: delete_service_connection(org, service_type, actor) deletes every row of
-- the type in the organization that is not an ops_key row. Release 2 drops the
-- old one row per service unique, after which an organization can hold two rows
-- of one service, and a Disconnect of one would remove both. The callers now
-- delete by the id of the row they read, scoped to the caller's organization.
--
-- WHAT IT PROVES (each under a simulated release 2, the old unique dropped,
-- inside a block that is rolled back):
--   A. Control: the scenario is real. With the alert row and a second, non ops
--      slack row of the same organization, the OLD delete by service type
--      removes both.
--   B. The delete by id removes only the row it names: the second slack row of
--      the same organization survives, and the function returns exactly that id.
--   C. Another organization's row cannot be deleted: a call naming org B with
--      org A's row id deletes nothing and returns no row.
--   D. An ops_key row is never deleted by it, even by its own id (Phase 8's own
--      delete removes those, with the refusal, tombstone and revoke).
--   E. The audit row of the delete names the actor, and the actor setting does
--      not outlive the call.
--   F. Only service_role may call it; the browser roles may not.
--   G. The old signature still exists beside it (expand), for the running code
--      and its rollback target until the contract step drops it.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS scd_cases (name text PRIMARY KEY);
DELETE FROM scd_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112333a', 'SCD Org', 'scd-org-2332') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111112333b', 'SCD Org B', 'scd-org-2332b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name)
  VALUES ('22222222-2222-2222-2222-22222222333a', '11111111-1111-1111-1111-11111112333a', 'scd2332@example.test', 'SCD User')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');
END
$do$;

-- The rows every case starts from, under a simulated release 2: org A's alert
-- row, a second non ops slack row of org A, an ops slack row of org A, and org
-- B's alert row. Called inside each case's rolled back block.
CREATE OR REPLACE FUNCTION pg_temp.scd_release2_rows()
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  ALTER TABLE public.service_connections DROP CONSTRAINT service_connections_org_type_unique;
  INSERT INTO public.service_connections (id, organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for)
  VALUES
    ('33333333-3333-3333-3333-33333333a001', '11111111-1111-1111-1111-11111112333a', 'slack', 'slack', 'oauth', NULL,
     '{"bot_token":"planted-bot-token-2332-a"}', 'planted-ciphertext-2332-a', 'bidding_ring'),
    ('33333333-3333-3333-3333-33333333a002', '11111111-1111-1111-1111-11111112333a', 'slack', 'second slack', 'oauth', NULL,
     '{"bot_token":"planted-bot-token-2332-b"}', NULL, NULL),
    ('33333333-3333-3333-3333-33333333a003', '11111111-1111-1111-1111-11111112333a', 'slack', 'ops-alerts', 'bot_token', NULL,
     NULL, 'planted-ops-ciphertext-2332', 'ops_key'),
    ('33333333-3333-3333-3333-33333333b001', '11111111-1111-1111-1111-11111112333b', 'slack', 'slack', 'oauth', NULL,
     '{"bot_token":"planted-bot-token-2332-c"}', 'planted-ciphertext-2332-c', 'bidding_ring');
END
$fn$;

-- ── A. Control: the old delete by service type removes both slack rows ──────
DO $do$
DECLARE
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.scd_release2_rows();
    SELECT count(*) INTO n FROM public.delete_service_connection('11111111-1111-1111-1111-11111112333a', 'slack', '22222222-2222-2222-2222-22222222333a');
    IF n <> 2 THEN RAISE EXCEPTION 'control: the old delete by service type removed % rows, not the 2 non ops slack rows', n; END IF;
    RAISE EXCEPTION 'scd_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'scd_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO scd_cases VALUES ('control: the old delete by service type removes a second slack row of the same organization');
END
$do$;

-- ── B. By id: the second row of the same service survives ───────────────────
DO $do$
DECLARE
  ids uuid[];
BEGIN
  BEGIN
    PERFORM pg_temp.scd_release2_rows();
    SELECT array_agg(d.id) INTO ids
    FROM public.delete_service_connection_by_id('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333a001', '22222222-2222-2222-2222-22222222333a') d;
    IF ids IS DISTINCT FROM ARRAY['33333333-3333-3333-3333-33333333a001'::uuid] THEN
      RAISE EXCEPTION 'the delete by id returned %, not the one row it named', ids;
    END IF;
    IF EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333a001') THEN
      RAISE EXCEPTION 'the named row was not deleted';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333a002') THEN
      RAISE EXCEPTION 'the second slack row of the same organization was deleted';
    END IF;
    IF (SELECT count(*) FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b')) <> 3 THEN
      RAISE EXCEPTION 'the delete by id removed more than one row';
    END IF;
    RAISE EXCEPTION 'scd_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'scd_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO scd_cases VALUES ('the delete by id removes only its row, and a second row of the same service survives');
END
$do$;

-- ── C. Another organization's row cannot be deleted ─────────────────────────
DO $do$
DECLARE
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.scd_release2_rows();
    -- Org B's caller names org A's alert row.
    SELECT count(*) INTO n
    FROM public.delete_service_connection_by_id('11111111-1111-1111-1111-11111112333b', '33333333-3333-3333-3333-33333333a001', '22222222-2222-2222-2222-22222222333a');
    IF n <> 0 THEN RAISE EXCEPTION 'a call for org B reported % rows deleted for org A''s row', n; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333a001') THEN
      RAISE EXCEPTION 'a call for org B deleted org A''s row';
    END IF;
    IF (SELECT count(*) FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b')) <> 4 THEN
      RAISE EXCEPTION 'a call for org B with org A''s row id deleted something';
    END IF;
    RAISE EXCEPTION 'scd_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'scd_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO scd_cases VALUES ('another organization''s row cannot be deleted by id');
END
$do$;

-- ── D. Never an ops_key row, even by its own id ─────────────────────────────
DO $do$
DECLARE
  n int;
BEGIN
  BEGIN
    PERFORM pg_temp.scd_release2_rows();
    SELECT count(*) INTO n
    FROM public.delete_service_connection_by_id('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333a003', '22222222-2222-2222-2222-22222222333a');
    IF n <> 0 THEN RAISE EXCEPTION 'the delete by id reported % rows deleted for an ops_key row', n; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.service_connections WHERE id = '33333333-3333-3333-3333-33333333a003') THEN
      RAISE EXCEPTION 'the delete by id removed an ops_key row';
    END IF;
    RAISE EXCEPTION 'scd_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'scd_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO scd_cases VALUES ('an ops_key row is never deleted by id');
END
$do$;

-- ── E. The delete is audited under its actor ────────────────────────────────
DO $do$
DECLARE
  a record;
BEGIN
  BEGIN
    PERFORM pg_temp.scd_release2_rows();
    DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112333a';
    PERFORM public.delete_service_connection_by_id('11111111-1111-1111-1111-11111112333a', '33333333-3333-3333-3333-33333333a001', '22222222-2222-2222-2222-22222222333a');
    SELECT * INTO a FROM public.audit_log
    WHERE organization_id = '11111111-1111-1111-1111-11111112333a' AND entity_id = '33333333-3333-3333-3333-33333333a001' AND action = 'deleted';
    IF NOT FOUND THEN RAISE EXCEPTION 'the delete by id wrote no audit row'; END IF;
    IF a.changed_by IS DISTINCT FROM '22222222-2222-2222-2222-22222222333a'::uuid THEN
      RAISE EXCEPTION 'the delete by id was audited under %, not its actor', a.changed_by;
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-11111112333a' AND action = 'deleted') <> 1 THEN
      RAISE EXCEPTION 'the delete by id wrote more than one delete audit row';
    END IF;
    IF coalesce(current_setting('bidspoke.actor_id', true), '') <> '' THEN
      RAISE EXCEPTION 'the actor setting outlived the call: %', current_setting('bidspoke.actor_id', true);
    END IF;
    RAISE EXCEPTION 'scd_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'scd_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO scd_cases VALUES ('the delete by id is audited under its actor, and the actor does not outlive the call');
END
$do$;

-- ── F. Only service_role may call it ────────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, 'public.delete_service_connection_by_id(uuid, uuid, uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION '% may call delete_service_connection_by_id', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.delete_service_connection_by_id(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role may not call delete_service_connection_by_id';
  END IF;
  INSERT INTO scd_cases VALUES ('only service_role may call delete_service_connection_by_id');
END
$do$;

-- ── G. The old signature is still there (expand) ────────────────────────────
DO $do$
BEGIN
  IF to_regprocedure('public.delete_service_connection(uuid, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'the old delete_service_connection(uuid, text, uuid) is gone before its contract step';
  END IF;
  INSERT INTO scd_cases VALUES ('the old signature stays beside the new one until the contract step');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_connections_org_type_unique') THEN
    RAISE EXCEPTION 'a simulated release 2 was not rolled back';
  END IF;
END
$do$;
DELETE FROM public.service_connections WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');
DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-11111112333a', '11111111-1111-1111-1111-11111112333b');

DO $do$
DECLARE
  n int := (SELECT count(*) FROM scd_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_delete_by_id.test.sql: % cases passed', n;
END
$do$;
