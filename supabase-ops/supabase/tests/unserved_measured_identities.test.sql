-- The measured identities of connections bidding never stored (#2573).
-- Migration 20261027180000_unserved_measured_identities_2573.sql.
--
-- WHAT IT PROVES.
--   A. The function is SECURITY DEFINER with a fixed search_path, a write
--      (VOLATILE), executable by service_role and by no browser role, and
--      refuses a missing time or list, a null in the list and a list over
--      1,000 by name.
--   B. It removes a measured identity only when all three hold: the
--      measurement is more than an hour older than the list (the margin a
--      create needs between its verify and its insert landing in a serve), the
--      list does not name the connection, and ops holds no copy of it at all.
--      Each removed row is answered with its organization, connection,
--      generation and measurement time, and a second call removes nothing.
--   C. The hour is judged on the earlier of the list's time and the database's
--      own clock, so a list stamped in the future removes nothing younger than
--      an hour by the database's clock.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE umi_cases (name text PRIMARY KEY);

-- ── A. The function's shape ───────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn record;
  v_message text;
  v_many uuid[];
BEGIN
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'remove_unserved_measured_identities';
  IF v_fn.oid IS NULL THEN RAISE EXCEPTION 'public.remove_unserved_measured_identities does not exist'; END IF;
  IF NOT v_fn.prosecdef THEN RAISE EXCEPTION 'remove_unserved_measured_identities is not SECURITY DEFINER'; END IF;
  IF v_fn.provolatile <> 'v' THEN RAISE EXCEPTION 'remove_unserved_measured_identities is a write and is not VOLATILE'; END IF;
  IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'remove_unserved_measured_identities has no fixed search_path';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute remove_unserved_measured_identities'; END IF;
  IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute remove_unserved_measured_identities';
  END IF;

  BEGIN
    PERFORM public.remove_unserved_measured_identities(NULL, ARRAY[]::uuid[]);
    RAISE EXCEPTION 'remove_unserved_measured_identities answered with no served_at';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%served_at and the named connections are required%' THEN RAISE EXCEPTION 'no served_at was refused for another reason: %', v_message; END IF;
  END;
  BEGIN
    PERFORM public.remove_unserved_measured_identities(now(), NULL);
    RAISE EXCEPTION 'remove_unserved_measured_identities answered with no list';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.remove_unserved_measured_identities(now(), ARRAY[NULL]::uuid[]);
    RAISE EXCEPTION 'remove_unserved_measured_identities answered a list holding a null';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%holds a null%' THEN RAISE EXCEPTION 'a null in the list was refused for another reason: %', v_message; END IF;
  END;
  SELECT array_agg(gen_random_uuid()) INTO v_many FROM generate_series(1, 1001);
  BEGIN
    PERFORM public.remove_unserved_measured_identities(now(), v_many);
    RAISE EXCEPTION 'remove_unserved_measured_identities answered a list of 1001';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%at most 1000%' THEN RAISE EXCEPTION 'a list of 1001 was refused for another reason: %', v_message; END IF;
  END;
  INSERT INTO umi_cases VALUES ('shape: security definer, volatile, fixed search_path, service_role only, bad input refused by name');
END
$do$;

-- ── B. Only an old, unnamed measurement of a connection ops never held ─────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002573';
  v_other_org uuid := 'bbbbbbbb-0000-4000-8000-000000002573';
  -- Verify measured it 2 hours before the list, the list does not name it, and ops never held a copy: removed.
  v_orphan uuid := '00000000-0000-4000-8000-0000000025a1';
  -- The same in another organization: removed too, since the list spans every organization.
  v_orphan_other uuid := '00000000-0000-4000-8000-0000000025a2';
  -- Measured 30 minutes before the list: a create whose insert may land in a later list, so kept.
  v_young uuid := '00000000-0000-4000-8000-0000000025a3';
  -- Named by the list, though no copy is saved yet (a copy refused as expired, say): kept.
  v_named uuid := '00000000-0000-4000-8000-0000000025a4';
  -- Not named, but ops holds a copy of it (withdrawn): a connection bidding did store once, so kept.
  v_held uuid := '00000000-0000-4000-8000-0000000025a5';
  v_env jsonb := '{"v": 1, "kid": "ops-test", "wrapped_key": "d3JhcA==", "iv": "aXY=", "ct": "Y3Q="}';
  v_served timestamptz := now();
  v_rows integer;
  v_row record;
BEGIN
  INSERT INTO public.connection_copies (connection_id, organization_id, service, generation, envelope, public_config, target, served_at, serve_until, withdrawn_at)
    VALUES (v_held, v_org, 'salesforce', 1, v_env, '{}', NULL, now() - interval '3 hours', now() + interval '2 hours', now() - interval '2 hours');
  INSERT INTO public.connection_measured_identity (connection_id, generation, organization_id, sf_org_id, username, measured_at) VALUES
    (v_orphan, 1, v_org, '00Dst0000000001AAA', 'ops-one@example.com', v_served - interval '2 hours'),
    (v_orphan_other, 1, v_other_org, '00Dst0000000002AAA', 'ops-two@example.com', v_served - interval '61 minutes'),
    (v_young, 1, v_org, '00Dst0000000003AAA', 'ops-three@example.com', v_served - interval '30 minutes'),
    (v_named, 1, v_org, '00Dst0000000004AAA', 'ops-four@example.com', v_served - interval '2 hours'),
    (v_held, 1, v_org, '00Dst0000000005AAA', 'ops-five@example.com', v_served - interval '3 hours');

  CREATE TEMP TABLE umi_removed ON COMMIT DROP AS
    SELECT * FROM public.remove_unserved_measured_identities(v_served, ARRAY[v_named]);
  SELECT count(*) INTO v_rows FROM umi_removed;
  IF v_rows <> 2 THEN RAISE EXCEPTION 'removed % measured identities, not 2 (the two orphans)', v_rows; END IF;
  SELECT * INTO v_row FROM umi_removed WHERE connection_id = v_orphan;
  IF v_row.organization_id IS DISTINCT FROM v_org OR v_row.generation IS DISTINCT FROM 1::bigint OR v_row.measured_at IS DISTINCT FROM v_served - interval '2 hours' THEN
    RAISE EXCEPTION 'the orphan is not answered with its organization, generation and measurement time';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM umi_removed WHERE connection_id = v_orphan_other AND organization_id = v_other_org) THEN
    RAISE EXCEPTION 'the other organization''s orphan was not removed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.connection_measured_identity WHERE connection_id IN (v_orphan, v_orphan_other)) THEN
    RAISE EXCEPTION 'an orphan''s measured identity is still stored';
  END IF;
  SELECT count(*) INTO v_rows FROM public.connection_measured_identity WHERE connection_id IN (v_young, v_named, v_held);
  IF v_rows <> 3 THEN RAISE EXCEPTION 'a measured identity that had to be kept was removed: % of 3 kept', v_rows; END IF;

  SELECT count(*) INTO v_rows FROM public.remove_unserved_measured_identities(v_served, ARRAY[v_named]);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'a second call removed % more', v_rows; END IF;
  INSERT INTO umi_cases VALUES ('removes only a measurement over an hour old, unnamed, of a connection ops never held, in any organization, once');
