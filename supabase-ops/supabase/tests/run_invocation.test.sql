-- The observation retention and the workflow definition copies (#1950, PR 3 of
-- B3; migration 20261022150000_run_invocation_1950.sql).
--
-- WHAT IT PROVES.
--   A. ops_workflow_definitions is under the ops rules (row level security on,
--      organization_id uuid NOT NULL, browser roles shut out, service_role read
--      only, a direct write refused); the new functions are SECURITY DEFINER
--      with a fixed search_path, executable by service_role alone, the reads
--      STABLE and the writes VOLATILE.
--   B. observation_purge is a sweep with one owner per interval.
--   C. The purge deletes observations older than 30 days, a page at a time,
--      and never a workflow's latest slot, however old: a schedule that fires
--      less often than monthly keeps its newest row, so workflow_copies still
--      answers its last observed slot. Rows younger than 30 days stay.
--   D. With a second session holding one old row, the purge skips it rather
--      than waiting (so two purges at once never block each other or delete a
--      row twice), and that row goes on the next run.
--   E. A definition saves once; the same one again is already_saved; a
--      different one for the same version is conflict and the first is kept; a
--      workflow with no copy is no_copy; another organization is refused; and
--      nothing refused writes a row.
--   F. workflow_definition answers only its own organization's row.
--   G. missing_workflow_definitions lists exactly the current versions not
--      held, skipping deleted and versionless copies.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). Case D commits its rows and uses a second session
-- through dblink, and deletes them again; every other case runs inside one
-- transaction rolled back at the end.

\if :{?self_host}
\else
  \echo 'run_invocation.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('ri_test.self_host', :'self_host', false) AS self_host_set \gset
SELECT NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') AS ri_created_dblink \gset
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TEMP TABLE ri_cases (name text PRIMARY KEY);

-- One observation, written as the table owner with the age the case needs.
CREATE FUNCTION pg_temp.ri_obs(p_wf uuid, p_slot timestamptz, p_age interval) RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.schedule_fire_observations (organization_id, workflow_id, workflow_version, scheduled_for, outcome, reason, dispatch_at, tick_id, observed_at)
  VALUES ('aaaaaaaa-0000-4000-8000-000000001950', p_wf, 1, p_slot, 'would_fire', 'due', p_slot, 'ri-test', now() - p_age)
  RETURNING id
$f$;

-- ── D (concurrent). A second session holds an old row: the purge skips it ─────
-- A run of this file stopped by a failure leaves case D's rows behind; clear them first.
DELETE FROM public.schedule_fire_observations WHERE workflow_id = '00000000-0000-4000-8000-0000000019d0';
SELECT pg_temp.ri_obs('00000000-0000-4000-8000-0000000019d0', '2026-08-01T09:00:00Z', interval '60 days') AS ri_d1 \gset
SELECT pg_temp.ri_obs('00000000-0000-4000-8000-0000000019d0', '2026-08-02T09:00:00Z', interval '59 days') AS ri_d2 \gset
SELECT pg_temp.ri_obs('00000000-0000-4000-8000-0000000019d0', '2026-10-21T09:00:00Z', interval '1 day') AS ri_d3 \gset

DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('ri_test.self_host'));
  v_wf uuid := '00000000-0000-4000-8000-0000000019d0';
  v_r record;
  v_started timestamptz := clock_timestamp();
