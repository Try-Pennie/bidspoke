-- Dan's approval of the trypennie Salesforce lane (#2336, Decision 11).
-- Migration 20261020010000_sf_lane_approval_2336.sql.
--
-- WHAT IT PROVES.
--   A. The approval rows exist with exactly the approved values, and the
--      migration added nothing else: one sf_pool_caps row (cap 3,
--      workflow_share 2, budget_floor 250000), one sf_bootstrap_caps row (the
--      trypennie instance host, cap 1), and four sf_purpose_caps rows (share 1
--      each for lookup, verify, connection_check, sf_limits), every one on the
--      nil uuid and approved by Dan at the time the decision was recorded.
--   B. The three tables stay read only to service_role and closed to the
--      browser roles, so a cap still arrives only by migration (L72).
--   C. The bootstrap slot: an unmeasured connection's verify against the
--      trypennie host is granted, and a second concurrent one is pool_full.
--   D. The org pool, once a measured identity names this org and a fresh
--      reading above the floor exists: up to 3 leases are granted; a 4th is
--      pool_full; a 3rd concurrent step for one workflow is
--      workflow_share_full; each non step purpose takes 1 and a 2nd concurrent
--      one is purpose_share_full.
--   E. The budget floor: a reading of 249,999 remaining is refused as
--      sf_budget_floor, and one of exactly 250,000 is granted.
--   F. Re-runs: the file runs again over its own rows and changes nothing, and
--      restores the rows into empty tables.
--   G. A re-run over a row holding different values RAISES naming that row and
--      overwrites nothing, for each of the three tables.
--
-- F and G run the migration file itself, read from the ops migrations folder
-- the harness copies into the container (scripts/sql-suite/project.sh).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE la_cases (name text PRIMARY KEY);

-- The approved values, stated once for every case below.
CREATE TEMP TABLE la_approved AS SELECT
  '00DDp00000170r6MAA'::text AS sf_org_id,
  'trypennie.my.salesforce.com'::text AS host,
  '2026-10-19 17:48:41+00'::timestamptz AS approved_at,
  'Dan Wright (Decision 11, #2336)'::text AS approved_by,
  '00000000-0000-0000-0000-000000000000'::uuid AS lane;

-- ── A. Exactly the approved rows, and nothing else ───────────────────────────
DO $do$
DECLARE
  a record;
  v_pool public.sf_pool_caps%ROWTYPE;
  v_boot public.sf_bootstrap_caps%ROWTYPE;
  v_purposes text[];
BEGIN
  SELECT * INTO a FROM la_approved;

  IF (SELECT count(*) FROM public.sf_pool_caps) <> 1 THEN RAISE EXCEPTION 'sf_pool_caps holds % rows, not the one approved', (SELECT count(*) FROM public.sf_pool_caps); END IF;
  SELECT * INTO v_pool FROM public.sf_pool_caps WHERE sf_org_id = a.sf_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'no sf_pool_caps row for %', a.sf_org_id; END IF;
  IF (v_pool.organization_id, v_pool.cap, v_pool.workflow_share, v_pool.budget_floor, v_pool.approved_at, v_pool.approved_by)
      IS DISTINCT FROM (a.lane, 3, 2, 250000, a.approved_at, a.approved_by) THEN
    RAISE EXCEPTION 'the sf_pool_caps row is not the approval: %', v_pool;
  END IF;

  IF (SELECT count(*) FROM public.sf_bootstrap_caps) <> 1 THEN RAISE EXCEPTION 'sf_bootstrap_caps holds % rows, not the one approved', (SELECT count(*) FROM public.sf_bootstrap_caps); END IF;
  SELECT * INTO v_boot FROM public.sf_bootstrap_caps WHERE instance_host = a.host;
  IF NOT FOUND THEN RAISE EXCEPTION 'no sf_bootstrap_caps row for %', a.host; END IF;
  IF (v_boot.organization_id, v_boot.cap, v_boot.approved_at, v_boot.approved_by) IS DISTINCT FROM (a.lane, 1, a.approved_at, a.approved_by) THEN
    RAISE EXCEPTION 'the sf_bootstrap_caps row is not the approval: %', v_boot;
  END IF;

  IF (SELECT count(*) FROM public.sf_purpose_caps) <> 4 THEN RAISE EXCEPTION 'sf_purpose_caps holds % rows, not the four approved', (SELECT count(*) FROM public.sf_purpose_caps); END IF;
  SELECT array_agg(purpose ORDER BY purpose) INTO v_purposes FROM public.sf_purpose_caps
  WHERE sf_org_id = a.sf_org_id AND organization_id = a.lane AND share = 1 AND approved_at = a.approved_at AND approved_by = a.approved_by;
  IF v_purposes IS DISTINCT FROM ARRAY['connection_check', 'lookup', 'sf_limits', 'verify'] THEN
    RAISE EXCEPTION 'the approved purpose shares are %, not share 1 each for connection_check, lookup, sf_limits, verify', v_purposes;
  END IF;
  INSERT INTO la_cases VALUES ('rows: exactly the approved pool cap, bootstrap cap and four purpose shares, and nothing else');
