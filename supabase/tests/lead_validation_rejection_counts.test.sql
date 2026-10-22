-- The lead validation rejection watch's one pass count (#2647), migration
-- 20261022160000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Fixed ids, deleted
-- first, so a rerun starts clean. No real identity.
--
-- WHAT IT PROVES:
--   A. lead_validation_rejection_counts counts finished live runs of the one
--      workflow in [p_from, p_to), across two daily partitions: a test run, a
--      running run, another workflow's run and a run on either side of the span
--      are not counted, and a run exactly at p_from is while one at p_to is not.
--   B. Of those it counts the runs ending at the step, those that failed there,
--      and a count per reason of the rest, listed or not; a failed run's reason,
--      a reason of a run ending elsewhere, and a missing reason are in no reason.
--   C. It agrees with the twelve head count predicates it replaced, bucket by
--      bucket, on the same rows.
--   D. An empty span is one row of zeros and an empty object, never no row.
--   E. It is STABLE, SECURITY INVOKER with its own search_path, and only
--      service_role may call it.
--
-- Mutations tried on 2026-10-22 (each turned its case red, then the function
-- was put back): dropping `NOT we.is_test` (A answered 9, 7, 1), and dropping
-- `AND we.status <> 'failed'` from the reason (B lost a count to a repeated key).
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS lvrc_cases (name text PRIMARY KEY);
DELETE FROM lvrc_cases;

DO $do$
DECLARE
  d date;
  v_name text;
BEGIN
  FOREACH d IN ARRAY ARRAY[CURRENT_DATE - 2, CURRENT_DATE - 1, CURRENT_DATE] LOOP
    v_name := 'workflow_executions_' || to_char(d, 'YYYY_MM_DD');
    BEGIN
      EXECUTE format('CREATE TABLE %I PARTITION OF public.workflow_executions FOR VALUES FROM (%L) TO (%L)', v_name, d, d + 1);
    EXCEPTION
      WHEN invalid_object_definition OR duplicate_table THEN NULL;
    END;
  END LOOP;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112647', 'LVRC Org', 'lvrc-org-2647') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES
    ('44444444-4444-4444-4444-444444442647', '11111111-1111-1111-1111-111111112647', 'LVRC Flow'),
    ('44444444-4444-4444-4444-444444442648', '11111111-1111-1111-1111-111111112647', 'LVRC Other Flow')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.workflow_executions WHERE workflow_id IN ('44444444-4444-4444-4444-444444442647', '44444444-4444-4444-4444-444444442648');
END
$do$;

-- The span is yesterday 08:00 to today 08:00 UTC, crossing a partition boundary.
-- Counted (8 runs, 6 at the step, 1 failed there):
--   yesterday 08:00 exactly   at the step, 'loan amount exceeds maximum'
--   yesterday 20:00           at the step, 'loan amount exceeds maximum'
--   today 03:00               at the step, 'military status ineligible'
--   today 03:00               at the step, 'renamed reason' (off any list)
--   today 04:00               at the step, no reason in the answer
--   today 05:00               at the step, failed, with a reason in its body
--   yesterday 09:00           ended elsewhere, completed, with a reason
--   today 06:00               ended nowhere (null namespace), completed
-- Not counted:
--   yesterday 07:59:59        before the span
--   today 08:00 exactly       the span's end
--   yesterday 10:00           a test run
--   yesterday 11:00           still running
--   yesterday 12:00           another workflow
INSERT INTO public.workflow_executions (workflow_id, status, started_at, is_test, final_node_namespace, response_body)
SELECT w::uuid, s, (CURRENT_DATE::timestamp AT TIME ZONE 'UTC') + at_offset, t, ns, body::jsonb
FROM (VALUES
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '-16 hours',            false, 'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '-4 hours',             false, 'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '3 hours',              false, 'validate_bidding_and_state', '{"reason": "military status ineligible"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '3 hours',              false, 'validate_bidding_and_state', '{"reason": "renamed reason"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '4 hours',              false, 'validate_bidding_and_state', '{"ok": true}'),
  ('44444444-4444-4444-4444-444444442647', 'failed',    interval '5 hours',              false, 'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '-15 hours',            false, 'return_response',            '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '6 hours',              false, NULL,                         NULL),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '-16 hours -1 second',  false, 'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '8 hours',              false, 'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442647', 'completed', interval '-14 hours',            true,  'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442647', 'running',   interval '-13 hours',            false, 'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}'),
  ('44444444-4444-4444-4444-444444442648', 'completed', interval '-12 hours',            false, 'validate_bidding_and_state', '{"reason": "loan amount exceeds maximum"}')
) AS v(w, s, at_offset, t, ns, body);