BEGIN
  IF EXISTS (SELECT 1 FROM public.schedule_fire_observations WHERE workflow_id <> v_wf) THEN
    RAISE EXCEPTION 'case D needs a database with no other observations';
  END IF;
  PERFORM dblink_connect('ri_a', conn);
  PERFORM dblink_exec('ri_a', 'BEGIN');
  PERFORM * FROM dblink('ri_a', format($q$SELECT id::text FROM public.schedule_fire_observations WHERE workflow_id = %L AND scheduled_for = '2026-08-01T09:00:00Z' FOR UPDATE$q$, v_wf)) AS t(x text);
  SELECT * INTO v_r FROM public.purge_schedule_observations(1000);
  PERFORM dblink_exec('ri_a', 'ROLLBACK');
  PERFORM dblink_disconnect('ri_a');
  IF clock_timestamp() - v_started > interval '1500 milliseconds' THEN RAISE EXCEPTION 'the purge waited on a row another session held'; END IF;
  IF v_r.purged <> 1 THEN RAISE EXCEPTION 'the purge deleted % rows beside the held one, expected 1', v_r.purged; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schedule_fire_observations WHERE workflow_id = v_wf AND scheduled_for = '2026-08-01T09:00:00Z') THEN
    RAISE EXCEPTION 'the purge deleted a row another session held';
  END IF;
  SELECT * INTO v_r FROM public.purge_schedule_observations(1000);
  IF v_r.purged <> 1 THEN RAISE EXCEPTION 'the next purge did not take the row once it was free (purged %)', v_r.purged; END IF;
  IF (SELECT count(*) FROM public.schedule_fire_observations WHERE workflow_id = v_wf) <> 1 THEN RAISE EXCEPTION 'the recent row was not kept alone'; END IF;
  INSERT INTO ri_cases VALUES ('purge: a row another session holds is skipped, not waited on, and goes on the next run');
END
$do$;
DELETE FROM public.schedule_fire_observations WHERE workflow_id = '00000000-0000-4000-8000-0000000019d0';

BEGIN;

-- ── A. Table and functions ───────────────────────────────────────────────────
DO $do$
DECLARE
  v_table text := 'public.ops_workflow_definitions';
  v_role text;
  v_priv text;
  v_name text;
  v_fn record;
BEGIN
  IF to_regclass(v_table) IS NULL THEN RAISE EXCEPTION '% does not exist', v_table; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_table::regclass) THEN RAISE EXCEPTION '% has row level security off', v_table; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_table::regclass AND a.attname = 'organization_id' AND a.attnotnull
      AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) THEN
    RAISE EXCEPTION '% has no organization_id uuid NOT NULL column', v_table;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION '% holds a privilege on %', v_role, v_table;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', v_table, 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read %', v_table; END IF;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('service_role', v_table, v_priv) THEN RAISE EXCEPTION 'service_role holds % on %', v_priv, v_table; END IF;
  END LOOP;
  SET LOCAL ROLE service_role;
  BEGIN
    INSERT INTO public.ops_workflow_definitions (workflow_id, version_number, organization_id, definition) VALUES (gen_random_uuid(), 1, gen_random_uuid(), '{}');
    RAISE EXCEPTION 'service_role wrote a definition directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.schedule_fire_observations;
    RAISE EXCEPTION 'service_role deleted observations directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  FOREACH v_name IN ARRAY ARRAY['purge_schedule_observations', 'save_workflow_definition', 'workflow_definition', 'missing_workflow_definitions', 'claim_ops_sweep'] LOOP
    SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'public.% does not exist', v_name; END IF;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_fn.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION '% has no fixed search_path', v_name;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_name;
    END IF;
    IF v_name IN ('workflow_definition', 'missing_workflow_definitions') AND v_fn.provolatile <> 's' THEN RAISE EXCEPTION 'the read function % is not STABLE', v_name; END IF;
    IF v_name NOT IN ('workflow_definition', 'missing_workflow_definitions') AND v_fn.provolatile <> 'v' THEN RAISE EXCEPTION 'the write function % is not VOLATILE', v_name; END IF;
  END LOOP;
  INSERT INTO ri_cases VALUES ('the definitions table and the new functions are under the ops rules');
END
$do$;

-- ── B. observation_purge is a sweep ──────────────────────────────────────────
DO $do$
DECLARE
  v_owned boolean;
BEGIN
  DELETE FROM public.ops_lane_sweeps WHERE sweep = 'observation_purge';
  SELECT o INTO v_owned FROM public.claim_ops_sweep('observation_purge', 'tick-1', 72000) AS c(o, n, s, w);
  IF NOT v_owned THEN RAISE EXCEPTION 'the first claim of observation_purge did not own it'; END IF;
  SELECT o INTO v_owned FROM public.claim_ops_sweep('observation_purge', 'tick-2', 72000) AS c(o, n, s, w);
  IF v_owned THEN RAISE EXCEPTION 'a second claim inside the interval owned observation_purge'; END IF;
  INSERT INTO ri_cases VALUES ('observation_purge: one owner per interval');