END
$do$;

-- ── B. Still read only to service_role ───────────────────────────────────────
DO $do$
DECLARE
  v_table text;
  v_priv text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.sf_pool_caps', 'public.sf_bootstrap_caps', 'public.sf_purpose_caps'] LOOP
    IF NOT has_table_privilege('service_role', v_table, 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read %', v_table; END IF;
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('service_role', v_table, v_priv) THEN RAISE EXCEPTION 'service_role holds % on %', v_priv, v_table; END IF;
      IF has_table_privilege('anon', v_table, v_priv) OR has_table_privilege('authenticated', v_table, v_priv) THEN
        RAISE EXCEPTION 'a browser role holds % on %', v_priv, v_table;
      END IF;
    END LOOP;
    IF has_table_privilege('anon', v_table, 'SELECT') OR has_table_privilege('authenticated', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'a browser role can read %', v_table;
    END IF;
  END LOOP;
  -- And measured, not only inspected: service_role's own update of the approval is refused.
  BEGIN
    SET LOCAL ROLE service_role;
    UPDATE public.sf_pool_caps SET cap = 4 WHERE sf_org_id = '00DDp00000170r6MAA';
    RAISE EXCEPTION 'service_role changed the approved cap';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  IF (SELECT cap FROM public.sf_pool_caps WHERE sf_org_id = '00DDp00000170r6MAA') <> 3 THEN RAISE EXCEPTION 'the approved cap moved'; END IF;
  INSERT INTO la_cases VALUES ('privileges: service_role reads the three tables and can write none, the browser roles reach nothing');
END
$do$;

-- ── C. The bootstrap slot on the trypennie host ──────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-00000000a336';
  v_one uuid := '00000000-0000-4000-8000-0000000a3c01';
  v_two uuid := '00000000-0000-4000-8000-0000000a3c02';
  v_a record;
BEGIN
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'verify', NULL, 'la-boot-1', 60, 'trypennie.my.salesforce.com');
  IF v_a.outcome <> 'granted' OR v_a.pool <> 'bootstrap' OR v_a.lease_id IS NULL THEN RAISE EXCEPTION 'the first bootstrap verify was answered %', v_a; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_two, 1, 'verify', NULL, 'la-boot-2', 60, 'trypennie.my.salesforce.com');
  IF v_a.outcome <> 'pool_full' OR v_a.pool <> 'bootstrap' OR v_a.retry_at IS NULL OR v_a.lease_id IS NOT NULL THEN
    RAISE EXCEPTION 'a second concurrent bootstrap verify was answered %', v_a;
  END IF;
  -- Another host has no approval, so it is still refused by name.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_two, 1, 'verify', NULL, 'la-boot-3', 60, 'tpl2.my.salesforce.com');
  IF v_a.outcome <> 'sf_cap_unset' THEN RAISE EXCEPTION 'a verify against an unapproved host was answered %', v_a.outcome; END IF;
  PERFORM public.release_sf_lease(v_org, 'la-boot-1');
  INSERT INTO la_cases VALUES ('bootstrap: one verify at a time on the trypennie host, an unapproved host still sf_cap_unset');