END
$do$;

-- ── C. A list stamped in the future is judged on the database's clock ─────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002573';
  v_recent uuid := '00000000-0000-4000-8000-0000000025b1';
  v_rows integer;
BEGIN
  INSERT INTO public.connection_measured_identity (connection_id, generation, organization_id, sf_org_id, username, measured_at)
    VALUES (v_recent, 1, v_org, '00Dst0000000006AAA', 'ops-six@example.com', now() - interval '10 minutes');
  SELECT count(*) INTO v_rows FROM public.remove_unserved_measured_identities(now() + interval '3 hours', ARRAY[]::uuid[]) r WHERE r.connection_id = v_recent;
  IF v_rows <> 0 OR NOT EXISTS (SELECT 1 FROM public.connection_measured_identity WHERE connection_id = v_recent) THEN RAISE EXCEPTION 'a list stamped 3 hours ahead removed a measurement 10 minutes old by the database''s clock'; END IF;
  INSERT INTO umi_cases VALUES ('a list stamped in the future removes nothing younger than an hour by the database clock');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM umi_cases);
BEGIN
  IF v_n <> 3 THEN RAISE EXCEPTION 'remove_unserved_measured_identities: % of 3 cases ran', v_n; END IF;
  RAISE NOTICE 'remove_unserved_measured_identities: % cases passed', v_n;
END
$do$;

ROLLBACK;
