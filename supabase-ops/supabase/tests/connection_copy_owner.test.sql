-- A person's own account connection carries its owner on its ops copy (#2339).
-- Migration 20261023230000_connection_copy_owner_2339.sql.
--
-- Dan decided on 2026-10-23 (recorded on #2338) that a person's own account may
-- be used only by its owner. The bidding Worker serves each connection's owner
-- (service_connections.user_id of a person bound connection, else null); ops
-- keeps it on the copy so the executor can compare it with who bound the step.
--
-- WHAT IT PROVES.
--   A. connection_copies.owner_user_id is a nullable uuid, and service_role
--      still only reads the table.
--   B. save_connection_copies keeps a served owner on insert, and on a later
--      list of the same generation, and on a higher generation; a copy served
--      with no owner key (a bidding Worker older than this change) saves with
--      no owner, so the executor refuses its own account steps by name.
--   C. A later list naming another owner replaces it: the bidding row
--      is the one home of who owns a connection.
--   D. connection_copy answers the owner beside the rest of the copy, null for
--      a copy with none; and still refuses another organization's copy.
--   E. Both functions are still SECURITY DEFINER with a fixed search_path and
--      executable by service_role alone.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE co_cases (name text PRIMARY KEY);

CREATE FUNCTION pg_temp.co_copy(p_conn uuid, p_org uuid, p_gen bigint, p_owner jsonb)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('connection_id', p_conn, 'organization_id', p_org, 'service', 'google', 'generation', p_gen,
    'envelope', jsonb_build_object('v', 1, 'kid', 'ops-2026-10', 'wrapped_key', 'd3JhcHBlZA', 'iv', 'aXY', 'ct', 'Y3Q'),
    'public_config', jsonb_build_object('name', 'my google'),
    'target', jsonb_build_object('own_account', true),
    'serve_until', now() + interval '5 hours')
    || CASE WHEN p_owner IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('owner_user_id', p_owner) END
$f$;

-- ── A. The column ────────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connection_copies'
      AND column_name = 'owner_user_id' AND data_type = 'uuid' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'connection_copies.owner_user_id is not a nullable uuid';
  END IF;
  IF has_table_privilege('service_role', 'public.connection_copies', 'UPDATE') OR NOT has_table_privilege('service_role', 'public.connection_copies', 'SELECT') THEN
    RAISE EXCEPTION 'service_role is no longer read only on connection_copies';
  END IF;
  INSERT INTO co_cases VALUES ('column: a nullable uuid, the table still read only to service_role');
END
$do$;

-- ── B and C. Saved, kept, replaced ───────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := '00000000-0000-4000-8000-000000002339';
  v_conn uuid := '00000000-0000-4000-8000-0000000023a1';
  v_old uuid := '00000000-0000-4000-8000-0000000023b1';
  v_owner uuid := '00000000-0000-4000-8000-0000000023f1';
  v_other uuid := '00000000-0000-4000-8000-0000000023f2';
  v_c record;
BEGIN
  SELECT * INTO v_c FROM public.save_connection_copies(now() - interval '2 minutes', false, jsonb_build_array(pg_temp.co_copy(v_conn, v_org, 1, to_jsonb(v_owner))));
  IF v_c.inserted <> 1 THEN RAISE EXCEPTION 'the copy was not inserted: %', v_c; END IF;
  IF (SELECT owner_user_id FROM public.connection_copies WHERE connection_id = v_conn) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'the served owner was not kept on insert';
  END IF;
  INSERT INTO co_cases VALUES ('insert: the served owner is kept');

  SELECT * INTO v_c FROM public.save_connection_copies(now() - interval '1 minute', false, jsonb_build_array(pg_temp.co_copy(v_conn, v_org, 1, to_jsonb(v_owner))));
  IF v_c.confirmed <> 1 OR (SELECT owner_user_id FROM public.connection_copies WHERE connection_id = v_conn) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'a later list of the same generation lost the owner: %', v_c;
  END IF;
  SELECT * INTO v_c FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.co_copy(v_conn, v_org, 2, to_jsonb(v_other))));
  IF v_c.updated <> 1 OR (SELECT owner_user_id FROM public.connection_copies WHERE connection_id = v_conn) IS DISTINCT FROM v_other THEN
    RAISE EXCEPTION 'a higher generation naming another owner did not replace it: %', v_c;
  END IF;
  INSERT INTO co_cases VALUES ('later lists: the owner is kept, and replaced by the bidding row''s');

  SELECT * INTO v_c FROM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.co_copy(v_old, v_org, 1, NULL)));
  IF v_c.inserted <> 1 OR (SELECT owner_user_id FROM public.connection_copies WHERE connection_id = v_old) IS NOT NULL THEN
    RAISE EXCEPTION 'a copy served with no owner key did not save with no owner: %', v_c;
  END IF;
  INSERT INTO co_cases VALUES ('older bidding Worker: a copy with no owner key saves with no owner');

  BEGIN
    PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.co_copy(v_old, v_org, 1, to_jsonb('not a uuid'::text))));
    RAISE EXCEPTION 'an owner that is not a uuid was saved';
  EXCEPTION WHEN invalid_text_representation THEN
    NULL;
  END;
  INSERT INTO co_cases VALUES ('refusal: an owner that is not a uuid is refused');
END
$do$;

-- ── D. The read ──────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := '00000000-0000-4000-8000-000000002339';
  v_r record;
BEGIN
  SELECT * INTO v_r FROM public.connection_copy(v_org, '00000000-0000-4000-8000-0000000023a1');
  IF v_r.state <> 'usable' OR v_r.owner_user_id IS DISTINCT FROM '00000000-0000-4000-8000-0000000023f2'::uuid OR v_r.target IS NULL THEN
    RAISE EXCEPTION 'connection_copy did not answer the owner beside the copy: %', v_r;
  END IF;
  SELECT * INTO v_r FROM public.connection_copy(v_org, '00000000-0000-4000-8000-0000000023b1');
  IF v_r.owner_user_id IS NOT NULL THEN RAISE EXCEPTION 'a copy with no owner answered one'; END IF;
  BEGIN
    PERFORM public.connection_copy('00000000-0000-4000-8000-00000000ffff', '00000000-0000-4000-8000-0000000023a1');
    RAISE EXCEPTION 'another organization''s copy was answered';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  INSERT INTO co_cases VALUES ('read: the owner beside the copy, null for none, another organization refused');
END
$do$;

-- ── E. Privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('save_connection_copies', 'connection_copy') LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('save_connection_copies', 'connection_copy')) <> 2 THEN
    RAISE EXCEPTION 'save_connection_copies or connection_copy exists more than once';
  END IF;
  INSERT INTO co_cases VALUES ('privileges: definer, fixed search_path, service_role alone, one of each');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM co_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'connection_copy_owner: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'connection_copy_owner: % cases passed', v_n;
END
$do$;

ROLLBACK;