END
$do$;

-- ── D. The org pool ──────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-00000000a336';
  v_conn uuid := '00000000-0000-4000-8000-0000000a3d01';
  v_sf text := '00DDp00000170r6MAA';
  v_wf uuid := '00000000-0000-4000-8000-0000000a3f01';
  v_wf2 uuid := '00000000-0000-4000-8000-0000000a3f02';
  v_purpose text;
  v_a record;
BEGIN
  IF public.record_measured_identity(v_org, v_conn, 1, v_sf, 'ops-integration@example.invalid') <> 'recorded' THEN RAISE EXCEPTION 'the measured identity was not recorded'; END IF;
  -- Measured, no reading yet: refused by name.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'lookup', NULL, 'la-l0', 60);
  IF v_a.outcome <> 'sf_budget_unmeasured' THEN RAISE EXCEPTION 'a lookup with no reading was answered %', v_a.outcome; END IF;
  -- Phase 0's measured day: 474,747 used of 1,680,000.
  IF public.record_sf_budget_reading(v_sf, 1680000, 1680000 - 474747, 'limits') <> 'recorded' THEN RAISE EXCEPTION 'the reading was not recorded'; END IF;

  -- Two steps of one workflow are granted; its third is workflow_share_full while a slot is still free.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'step', v_wf, 'la-s1', 60);
  IF v_a.outcome <> 'granted' OR v_a.pool <> 'org' THEN RAISE EXCEPTION 'step 1 was answered %', v_a; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'step', v_wf, 'la-s2', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'step 2 was answered %', v_a.outcome; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'step', v_wf, 'la-s3', 60);
  IF v_a.outcome <> 'workflow_share_full' OR v_a.retry_at IS NULL OR v_a.lease_id IS NOT NULL THEN RAISE EXCEPTION 'a third concurrent step of one workflow was answered %', v_a; END IF;

  -- The free lane takes a lookup: 3 held, the cap.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'lookup', NULL, 'la-l1', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'the lookup on the free lane was answered %', v_a.outcome; END IF;
  -- A 4th, of any kind, is pool_full.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'step', v_wf2, 'la-s4', 60);
  IF v_a.outcome <> 'pool_full' OR v_a.retry_at IS NULL THEN RAISE EXCEPTION 'a 4th lease (another workflow''s step) was answered %', v_a; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'connection_check', NULL, 'la-c4', 60);
  IF v_a.outcome <> 'pool_full' THEN RAISE EXCEPTION 'a 4th lease (a connection check) was answered %', v_a.outcome; END IF;
  IF (SELECT count(*) FROM public.sf_leases WHERE sf_org_id = v_sf AND expires_at > now()) <> 3 THEN RAISE EXCEPTION 'the pool holds other than its cap of 3'; END IF;

  -- With a slot free again, a 2nd concurrent lookup meets its share.
  PERFORM public.release_sf_lease(v_org, 'la-s1');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'lookup', NULL, 'la-l2', 60);
  IF v_a.outcome <> 'purpose_share_full' OR v_a.retry_at IS NULL THEN RAISE EXCEPTION 'a 2nd concurrent lookup was answered %', v_a; END IF;
  PERFORM public.release_sf_lease(v_org, 'la-s2');
  PERFORM public.release_sf_lease(v_org, 'la-l1');

  -- Every non step purpose: one granted, a 2nd concurrent one purpose_share_full.
  FOREACH v_purpose IN ARRAY ARRAY['lookup', 'verify', 'connection_check', 'sf_limits'] LOOP
    SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, v_purpose, NULL, 'la-p1-' || v_purpose, 60);
    IF v_a.outcome <> 'granted' OR v_a.pool <> 'org' THEN RAISE EXCEPTION 'the first % was answered %', v_purpose, v_a; END IF;
    SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, v_purpose, NULL, 'la-p2-' || v_purpose, 60);
    IF v_a.outcome <> 'purpose_share_full' THEN RAISE EXCEPTION 'a 2nd concurrent % was answered %', v_purpose, v_a.outcome; END IF;
    PERFORM public.release_sf_lease(v_org, 'la-p1-' || v_purpose);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.sf_leases WHERE sf_org_id = v_sf AND expires_at > now()) THEN RAISE EXCEPTION 'leases were left held'; END IF;
  INSERT INTO la_cases VALUES ('org pool: 3 at once, a 4th pool_full, 2 steps per workflow, 1 of each other purpose');