-- ── A and B. What it counts ──────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  n int;
BEGIN
  SELECT count(*) INTO n FROM public.lead_validation_rejection_counts('44444444-4444-4444-4444-444444442647', 'validate_bidding_and_state',
    CURRENT_DATE::timestamp AT TIME ZONE 'UTC' - interval '16 hours', CURRENT_DATE::timestamp AT TIME ZONE 'UTC' + interval '8 hours');
  IF n <> 1 THEN RAISE EXCEPTION 'expected one row, got %', n; END IF;
  SELECT * INTO r FROM public.lead_validation_rejection_counts('44444444-4444-4444-4444-444444442647', 'validate_bidding_and_state',
    CURRENT_DATE::timestamp AT TIME ZONE 'UTC' - interval '16 hours', CURRENT_DATE::timestamp AT TIME ZONE 'UTC' + interval '8 hours');
  IF (r.runs, r.at_step, r.failed) IS DISTINCT FROM (8::bigint, 6::bigint, 1::bigint) THEN
    RAISE EXCEPTION '(runs, at_step, failed) = (%, %, %), expected (8, 6, 1)', r.runs, r.at_step, r.failed;
  END IF;
  INSERT INTO lvrc_cases VALUES ('counts the finished live runs of the one workflow in the half open span, across partitions');
  IF r.by_reason IS DISTINCT FROM '{"loan amount exceeds maximum": 2, "military status ineligible": 1, "renamed reason": 1}'::jsonb THEN
    RAISE EXCEPTION 'by_reason = %', r.by_reason;
  END IF;
  INSERT INTO lvrc_cases VALUES ('counts each reason of the runs at the step that did not fail, listed or not');
END
$do$;

-- ── C. The same answers as the head counts it replaced ──────────────────────
DO $do$
DECLARE
  f timestamptz := CURRENT_DATE::timestamp AT TIME ZONE 'UTC' - interval '16 hours';
  t timestamptz := CURRENT_DATE::timestamp AT TIME ZONE 'UTC' + interval '8 hours';
  r record;
  reason text;
  old bigint;
BEGIN
  SELECT * INTO r FROM public.lead_validation_rejection_counts('44444444-4444-4444-4444-444444442647', 'validate_bidding_and_state', f, t);
  SELECT count(*) INTO old FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444442647' AND is_test = false AND status <> 'running' AND started_at >= f AND started_at < t;
  IF old <> r.runs THEN RAISE EXCEPTION 'runs % against the head count %', r.runs, old; END IF;
  SELECT count(*) INTO old FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444442647' AND is_test = false AND status <> 'running' AND started_at >= f AND started_at < t
    AND final_node_namespace = 'validate_bidding_and_state';
  IF old <> r.at_step THEN RAISE EXCEPTION 'at_step % against the head count %', r.at_step, old; END IF;
  SELECT count(*) INTO old FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444442647' AND is_test = false AND status <> 'running' AND started_at >= f AND started_at < t
    AND final_node_namespace = 'validate_bidding_and_state' AND status = 'failed';
  IF old <> r.failed THEN RAISE EXCEPTION 'failed % against the head count %', r.failed, old; END IF;
  FOREACH reason IN ARRAY ARRAY['loan amount exceeds maximum', 'military status ineligible', 'renamed reason', 'ineligible state'] LOOP
    SELECT count(*) INTO old FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444442647' AND is_test = false AND status <> 'running' AND started_at >= f AND started_at < t
      AND final_node_namespace = 'validate_bidding_and_state' AND status <> 'failed' AND response_body ->> 'reason' = reason;
    IF old <> coalesce((r.by_reason ->> reason)::bigint, 0) THEN RAISE EXCEPTION '% counted % against the head count %', reason, r.by_reason ->> reason, old; END IF;
  END LOOP;
  INSERT INTO lvrc_cases VALUES ('agrees with the head counts it replaced, bucket by bucket');
END
$do$;

-- ── D. An empty span ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.lead_validation_rejection_counts('44444444-4444-4444-4444-444444442647', 'validate_bidding_and_state',
    CURRENT_DATE::timestamp AT TIME ZONE 'UTC' - interval '40 hours', CURRENT_DATE::timestamp AT TIME ZONE 'UTC' - interval '39 hours');
  IF NOT FOUND OR (r.runs, r.at_step, r.failed, r.by_reason) IS DISTINCT FROM (0::bigint, 0::bigint, 0::bigint, '{}'::jsonb) THEN
    RAISE EXCEPTION 'an empty span answered (%, %, %, %)', r.runs, r.at_step, r.failed, r.by_reason;
  END IF;
  INSERT INTO lvrc_cases VALUES ('an empty span is one row of zeros');
END
$do$;

-- ── E. Grants and volatility ─────────────────────────────────────────────────
DO $do$
DECLARE
  fn text := 'public.lead_validation_rejection_counts(uuid, text, timestamptz, timestamptz)';
  r text;
  p record;
BEGIN
  IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION '% does not exist', fn; END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(r, fn, 'EXECUTE') THEN RAISE EXCEPTION '% may call %', r, fn; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role may not call %', fn; END IF;
  SELECT prosecdef, proconfig, provolatile INTO p FROM pg_proc WHERE oid = to_regprocedure(fn);
  IF p.prosecdef OR p.provolatile <> 's' OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') THEN
    RAISE EXCEPTION '% is not STABLE SECURITY INVOKER with its own search_path', fn;
  END IF;
  INSERT INTO lvrc_cases VALUES ('it is service_role only, STABLE and SECURITY INVOKER');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.workflow_executions WHERE workflow_id IN ('44444444-4444-4444-4444-444444442647', '44444444-4444-4444-4444-444444442648');

DO $do$
DECLARE
  n int := (SELECT count(*) FROM lvrc_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'lead_validation_rejection_counts.test.sql: % cases passed', n;
END
$do$;
