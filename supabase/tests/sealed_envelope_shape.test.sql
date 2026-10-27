-- is_sealed_envelope: the one shape check the three bidding functions that
-- store an ops connection's sealed login share (#2565), migration
-- 20261027200000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The envelopes below
-- are planted placeholders shaped like the seal's, not ciphertext of anything,
-- and no row is written: every call is refused or misses before it reaches one.
--
-- WHY: the check was copied inline into store_rotated_envelope,
-- replace_connection_envelope and reconnect_ops_connection, and the copies had
-- already drifted: store_rotated_envelope had no kid pattern, so it stored an
-- envelope the seal cannot open and the other two refuse. Each malformed
-- envelope below is fed to all three, and every one must be refused by each,
-- so a copy that drifts again fails here.
--
-- WHAT IT PROVES:
--   A. Every malformed envelope is refused by all three functions, each by its
--      own name and as not of the seal's shape (not by some other argument check).
--   B. A well formed envelope passes the shape check in all three (the control:
--      a refusal in A is the shape check, not the call).
--   C. The helper answers false, never NULL, for every malformed envelope and
--      true for the well formed one, and is IMMUTABLE.
--   D. Each of the three functions calls the helper rather than a copy of it.
--   E. Only service_role may call the helper; the browser roles may not.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS ses_cases (name text PRIMARY KEY);
DELETE FROM ses_cases;

-- A planted envelope of the seal's shape.
CREATE OR REPLACE FUNCTION pg_temp.ses_good()
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT jsonb_build_object('v', 1, 'kid', 'ops-new', 'wrapped_key', 'cGxhbnRlZC13aw==', 'iv', 'aXYtcGxhbnRlZA', 'ct', 'cGxhbnRlZC1jdA==')
$fn$;

-- Every malformed envelope, each with what is wrong with it.
CREATE OR REPLACE FUNCTION pg_temp.ses_bad()
RETURNS TABLE (env jsonb, what text)
LANGUAGE sql
AS $fn$
  SELECT * FROM (VALUES
    (NULL::jsonb, 'no envelope'),
    ('"a string"'::jsonb, 'an envelope that is a string'),
    ('[1, 2, 3]'::jsonb, 'an envelope that is an array'),
    ('{}'::jsonb, 'an empty object'),
    (pg_temp.ses_good() - 'ct', 'an envelope missing ct'),
    (pg_temp.ses_good() - 'kid', 'an envelope missing kid'),
    (pg_temp.ses_good() || '{"extra":"field"}'::jsonb, 'an envelope with a field the seal has not'),
    (jsonb_set(pg_temp.ses_good(), '{v}', '2'), 'an envelope of another version'),
    (jsonb_set(pg_temp.ses_good(), '{v}', '"1"'), 'an envelope whose version is a string'),
    (jsonb_set(pg_temp.ses_good(), '{kid}', '7'), 'an envelope whose kid is a number'),
    (jsonb_set(pg_temp.ses_good(), '{kid}', '"Not A Kid"'), 'an envelope whose kid is not a kid'),
    (jsonb_set(pg_temp.ses_good(), '{kid}', '"-ops"'), 'an envelope whose kid starts with a dash'),
    (jsonb_set(pg_temp.ses_good(), '{kid}', to_jsonb(repeat('k', 64))), 'an envelope whose kid is too long'),
    (jsonb_set(pg_temp.ses_good(), '{wrapped_key}', 'null'), 'an envelope whose wrapped_key is null'),
    (jsonb_set(pg_temp.ses_good(), '{iv}', '12'), 'an envelope whose iv is a number'),
    (jsonb_set(pg_temp.ses_good(), '{ct}', '{}'), 'an envelope whose ct is an object'),
    (jsonb_set(pg_temp.ses_good(), '{iv}', '""'), 'an envelope with an empty iv'),
    (jsonb_set(pg_temp.ses_good(), '{ct}', '""'), 'an envelope with an empty ct'),
    (jsonb_set(pg_temp.ses_good(), '{ct}', to_jsonb(repeat('A', 70000))), 'an envelope over 64 KiB')
  ) AS b(env, what)
$fn$;

-- Calls one of the three with an envelope, every other argument well formed,
-- and answers how it ended: 'shape' when refused as not of the seal's shape by
-- that function's own name, 'passed' when the shape check let it through (the
-- call then answered or refused for the row, which no fixture holds), or the
-- error itself.
CREATE OR REPLACE FUNCTION pg_temp.ses_call(p_fn text, p_env jsonb)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  prefix text := CASE p_fn
    WHEN 'store_rotated_envelope' THEN 'rotated_envelope_refused'
    WHEN 'replace_connection_envelope' THEN 'envelope_replace_refused'
    WHEN 'reconnect_ops_connection' THEN 'reconnect_refused'
  END;
