-- Behavioural tests for held_click_claims and record_held_click (#1552).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. It uses its
-- own organization, user and partners with fixed ids (none shared with
-- buyer_profiles.test.sql), deletes them first and leaves them in place, so a
-- rerun is idempotent. No real identity appears anywhere in it.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, with the
-- cases counted into a temp table and compared to the number at the bottom
-- (L288). Assertions use IS DISTINCT FROM, never <>, so a NULL cannot pass.

CREATE TEMP TABLE IF NOT EXISTS held_cases (name text PRIMARY KEY);
DELETE FROM held_cases;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  DELETE FROM public.held_click_claims WHERE organization_id IN ('11111111-1111-1111-1111-111111115520', '11111111-1111-1111-1111-111111115521');
  DELETE FROM public.partner_configs WHERE organization_id IN ('11111111-1111-1111-1111-111111115520', '11111111-1111-1111-1111-111111115521');
  DELETE FROM public.audit_log WHERE organization_id IN ('11111111-1111-1111-1111-111111115520', '11111111-1111-1111-1111-111111115521');
  DELETE FROM public.users WHERE organization_id IN ('11111111-1111-1111-1111-111111115520', '11111111-1111-1111-1111-111111115521');
  DELETE FROM public.organizations WHERE id IN ('11111111-1111-1111-1111-111111115520', '11111111-1111-1111-1111-111111115521');
END
$do$;

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111115520', 'Held Org', 'held-org');
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111115521', 'Other Org', 'held-other-org');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES ('22222222-2222-2222-2222-222222225520', '11111111-1111-1111-1111-111111115520', 'held@example.test', 'Held User');
INSERT INTO public.partner_configs (id, organization_id, name, slug, partner_type, is_active, updated_by, updated_by_email)
VALUES ('33333333-3333-3333-3333-333333335520', '11111111-1111-1111-1111-111111115520', 'Held Click Buyer', 'held-click-buyer', 'buyer', true, '22222222-2222-2222-2222-222222225520', 'held@example.test');

-- ── 1. Grants: anon and authenticated reach neither the table nor the function; service_role reaches both ──
DO $do$
DECLARE
  verb text;
  fn text := 'public.record_held_click(uuid, uuid, text, text, text, text, uuid, text, text)';
  bad text[] := '{}';
BEGIN
  FOREACH verb IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    IF has_table_privilege('authenticated', 'public.held_click_claims', verb) THEN bad := array_append(bad, 'authenticated has ' || verb); END IF;
    IF has_table_privilege('anon', 'public.held_click_claims', verb) THEN bad := array_append(bad, 'anon has ' || verb); END IF;
    IF NOT has_table_privilege('service_role', 'public.held_click_claims', verb) THEN bad := array_append(bad, 'service_role lacks ' || verb); END IF;
  END LOOP;
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN bad := array_append(bad, 'anon can execute record_held_click'); END IF;
  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN bad := array_append(bad, 'authenticated can execute record_held_click'); END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN bad := array_append(bad, 'service_role cannot execute record_held_click'); END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.held_click_claims'::regclass) THEN bad := array_append(bad, 'RLS is off'); END IF;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO held_cases(name) VALUES ('grants and rls');
END
$do$;

-- ── 2. A first hold is recorded whole, with last_execution_id the holding execution ──
DO $do$
DECLARE
  r jsonb;
BEGIN
  r := public.record_held_click('11111111-1111-1111-1111-111111115520', '33333333-3333-3333-3333-333333335520', 'a0B000000000001AAA',
    'outcome_unknown', 'no answer from the buyer: timed out', NULL, '44444444-4444-4444-4444-444444445520', 'exec-1', 'trace-1');
  IF r->>'reason' IS DISTINCT FROM 'outcome_unknown' THEN RAISE EXCEPTION 'reason not stored: %', r; END IF;
  IF r->>'execution_id' IS DISTINCT FROM 'exec-1' OR r->>'last_execution_id' IS DISTINCT FROM 'exec-1' THEN RAISE EXCEPTION 'executions not stored: %', r; END IF;
  IF r->>'organization_id' IS DISTINCT FROM '11111111-1111-1111-1111-111111115520' THEN RAISE EXCEPTION 'org not stored: %', r; END IF;
  IF (r->>'held_at') IS NULL THEN RAISE EXCEPTION 'held_at not stamped'; END IF;
  INSERT INTO held_cases(name) VALUES ('first hold');
END
$do$;

-- ── 3. A later click finding it in doubt keeps the first hold and moves only the last sighting ──
DO $do$
DECLARE
  before jsonb;
  r jsonb;
BEGIN
  SELECT to_jsonb(h) INTO before FROM public.held_click_claims h WHERE prospect_id = 'a0B000000000001AAA';
  PERFORM pg_sleep(0.01);
  r := public.record_held_click('11111111-1111-1111-1111-111111115520', '33333333-3333-3333-3333-333333335520', 'a0B000000000001AAA',
    'claim_in_doubt', 'an earlier send never recorded its outcome', NULL, '44444444-4444-4444-4444-444444445520', 'exec-2', 'trace-2');
  IF (SELECT count(*) FROM public.held_click_claims WHERE prospect_id = 'a0B000000000001AAA') IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'a second row was written'; END IF;
  IF r->>'reason' IS DISTINCT FROM 'outcome_unknown' OR r->>'execution_id' IS DISTINCT FROM 'exec-1' OR r->>'detail' IS DISTINCT FROM before->>'detail' THEN RAISE EXCEPTION 'the first hold was overwritten: %', r; END IF;
  IF r->>'held_at' IS DISTINCT FROM before->>'held_at' THEN RAISE EXCEPTION 'held_at moved'; END IF;
  IF r->>'last_execution_id' IS DISTINCT FROM 'exec-2' THEN RAISE EXCEPTION 'last_execution_id did not move: %', r; END IF;
  IF (r->>'last_seen_at')::timestamptz <= (before->>'last_seen_at')::timestamptz THEN RAISE EXCEPTION 'last_seen_at did not move'; END IF;
  INSERT INTO held_cases(name) VALUES ('in doubt sighting keeps the first hold');
END
$do$;

-- ── 4. A fresh hold on a left over row replaces it whole: the claim had been free in between ──
DO $do$
DECLARE
  r jsonb;
BEGIN
  r := public.record_held_click('11111111-1111-1111-1111-111111115520', '33333333-3333-3333-3333-333333335520', 'a0B000000000001AAA',
    'sold_mark_failed', 'the buyer created a0B5f00000XyZ12AAB, and marking the claim sold failed', 'a0B5f00000XyZ12AAB', '44444444-4444-4444-4444-444444445520', 'exec-3', 'trace-3');
  IF r->>'reason' IS DISTINCT FROM 'sold_mark_failed' OR r->>'execution_id' IS DISTINCT FROM 'exec-3' OR r->>'last_execution_id' IS DISTINCT FROM 'exec-3' THEN RAISE EXCEPTION 'a fresh hold did not replace the row: %', r; END IF;
  IF r->>'partner_lead_id' IS DISTINCT FROM 'a0B5f00000XyZ12AAB' THEN RAISE EXCEPTION 'partner lead id not stored: %', r; END IF;
  INSERT INTO held_cases(name) VALUES ('fresh hold replaces a left over row');
END
$do$;

-- ── 5. Refusals: a partner outside the organization, and a reason outside the vocabulary ──
DO $do$
DECLARE
  msg text;
BEGIN
  BEGIN
    PERFORM public.record_held_click('11111111-1111-1111-1111-111111115521', '33333333-3333-3333-3333-333333335520', 'a0B000000000002AAA',
      'outcome_unknown', 'x', NULL, NULL, 'exec-9', NULL);
    RAISE EXCEPTION 'a partner from another organization was recorded';
  EXCEPTION WHEN SQLSTATE 'BP404' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg IS DISTINCT FROM 'partner_not_in_org' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
  END;
  BEGIN
    PERFORM public.record_held_click('11111111-1111-1111-1111-111111115520', '33333333-3333-3333-3333-333333335520', 'a0B000000000002AAA',
      'count_failed', 'x', NULL, NULL, 'exec-9', NULL);
    RAISE EXCEPTION 'a reason outside the vocabulary was recorded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.held_click_claims WHERE prospect_id = 'a0B000000000002AAA') THEN RAISE EXCEPTION 'a refused hold left a row'; END IF;
  INSERT INTO held_cases(name) VALUES ('refusals');
END
$do$;

-- ── 6. A partner with a held click cannot be deleted, and the refusal names the table ──
DO $do$
DECLARE
  msg text;
  detail text;
BEGIN
  BEGIN
    PERFORM public.delete_partner_config('11111111-1111-1111-1111-111111115520', '33333333-3333-3333-3333-333333335520', '22222222-2222-2222-2222-222222225520', 'held@example.test');
    RAISE EXCEPTION 'a partner with a held click was deleted';
  EXCEPTION WHEN SQLSTATE 'BP023' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT, detail = PG_EXCEPTION_DETAIL;
    IF msg IS DISTINCT FROM 'partner_has_dependents' THEN RAISE EXCEPTION 'wrong refusal: %', msg; END IF;
    IF position('held_click_claims' IN detail) = 0 THEN RAISE EXCEPTION 'refusal does not name the table: %', detail; END IF;
  END;
  INSERT INTO held_cases(name) VALUES ('partner delete refused');
END
$do$;

-- ── The count ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM held_cases;
  IF n IS DISTINCT FROM 6 THEN RAISE EXCEPTION 'ran % of 6 cases', n; END IF;
  RAISE NOTICE 'held_click_claims.test.sql: % of 6 cases passed', n;
END
$do$;
