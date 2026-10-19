-- The connection_check sweep's list of ops connections, and the login states the
-- tick reports (#2340, phase 10 of #1689).
-- Migration 20261020030000_connection_check_targets_2340.sql.
--
-- WHAT IT PROVES.
--   A. The function is SECURITY DEFINER with a fixed search_path, STABLE,
--      executable by service_role and by no browser role, and refuses a limit
--      outside 1 to 500 by name.
--   B. Nothing stored answers no rows, which is today: the sweep claims, finds
--      nothing and reports nothing, and the tick reports no login.
--   C. One row per ops connection whose copy is not withdrawn and not covered by
--      a tombstone, across organizations, each carrying its own. A copy past its
--      serve_until is still listed, marked not servable, so a login state it
--      holds is not read as cleared while bidding is down; only a servable one
--      is probed.
--   D. Each row's status is the one connection_status derives for it, and it
--      carries the streak, the needs_reauth time and cause, and the identity
--      verify measured for its generation, with the database clock.
--   E. The ones the sweep probes come first, so the copies it skips (past their
--      serve window, or in needs_reauth), which no check is recorded for, can
--      never fill its limit; then the least recently checked, never checked
--      before all, so a sweep held to its limit reaches every connection in turn.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE cc_cases (name text PRIMARY KEY);

-- ── A. The function's shape ───────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn record;
  v_message text;
BEGIN
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'connection_check_targets';
  IF v_fn.oid IS NULL THEN RAISE EXCEPTION 'public.connection_check_targets does not exist'; END IF;
  IF NOT v_fn.prosecdef THEN RAISE EXCEPTION 'connection_check_targets is not SECURITY DEFINER'; END IF;
  IF v_fn.provolatile <> 's' THEN RAISE EXCEPTION 'connection_check_targets is a read and is not STABLE'; END IF;
  IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'connection_check_targets has no fixed search_path';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute connection_check_targets'; END IF;
  IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute connection_check_targets';
  END IF;

  BEGIN
    PERFORM public.connection_check_targets(0);
    RAISE EXCEPTION 'connection_check_targets answered a limit of 0';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%limit must be 1 to 500%' THEN RAISE EXCEPTION 'a limit of 0 was refused for another reason: %', v_message; END IF;
  END;
  BEGIN
    PERFORM public.connection_check_targets(501);
    RAISE EXCEPTION 'connection_check_targets answered a limit of 501';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.connection_check_targets(NULL);
    RAISE EXCEPTION 'connection_check_targets answered a null limit';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO cc_cases VALUES ('shape: security definer, stable, fixed search_path, service_role only, limit refused by name');
END
$do$;

-- ── B. Nothing stored ─────────────────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.connection_check_targets(500)) THEN RAISE EXCEPTION 'connection_check_targets answered a row with no connection stored'; END IF;
  INSERT INTO cc_cases VALUES ('nothing stored answers no rows');
END
$do$;

-- ── C, D and E. The listed connections ───────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002340';
  v_other_org uuid := 'bbbbbbbb-0000-4000-8000-000000002340';
  v_healthy uuid := '00000000-0000-4000-8000-0000000c2341';
  v_reauth uuid := '00000000-0000-4000-8000-0000000c2342';
  v_failing uuid := '00000000-0000-4000-8000-0000000c2343';
  v_unchecked uuid := '00000000-0000-4000-8000-0000000c2344';
  v_expired uuid := '00000000-0000-4000-8000-0000000c2345';
  v_withdrawn uuid := '00000000-0000-4000-8000-0000000c2346';
  v_removed uuid := '00000000-0000-4000-8000-0000000c2347';
  -- A tombstone of an older generation covers nothing the copy now holds.
  v_reissued uuid := '00000000-0000-4000-8000-0000000c2348';
  v_snowflake uuid := '00000000-0000-4000-8000-0000000c2349';
  v_env jsonb := '{"v": 1, "kid": "ops-test", "wrapped_key": "d3JhcA==", "iv": "aXY=", "ct": "Y3Q="}';
  v_target jsonb := '{"instance_url": "https://example.my.salesforce.com", "client_id": "plain-client"}';
  v_rows integer;
  v_row record;
  v_status record;
  v_ids uuid[];
