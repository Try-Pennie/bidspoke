-- Per purpose shares of the ops Salesforce pool (#2335, finding F125).
-- Migration 20261018090000_sf_purpose_caps_2335.sql.
--
-- WHAT IT PROVES.
--   A. sf_purpose_caps is under the ops rules: row level security on,
--      organization_id uuid NOT NULL held to the nil uuid (a Salesforce org's
--      row, not an organization's), browser roles shut out, service_role read
--      only, so a share arrives only by an approval migration (L72). It names
--      only the non step purposes (a step's share is its workflow's), and only
--      an org that has an approved cap.
--   B. A lookup flood exhausts only the lookup share: verify, a scheduled read
--      and a step still get slots from the same org's pool.
--   C. A non step purpose with no approved share is refused by its own name,
--      sf_purpose_cap_unset, however empty the pool; a step never needs one.
--   D. The org's cap still binds over the shares: shares that add up past it
--      meet pool_full.
--   E. A purpose's share counts across every connection measured to the org.
--   F. The order of refusals: an org with no cap is sf_cap_unset before any
--      purpose is looked at; a missing share is named before the budget is
--      read; the sf_limits read still needs its share but no reading (L665).
--   G. The bootstrap verify of an unmeasured connection needs no share.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE pc_cases (name text PRIMARY KEY);

-- ── A. The table ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_role text;
  v_priv text;
  v_stmt text;
  v_refused integer := 0;
BEGIN
  IF to_regclass('public.sf_purpose_caps') IS NULL THEN RAISE EXCEPTION 'public.sf_purpose_caps does not exist'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sf_purpose_caps'::regclass) THEN RAISE EXCEPTION 'sf_purpose_caps has row level security off'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.sf_purpose_caps'::regclass AND a.attname = 'organization_id' AND a.attnotnull
      AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'sf_purpose_caps has no organization_id uuid NOT NULL column';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.sf_purpose_caps', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION '% holds a privilege on sf_purpose_caps', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.sf_purpose_caps', 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read sf_purpose_caps'; END IF;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('service_role', 'public.sf_purpose_caps', v_priv) THEN RAISE EXCEPTION 'service_role holds % on sf_purpose_caps', v_priv; END IF;
  END LOOP;

  INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 5, 2, 0, now(), 'Dan (test)');

  -- A share is set only by an approval migration, never by the Worker (L72).
  SET LOCAL ROLE service_role;
  BEGIN
    INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 'lookup', 1, now(), 'worker');
    RAISE EXCEPTION 'service_role wrote a purpose share';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  FOREACH v_stmt IN ARRAY ARRAY[
    -- A step's share is its workflow's, in sf_pool_caps.
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 'step', 1, now(), 'x')$s$,
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 'everything', 1, now(), 'x')$s$,
    -- A Salesforce org's row, never an organization's.
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, organization_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', gen_random_uuid(), 'lookup', 1, now(), 'x')$s$,
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 'lookup', 0, now(), 'x')$s$,
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 'lookup', 101, now(), 'x')$s$,
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 'lookup', 1, now(), '')$s$,
    -- No share for an org with no approved cap.
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000009AAA', 'lookup', 1, now(), 'x')$s$,
    $s$INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('not-an-org', 'lookup', 1, now(), 'x')$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
    EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation OR invalid_text_representation THEN
      v_refused := v_refused + 1;
    END;
  END LOOP;
  IF v_refused <> 8 THEN RAISE EXCEPTION 'sf_purpose_caps refused % of 8 bad rows', v_refused; END IF;

  -- An org cap cannot be removed while a share of it stands.
  INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES ('00Dpc0000000000AAA', 'lookup', 1, now(), 'x');
  BEGIN
    DELETE FROM public.sf_pool_caps WHERE sf_org_id = '00Dpc0000000000AAA';
    RAISE EXCEPTION 'an org cap was removed under its shares';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  DELETE FROM public.sf_purpose_caps WHERE sf_org_id = '00Dpc0000000000AAA';
  DELETE FROM public.sf_pool_caps WHERE sf_org_id = '00Dpc0000000000AAA';
  INSERT INTO pc_cases VALUES ('table: ops rules, approval only, non step purposes of an org with an approved cap');
END
$do$;

-- ── B, D, E. Shares ──────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002335';
  v_other_org uuid := 'bbbbbbbb-0000-4000-8000-000000002335';
  v_one uuid := '00000000-0000-4000-8000-0000000023c1';
  v_two uuid := '00000000-0000-4000-8000-0000000023c2';
  v_sf text := '00Dpc0000000001AAA';
  v_wf uuid := '00000000-0000-4000-8000-00000000c0f1';
  v_a record;
  v_i integer;