END
$do$;

-- ── C. The purge keeps 30 days and every workflow's latest slot ──────────────
DO $do$
DECLARE
  v_busy uuid := '00000000-0000-4000-8000-0000000019c1';
  v_rare uuid := '00000000-0000-4000-8000-0000000019c2';
  v_r record;
  v_total integer := 0;
  v_pages integer := 0;
BEGIN
  DELETE FROM public.schedule_fire_observations;
  -- A daily schedule with 40 days of rows: 9 are past 30 days and none is its latest.
  FOR i IN 0..39 LOOP
    PERFORM pg_temp.ri_obs(v_busy, timestamptz '2026-09-12T13:00:00Z' + make_interval(days => i), make_interval(days => 39 - i, hours => -1));
  END LOOP;
  -- A quarterly schedule: two rows, both older than 30 days. Only the older may go.
  PERFORM pg_temp.ri_obs(v_rare, '2026-04-01T13:00:00Z', interval '200 days');
  PERFORM pg_temp.ri_obs(v_rare, '2026-07-01T13:00:00Z', interval '110 days');

  LOOP
    SELECT * INTO v_r FROM public.purge_schedule_observations(4);
    v_total := v_total + v_r.purged;
    v_pages := v_pages + 1;
    EXIT WHEN NOT v_r.more OR v_pages > 10;
  END LOOP;
  IF v_total <> 10 THEN RAISE EXCEPTION 'the purge deleted % rows, expected 10 (9 daily, 1 quarterly)', v_total; END IF;
  IF v_pages <> 3 THEN RAISE EXCEPTION 'the purge took % pages of 4 for 10 rows, expected 3', v_pages; END IF;
  IF EXISTS (SELECT 1 FROM public.schedule_fire_observations WHERE observed_at < now() - interval '30 days' AND workflow_id = v_busy) THEN
    RAISE EXCEPTION 'a daily row past 30 days was kept';
  END IF;
  IF (SELECT count(*) FROM public.schedule_fire_observations WHERE workflow_id = v_busy) <> 31 THEN RAISE EXCEPTION 'a daily row inside 30 days was purged'; END IF;
  IF (SELECT max(scheduled_for) FROM public.schedule_fire_observations WHERE workflow_id = v_rare) IS DISTINCT FROM '2026-07-01T13:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'the quarterly schedule lost its latest slot';
  END IF;
  -- A run with nothing to purge says so.
  SELECT * INTO v_r FROM public.purge_schedule_observations(1000);
  IF v_r.purged <> 0 OR v_r.more THEN RAISE EXCEPTION 'a purge with nothing to do answered %', v_r; END IF;
  BEGIN
    PERFORM public.purge_schedule_observations(0);
    RAISE EXCEPTION 'a purge of no rows was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO ri_cases VALUES ('purge: past 30 days goes, page by page, and each workflow keeps its latest slot');
END
$do$;

