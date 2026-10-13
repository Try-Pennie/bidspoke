-- query_timeout_watch exposes the slowest statements per role, safely (#1043).
--
-- WHY THIS EXISTS: Postgres cancels a statement at its role's statement_timeout
-- with a 57014 and no signal before that (#1040). This function reads
-- pg_stat_statements so the Worker can warn before the cliff. It is SECURITY
-- DEFINER, which Postgres makes callable by anon over the REST API unless the
-- grant is revoked (#762), so the revoke is the load-bearing line tested here.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. That database may
-- not have the pg_stat_statements extension or the roles' statement_timeout
-- settings, so the function is built to return empty there; this proves it is
-- safe to CALL under those conditions rather than erroring.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS qtw_cases (name text PRIMARY KEY);
DELETE FROM qtw_cases;

-- ── 1. The function exists, is STABLE, and is SECURITY DEFINER ────────────────
DO $do$
DECLARE p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'query_timeout_watch';
  IF NOT FOUND THEN RAISE EXCEPTION 'query_timeout_watch does not exist'; END IF;
  IF p.provolatile <> 's' THEN RAISE EXCEPTION 'query_timeout_watch is not STABLE (provolatile=%)', p.provolatile; END IF;
  IF NOT p.prosecdef THEN RAISE EXCEPTION 'query_timeout_watch is not SECURITY DEFINER'; END IF;
  INSERT INTO qtw_cases(name) VALUES ('exists, stable, security definer');
END
$do$;

-- ── 2. anon and authenticated CANNOT execute it; service_role can ─────────────
-- This is the line that matters: without the REVOKE, the publishable key reads a
-- listing of the slowest statements and their shapes.
DO $do$
BEGIN
  IF has_function_privilege('anon', 'public.query_timeout_watch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute query_timeout_watch';
  END IF;
  IF has_function_privilege('authenticated', 'public.query_timeout_watch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute query_timeout_watch';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.query_timeout_watch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute query_timeout_watch';
  END IF;
  INSERT INTO qtw_cases(name) VALUES ('service_role only');
END
$do$;

-- ── 3. It is safe to CALL even without pg_stat_statements or role settings ────
-- The replay database may have neither; the function returns empty rather than
-- erroring, so an outage of the extension is not a crash of the Worker's check.
DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.query_timeout_watch(20);
  -- n may be zero (no extension / no stats) or positive; either is a successful
  -- call. The assertion is that the call did not raise.
  INSERT INTO qtw_cases(name) VALUES ('callable without pg_stat_statements');
END
$do$;

DO $do$
DECLARE n int := (SELECT count(*) FROM qtw_cases);
BEGIN
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 cases, % ran', n; END IF;
  RAISE NOTICE 'query_timeout_watch.test.sql: % cases passed', n;
END
$do$;
