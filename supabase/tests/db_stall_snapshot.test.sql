-- db_stall_snapshot: what the database was doing during a write stall (#2292).
--
-- WHY THIS EXISTS: writes stalled for minutes three times on 2026-10-16 and
-- nothing recorded what the database was doing while they did. The Worker now
-- calls this function the moment a post-response write times out, and keeps the
-- answer in KV beside the slowdown alert. It is SECURITY DEFINER (so it can read
-- every backend's query), which Postgres makes callable by anon over the REST
-- API unless the grant is revoked (#762), and those queries can carry customer
-- data, so the revokes are the load-bearing lines tested here.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds by replaying every migration from empty, never production.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS dss_cases (name text PRIMARY KEY);
DELETE FROM dss_cases;

-- ── 1. It exists, is STABLE, SECURITY DEFINER, with a fixed search_path ───────
DO $do$
DECLARE p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'db_stall_snapshot';
  IF NOT FOUND THEN RAISE EXCEPTION 'db_stall_snapshot does not exist'; END IF;
  IF p.provolatile <> 's' THEN RAISE EXCEPTION 'db_stall_snapshot is not STABLE (provolatile=%)', p.provolatile; END IF;
  IF NOT p.prosecdef THEN RAISE EXCEPTION 'db_stall_snapshot is not SECURITY DEFINER'; END IF;
  IF p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'db_stall_snapshot has no fixed search_path';
  END IF;
  INSERT INTO dss_cases(name) VALUES ('exists, stable, security definer, fixed search_path');
END
$do$;

-- ── 2. anon and authenticated CANNOT execute it; service_role can ─────────────
DO $do$
BEGIN
  IF has_function_privilege('anon', 'public.db_stall_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute db_stall_snapshot';
  END IF;
  IF has_function_privilege('authenticated', 'public.db_stall_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute db_stall_snapshot';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.db_stall_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute db_stall_snapshot';
  END IF;
  INSERT INTO dss_cases(name) VALUES ('privileges: service_role only');
END
$do$;

-- ── 3. A call as anon or authenticated is REFUSED, not merely unlisted ────────
-- has_function_privilege reads the catalogue; this makes the call the way the
-- REST API would, as each role, and requires the refusal.
DO $do$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      PERFORM public.db_stall_snapshot();
      RESET ROLE;
      RAISE EXCEPTION 'db_stall_snapshot answered a call as %', r;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
    END;
  END LOOP;
  INSERT INTO dss_cases(name) VALUES ('a call as anon or authenticated is refused');
END
$do$;

-- ── 4. As service_role it answers the whole shape ────────────────────────────
DO $do$
DECLARE s jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  s := public.db_stall_snapshot();
  RESET ROLE;
  IF s IS NULL THEN RAISE EXCEPTION 'db_stall_snapshot returned null'; END IF;
  IF NOT (s ?& ARRAY['taken_at', 'max_connections', 'total_backends', 'backends', 'backends_shown', 'blocking', 'by_state', 'by_client']) THEN
    RAISE EXCEPTION 'db_stall_snapshot is missing a field: %', s;
  END IF;
  IF jsonb_typeof(s->'backends') <> 'array' OR jsonb_typeof(s->'blocking') <> 'array' OR jsonb_typeof(s->'by_state') <> 'array' THEN
    RAISE EXCEPTION 'db_stall_snapshot lists are not arrays: %', s;
  END IF;
  -- The caller's own backend is the one thing it never reports.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'backends') b WHERE (b->>'pid')::int = pg_backend_pid()) THEN
    RAISE EXCEPTION 'db_stall_snapshot reported its own backend';
  END IF;
  INSERT INTO dss_cases(name) VALUES ('service_role gets the whole shape, without its own backend');
END
$do$;

-- ── 5. A real blocking chain is named, and query text is cut to 300 chars ─────
-- Two more sessions through dblink: A holds an exclusive lock, B waits on it
-- running a query longer than 300 characters. The snapshot must show B waiting
-- on a Lock, blocked by A on the probe table, with its query cut to 300.
\if :{?self_host}
\else
  \echo 'db_stall_snapshot.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('dss_test.self_host', :'self_host', false) AS self_host_set \gset

CREATE TABLE IF NOT EXISTS public.dss_probe (id int);

DO $do$
DECLARE
  created boolean := NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink');
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('dss_test.self_host'));
  long_query text := 'SELECT count(*) FROM public.dss_probe /* ' || repeat('x', 400) || ' */';
  holder int;
  waiter int;
  s jsonb;
  b jsonb;
  chain jsonb;
BEGIN
  IF created THEN
    CREATE EXTENSION dblink;
  END IF;
  PERFORM dblink_connect('dss_a', conn);
  PERFORM dblink_connect('dss_b', conn);
  SELECT pid INTO holder FROM dblink('dss_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO waiter FROM dblink('dss_b', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM dblink_exec('dss_a', 'BEGIN');
  PERFORM dblink_exec('dss_a', 'LOCK TABLE public.dss_probe IN ACCESS EXCLUSIVE MODE');
  PERFORM dblink_send_query('dss_b', long_query);
  PERFORM pg_sleep(0.3);

  s := public.db_stall_snapshot();

  PERFORM dblink_exec('dss_a', 'COMMIT');
  PERFORM * FROM dblink_get_result('dss_b') AS t(n bigint);
  PERFORM dblink_disconnect('dss_a');
  PERFORM dblink_disconnect('dss_b');
  IF created THEN
    DROP EXTENSION dblink;
  END IF;

  SELECT x INTO b FROM jsonb_array_elements(s->'backends') x WHERE (x->>'pid')::int = waiter;
  IF b IS NULL THEN RAISE EXCEPTION 'the waiting backend % is not in the snapshot: %', waiter, s->'backends'; END IF;
  IF b->>'wait_event_type' IS DISTINCT FROM 'Lock' THEN RAISE EXCEPTION 'the waiting backend reads wait_event_type %', b->>'wait_event_type'; END IF;
  IF length(b->>'query') <> 300 THEN RAISE EXCEPTION 'query text is % chars, not cut to 300', length(b->>'query'); END IF;
  IF NOT (b ?& ARRAY['pid', 'usename', 'application_name', 'client_addr', 'backend_type', 'state', 'wait_event_type', 'wait_event', 'xact_start', 'query_start', 'query']) THEN
    RAISE EXCEPTION 'a backend is missing a field: %', b;
  END IF;

  SELECT x INTO chain FROM jsonb_array_elements(s->'blocking') x WHERE (x->>'pid')::int = waiter;
  IF chain IS NULL THEN RAISE EXCEPTION 'no blocking chain for the waiter: %', s->'blocking'; END IF;
  IF NOT (chain->'blocked_by' @> to_jsonb(ARRAY[holder])) THEN RAISE EXCEPTION 'the chain does not name the holder %: %', holder, chain; END IF;
  IF chain->>'relation' IS DISTINCT FROM 'public.dss_probe' THEN RAISE EXCEPTION 'the chain names relation %', chain->>'relation'; END IF;

  -- Counted by state, and the waiter is one of the active ones.
  IF coalesce((SELECT (x->>'count')::int FROM jsonb_array_elements(s->'by_state') x WHERE x->>'state' = 'active'), 0) < 1 THEN
    RAISE EXCEPTION 'by_state counts no active backend: %', s->'by_state';
  END IF;
  INSERT INTO dss_cases(name) VALUES ('a blocking chain is named, and query text is cut to 300');
END
$do$;

DROP TABLE IF EXISTS public.dss_probe;

DO $do$
DECLARE n int := (SELECT count(*) FROM dss_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'db_stall_snapshot.test.sql: % cases passed', n;
END
$do$;
