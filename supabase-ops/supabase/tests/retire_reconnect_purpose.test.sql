-- The ops Salesforce lease purpose reconnect is retired (#2336).
-- Migration 20261019200000_retire_reconnect_purpose_2336.sql.
--
-- WHAT IT PROVES.
--   A. reconnect is refused by sf_leases and by sf_purpose_caps, each by its
--      own purpose CHECK, and by acquire_sf_lease as not a purpose; every
--      remaining purpose is still accepted by both tables.
--   B. The migration re-runs cleanly on a database it has already narrowed.
--   C. Run against tables still holding a reconnect row (a lease, or a share),
--      the migration RAISES by name, deletes nothing and changes nothing: the
--      row stays and the constraint keeps its wider list. Once the row is gone
--      the same file runs and narrows again.
--
-- B and C run the migration file itself, read from the ops migrations folder
-- the harness copies into the container (scripts/sql-suite/project.sh).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE rr_cases (name text PRIMARY KEY);

-- ── A. Refused, and every other purpose still accepted ───────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002336';
  v_conn uuid := '00000000-0000-4000-8000-0000000023e1';
  v_sf text := '00Drr0000000001AAA';
  v_wf uuid := '00000000-0000-4000-8000-00000000e0f1';
  v_purpose text;
  v_constraint text;
  v_message text;
BEGIN
  INSERT INTO public.sf_pool_caps (sf_org_id, cap, workflow_share, budget_floor, approved_at, approved_by) VALUES (v_sf, 10, 2, 0, now(), 'Dan (test)');

  BEGIN
    INSERT INTO public.sf_leases (organization_id, holder, connection_id, generation, sf_org_id, purpose, expires_at)
    VALUES (v_org, 'rr-lease-reconnect', v_conn, 1, v_sf, 'reconnect', now() + interval '1 minute');
    RAISE EXCEPTION 'sf_leases took a reconnect lease';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint <> 'sf_leases_purpose_check' THEN RAISE EXCEPTION 'a reconnect lease was refused by % rather than its purpose check', v_constraint; END IF;
  END;
  BEGIN
    INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES (v_sf, 'reconnect', 1, now(), 'Dan (test)');
    RAISE EXCEPTION 'sf_purpose_caps took a reconnect share';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint <> 'sf_purpose_caps_purpose_check' THEN RAISE EXCEPTION 'a reconnect share was refused by % rather than its purpose check', v_constraint; END IF;
  END;
  BEGIN
    PERFORM public.acquire_sf_lease(v_org, v_conn, 1, 'reconnect', NULL, 'rr-acquire-reconnect', 60);
    RAISE EXCEPTION 'acquire_sf_lease answered a reconnect';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE '%reconnect is not a purpose%' THEN RAISE EXCEPTION 'acquire_sf_lease refused a reconnect for another reason: %', v_message; END IF;
  END;

  FOREACH v_purpose IN ARRAY ARRAY['step', 'lookup', 'verify', 'connection_check', 'sf_limits'] LOOP
    INSERT INTO public.sf_leases (organization_id, holder, connection_id, generation, sf_org_id, purpose, workflow_id, expires_at)
    VALUES (v_org, 'rr-lease-' || v_purpose, v_conn, 1, v_sf, v_purpose, CASE WHEN v_purpose = 'step' THEN v_wf END, now() + interval '1 minute');
  END LOOP;
  FOREACH v_purpose IN ARRAY ARRAY['lookup', 'verify', 'connection_check', 'sf_limits'] LOOP
    INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES (v_sf, v_purpose, 1, now(), 'Dan (test)');
  END LOOP;
  IF (SELECT count(*) FROM public.sf_leases WHERE holder LIKE 'rr-lease-%') <> 5 THEN RAISE EXCEPTION 'not every remaining purpose was taken as a lease'; END IF;
  IF (SELECT count(*) FROM public.sf_purpose_caps WHERE sf_org_id = v_sf) <> 4 THEN RAISE EXCEPTION 'not every remaining non step purpose was taken as a share'; END IF;
  INSERT INTO rr_cases VALUES ('refused: reconnect by both CHECKs and by acquire_sf_lease; every other purpose still accepted');
END
$do$;

-- ── B. The migration re-runs on a narrowed database ──────────────────────────
DO $do$
BEGIN
  EXECUTE pg_read_file('/sql-suite-fixtures/supabase/20261019200000_retire_reconnect_purpose_2336.sql');
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'sf_leases_purpose_check')) LIKE '%reconnect%'
      OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'sf_purpose_caps_purpose_check')) LIKE '%reconnect%' THEN
    RAISE EXCEPTION 'a rerun of the migration left reconnect in a purpose check';
  END IF;
  -- The rows A wrote, under every remaining purpose, are untouched by a rerun.
  IF (SELECT count(*) FROM public.sf_leases WHERE holder LIKE 'rr-lease-%') <> 5 THEN RAISE EXCEPTION 'a rerun changed the leases'; END IF;
  INSERT INTO rr_cases VALUES ('rerun: the migration runs again on a database it narrowed');
