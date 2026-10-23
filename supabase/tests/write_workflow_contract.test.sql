-- The contract step of write_workflow (#1947, migration 20261024120000): the
-- Worker's role writes workflows and workflow_versions only through it.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. One transaction,
-- rolled back. No real identity.
--
-- WHAT IT PROVES, each statement made as service_role, the Worker's role:
--   A. A direct INSERT, UPDATE of the definition, is_active, deleted_at or lane,
--      DELETE and TRUNCATE of a workflow are refused by the database itself
--      (42501), and so are a direct INSERT, UPDATE of the definition, DELETE and
--      TRUNCATE of a version.
--   B. What the Worker still writes directly is allowed: a workflow's
--      test_payloads (PATCH /:id/test-payloads) and a version's commit_sha (the
--      GitHub backup's stamp).
--   C. write_workflow still creates and saves, its SECURITY DEFINER owner doing
--      the writing.
--   D. A hand write by the owner (postgres, the SQL editor) is not refused, and
--      it still moves the version (workflows_bump_version).
--
-- Mutations tried (each turned its case red, then was put back):
--  - the REVOKE on workflows left out: A red (the direct update landed);
--  - the GRANT of UPDATE (test_payloads) left out: B red;
--  - the GRANT of UPDATE (commit_sha) left out: B red;
--  - TRUNCATE left out of both REVOKEs: A red (the truncate passed the
--    privilege check and reached the foreign key check, 0A000).

BEGIN;

CREATE TEMP TABLE wwc_cases (name text PRIMARY KEY);

INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-11111111c947', 'WWC Org', 'wwc-org-1947');
INSERT INTO public.users (id, organization_id, email, display_name) VALUES
  ('22222222-2222-2222-2222-22222222c947', '11111111-1111-1111-1111-11111111c947', 'wwc1947@example.test', 'WWC Alice');
INSERT INTO public.workflows (id, organization_id, name, definition) VALUES
  ('44444444-4444-4444-4444-44444444c947', '11111111-1111-1111-1111-11111111c947', 'Contract', '{"nodes":[],"edges":[]}');
INSERT INTO public.workflow_versions (id, workflow_id, version_number, definition) VALUES
  ('55555555-5555-5555-5555-55555555c947', '44444444-4444-4444-4444-44444444c947', 1, '{"nodes":[],"edges":[]}');

-- The SQLSTATE a statement run as service_role ends with, or 'ok'.
CREATE FUNCTION pg_temp.as_worker(p_sql text)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE s text;
BEGIN
  EXECUTE 'SET ROLE service_role';
  BEGIN
    EXECUTE p_sql;
    EXECUTE 'RESET ROLE';
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
    EXECUTE 'RESET ROLE';
    RETURN s;
  END;
END
$fn$;

-- ── A. direct writes refused ─────────────────────────────────────────────────
DO $do$
DECLARE stmt text; got text;
BEGIN
  FOREACH stmt IN ARRAY ARRAY[
    $s$INSERT INTO public.workflows (organization_id, name) VALUES ('11111111-1111-1111-1111-11111111c947', 'Direct')$s$,
    $s$UPDATE public.workflows SET definition = '{"nodes":[],"edges":[],"x":1}' WHERE id = '44444444-4444-4444-4444-44444444c947'$s$,
    $s$UPDATE public.workflows SET is_active = true WHERE id = '44444444-4444-4444-4444-44444444c947'$s$,
    $s$UPDATE public.workflows SET deleted_at = now() WHERE id = '44444444-4444-4444-4444-44444444c947'$s$,
    $s$UPDATE public.workflows SET lane = 'ops' WHERE id = '44444444-4444-4444-4444-44444444c947'$s$,
    $s$DELETE FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444444c947'$s$,
    $s$INSERT INTO public.workflow_versions (workflow_id, version_number, definition) VALUES ('44444444-4444-4444-4444-44444444c947', 2, '{}')$s$,
    $s$UPDATE public.workflow_versions SET definition = '{}' WHERE id = '55555555-5555-5555-5555-55555555c947'$s$,
    $s$DELETE FROM public.workflow_versions WHERE id = '55555555-5555-5555-5555-55555555c947'$s$,
    $s$TRUNCATE public.workflow_versions$s$,
    $s$TRUNCATE public.workflows$s$
  ] LOOP
    got := pg_temp.as_worker(stmt);
    IF got <> '42501' THEN RAISE EXCEPTION 'A: service_role ran % and got %, expected 42501', stmt, got; END IF;
  END LOOP;
  INSERT INTO wwc_cases VALUES ('A direct writes refused');
END
$do$;

-- ── B. the two direct writes the Worker keeps ────────────────────────────────
DO $do$
DECLARE got text;
BEGIN
  got := pg_temp.as_worker($s$UPDATE public.workflows SET test_payloads = '[{"name":"p","payload":{}}]' WHERE id = '44444444-4444-4444-4444-44444444c947'$s$);
  IF got <> 'ok' THEN RAISE EXCEPTION 'B: test_payloads update got %', got; END IF;
  got := pg_temp.as_worker($s$UPDATE public.workflow_versions SET commit_sha = 'abc123' WHERE id = '55555555-5555-5555-5555-55555555c947'$s$);
  IF got <> 'ok' THEN RAISE EXCEPTION 'B: commit_sha update got %', got; END IF;
  IF (SELECT commit_sha FROM public.workflow_versions WHERE id = '55555555-5555-5555-5555-55555555c947') <> 'abc123' THEN RAISE EXCEPTION 'B: commit_sha not written'; END IF;
  INSERT INTO wwc_cases VALUES ('B kept direct writes');
END
$do$;

-- ── C. write_workflow still writes ───────────────────────────────────────────
DO $do$
DECLARE v jsonb; ver int;
BEGIN
  EXECUTE 'SET ROLE service_role';
  v := public.write_workflow('create', '11111111-1111-1111-1111-11111111c947', NULL, NULL,
    '{"name":"Through the function","definition":{"nodes":[],"edges":[]},"definition_schema_version":1}'::jsonb,
    NULL, '22222222-2222-2222-2222-22222222c947', 'wwc1947@example.test', 'WWC Alice');
  SELECT version INTO ver FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444444c947';
  v := v || jsonb_build_object('saved', public.write_workflow('save', '11111111-1111-1111-1111-11111111c947', '44444444-4444-4444-4444-44444444c947', ver,
    '{"name":"Renamed"}'::jsonb, NULL, '22222222-2222-2222-2222-22222222c947', 'wwc1947@example.test', 'WWC Alice'));
  EXECUTE 'RESET ROLE';
  IF v -> 'workflow' ->> 'name' <> 'Through the function' OR v -> 'saved' -> 'workflow' ->> 'name' <> 'Renamed' THEN
    RAISE EXCEPTION 'C: write_workflow answered %', v;
  END IF;
  INSERT INTO wwc_cases VALUES ('C write_workflow writes');
END
$do$;

-- ── D. the owner's hand write ────────────────────────────────────────────────
DO $do$
DECLARE before int; after int;
BEGIN
  SELECT version INTO before FROM public.workflows WHERE id = '44444444-4444-4444-4444-44444444c947';
  UPDATE public.workflows SET description = 'By hand' WHERE id = '44444444-4444-4444-4444-44444444c947' RETURNING version INTO after;
  IF after <> before + 1 THEN RAISE EXCEPTION 'D: a hand write moved version from % to %', before, after; END IF;
  INSERT INTO wwc_cases VALUES ('D owner writes');
END
$do$;

DO $do$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM wwc_cases;
  IF n <> 4 THEN RAISE EXCEPTION 'write_workflow_contract: % of 4 cases ran', n; END IF;
  RAISE NOTICE 'write_workflow_contract.test.sql: % cases passed', n;
END
$do$;

ROLLBACK;