END
$do$;

-- ── E. The budget floor of 250,000 ───────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-00000000a336';
  v_conn uuid := '00000000-0000-4000-8000-0000000a3d01';
  v_sf text := '00DDp00000170r6MAA';
  v_a record;
BEGIN
  PERFORM public.record_sf_budget_reading(v_sf, 1680000, 249999, 'limits');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'lookup', NULL, 'la-f1', 60);
  IF v_a.outcome <> 'sf_budget_floor' OR v_a.retry_at IS NULL THEN RAISE EXCEPTION 'a lookup at 249,999 remaining was answered %', v_a; END IF;
  -- The limits read itself is exempt, so the floor can be measured out of.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'sf_limits', NULL, 'la-f2', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'the sf_limits read below the floor was answered %', v_a.outcome; END IF;
  PERFORM public.release_sf_lease(v_org, 'la-f2');
  PERFORM public.record_sf_budget_reading(v_sf, 1680000, 250000, 'limits');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'lookup', NULL, 'la-f3', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'a lookup at exactly the floor was answered %', v_a.outcome; END IF;
  PERFORM public.release_sf_lease(v_org, 'la-f3');
  INSERT INTO la_cases VALUES ('floor: below 250,000 remaining is sf_budget_floor, exactly 250,000 is granted');
END
$do$;

-- ── F. Re-runs ───────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261020010000_sf_lane_approval_2336.sql');
  v_before text;
BEGIN
  SELECT string_agg(t::text, '|' ORDER BY t::text) INTO v_before FROM (
    SELECT p::text AS t FROM public.sf_pool_caps p UNION ALL SELECT b::text FROM public.sf_bootstrap_caps b UNION ALL SELECT c::text FROM public.sf_purpose_caps c) rows;
  EXECUTE v_file;
  IF (SELECT string_agg(t::text, '|' ORDER BY t::text) FROM (
      SELECT p::text AS t FROM public.sf_pool_caps p UNION ALL SELECT b::text FROM public.sf_bootstrap_caps b UNION ALL SELECT c::text FROM public.sf_purpose_caps c) rows)
      IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'a re-run over its own rows changed them';
  END IF;

  -- Into empty tables, the file writes the same rows again.
  DELETE FROM public.sf_purpose_caps;
  DELETE FROM public.sf_bootstrap_caps;
  DELETE FROM public.sf_pool_caps;
  EXECUTE v_file;
  IF (SELECT string_agg(t::text, '|' ORDER BY t::text) FROM (
      SELECT p::text AS t FROM public.sf_pool_caps p UNION ALL SELECT b::text FROM public.sf_bootstrap_caps b UNION ALL SELECT c::text FROM public.sf_purpose_caps c) rows)
      IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'the file into empty tables wrote other rows than the approval';
  END IF;
  INSERT INTO la_cases VALUES ('rerun: changes nothing over its own rows, and writes the same rows into empty tables');
END
$do$;

-- ── G. A different existing approval is refused, never overwritten ───────────
DO $do$
DECLARE
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261020010000_sf_lane_approval_2336.sql');
  v_case text;
  v_message text;
  v_refused integer := 0;
