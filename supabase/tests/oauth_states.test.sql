-- Sign in with Google's single use state (#2338, build PR 13), migration
-- 20261024130000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production.
--
-- WHAT IT PROVES:
--   A. create_oauth_state writes a state expiring 10 minutes from the
--      database's clock, holding what the exchange repeats.
--   B. It refuses a user who is not of the organization.
--   C. The user's claim answers claimed with the state's contents, once; the
--      next claim answers used and nothing of the row.
--   D. Another user's or organization's claim answers not_found and consumes
--      nothing: the owner can still claim it.
--   E. An expired state answers expired and is not consumed.
--   F. A create deletes states expired over a day ago, and keeps newer ones.
--   G. Two racing claims of one state: the second waits on the first's row
--      lock and answers used, so exactly one is claimed.
--   H. No browser role reaches the table or either function; both functions
--      are SECURITY DEFINER with their search_path set; RLS is on.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

\if :{?self_host}
\else
  \echo 'oauth_states.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  \quit
\endif
SELECT set_config('oas_test.self_host', :'self_host', false) AS self_host_set \gset

CREATE TEMP TABLE IF NOT EXISTS oas_cases (name text PRIMARY KEY);
DELETE FROM oas_cases;

CREATE OR REPLACE FUNCTION pg_temp.oas_clean()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM public.oauth_states WHERE organization_id IN ('11111111-1111-1111-1111-11111e2338aa', '11111111-1111-1111-1111-11111e2338bb');
$$;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111e2338aa', 'OAS Org', 'oas-org-2338') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111e2338bb', 'OAS Org B', 'oas-org-2338b') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, organization_id, email, display_name) VALUES
    ('22222222-2222-2222-2222-22222e2338aa', '11111111-1111-1111-1111-11111e2338aa', 'oas-a@example.test', 'OAS A'),
    ('22222222-2222-2222-2222-22222e2338ab', '11111111-1111-1111-1111-11111e2338aa', 'oas-a2@example.test', 'OAS A2'),
    ('22222222-2222-2222-2222-22222e2338bb', '11111111-1111-1111-1111-11111e2338bb', 'oas-b@example.test', 'OAS B')
  ON CONFLICT (id) DO NOTHING;
  PERFORM pg_temp.oas_clean();
END
$do$;

CREATE OR REPLACE FUNCTION pg_temp.oas_state(p_user uuid DEFAULT '22222222-2222-2222-2222-22222e2338aa')
RETURNS uuid
LANGUAGE sql
AS $$
  SELECT state_id FROM public.create_oauth_state(
    '11111111-1111-1111-1111-11111e2338aa', p_user, 'google', '33333333-3333-3333-3333-33333e2338aa',
    'My Google', false, '1234-sign-in.apps.googleusercontent.com', repeat('v', 43), 'https://bidspoke.trypennie.dev/connections/google/callback');
$$;

-- ── A. A state expiring in 10 minutes ────────────────────────────────────────
DO $do$
DECLARE
  r record;
  s record;
BEGIN
  BEGIN
    SELECT * INTO r FROM public.create_oauth_state(
      '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa', 'google', '33333333-3333-3333-3333-33333e2338aa',
      'My Google', false, '1234-sign-in.apps.googleusercontent.com', repeat('v', 43), 'https://bidspoke.trypennie.dev/connections/google/callback');
    IF r.state_id IS NULL OR r.expires_at <> now() + interval '10 minutes' THEN
      RAISE EXCEPTION 'case A: the state expires at %, not 10 minutes from now', r.expires_at;
    END IF;
    SELECT * INTO s FROM public.oauth_states WHERE state_id = r.state_id;
    IF s.user_id <> '22222222-2222-2222-2222-22222e2338aa' OR s.connection_id <> '33333333-3333-3333-3333-33333e2338aa' OR s.name <> 'My Google'
       OR s.reconnect OR s.consumed_at IS NOT NULL OR s.verifier <> repeat('v', 43) THEN
      RAISE EXCEPTION 'case A: the row holds %', row_to_json(s);
    END IF;
    RAISE EXCEPTION 'oas_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'oas_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO oas_cases VALUES ('a state expires 10 minutes from the database clock and holds what the exchange repeats');
END
$do$;

-- ── B. Never for a user of another organization ──────────────────────────────
DO $do$
BEGIN
  BEGIN
    PERFORM pg_temp.oas_state('22222222-2222-2222-2222-22222e2338bb');
    RAISE EXCEPTION 'case B: a state was made for a user of another organization';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM NOT LIKE 'oauth_state_invalid%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.oauth_states WHERE user_id = '22222222-2222-2222-2222-22222e2338bb') THEN
    RAISE EXCEPTION 'case B: the refused state was written';
  END IF;
  INSERT INTO oas_cases VALUES ('a state is never made for a user of another organization');