-- Saves one copy for the definition cases.
CREATE FUNCTION pg_temp.ri_copy(p_wf uuid, p_org uuid, p_version integer, p_deleted text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM public.save_workflow_copies('2026-10-22T10:00:00Z', false, jsonb_build_array(jsonb_build_object(
    'workflow_id', p_wf, 'organization_id', p_org, 'is_active', true, 'deleted_at', p_deleted,
    'row_updated_at', '2026-10-22T09:00:00Z', 'version_number', p_version, 'trigger', NULL)));
END
$f$;

-- ── E, F. A version's definition saves once and reads in its organization ───
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001950';
  v_other uuid := 'cccccccc-0000-4000-8000-000000001950';
  v_wf uuid := '00000000-0000-4000-8000-0000000019e1';
  v_def jsonb := '{"nodes":[{"id":"a","type":"transform"}],"edges":[]}';
  v_out text;
BEGIN
  PERFORM pg_temp.ri_copy(v_wf, v_org, 2);
  v_out := public.save_workflow_definition(v_org, v_wf, 2, v_def);
  IF v_out <> 'saved' THEN RAISE EXCEPTION 'a first save answered %', v_out; END IF;
  -- The same definition, keys in another order: jsonb equality, not text.
  v_out := public.save_workflow_definition(v_org, v_wf, 2, '{"edges":[],"nodes":[{"type":"transform","id":"a"}]}');
  IF v_out <> 'already_saved' THEN RAISE EXCEPTION 'the same definition again answered %', v_out; END IF;
  v_out := public.save_workflow_definition(v_org, v_wf, 2, '{"nodes":[],"edges":[]}');
  IF v_out <> 'conflict' THEN RAISE EXCEPTION 'a different definition for a held version answered %', v_out; END IF;
  IF (SELECT definition FROM public.workflow_definition(v_org, v_wf, 2)) <> v_def THEN RAISE EXCEPTION 'a conflict replaced the held definition'; END IF;
  v_out := public.save_workflow_definition(v_org, '00000000-0000-4000-8000-0000000019e9', 1, v_def);
  IF v_out <> 'no_copy' THEN RAISE EXCEPTION 'a workflow with no copy answered %', v_out; END IF;
  BEGIN
    PERFORM public.save_workflow_definition(v_other, v_wf, 3, v_def);
    RAISE EXCEPTION 'another organization saved a definition of this workflow';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.workflow_definition(v_other, v_wf, 2)) THEN RAISE EXCEPTION 'another organization read this workflow''s definition'; END IF;
  IF (SELECT count(*) FROM public.ops_workflow_definitions WHERE workflow_id = v_wf) <> 1 THEN RAISE EXCEPTION 'a refused save wrote a row'; END IF;
  BEGIN
    PERFORM public.save_workflow_definition(v_org, v_wf, 4, '[1,2]');
    RAISE EXCEPTION 'a definition that is not an object was saved';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO ri_cases VALUES ('definition: saves once, a different one for the version is a conflict that keeps the first, another organization is refused');
END
$do$;

-- ── G. The versions the tick must still fetch ────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000001950';
  v_missing uuid[];
BEGIN
  DELETE FROM public.ops_workflow_definitions;
  DELETE FROM public.ops_workflow_copies;
  PERFORM pg_temp.ri_copy('00000000-0000-4000-8000-0000000019f1', v_org, 3);
  PERFORM pg_temp.ri_copy('00000000-0000-4000-8000-0000000019f2', v_org, 1);
  PERFORM pg_temp.ri_copy('00000000-0000-4000-8000-0000000019f3', v_org, 5, '2026-10-22T08:00:00Z');
  PERFORM pg_temp.ri_copy('00000000-0000-4000-8000-0000000019f4', v_org, NULL);
  PERFORM public.save_workflow_definition(v_org, '00000000-0000-4000-8000-0000000019f2', 1, '{"nodes":[]}');
  -- An older version held does not stand in for the current one.
  PERFORM public.save_workflow_definition(v_org, '00000000-0000-4000-8000-0000000019f1', 2, '{"nodes":[]}');
  SELECT array_agg(workflow_id ORDER BY workflow_id) INTO v_missing FROM public.missing_workflow_definitions(1000);
  IF v_missing IS DISTINCT FROM ARRAY['00000000-0000-4000-8000-0000000019f1'::uuid] THEN
    RAISE EXCEPTION 'missing_workflow_definitions answered %, expected only the workflow whose current version is not held', v_missing;
  END IF;
  INSERT INTO ri_cases VALUES ('missing definitions: only current versions not held, never a deleted or versionless copy');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM ri_cases);
BEGIN
  IF v_n <> 6 THEN RAISE EXCEPTION 'run_invocation: % of 6 cases ran', v_n; END IF;
  RAISE NOTICE 'run_invocation: % cases passed', v_n;
END
$do$;

ROLLBACK;

\if :ri_created_dblink
  DROP EXTENSION dblink;
\endif
