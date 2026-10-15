-- Behavioural tests for the failed Salesforce writeback store of #1993.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. No real identity:
-- the encrypted columns hold placeholder text, which is all the table can see.
--
-- WHAT IT PROVES.
--   A. A second failed write in one run is kept, whether to a different record
--      or to the same record from a different step, and the same write recorded
--      twice is refused, by the unique key.
--   B. Only the status values the code writes are accepted.
--   C. The browser roles can neither read nor write the table.
--   D. The retention purge removes only finished rows older than 30 days, and
--      never a pending one however old.
--   E. The `replayable` column describes the rule the capture writes it by
--      (#2054): Salesforce rejecting the write, not any failure classed
--      permanent, which a login or permission refusal also is.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS ow_cases (name text PRIMARY KEY);
DELETE FROM ow_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111993', 'OW Org', 'ow-org-1993') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.outcome_writeback_deadletters WHERE organization_id = '11111111-1111-1111-1111-111111111993';
END
$do$;

-- ── A. The unique key ────────────────────────────────────────────────────────
DO $do$
DECLARE
  refused boolean := false;
BEGIN
  INSERT INTO public.outcome_writeback_deadletters
    (organization_id, workflow_id, execution_id, step_namespace, sf_object, sf_record_id, sf_operation, body_encrypted, error_encrypted, replayable)
  VALUES
    ('11111111-1111-1111-1111-111111111993', '44444444-4444-4444-4444-444444441993', '01920000-0000-7000-8000-000000001993', 'patch_a', 'Submission__c', 'a04A', 'update', 'enc', 'enc', true),
    ('11111111-1111-1111-1111-111111111993', '44444444-4444-4444-4444-444444441993', '01920000-0000-7000-8000-000000001993', 'patch_b', 'Applicant__c', 'a05B', 'update', 'enc', 'enc', true),
    ('11111111-1111-1111-1111-111111111993', '44444444-4444-4444-4444-444444441993', '01920000-0000-7000-8000-000000001993', 'patch_c', 'Submission__c', 'a04A', 'update', 'enc', 'enc', true);
  BEGIN
    INSERT INTO public.outcome_writeback_deadletters
      (organization_id, workflow_id, execution_id, step_namespace, sf_object, sf_record_id, sf_operation, body_encrypted, error_encrypted, replayable)
    VALUES ('11111111-1111-1111-1111-111111111993', '44444444-4444-4444-4444-444444441993', '01920000-0000-7000-8000-000000001993', 'patch_a', 'Submission__c', 'a04A', 'update', 'enc', 'enc', true);
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'the same write recorded twice in one run was accepted'; END IF;
  IF (SELECT count(*) FROM public.outcome_writeback_deadletters WHERE execution_id = '01920000-0000-7000-8000-000000001993') <> 3 THEN
    RAISE EXCEPTION 'three distinct failed writes in one run were not all kept';
  END IF;
  INSERT INTO ow_cases VALUES ('the unique key keeps distinct writes and refuses a repeat');
END
$do$;

-- ── B. Status values ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  s text;
  refused boolean;
BEGIN
  FOREACH s IN ARRAY ARRAY['pending', 'replayed', 'refused', 'abandoned'] LOOP
    UPDATE public.outcome_writeback_deadletters
    SET status = s, finished_at = CASE WHEN s = 'pending' THEN NULL ELSE now() END
    WHERE step_namespace = 'patch_a' AND execution_id = '01920000-0000-7000-8000-000000001993';
  END LOOP;
  refused := false;
  BEGIN
    UPDATE public.outcome_writeback_deadletters SET status = 'done', finished_at = now() WHERE step_namespace = 'patch_a' AND execution_id = '01920000-0000-7000-8000-000000001993';
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a status the code never writes was accepted'; END IF;
  -- And a finished status without the time it finished, which the purge keys on.
  refused := false;
  BEGIN
    UPDATE public.outcome_writeback_deadletters SET status = 'replayed', finished_at = NULL WHERE step_namespace = 'patch_a' AND execution_id = '01920000-0000-7000-8000-000000001993';
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a finished row without its finish time was accepted, so the purge could never reach it'; END IF;
  INSERT INTO ow_cases VALUES ('only the status values the code writes are accepted');
END
$do$;

-- ── C. The browser roles reach nothing ───────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.outcome_writeback_deadletters', 'SELECT')
       OR has_table_privilege(r, 'public.outcome_writeback_deadletters', 'INSERT')
       OR has_table_privilege(r, 'public.outcome_writeback_deadletters', 'UPDATE')
       OR has_table_privilege(r, 'public.outcome_writeback_deadletters', 'DELETE') THEN
      RAISE EXCEPTION '% can reach outcome_writeback_deadletters', r;
    END IF;
    IF has_function_privilege(r, 'public.purge_outcome_writeback_deadletters()', 'EXECUTE') THEN
      RAISE EXCEPTION '% can run the purge', r;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outcome_writeback_deadletters'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on outcome_writeback_deadletters';
  END IF;
  INSERT INTO ow_cases VALUES ('the browser roles can neither read nor write the store');
END
$do$;

-- ── D. Retention ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  removed int;
BEGIN
  DELETE FROM public.outcome_writeback_deadletters WHERE organization_id = '11111111-1111-1111-1111-111111111993';
  INSERT INTO public.outcome_writeback_deadletters
    (organization_id, workflow_id, execution_id, step_namespace, sf_object, sf_record_id, sf_operation, body_encrypted, error_encrypted, replayable, status, created_at, finished_at)
  VALUES
    -- finished 31 days ago: purged
    ('11111111-1111-1111-1111-111111111993', '44444444-4444-4444-4444-444444441993', '01920000-0000-7000-8000-000000000001', 'p', 'Submission__c', 'old_done', 'update', 'enc', 'enc', true, 'replayed', now() - interval '40 days', now() - interval '31 days'),
    -- finished 29 days ago: kept
    ('11111111-1111-1111-1111-111111111993', '44444444-4444-4444-4444-444444441993', '01920000-0000-7000-8000-000000000002', 'p', 'Submission__c', 'recent_done', 'update', 'enc', 'enc', true, 'abandoned', now() - interval '40 days', now() - interval '29 days'),
    -- pending for 90 days: never purged
    ('11111111-1111-1111-1111-111111111993', '44444444-4444-4444-4444-444444441993', '01920000-0000-7000-8000-000000000003', 'p', 'Submission__c', 'old_pending', 'update', 'enc', 'enc', true, 'pending', now() - interval '90 days', NULL);
  removed := public.purge_outcome_writeback_deadletters();
  IF removed <> 1 THEN RAISE EXCEPTION 'purge removed % rows, expected 1', removed; END IF;
  IF EXISTS (SELECT 1 FROM public.outcome_writeback_deadletters WHERE sf_record_id = 'old_done') THEN
    RAISE EXCEPTION 'a row finished 31 days ago survived the purge';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outcome_writeback_deadletters WHERE sf_record_id = 'recent_done') THEN
    RAISE EXCEPTION 'a row finished 29 days ago was purged';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outcome_writeback_deadletters WHERE sf_record_id = 'old_pending') THEN
    RAISE EXCEPTION 'a pending row was purged';
  END IF;
  INSERT INTO ow_cases VALUES ('the purge removes only finished rows older than 30 days');
END
$do$;

-- ── E. What replayable means (#2054) ─────────────────────────────────────────
DO $do$
DECLARE
  said text := col_description(
    'public.outcome_writeback_deadletters'::regclass,
    (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.outcome_writeback_deadletters'::regclass AND attname = 'replayable')
  );
BEGIN
  IF said IS NULL OR said NOT LIKE '%salesforceRejectedTheWrite%' THEN
    RAISE EXCEPTION 'the replayable column does not name the rule the capture writes it by: %', said;
  END IF;
  IF said LIKE '%classed the failure permanent%' THEN
    RAISE EXCEPTION 'the replayable column still describes the rule before #2054: %', said;
  END IF;
  INSERT INTO ow_cases VALUES ('the replayable column describes the rule it is written by');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.outcome_writeback_deadletters WHERE organization_id = '11111111-1111-1111-1111-111111111993';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM ow_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'outcome_writeback_deadletters.test.sql: % cases passed', n;
END
$do$;