END
$do$;

-- ── C. Claimed once, then used ───────────────────────────────────────────────
DO $do$
DECLARE
  v_state uuid;
  r record;
BEGIN
  BEGIN
    v_state := pg_temp.oas_state();
    SELECT * INTO r FROM public.claim_oauth_state(v_state, '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa');
    IF r.outcome <> 'claimed' OR r.connection_id <> '33333333-3333-3333-3333-33333e2338aa' OR r.verifier <> repeat('v', 43)
       OR r.client_id <> '1234-sign-in.apps.googleusercontent.com' OR r.name <> 'My Google' OR r.reconnect THEN
      RAISE EXCEPTION 'case C: the first claim answered %', row_to_json(r);
    END IF;
    SELECT * INTO r FROM public.claim_oauth_state(v_state, '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa');
    IF r.outcome <> 'used' OR r.verifier IS NOT NULL OR r.connection_id IS NOT NULL THEN
      RAISE EXCEPTION 'case C: the second claim answered %', row_to_json(r);
    END IF;
    RAISE EXCEPTION 'oas_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'oas_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO oas_cases VALUES ('a state is claimed once, and the next claim answers used with nothing of the row');
END
$do$;

-- ── D. Another user or organization: not_found, nothing consumed ─────────────
DO $do$
DECLARE
  v_state uuid;
  r record;
BEGIN
  BEGIN
    v_state := pg_temp.oas_state();
    SELECT * INTO r FROM public.claim_oauth_state(v_state, '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338ab');
    IF r.outcome <> 'not_found' OR r.verifier IS NOT NULL THEN RAISE EXCEPTION 'case D: another user''s claim answered %', row_to_json(r); END IF;
    SELECT * INTO r FROM public.claim_oauth_state(v_state, '11111111-1111-1111-1111-11111e2338bb', '22222222-2222-2222-2222-22222e2338aa');
    IF r.outcome <> 'not_found' THEN RAISE EXCEPTION 'case D: another organization''s claim answered %', r.outcome; END IF;
    SELECT * INTO r FROM public.claim_oauth_state(gen_random_uuid(), '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa');
    IF r.outcome <> 'not_found' THEN RAISE EXCEPTION 'case D: an unknown state answered %', r.outcome; END IF;
    SELECT * INTO r FROM public.claim_oauth_state(v_state, '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa');
    IF r.outcome <> 'claimed' THEN RAISE EXCEPTION 'case D: the owner could not claim after the others tried: %', r.outcome; END IF;
    RAISE EXCEPTION 'oas_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'oas_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO oas_cases VALUES ('another user or organization reads not_found and consumes nothing');
END
$do$;

-- ── E. Expired ───────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_state uuid;
  r record;
BEGIN
  BEGIN
    v_state := pg_temp.oas_state();
    UPDATE public.oauth_states SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE state_id = v_state;
    SELECT * INTO r FROM public.claim_oauth_state(v_state, '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa');
    IF r.outcome <> 'expired' OR r.verifier IS NOT NULL THEN RAISE EXCEPTION 'case E: an expired state answered %', row_to_json(r); END IF;
    IF (SELECT consumed_at FROM public.oauth_states WHERE state_id = v_state) IS NOT NULL THEN
      RAISE EXCEPTION 'case E: the expired state was consumed';
    END IF;
    RAISE EXCEPTION 'oas_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'oas_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO oas_cases VALUES ('an expired state answers expired and is not consumed');
END
$do$;

-- ── F. Old states are deleted by the next create ─────────────────────────────
DO $do$
DECLARE
  v_old uuid;
  v_recent uuid;
BEGIN
  BEGIN
    v_old := pg_temp.oas_state();
    v_recent := pg_temp.oas_state();
    UPDATE public.oauth_states SET created_at = now() - interval '2 days', expires_at = now() - interval '2 days' + interval '10 minutes' WHERE state_id = v_old;
    UPDATE public.oauth_states SET created_at = now() - interval '2 hours', expires_at = now() - interval '2 hours' + interval '10 minutes' WHERE state_id = v_recent;
    PERFORM pg_temp.oas_state();
    IF EXISTS (SELECT 1 FROM public.oauth_states WHERE state_id = v_old) THEN RAISE EXCEPTION 'case F: a state expired two days ago was kept'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.oauth_states WHERE state_id = v_recent) THEN RAISE EXCEPTION 'case F: a state expired two hours ago was deleted'; END IF;
    RAISE EXCEPTION 'oas_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'oas_rollback' THEN RAISE; END IF;
  END;
  INSERT INTO oas_cases VALUES ('a create deletes states expired over a day ago and keeps newer ones');
END
$do$;

