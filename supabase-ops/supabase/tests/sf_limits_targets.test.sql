-- The sf_limits sweep's list of measured Salesforce orgs (#2336, phase 6 of #1689).
-- Migration 20261019230000_sf_limits_targets_2336.sql.
--
-- WHAT IT PROVES.
--   A. The function is SECURITY DEFINER with a fixed search_path, STABLE,
--      executable by service_role and by no browser role, and refuses a limit
--      outside 1 to 100 by name.
--   B. One row per MEASURED org, never per connection: two connections that
--      measured as one org are one row, keyed on the measured org id and never
--      on a declared target (L66, L83). Each row names one connection that can
--      read it: a Salesforce copy whose generation is the measured one, not
--      withdrawn, not past serve_until, not covered by a tombstone. A healthy
--      connection is chosen over one in needs_reauth, then the latest measured.
--   C. Nothing measured answers no rows, which is today: the sweep claims,
--      finds nothing and reports nothing.
--   D. Each row carries the org's last reading time (null when it has none) and
--      the database clock, so the sweep judges a reading's age on one clock.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE st_cases (name text PRIMARY KEY);

-- ── A. The function's shape ───────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn record;
  v_message text;
BEGIN
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'sf_limits_targets';
  IF v_fn.oid IS NULL THEN RAISE EXCEPTION 'public.sf_limits_targets does not exist'; END IF;
  IF NOT v_fn.prosecdef THEN RAISE EXCEPTION 'sf_limits_targets is not SECURITY DEFINER'; END IF;
  IF v_fn.provolatile <> 's' THEN RAISE EXCEPTION 'sf_limits_targets is a read and is not STABLE'; END IF;
  IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'sf_limits_targets has no fixed search_path';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute sf_limits_targets'; END IF;
  IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute sf_limits_targets';
  END IF;

  BEGIN
    PERFORM public.sf_limits_targets(0);
    RAISE EXCEPTION 'sf_limits_targets answered a limit of 0';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%limit must be 1 to 100%' THEN RAISE EXCEPTION 'a limit of 0 was refused for another reason: %', v_message; END IF;
  END;
  BEGIN
    PERFORM public.sf_limits_targets(101);
    RAISE EXCEPTION 'sf_limits_targets answered a limit of 101';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO st_cases VALUES ('shape: security definer, stable, fixed search_path, service_role only, limit refused by name');
END
$do$;

-- ── C. Nothing measured ───────────────────────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sf_limits_targets(100)) THEN RAISE EXCEPTION 'sf_limits_targets answered a row with nothing measured'; END IF;
  INSERT INTO st_cases VALUES ('nothing measured answers no rows');
END
$do$;

-- ── B and D. One row per measured org, with a connection that can read it ─────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002336';
  v_other_org uuid := 'bbbbbbbb-0000-4000-8000-000000002336';
  -- Two connections measured as org one; the first is in needs_reauth, the second is healthy.
  v_reauth uuid := '00000000-0000-4000-8000-0000000051a1';
  v_healthy uuid := '00000000-0000-4000-8000-0000000051a2';
  -- One measured as org two at an older generation only: its copy has moved on, so it cannot read.
  v_moved uuid := '00000000-0000-4000-8000-0000000051a3';
  -- One of another Bidspoke organization, measured as org three, withdrawn.
  v_withdrawn uuid := '00000000-0000-4000-8000-0000000051a4';
  -- One measured as org four, removed by a tombstone.
  v_removed uuid := '00000000-0000-4000-8000-0000000051a5';
  -- One measured as org five, past its serve_until.
  v_expired uuid := '00000000-0000-4000-8000-0000000051a6';
  -- A Snowflake copy that somehow carries a measured row: not a Salesforce connection.
  v_snowflake uuid := '00000000-0000-4000-8000-0000000051a7';
  -- One of the other organization, measured as org six, usable: proves the read spans organizations.
  v_lane uuid := '00000000-0000-4000-8000-0000000051a8';
  v_sf_one text := '00Dst0000000001AAA';
  v_sf_two text := '00Dst0000000002AAA';
  v_sf_three text := '00Dst0000000003AAA';
  v_sf_four text := '00Dst0000000004AAA';
  v_sf_five text := '00Dst0000000005AAA';
  v_sf_six text := '00Dst0000000006AAA';
  v_env jsonb := '{"v": 1, "kid": "ops-test", "wrapped_key": "d3JhcA==", "iv": "aXY=", "ct": "Y3Q="}';
  v_target jsonb := '{"instance_url": "https://example.my.salesforce.com", "client_id": "plain-client"}';
  v_rows integer;
  v_row record;