BEGIN
  IF p_fn = 'store_rotated_envelope' THEN
    PERFORM public.store_rotated_envelope('11111111-1111-1111-1111-11111112565a', '33333333-3333-3333-3333-33333332565a', 3, 4, p_env);
  ELSIF p_fn = 'replace_connection_envelope' THEN
    PERFORM public.replace_connection_envelope('11111111-1111-1111-1111-11111112565a', '33333333-3333-3333-3333-33333332565a', 'ops-old', 3, p_env);
  ELSIF p_fn = 'reconnect_ops_connection' THEN
    PERFORM public.reconnect_ops_connection('11111111-1111-1111-1111-11111112565a', '33333333-3333-3333-3333-33333332565a', 3, 4, p_env, NULL, '22222222-2222-2222-2222-22222222565a', 'ses2565@example.test');
  ELSE
    RAISE EXCEPTION 'ses_call: no function %', p_fn;
  END IF;
  RETURN 'passed';
EXCEPTION
  WHEN invalid_parameter_value THEN
    IF SQLERRM = prefix || ': the envelope is not of the seal''s shape' THEN RETURN 'shape'; END IF;
    RETURN 'refused otherwise: ' || SQLERRM;
  WHEN no_data_found THEN
    -- reconnect_ops_connection's connection_not_found: it got past the shape check.
    IF SQLERRM = 'connection_not_found' THEN RETURN 'passed'; END IF;
    RETURN 'refused otherwise: ' || SQLERRM;
END
$fn$;

-- ── A. Every malformed envelope is refused by all three ──────────────────────
DO $do$
DECLARE
  bad record;
  fn text;
  answer text;
BEGIN
  FOR bad IN SELECT * FROM pg_temp.ses_bad() LOOP
    FOREACH fn IN ARRAY ARRAY['store_rotated_envelope', 'replace_connection_envelope', 'reconnect_ops_connection'] LOOP
      answer := pg_temp.ses_call(fn, bad.env);
      IF answer <> 'shape' THEN
        RAISE EXCEPTION '% took %: %', fn, bad.what, answer;
      END IF;
    END LOOP;
  END LOOP;
  INSERT INTO ses_cases VALUES ('every malformed envelope is refused as not of the seal''s shape by all three functions, each by its own name');
END
$do$;

-- ── B. The control: a well formed envelope passes the shape check in all three ─
DO $do$
DECLARE
  fn text;
  answer text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['store_rotated_envelope', 'replace_connection_envelope', 'reconnect_ops_connection'] LOOP
    answer := pg_temp.ses_call(fn, pg_temp.ses_good());
    IF answer <> 'passed' THEN
      RAISE EXCEPTION '% refused a well formed envelope: %', fn, answer;
    END IF;
  END LOOP;
  INSERT INTO ses_cases VALUES ('a well formed envelope passes the shape check in all three functions');
END
$do$;

-- ── C. The helper itself ─────────────────────────────────────────────────────
DO $do$
DECLARE
  bad record;
  answer boolean;
BEGIN
  FOR bad IN SELECT * FROM pg_temp.ses_bad() LOOP
    answer := public.is_sealed_envelope(bad.env);
    IF answer IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'is_sealed_envelope answered % for %', coalesce(answer::text, 'NULL'), bad.what;
    END IF;
  END LOOP;
  IF public.is_sealed_envelope(pg_temp.ses_good()) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'is_sealed_envelope refused a well formed envelope';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.is_sealed_envelope(jsonb)'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'is_sealed_envelope is not IMMUTABLE';
  END IF;
  INSERT INTO ses_cases VALUES ('is_sealed_envelope answers false, never NULL, for every malformed envelope, true for a well formed one, and is IMMUTABLE');
END
$do$;

-- ── D. Each function calls the helper rather than a copy ────────────────────
DO $do$
DECLARE
  fn text;
  body text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.store_rotated_envelope(uuid, uuid, bigint, bigint, jsonb)',
    'public.replace_connection_envelope(uuid, uuid, text, bigint, jsonb)',
    'public.reconnect_ops_connection(uuid, uuid, bigint, bigint, jsonb, text, uuid, text)'
  ] LOOP
    body := pg_get_functiondef(fn::regprocedure);
    IF body NOT LIKE '%public.is_sealed_envelope(p_envelope)%' THEN
      RAISE EXCEPTION '% does not call public.is_sealed_envelope', fn;
    END IF;
    IF body LIKE '%wrapped_key%' THEN
      RAISE EXCEPTION '% still holds its own copy of the shape check', fn;
    END IF;
  END LOOP;
  INSERT INTO ses_cases VALUES ('store_rotated_envelope, replace_connection_envelope and reconnect_ops_connection each call is_sealed_envelope and hold no copy of it');
END
$do$;

-- ── E. Grants ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'public'] LOOP
    IF has_function_privilege(r, 'public.is_sealed_envelope(jsonb)', 'EXECUTE') THEN
      RAISE EXCEPTION '% may call is_sealed_envelope', r;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.is_sealed_envelope(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role may not call is_sealed_envelope, so store_rotated_envelope and replace_connection_envelope cannot';
  END IF;
  INSERT INTO ses_cases VALUES ('only service_role may call is_sealed_envelope');
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM ses_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'sealed_envelope_shape.test.sql: % cases passed', n;
END
$do$;