-- ── G. Two racing claims: exactly one wins ───────────────────────────────────
-- The state is committed, so the second session sees it.
CREATE TEMP TABLE oas_race (state_id uuid);
INSERT INTO oas_race SELECT pg_temp.oas_state();

DO $do$
DECLARE
  created boolean := NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink');
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('oas_test.self_host'));
  v_state uuid := (SELECT state_id FROM oas_race);
  v_pid integer;
  v_waiting boolean := false;
  r record;
  i integer;
BEGIN
  IF created THEN CREATE EXTENSION dblink; END IF;
  PERFORM set_config('oas_test.created_dblink', created::text, false);
  PERFORM dblink_connect('oas_b', conn);
  SELECT pid INTO v_pid FROM dblink('oas_b', 'SELECT pg_backend_pid()') AS t(pid integer);
  -- The first claim, holding the row until this block commits.
  SELECT * INTO r FROM public.claim_oauth_state(v_state, '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa');
  IF r.outcome <> 'claimed' THEN RAISE EXCEPTION 'case G: the first claim answered %', r.outcome; END IF;
  PERFORM dblink_send_query('oas_b', format($q$SELECT outcome, verifier FROM public.claim_oauth_state(%L, '11111111-1111-1111-1111-11111e2338aa', '22222222-2222-2222-2222-22222e2338aa')$q$, v_state));
  FOR i IN 1..200 LOOP
    SELECT wait_event_type = 'Lock' INTO v_waiting FROM pg_stat_activity WHERE pid = v_pid;
    EXIT WHEN v_waiting;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF NOT coalesce(v_waiting, false) THEN
    PERFORM dblink_cancel_query('oas_b');
    PERFORM dblink_disconnect('oas_b');
    RAISE EXCEPTION 'case G: the second claim did not wait for the first';
  END IF;
END
$do$;

DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM dblink_get_result('oas_b', true) AS t(outcome text, verifier text);
  PERFORM * FROM dblink_get_result('oas_b', true) AS t(outcome text, verifier text);
  PERFORM dblink_disconnect('oas_b');
  IF current_setting('oas_test.created_dblink', true) = 'true' THEN DROP EXTENSION dblink; END IF;
  IF r.outcome IS DISTINCT FROM 'used' OR r.verifier IS NOT NULL THEN
    RAISE EXCEPTION 'case G: the racing second claim answered % %', r.outcome, r.verifier;
  END IF;
  INSERT INTO oas_cases VALUES ('of two racing claims of one state exactly one is claimed, and the other answers used');
END
$do$;

-- ── H. Privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  role_name text;
  fn text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(role_name, 'public.oauth_states', 'SELECT') OR has_table_privilege(role_name, 'public.oauth_states', 'INSERT')
       OR has_table_privilege(role_name, 'public.oauth_states', 'UPDATE') OR has_table_privilege(role_name, 'public.oauth_states', 'DELETE') THEN
      RAISE EXCEPTION 'case H: % reaches oauth_states', role_name;
    END IF;
    FOREACH fn IN ARRAY ARRAY['public.create_oauth_state(uuid, uuid, text, uuid, text, boolean, text, text, text)', 'public.claim_oauth_state(uuid, uuid, uuid)'] LOOP
      IF has_function_privilege(role_name, fn, 'EXECUTE') THEN RAISE EXCEPTION 'case H: % may call %', role_name, fn; END IF;
    END LOOP;
  END LOOP;
  IF has_table_privilege('service_role', 'public.oauth_states', 'SELECT') THEN
    RAISE EXCEPTION 'case H: service_role reads the table past the claim';
  END IF;
  FOREACH fn IN ARRAY ARRAY['public.create_oauth_state(uuid, uuid, text, uuid, text, boolean, text, text, text)', 'public.claim_oauth_state(uuid, uuid, uuid)'] LOOP
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION 'case H: service_role may not call %', fn; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(fn)) THEN RAISE EXCEPTION 'case H: % is not SECURITY DEFINER', fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(fn) AND proconfig::text LIKE '%search_path%') THEN
      RAISE EXCEPTION 'case H: % sets no search_path', fn;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.oauth_states'::regclass) THEN RAISE EXCEPTION 'case H: RLS is off'; END IF;
  INSERT INTO oas_cases VALUES ('no browser role reaches the table or the functions, which are SECURITY DEFINER with a search_path, and RLS is on');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
SELECT pg_temp.oas_clean();

DO $do$
DECLARE
  n int := (SELECT count(*) FROM oas_cases);
BEGIN
  IF n <> 8 THEN RAISE EXCEPTION 'expected 8 cases, % ran', n; END IF;
  RAISE NOTICE 'oauth_states.test.sql: % cases passed', n;
END
$do$;