BEGIN
  INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES (v_sf, 5, 2, 100, now(), 'Dan (test)');
  INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES
    (v_sf, 'lookup', 2, now(), 'Dan (test)'), (v_sf, 'verify', 1, now(), 'Dan (test)'),
    (v_sf, 'connection_check', 1, now(), 'Dan (test)'), (v_sf, 'sf_limits', 1, now(), 'Dan (test)');
  -- Two connections of two organizations, measured to one org (L66, L1005).
  PERFORM public.record_measured_identity(v_org, v_one, 1, v_sf, 'ops-one@example.invalid');
  PERFORM public.record_measured_identity(v_other_org, v_two, 1, v_sf, 'ops-two@example.invalid');
  PERFORM public.record_sf_budget_reading(v_sf, 15000, 14000, 'limits');

  -- B and E: the flood, from both connections, exhausts only the lookup share.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'lookup', NULL, 'pc-l1', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'pc-l1: %', v_a.outcome; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_other_org, v_two, 1, 'lookup', NULL, 'pc-l2', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'pc-l2: %', v_a.outcome; END IF;
  FOR v_i IN 3..6 LOOP
    SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'lookup', NULL, 'pc-l' || v_i, 60);
    IF v_a.outcome <> 'purpose_share_full' OR v_a.retry_at IS NULL OR v_a.lease_id IS NOT NULL THEN
      RAISE EXCEPTION 'lookup % past its share was answered %', v_i, v_a;
    END IF;
  END LOOP;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'verify', NULL, 'pc-v1', 60, 'trypennie.my.salesforce.com');
  IF v_a.outcome <> 'granted' OR v_a.pool <> 'org' THEN RAISE EXCEPTION 'verify during a lookup flood was answered %', v_a; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'connection_check', NULL, 'pc-c1', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'the still valid check during a lookup flood was answered %', v_a.outcome; END IF;
  -- D: a step still has its workflow share, but the org's cap of 5 now binds: 4 held, one left.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'step', v_wf, 'pc-s1', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'a step during a lookup flood was answered %', v_a.outcome; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_one, 1, 'sf_limits', NULL, 'pc-m1', 60);
  IF v_a.outcome <> 'pool_full' THEN RAISE EXCEPTION 'a sixth lease on a pool of 5 was answered %', v_a.outcome; END IF;
  IF (SELECT count(*) FROM public.sf_leases WHERE sf_org_id = v_sf AND expires_at > now()) <> 5 THEN RAISE EXCEPTION 'the pool holds more than its cap'; END IF;
  INSERT INTO pc_cases VALUES ('shares: a lookup flood across connections exhausts only the lookup share, and the org cap still binds');
END
$do$;

-- ── C, F, G. Refusals by name, in order ──────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002335';
  v_conn uuid := '00000000-0000-4000-8000-0000000023d1';
  v_nocap uuid := '00000000-0000-4000-8000-0000000023d2';
  v_fresh uuid := '00000000-0000-4000-8000-0000000023d3';
  v_sf text := '00Dpc0000000002AAA';
  v_wf uuid := '00000000-0000-4000-8000-00000000d0f1';
  v_purpose text;
  v_a record;
BEGIN
  INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES (v_sf, 5, 2, 100, now(), 'Dan (test)');
  PERFORM public.record_measured_identity(v_org, v_conn, 1, v_sf, 'ops@example.invalid');

  -- C and F: no share approved and no reading: each non step purpose is refused for its missing share first.
  FOREACH v_purpose IN ARRAY ARRAY['lookup', 'verify', 'connection_check', 'sf_limits'] LOOP
    SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, v_purpose, NULL, 'pc-u-' || v_purpose, 60);
    IF v_a.outcome <> 'sf_purpose_cap_unset' OR v_a.lease_id IS NOT NULL THEN RAISE EXCEPTION '% with no approved share was answered %', v_purpose, v_a; END IF;
  END LOOP;
  -- A step needs no purpose share: with no reading it meets the budget, never sf_purpose_cap_unset.
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'step', v_wf, 'pc-u-step', 60);
  IF v_a.outcome <> 'sf_budget_unmeasured' THEN RAISE EXCEPTION 'a step with no reading was answered %', v_a.outcome; END IF;

  -- F: with its share approved, the sf_limits read is granted with no reading (L665); a lookup meets the budget.
  INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES
    (v_sf, 'sf_limits', 1, now(), 'Dan (test)'), (v_sf, 'lookup', 1, now(), 'Dan (test)');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'sf_limits', NULL, 'pc-f-limits', 60);
  IF v_a.outcome <> 'granted' THEN RAISE EXCEPTION 'the sf_limits read with its share and no reading was answered %', v_a.outcome; END IF;
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_conn, 1, 'lookup', NULL, 'pc-f-lookup', 60);
  IF v_a.outcome <> 'sf_budget_unmeasured' THEN RAISE EXCEPTION 'a lookup with its share and no reading was answered %', v_a.outcome; END IF;

  -- F: an org with no approved cap is refused for that before any share is read.
  PERFORM public.record_measured_identity(v_org, v_nocap, 1, '00Dpc0000000003AAA', 'ops@example.invalid');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_nocap, 1, 'lookup', NULL, 'pc-f-nocap', 60);
  IF v_a.outcome <> 'sf_cap_unset' THEN RAISE EXCEPTION 'an org with no cap was answered %', v_a.outcome; END IF;

  -- G: an unmeasured connection's first verify takes its host's bootstrap slot with no share at all.
  INSERT INTO public.sf_bootstrap_caps (instance_host, cap, approved_at, approved_by) VALUES ('pc.my.salesforce.com', 1, now(), 'Dan (test)');
  SELECT * INTO v_a FROM public.acquire_sf_lease(v_org, v_fresh, 1, 'verify', NULL, 'pc-g-verify', 60, 'pc.my.salesforce.com');
  IF v_a.outcome <> 'granted' OR v_a.pool <> 'bootstrap' THEN RAISE EXCEPTION 'the bootstrap verify was answered %', v_a; END IF;
  INSERT INTO pc_cases VALUES ('refusals: a missing share by its own name, after the org cap and before the budget; bootstrap needs none');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM pc_cases);
BEGIN
  IF v_n <> 3 THEN RAISE EXCEPTION 'sf_purpose_caps: % of 3 cases ran', v_n; END IF;
  RAISE NOTICE 'sf_purpose_caps: % cases passed', v_n;
END
$do$;

ROLLBACK;