BEGIN
  INSERT INTO public.connection_copies (connection_id, organization_id, service, generation, envelope, public_config, target, served_at, serve_until, withdrawn_at) VALUES
    (v_healthy, v_org, 'salesforce', 2, v_env, '{"label": "plain"}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_reauth, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_failing, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_unchecked, v_other_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_expired, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '6 hours', now() - interval '1 second', NULL),
    (v_withdrawn, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', now()),
    (v_removed, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_reissued, v_org, 'salesforce', 3, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_snowflake, v_other_org, 'snowflake', 1, v_env, '{}', '{"account": "plain-account", "user": "PLAIN_USER"}', now() - interval '1 minute', now() + interval '5 hours', NULL);
  INSERT INTO public.connection_tombstones_ops (connection_id, organization_id, generation, removed_at, expires_at) VALUES
    (v_removed, v_org, 1, now(), now() + interval '7 hours'),
    (v_reissued, v_org, 2, now() - interval '1 hour', now() + interval '6 hours');
  INSERT INTO public.connection_measured_identity (connection_id, generation, organization_id, sf_org_id, username, measured_at) VALUES
    -- An older generation's measurement is not the copy's.
    (v_healthy, 1, v_org, '00Dst0000000009AAA', 'ops-old@example.com', now() - interval '2 days'),
    (v_healthy, 2, v_org, '00Dst0000000001AAA', 'ops-one@example.com', now() - interval '1 day');
  INSERT INTO public.connection_health (connection_id, organization_id, last_check_ok_at, last_check_failed_at, last_check_cause) VALUES
    (v_healthy, v_org, now() - interval '10 minutes', NULL, NULL),
    (v_expired, v_org, now() - interval '50 minutes', NULL, NULL),
    (v_reissued, v_org, now() - interval '20 minutes', NULL, NULL),
    (v_snowflake, v_other_org, now() - interval '40 minutes', now() - interval '30 minutes', 'connection_timeout');
  INSERT INTO public.connection_health (connection_id, organization_id, needs_reauth_at, needs_reauth_cause)
    VALUES (v_reauth, v_org, now() - interval '3 minutes', 'login_refused: invalid_grant');
  INSERT INTO public.connection_health (connection_id, organization_id, refresh_failures, refresh_failing_since, refresh_last_failed_at, refresh_failure_cause)
    VALUES (v_failing, v_org, 5, now() - interval '16 minutes', now() - interval '1 minute', 'token_endpoint_5xx');

  -- C. Seven listed: not the withdrawn one, not the one a tombstone covers.
  SELECT count(*) INTO v_rows FROM public.connection_check_targets(500);
  IF v_rows <> 7 THEN RAISE EXCEPTION 'connection_check_targets answered % rows, not 7', v_rows; END IF;
  IF EXISTS (SELECT 1 FROM public.connection_check_targets(500) WHERE connection_id IN (v_withdrawn, v_removed)) THEN
    RAISE EXCEPTION 'a withdrawn or removed connection was listed';
  END IF;
  SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_expired;
  IF v_row.servable IS DISTINCT FROM false THEN RAISE EXCEPTION 'a copy past its serve_until is marked servable'; END IF;
  IF EXISTS (SELECT 1 FROM public.connection_check_targets(500) WHERE connection_id <> v_expired AND NOT servable) THEN
    RAISE EXCEPTION 'a copy inside its serve_until is marked not servable';
  END IF;
  SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_unchecked;
  IF v_row.organization_id <> v_other_org THEN RAISE EXCEPTION 'a row of the other organization does not carry its own'; END IF;
  INSERT INTO cc_cases VALUES ('lists every connection not withdrawn and not removed, across organizations, an expired copy marked not servable');

  -- D. The status agrees with connection_status, row for row, for both organizations.
  FOR v_status IN
    SELECT s.connection_id, s.status FROM public.connection_status(v_org, 1000) s
    UNION ALL SELECT s.connection_id, s.status FROM public.connection_status(v_other_org, 1000) s
  LOOP
    SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_status.connection_id;
    IF FOUND AND v_row.status IS DISTINCT FROM v_status.status THEN
      RAISE EXCEPTION 'connection % reads % here and % in connection_status', v_status.connection_id, v_row.status, v_status.status;
    END IF;
  END LOOP;
  SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_reauth;
  IF v_row.status <> 'needs_reauth' OR v_row.needs_reauth_cause <> 'login_refused: invalid_grant' OR v_row.needs_reauth_at IS NULL THEN
    RAISE EXCEPTION 'the needs_reauth row reads %', v_row;
  END IF;
  SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_failing;
  IF v_row.status <> 'refresh_failing' OR v_row.refresh_failures <> 5 OR v_row.refresh_failing_since > v_row.db_now - interval '15 minutes' THEN
    RAISE EXCEPTION 'the refresh_failing row reads %', v_row;
  END IF;
  SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_unchecked;
  IF v_row.status <> 'unchecked' OR v_row.refresh_failures <> 0 OR v_row.refresh_failing_since IS NOT NULL OR v_row.last_check_ok_at IS NOT NULL THEN
    RAISE EXCEPTION 'a connection with no health row reads %', v_row;
  END IF;
  SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_snowflake;
  IF v_row.status <> 'check_failing' OR v_row.last_check_failed_at IS NULL OR v_row.service <> 'snowflake' THEN RAISE EXCEPTION 'the failing check reads %', v_row; END IF;
  IF v_row.measured_sf_org_id IS NOT NULL THEN RAISE EXCEPTION 'a connection with no measured identity carries one'; END IF;
  SELECT * INTO v_row FROM public.connection_check_targets(500) WHERE connection_id = v_healthy;
  IF v_row.status <> 'healthy' OR v_row.generation <> 2 OR v_row.target IS DISTINCT FROM v_target OR v_row.public_config IS DISTINCT FROM '{"label": "plain"}'::jsonb THEN
    RAISE EXCEPTION 'the healthy row reads %', v_row;
  END IF;
  IF v_row.measured_sf_org_id IS DISTINCT FROM '00Dst0000000001AAA' OR v_row.measured_username IS DISTINCT FROM 'ops-one@example.com' THEN
    RAISE EXCEPTION 'the healthy row does not carry the identity its own generation measured';
  END IF;
  IF v_row.db_now IS NULL OR v_row.db_now > now() + interval '1 second' THEN RAISE EXCEPTION 'a row carries no database clock'; END IF;
  INSERT INTO cc_cases VALUES ('each row carries connection_status''s status, the streak, needs_reauth and its generation''s measured identity');

  -- E. The probed first, never checked before the oldest check; the skipped last.
  SELECT array_agg(connection_id) INTO v_ids FROM public.connection_check_targets(500);
  IF v_ids[1:2] @> ARRAY[v_unchecked, v_failing] IS NOT TRUE OR ARRAY[v_unchecked, v_failing] @> v_ids[1:2] IS NOT TRUE THEN
    RAISE EXCEPTION 'the never checked of the probed do not come first: %', v_ids;
  END IF;
  IF v_ids[3:5] IS DISTINCT FROM ARRAY[v_snowflake, v_reissued, v_healthy] THEN RAISE EXCEPTION 'the checked are not oldest check first: %', v_ids; END IF;
  -- The one in needs_reauth was never checked and the expired one was checked longest ago, yet both come last.
  IF v_ids[6:7] IS DISTINCT FROM ARRAY[v_reauth, v_expired] THEN RAISE EXCEPTION 'the copies the sweep skips do not come last: %', v_ids; END IF;
  SELECT count(*) INTO v_rows FROM public.connection_check_targets(2);
  IF v_rows <> 2 THEN RAISE EXCEPTION 'a limit of 2 answered % rows', v_rows; END IF;
  IF EXISTS (SELECT 1 FROM public.connection_check_targets(5) WHERE connection_id IN (v_reauth, v_expired)) THEN
    RAISE EXCEPTION 'a limit filled before the probed ones ran out holds a copy the sweep skips';
  END IF;
  INSERT INTO cc_cases VALUES ('the probed first, least recently checked first among them, the skipped last, held to the limit');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM cc_cases);
BEGIN
  IF v_n <> 5 THEN RAISE EXCEPTION 'connection_check_targets: % of 5 cases ran', v_n; END IF;
  RAISE NOTICE 'connection_check_targets: % cases passed', v_n;
END
$do$;

ROLLBACK;
