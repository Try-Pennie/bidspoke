-- The browser roles can reach nothing in service_connections (#2331, phase 1
-- of #1689).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Its bootstrap
-- reproduces the hosted platform's default grants (L714), which is what gave
-- anon and authenticated SELECT on this table, and with it the Slack bot token
-- in config.bot_token, to anyone holding the public key.
--
-- WHAT IT PROVES.
--   A. Neither anon nor authenticated holds any table privilege.
--   B. Neither holds any column privilege on any column, credential_enc included.
--   C. Neither appears in the table's ACL at all: revoked directly on each role,
--      not only on PUBLIC (L541).
--   D. service_role, the Worker, still reads and writes it.
--   E. sealed_for takes only the two values, and a ciphertext must name what it
--      is sealed for.
--   F. Only service_role may call delete_service_connection_by_id, the one
--      delete of the table a route calls, and every other function of that
--      name family is gone (#2332 release 2 dropped the delete by type).
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS scg_cases (name text PRIMARY KEY);
DELETE FROM scg_cases;

-- ── A. No table privilege ────────────────────────────────────────────────────
DO $do$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.service_connections', p) THEN
        RAISE EXCEPTION '% still holds % on public.service_connections', r, p;
      END IF;
    END LOOP;
  END LOOP;
  INSERT INTO scg_cases VALUES ('neither browser role holds a table privilege');
END
$do$;

-- ── B. No column privilege ───────────────────────────────────────────────────
DO $do$
DECLARE
  r text;
  p text;
  col text;
  n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.service_connections'::regclass AND attname = 'credential_enc' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'service_connections has no credential_enc column';
  END IF;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = 'public.service_connections'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    n := n + 1;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
        IF has_column_privilege(r, 'public.service_connections', col, p) THEN
          RAISE EXCEPTION '% still holds % on public.service_connections.%', r, p, col;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  -- The loop must have seen the columns, so an empty pass cannot read as a pass.
  IF n < 10 THEN RAISE EXCEPTION 'only % columns were checked', n; END IF;
  INSERT INTO scg_cases VALUES ('neither browser role holds a privilege on any column, credential_enc included');
END
$do$;

-- ── C. Not in the ACL at all ─────────────────────────────────────────────────
DO $do$
DECLARE
  held text;
BEGIN
  SELECT string_agg(DISTINCT g.rolname || ':' || a.privilege_type, ', ')
  INTO held
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  JOIN pg_roles g ON g.oid = a.grantee
  WHERE c.oid = 'public.service_connections'::regclass
    AND g.rolname IN ('anon', 'authenticated');
  IF held IS NOT NULL THEN RAISE EXCEPTION 'the ACL still grants the browser roles: %', held; END IF;
  -- PUBLIC (grantee 0) holds nothing either.
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid = 'public.service_connections'::regclass AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PUBLIC still holds a privilege on service_connections';
  END IF;
  INSERT INTO scg_cases VALUES ('the browser roles and PUBLIC are absent from the ACL');
END
$do$;

-- ── D. The Worker keeps its access ───────────────────────────────────────────
DO $do$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.service_connections', p) THEN
      RAISE EXCEPTION 'service_role lost % on service_connections', p;
    END IF;
  END LOOP;
  INSERT INTO scg_cases VALUES ('service_role still reads and writes the table');
END
$do$;

-- ── E. sealed_for ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  refused boolean;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112331', 'SCG Org', 'scg-org-2331') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-111111112331';

  -- Named, not left to default to 'slack': the row is flipped to ops_key below,
  -- and the alert name is reserved from ops rows (#2332).
  INSERT INTO public.service_connections (organization_id, service_type, name, auth_type, cf_secret_key, config, credential_enc, sealed_for)
  VALUES ('11111111-1111-1111-1111-111111112331', 'slack', 'scg-row', 'oauth', '', '{"default_channel":"#a"}', 'placeholder-ciphertext', 'bidding_ring');

  refused := false;
  BEGIN
    UPDATE public.service_connections SET sealed_for = 'somewhere_else' WHERE organization_id = '11111111-1111-1111-1111-111111112331';
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a sealed_for outside the two values was accepted'; END IF;

  refused := false;
  BEGIN
    UPDATE public.service_connections SET sealed_for = NULL WHERE organization_id = '11111111-1111-1111-1111-111111112331';
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a ciphertext with no sealed_for was accepted'; END IF;

  UPDATE public.service_connections SET sealed_for = 'ops_key' WHERE organization_id = '11111111-1111-1111-1111-111111112331';
  -- A row with no ciphertext (every row before the backfill) needs no sealed_for.
  UPDATE public.service_connections SET credential_enc = NULL, sealed_for = NULL WHERE organization_id = '11111111-1111-1111-1111-111111112331';

  DELETE FROM public.service_connections WHERE organization_id = '11111111-1111-1111-1111-111111112331';
  DELETE FROM public.audit_log WHERE organization_id = '11111111-1111-1111-1111-111111112331';
  INSERT INTO scg_cases VALUES ('sealed_for takes only the two values and a ciphertext must name it');
END
$do$;

-- ── F. The delete function is the Worker's only ──────────────────────────────
DO $do$
DECLARE
  r text;
  others text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, 'public.delete_service_connection_by_id(uuid, uuid, uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION '% may call delete_service_connection_by_id', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.delete_service_connection_by_id(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role may not call delete_service_connection_by_id';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO others
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'delete\_service\_connection%' AND p.proname <> 'delete_service_connection_by_id';
  IF others IS NOT NULL THEN RAISE EXCEPTION 'another delete of the table is still there: %', others; END IF;
  INSERT INTO scg_cases VALUES ('only service_role may call delete_service_connection_by_id, and no other delete of the table remains');
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM scg_cases);
BEGIN
  IF n <> 6 THEN RAISE EXCEPTION 'expected 6 cases, % ran', n; END IF;
  RAISE NOTICE 'service_connections_grants.test.sql: % cases passed', n;
END
$do$;