BEGIN
  FOREACH v_case IN ARRAY ARRAY['pool', 'bootstrap', 'purpose'] LOOP
    IF v_case = 'pool' THEN
      UPDATE public.sf_pool_caps SET cap = 4 WHERE sf_org_id = '00DDp00000170r6MAA';
    ELSIF v_case = 'bootstrap' THEN
      UPDATE public.sf_bootstrap_caps SET approved_by = 'someone else' WHERE instance_host = 'trypennie.my.salesforce.com';
    ELSE
      UPDATE public.sf_purpose_caps SET share = 2 WHERE sf_org_id = '00DDp00000170r6MAA' AND purpose = 'lookup';
    END IF;

    BEGIN
      EXECUTE v_file;
      RAISE EXCEPTION 'the migration ran over a different % approval', v_case;
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message NOT LIKE 'sf lane approval (#2336): %' OR v_message NOT LIKE '%nothing was changed%' THEN RAISE EXCEPTION 'the refusal did not say why: %', v_message; END IF;
      IF v_case = 'pool' AND (v_message NOT LIKE '%sf_pool_caps%' OR v_message NOT LIKE '%00DDp00000170r6MAA%' OR v_message NOT LIKE '%cap 4%') THEN
        RAISE EXCEPTION 'the pool refusal did not name its row: %', v_message;
      END IF;
      IF v_case = 'bootstrap' AND (v_message NOT LIKE '%sf_bootstrap_caps%' OR v_message NOT LIKE '%trypennie.my.salesforce.com%' OR v_message NOT LIKE '%someone else%') THEN
        RAISE EXCEPTION 'the bootstrap refusal did not name its row: %', v_message;
      END IF;
      IF v_case = 'purpose' AND (v_message NOT LIKE '%sf_purpose_caps%' OR v_message NOT LIKE '%lookup%' OR v_message NOT LIKE '%share 2%') THEN
        RAISE EXCEPTION 'the purpose refusal did not name its row: %', v_message;
      END IF;
      v_refused := v_refused + 1;
    END;

    -- Nothing overwritten: the different value stands.
    IF v_case = 'pool' AND (SELECT cap FROM public.sf_pool_caps WHERE sf_org_id = '00DDp00000170r6MAA') <> 4 THEN RAISE EXCEPTION 'the refused migration overwrote the pool cap'; END IF;
    IF v_case = 'bootstrap' AND (SELECT approved_by FROM public.sf_bootstrap_caps WHERE instance_host = 'trypennie.my.salesforce.com') <> 'someone else' THEN RAISE EXCEPTION 'the refused migration overwrote the bootstrap approval'; END IF;
    IF v_case = 'purpose' AND (SELECT share FROM public.sf_purpose_caps WHERE sf_org_id = '00DDp00000170r6MAA' AND purpose = 'lookup') <> 2 THEN RAISE EXCEPTION 'the refused migration overwrote the lookup share'; END IF;

    -- Put the approval back for the next case.
    UPDATE public.sf_pool_caps SET cap = 3 WHERE sf_org_id = '00DDp00000170r6MAA';
    UPDATE public.sf_bootstrap_caps SET approved_by = 'Dan Wright (Decision 11, #2336)' WHERE instance_host = 'trypennie.my.salesforce.com';
    UPDATE public.sf_purpose_caps SET share = 1 WHERE sf_org_id = '00DDp00000170r6MAA' AND purpose = 'lookup';
  END LOOP;
  IF v_refused <> 3 THEN RAISE EXCEPTION 'the migration refused % of 3 different approvals', v_refused; END IF;
  INSERT INTO la_cases VALUES ('refusal: a different pool cap, bootstrap approval or purpose share stops the re-run by name, overwriting nothing');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM la_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'sf_lane_approval: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'sf_lane_approval: % cases passed', v_n;
END
$do$;

ROLLBACK;