END
$do$;

-- ── C. Refused by name while a row holds reconnect, changing nothing ─────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002336';
  v_conn uuid := '00000000-0000-4000-8000-0000000023e1';
  v_sf text := '00Drr0000000001AAA';
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261019200000_retire_reconnect_purpose_2336.sql');
  v_table text;
  v_message text;
  v_refused integer := 0;
BEGIN
  -- Each table as it stood before the migration: the wider list, and one reconnect row.
  ALTER TABLE public.sf_leases DROP CONSTRAINT sf_leases_purpose_check;
  ALTER TABLE public.sf_leases ADD CONSTRAINT sf_leases_purpose_check CHECK (purpose IN ('step', 'lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits'));
  ALTER TABLE public.sf_purpose_caps DROP CONSTRAINT sf_purpose_caps_purpose_check;
  ALTER TABLE public.sf_purpose_caps ADD CONSTRAINT sf_purpose_caps_purpose_check CHECK (purpose IN ('lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits'));

  FOREACH v_table IN ARRAY ARRAY['sf_leases', 'sf_purpose_caps'] LOOP
    IF v_table = 'sf_leases' THEN
      INSERT INTO public.sf_leases (organization_id, holder, connection_id, generation, sf_org_id, purpose, expires_at)
      VALUES (v_org, 'rr-old-reconnect', v_conn, 1, v_sf, 'reconnect', now() + interval '1 minute');
    ELSE
      INSERT INTO public.sf_purpose_caps (sf_org_id, purpose, share, approved_at, approved_by) VALUES (v_sf, 'reconnect', 1, now(), 'Dan (test)');
    END IF;

    BEGIN
      EXECUTE v_file;
      RAISE EXCEPTION 'the migration ran over a % row holding reconnect', v_table;
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message NOT LIKE 'retire reconnect (#2336): %' OR v_message NOT LIKE '%nothing was changed%' THEN
        RAISE EXCEPTION 'the refusal did not say why: %', v_message;
      END IF;
      IF v_table = 'sf_leases' AND v_message NOT LIKE '%1 sf_leases and 0 sf_purpose_caps rows%' THEN RAISE EXCEPTION 'the refusal miscounted: %', v_message; END IF;
      IF v_table = 'sf_purpose_caps' AND v_message NOT LIKE '%0 sf_leases and 1 sf_purpose_caps rows%' THEN RAISE EXCEPTION 'the refusal miscounted: %', v_message; END IF;
      v_refused := v_refused + 1;
    END;

    -- Nothing deleted, nothing narrowed.
    IF v_table = 'sf_leases' AND NOT EXISTS (SELECT 1 FROM public.sf_leases WHERE holder = 'rr-old-reconnect') THEN RAISE EXCEPTION 'the refused migration deleted the reconnect lease'; END IF;
    IF v_table = 'sf_purpose_caps' AND NOT EXISTS (SELECT 1 FROM public.sf_purpose_caps WHERE purpose = 'reconnect') THEN RAISE EXCEPTION 'the refused migration deleted the reconnect share'; END IF;
    IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = v_table || '_purpose_check')) NOT LIKE '%reconnect%' THEN
      RAISE EXCEPTION 'the refused migration narrowed % anyway', v_table;
    END IF;

    -- Cleared by hand, the same file runs and narrows again.
    DELETE FROM public.sf_leases WHERE purpose = 'reconnect';
    DELETE FROM public.sf_purpose_caps WHERE purpose = 'reconnect';
    EXECUTE v_file;
    IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = v_table || '_purpose_check')) LIKE '%reconnect%' THEN
      RAISE EXCEPTION 'the migration did not narrow % once the row was gone', v_table;
    END IF;
    -- Widen again for the next table's case.
    ALTER TABLE public.sf_leases DROP CONSTRAINT sf_leases_purpose_check;
    ALTER TABLE public.sf_leases ADD CONSTRAINT sf_leases_purpose_check CHECK (purpose IN ('step', 'lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits'));
    ALTER TABLE public.sf_purpose_caps DROP CONSTRAINT sf_purpose_caps_purpose_check;
    ALTER TABLE public.sf_purpose_caps ADD CONSTRAINT sf_purpose_caps_purpose_check CHECK (purpose IN ('lookup', 'verify', 'reconnect', 'connection_check', 'sf_limits'));
  END LOOP;
  IF v_refused <> 2 THEN RAISE EXCEPTION 'the migration refused % of 2 tables holding reconnect', v_refused; END IF;
  INSERT INTO rr_cases VALUES ('refusal: a reconnect lease or share stops the migration by name, deleting and narrowing nothing');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM rr_cases);
BEGIN
  IF v_n <> 3 THEN RAISE EXCEPTION 'retire_reconnect_purpose: % of 3 cases ran', v_n; END IF;
  RAISE NOTICE 'retire_reconnect_purpose: % cases passed', v_n;
END
$do$;

ROLLBACK;