BEGIN
  INSERT INTO public.connection_copies (connection_id, organization_id, service, generation, envelope, public_config, target, served_at, serve_until, withdrawn_at) VALUES
    (v_reauth, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_healthy, v_org, 'salesforce', 2, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_moved, v_org, 'salesforce', 3, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_withdrawn, v_other_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', now()),
    (v_removed, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_expired, v_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '6 hours', now() - interval '1 second', NULL),
    (v_snowflake, v_org, 'snowflake', 1, v_env, '{}', '{}', now() - interval '1 minute', now() + interval '5 hours', NULL),
    (v_lane, v_other_org, 'salesforce', 1, v_env, '{}', v_target, now() - interval '1 minute', now() + interval '5 hours', NULL);
  INSERT INTO public.connection_tombstones_ops (connection_id, organization_id, generation, removed_at, expires_at)
    VALUES (v_removed, v_org, 1, now(), now() + interval '7 hours');
  INSERT INTO public.connection_measured_identity (connection_id, generation, organization_id, sf_org_id, username, measured_at) VALUES
    -- The reauth one measured later, so only the health rule can put the healthy one first.
    (v_reauth, 1, v_org, v_sf_one, 'ops-one@example.com', now()),
    (v_healthy, 2, v_org, v_sf_one, 'ops-two@example.com', now() - interval '1 hour'),
    (v_moved, 2, v_org, v_sf_two, 'ops-three@example.com', now()),
    (v_withdrawn, 1, v_other_org, v_sf_three, 'ops-four@example.com', now()),
    (v_removed, 1, v_org, v_sf_four, 'ops-five@example.com', now()),
    (v_expired, 1, v_org, v_sf_five, 'ops-six@example.com', now()),
    (v_snowflake, 1, v_org, v_sf_two, 'ops-seven@example.com', now()),
    (v_lane, 1, v_other_org, v_sf_six, 'ops-eight@example.com', now());
  INSERT INTO public.connection_health (connection_id, organization_id, needs_reauth_at, needs_reauth_cause)
    VALUES (v_reauth, v_org, now(), 'login_refused: invalid_grant');
  INSERT INTO public.sf_budget_readings (sf_org_id, daily_api_max, daily_api_remaining, source, measured_at)
    VALUES (v_sf_one, 1000, 600, 'sforce_limit_info', now() - interval '3 minutes');

  SELECT count(*) INTO v_rows FROM public.sf_limits_targets(100);
  IF v_rows <> 2 THEN RAISE EXCEPTION 'sf_limits_targets answered % rows, not 2 (org one and org six)', v_rows; END IF;

  SELECT * INTO v_row FROM public.sf_limits_targets(100) WHERE sf_org_id = v_sf_one;
  IF v_row.connection_id IS DISTINCT FROM v_healthy THEN RAISE EXCEPTION 'org one is read through %, not the healthy connection', v_row.connection_id; END IF;
  IF v_row.organization_id <> v_org OR v_row.generation <> 2 THEN RAISE EXCEPTION 'org one''s row names the wrong organization or generation'; END IF;
  IF v_row.target IS DISTINCT FROM v_target THEN RAISE EXCEPTION 'org one''s row does not carry the copy''s target'; END IF;
  IF v_row.reading_measured_at IS NULL OR v_row.reading_measured_at > v_row.db_now - interval '2 minutes' THEN
    RAISE EXCEPTION 'org one''s row does not carry its reading time';
  END IF;

  SELECT * INTO v_row FROM public.sf_limits_targets(100) WHERE sf_org_id = v_sf_six;
  IF v_row.organization_id <> v_other_org OR v_row.connection_id <> v_lane THEN RAISE EXCEPTION 'org six is not read through its own organization''s connection'; END IF;
  IF v_row.reading_measured_at IS NOT NULL THEN RAISE EXCEPTION 'org six has no reading and its row says it has one'; END IF;
  IF v_row.db_now IS NULL THEN RAISE EXCEPTION 'a row carries no database clock'; END IF;

  -- The limit caps the rows, in org order, so the caller can tell a full page (L24).
  SELECT count(*) INTO v_rows FROM public.sf_limits_targets(1);
  IF v_rows <> 1 THEN RAISE EXCEPTION 'a limit of 1 answered % rows', v_rows; END IF;
  IF (SELECT sf_org_id FROM public.sf_limits_targets(1)) <> v_sf_one THEN RAISE EXCEPTION 'a limit of 1 did not answer the first org'; END IF;

  -- With the healthy one gone, the org is still read, through the one in needs_reauth, so its refusal is reported by name.
  UPDATE public.connection_copies SET withdrawn_at = now() WHERE connection_id = v_healthy;
  SELECT * INTO v_row FROM public.sf_limits_targets(100) WHERE sf_org_id = v_sf_one;
  IF v_row.connection_id IS DISTINCT FROM v_reauth THEN RAISE EXCEPTION 'org one was dropped when only its needs_reauth connection was left'; END IF;

  INSERT INTO st_cases VALUES ('one row per measured org, through a usable Salesforce copy of the measured generation, healthy first, with its reading time');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM st_cases);
BEGIN
  IF v_n <> 3 THEN RAISE EXCEPTION 'sf_limits_targets: % of 3 cases ran', v_n; END IF;
  RAISE NOTICE 'sf_limits_targets: % cases passed', v_n;
END
$do$;

ROLLBACK;
