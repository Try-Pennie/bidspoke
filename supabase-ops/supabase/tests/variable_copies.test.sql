-- The last good copy of each ops version's plain variables (#2999, phase 3 of #2982).
-- Migration 20261029220000_variable_copies_2999.sql.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a save writes a version's whole list: each plain value, each secret by
--      name with no value, each absent name; and answers what it wrote;
--   2. the same save again rewrites no row (each row's ctid is unchanged), and
--      within the confirm interval does not move the version row either;
--   3. a changed value rewrites only its own row, a name the version no
--      longer lists is deleted, a new one is added, and the version row moves;
--   4. past the confirm interval an unchanged copy moves its version row's
--      confirmed_at only, and no key row;
--   5. a save served earlier than the copy held changes nothing, and is counted;
--   6. a version of a workflow with no copy, or whose copy is another
--      organization's, is skipped and counted, and the rest of the batch is written;
--   7. NEVER A SECRET VALUE: an entry carrying a secret_values field, a name
--      both plain and secret, or any other key is refused by name and the whole
--      call writes nothing; the table's CHECK refuses a secret row holding a
--      value even from its owner; service_role cannot write either table;
--   8. the bounds: more than 1000 versions, more than 500 names, a value over
--      65536 bytes, a name that is not a variable name, and a confirm interval
--      outside 0 to 3600 are each refused by name;
--   9. variable_copies answers only the organization's versions asked about,
--      with the plain values, the secret and absent names, and the database
--      clock; it refuses a malformed request;
--  10. purge_variable_copies deletes, a page at a time, versions confirmed more
--      than 6 hours ago and those of a workflow switched off, deleted,
--      withdrawn or with no copy, with their key rows, and keeps a fresh copy
--      of a workflow that is on; it refuses a limit outside 1 to 1000;
--  11. the tables are under the ops rules (row level security on,
--      organization_id uuid NOT NULL, browser roles shut out, service_role
--      read only), and the functions are SECURITY DEFINER with a fixed
--      search_path, executable by service_role alone, the read one STABLE.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE vc_cases (name text PRIMARY KEY) ON COMMIT DROP;

-- Two organizations, and the workflows the tests copy.
--   ...c1 on (org A), ...c2 on (org A), ...c3 org B's, ...c4 switched off,
--   ...c5 deleted, ...c6 withdrawn, ...c7 no copy at all.
CREATE FUNCTION pg_temp.vc_org() RETURNS uuid LANGUAGE sql AS $f$ SELECT 'aaaaaaaa-0000-4000-8000-000000002999'::uuid $f$;
CREATE FUNCTION pg_temp.vc_org_b() RETURNS uuid LANGUAGE sql AS $f$ SELECT 'bbbbbbbb-0000-4000-8000-000000002999'::uuid $f$;
CREATE FUNCTION pg_temp.vc_wf(n integer) RETURNS uuid LANGUAGE sql AS $f$ SELECT ('00000000-0000-4000-8000-0000000029c' || n)::uuid $f$;

CREATE FUNCTION pg_temp.vc_reset() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM public.ops_variable_copy_versions;
  DELETE FROM public.ops_workflow_copies WHERE workflow_id IN (SELECT pg_temp.vc_wf(n) FROM generate_series(1, 7) n);
  INSERT INTO public.ops_workflow_copies (workflow_id, organization_id, is_active, deleted_at, withdrawn_at, row_updated_at, served_at) VALUES
    (pg_temp.vc_wf(1), pg_temp.vc_org(), true, NULL, NULL, now(), now()),
    (pg_temp.vc_wf(2), pg_temp.vc_org(), true, NULL, NULL, now(), now()),
    (pg_temp.vc_wf(3), pg_temp.vc_org_b(), true, NULL, NULL, now(), now()),
    (pg_temp.vc_wf(4), pg_temp.vc_org(), false, NULL, NULL, now(), now()),
    (pg_temp.vc_wf(5), pg_temp.vc_org(), true, now(), NULL, now(), now()),
    (pg_temp.vc_wf(6), pg_temp.vc_org(), true, NULL, now(), now(), now());
END
$f$;

-- One copy entry as the tick sends it.
CREATE FUNCTION pg_temp.vc_entry(p_org uuid, p_wf uuid, p_version integer, p_served text, p_values jsonb, p_secret jsonb, p_absent jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('organization_id', p_org, 'workflow_id', p_wf, 'version_number', p_version, 'served_at', p_served,
    'values', p_values, 'secret_keys', p_secret, 'absent_keys', p_absent);
$f$;

-- A key row's ctid, which an UPDATE always changes, so a rewrite is visible inside one transaction.
CREATE FUNCTION pg_temp.vc_ctid(p_wf uuid, p_version integer, p_key text) RETURNS tid LANGUAGE sql AS $f$
  SELECT ctid FROM public.ops_variable_copies WHERE workflow_id = p_wf AND version_number = p_version AND key = p_key;
$f$;
CREATE FUNCTION pg_temp.vc_version_ctid(p_wf uuid, p_version integer) RETURNS tid LANGUAGE sql AS $f$
  SELECT ctid FROM public.ops_variable_copy_versions WHERE workflow_id = p_wf AND version_number = p_version;
$f$;

-- A refusal's message, or null when the statement ran.
CREATE FUNCTION pg_temp.vc_refused(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END
$f$;

-- ── 1. a save writes the version's whole list ────────────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  PERFORM pg_temp.vc_reset();
  SELECT * INTO r FROM public.save_variable_copies(jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 3, '2026-10-29T10:00:00Z',
    '{"API_BASE": "https://a.example.test", "REGION": "us"}', '["API_TOKEN"]', '["GONE"]')), 600);
  IF (r.versions_written, r.versions_unchanged, r.keys_written, r.keys_deleted, r.refused_no_copy, r.refused_older) IS DISTINCT FROM (1, 0, 4, 0, 0, 0) THEN
    RAISE EXCEPTION 'the first save answered %', r;
  END IF;
  IF (SELECT jsonb_object_agg(key, jsonb_build_array(kind, value)) FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1))
     IS DISTINCT FROM '{"API_BASE": ["plain", "https://a.example.test"], "REGION": ["plain", "us"], "API_TOKEN": ["secret", null], "GONE": ["absent", null]}'::jsonb THEN
    RAISE EXCEPTION 'the copy holds %', (SELECT jsonb_agg(c) FROM public.ops_variable_copies c);
  END IF;
  IF (SELECT served_at FROM public.ops_variable_copy_versions WHERE workflow_id = pg_temp.vc_wf(1) AND version_number = 3) <> '2026-10-29T10:00:00Z'
     OR (SELECT confirmed_at FROM public.ops_variable_copy_versions WHERE workflow_id = pg_temp.vc_wf(1) AND version_number = 3) <> now() THEN
    RAISE EXCEPTION 'the version row does not hold the served time and this database''s clock';
  END IF;
  INSERT INTO vc_cases VALUES ('a save writes each plain value, each secret by name and each absent name');
END
$do$;

-- ── 2. the same save again rewrites nothing ─────────────────────────────────
DO $do$
DECLARE
  r record;
  v_keys tid[];
  v_version tid;
BEGIN
  SELECT array_agg(ctid ORDER BY key) INTO v_keys FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1);
  v_version := pg_temp.vc_version_ctid(pg_temp.vc_wf(1), 3);
  SELECT * INTO r FROM public.save_variable_copies(jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 3, '2026-10-29T10:01:00Z',
    '{"REGION": "us", "API_BASE": "https://a.example.test"}', '["API_TOKEN"]', '["GONE"]')), 600);
  IF (r.versions_written, r.versions_unchanged, r.keys_written, r.keys_deleted) IS DISTINCT FROM (0, 1, 0, 0) THEN
    RAISE EXCEPTION 'an unchanged save answered %', r;
  END IF;
  IF (SELECT array_agg(ctid ORDER BY key) FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1)) IS DISTINCT FROM v_keys THEN
    RAISE EXCEPTION 'an unchanged save rewrote a key row';
  END IF;
  IF pg_temp.vc_version_ctid(pg_temp.vc_wf(1), 3) IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'an unchanged save inside the confirm interval rewrote the version row';
  END IF;
  INSERT INTO vc_cases VALUES ('the same save again rewrites no row');
END
$do$;

-- ── 3. a change rewrites only what changed ──────────────────────────────────
DO $do$
DECLARE
  r record;
  v_region tid := pg_temp.vc_ctid(pg_temp.vc_wf(1), 3, 'REGION');
  v_token tid := pg_temp.vc_ctid(pg_temp.vc_wf(1), 3, 'API_TOKEN');
BEGIN
  SELECT * INTO r FROM public.save_variable_copies(jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 3, '2026-10-29T10:02:00Z',
    '{"API_BASE": "https://b.example.test", "REGION": "us", "NEW_ONE": "x"}', '["API_TOKEN"]', '[]')), 600);
  IF (r.versions_written, r.versions_unchanged, r.keys_written, r.keys_deleted) IS DISTINCT FROM (1, 0, 2, 1) THEN
    RAISE EXCEPTION 'a changed save answered %', r;
  END IF;
  IF pg_temp.vc_ctid(pg_temp.vc_wf(1), 3, 'REGION') IS DISTINCT FROM v_region OR pg_temp.vc_ctid(pg_temp.vc_wf(1), 3, 'API_TOKEN') IS DISTINCT FROM v_token THEN
    RAISE EXCEPTION 'a changed save rewrote a key that did not change';
  END IF;
  IF (SELECT value FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1) AND key = 'API_BASE') <> 'https://b.example.test'
     OR EXISTS (SELECT 1 FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1) AND key = 'GONE')
     OR NOT EXISTS (SELECT 1 FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1) AND key = 'NEW_ONE' AND value = 'x') THEN
    RAISE EXCEPTION 'the changed save did not leave the version''s new list';
  END IF;
  IF (SELECT served_at FROM public.ops_variable_copy_versions WHERE workflow_id = pg_temp.vc_wf(1) AND version_number = 3) <> '2026-10-29T10:02:00Z' THEN
    RAISE EXCEPTION 'a changed save did not move the version''s served time';
  END IF;
  INSERT INTO vc_cases VALUES ('a change rewrites only its own row, deletes a name no longer listed, adds a new one');
END
$do$;

-- ── 4. past the confirm interval, only the version row moves ────────────────
DO $do$
DECLARE
  r record;
  v_keys tid[];
BEGIN
  UPDATE public.ops_variable_copy_versions SET confirmed_at = now() - interval '11 minutes' WHERE workflow_id = pg_temp.vc_wf(1);
  SELECT array_agg(ctid ORDER BY key) INTO v_keys FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1);
  SELECT * INTO r FROM public.save_variable_copies(jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 3, '2026-10-29T10:13:00Z',
    '{"API_BASE": "https://b.example.test", "REGION": "us", "NEW_ONE": "x"}', '["API_TOKEN"]', '[]')), 600);
  IF (r.versions_written, r.versions_unchanged, r.keys_written, r.keys_deleted) IS DISTINCT FROM (1, 0, 0, 0) THEN
    RAISE EXCEPTION 'a confirm past the interval answered %', r;
  END IF;
  IF (SELECT confirmed_at FROM public.ops_variable_copy_versions WHERE workflow_id = pg_temp.vc_wf(1)) <> now()
     OR (SELECT served_at FROM public.ops_variable_copy_versions WHERE workflow_id = pg_temp.vc_wf(1)) <> '2026-10-29T10:13:00Z' THEN
    RAISE EXCEPTION 'a confirm past the interval did not move the version row';
  END IF;
  IF (SELECT array_agg(ctid ORDER BY key) FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1)) IS DISTINCT FROM v_keys THEN
    RAISE EXCEPTION 'a confirm rewrote a key row';
  END IF;
  INSERT INTO vc_cases VALUES ('past the confirm interval an unchanged copy moves its version row only');
END
$do$;

-- ── 5. an older answer changes nothing ──────────────────────────────────────
DO $do$
DECLARE
  r record;
  v_version tid := pg_temp.vc_version_ctid(pg_temp.vc_wf(1), 3);
BEGIN
  SELECT * INTO r FROM public.save_variable_copies(jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 3, '2026-10-29T09:00:00Z',
    '{"API_BASE": "https://old.example.test"}', '[]', '[]')), 600);
  IF (r.versions_written, r.keys_written, r.keys_deleted, r.refused_older) IS DISTINCT FROM (0, 0, 0, 1) THEN
    RAISE EXCEPTION 'an older save answered %', r;
  END IF;
  IF (SELECT value FROM public.ops_variable_copies WHERE workflow_id = pg_temp.vc_wf(1) AND key = 'API_BASE') <> 'https://b.example.test'
     OR pg_temp.vc_version_ctid(pg_temp.vc_wf(1), 3) IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'an older save changed the copy';
  END IF;
  INSERT INTO vc_cases VALUES ('a save served earlier than the copy held changes nothing');
END
$do$;

-- ── 6. no copy, or another organization's ───────────────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.save_variable_copies(jsonb_build_array(
    pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(7), 1, '2026-10-29T10:00:00Z', '{"A": "1"}', '[]', '[]'),
    pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(3), 1, '2026-10-29T10:00:00Z', '{"A": "1"}', '[]', '[]'),
    pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(2), 1, '2026-10-29T10:00:00Z', '{"A": "1"}', '[]', '[]')), 600);
  IF (r.versions_written, r.refused_no_copy) IS DISTINCT FROM (1, 2) THEN
    RAISE EXCEPTION 'a batch with two strangers answered %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ops_variable_copy_versions WHERE workflow_id IN (pg_temp.vc_wf(7), pg_temp.vc_wf(3)))
     OR NOT EXISTS (SELECT 1 FROM public.ops_variable_copy_versions WHERE workflow_id = pg_temp.vc_wf(2)) THEN
    RAISE EXCEPTION 'the batch wrote a stranger, or not the workflow it should';
  END IF;
  INSERT INTO vc_cases VALUES ('a workflow with no copy or another organization''s is skipped and the rest written');
END
$do$;

-- ── 7. never a secret value ─────────────────────────────────────────────────
DO $do$
DECLARE
  v_before bigint := (SELECT count(*) FROM public.ops_variable_copies);
  v_msg text;
  v_sql text;
  v_good jsonb := pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(2), 2, '2026-10-29T10:00:00Z', '{"B": "2"}', '[]', '[]');
BEGIN
  FOREACH v_sql IN ARRAY ARRAY[
    -- A secret_values field beside the rest.
    format('SELECT public.save_variable_copies(%L::jsonb, 600)', jsonb_build_array(v_good,
      pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 4, '2026-10-29T10:00:00Z', '{}', '["API_TOKEN"]', '[]') || '{"secret_values": {"API_TOKEN": "fake-copy-secret"}}')),
    -- A secret's name also among the plain values, which would hold its value.
    format('SELECT public.save_variable_copies(%L::jsonb, 600)', jsonb_build_array(v_good,
      pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 4, '2026-10-29T10:00:00Z', '{"API_TOKEN": "fake-copy-secret"}', '["API_TOKEN"]', '[]'))),
    -- Any other key.
    format('SELECT public.save_variable_copies(%L::jsonb, 600)', jsonb_build_array(v_good,
      pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 4, '2026-10-29T10:00:00Z', '{}', '[]', '[]') || '{"note": "x"}')),
    -- A secret written as an object rather than a name.
    format('SELECT public.save_variable_copies(%L::jsonb, 600)', jsonb_build_array(v_good,
      pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 4, '2026-10-29T10:00:00Z', '{}', '[{"API_TOKEN": "fake-copy-secret"}]', '[]')))
  ] LOOP
    v_msg := pg_temp.vc_refused(v_sql);
    IF v_msg IS NULL OR v_msg NOT LIKE 'save_variable_copies:%' THEN RAISE EXCEPTION 'a copy that could carry a secret''s value was not refused by name: %', v_msg; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.ops_variable_copies) <> v_before OR EXISTS (SELECT 1 FROM public.ops_variable_copy_versions WHERE version_number IN (2, 4)) THEN
    RAISE EXCEPTION 'a refused call wrote something';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ops_variable_copies WHERE value = 'fake-copy-secret') THEN RAISE EXCEPTION 'a secret''s value was kept'; END IF;
  -- The owner itself cannot keep a secret's value, or a value under absent.
  v_msg := pg_temp.vc_refused(format($s$UPDATE public.ops_variable_copies SET value = 'fake-copy-secret' WHERE workflow_id = %L AND key = 'API_TOKEN'$s$, pg_temp.vc_wf(1)));
  IF v_msg IS NULL OR v_msg NOT LIKE '%ops_variable_copies_value_check%' THEN RAISE EXCEPTION 'the owner kept a secret''s value: %', v_msg; END IF;
  v_msg := pg_temp.vc_refused(format($s$INSERT INTO public.ops_variable_copies (organization_id, workflow_id, version_number, key, kind, value) VALUES (%L, %L, 3, 'X', 'absent', 'v')$s$, pg_temp.vc_org(), pg_temp.vc_wf(1)));
  IF v_msg IS NULL OR v_msg NOT LIKE '%ops_variable_copies_value_check%' THEN RAISE EXCEPTION 'the owner kept a value under absent: %', v_msg; END IF;
  INSERT INTO vc_cases VALUES ('no call or direct write can keep a secret''s value');
END
$do$;

-- service_role, which the Worker connects as, cannot write either table.
DO $do$
DECLARE
  v_sql text;
  v_refused boolean;
BEGIN
  FOREACH v_sql IN ARRAY ARRAY[
    $s$INSERT INTO public.ops_variable_copy_versions (organization_id, workflow_id, version_number, served_at) VALUES (gen_random_uuid(), gen_random_uuid(), 1, now())$s$,
    $s$UPDATE public.ops_variable_copies SET value = 'x'$s$,
    $s$DELETE FROM public.ops_variable_copy_versions$s$
  ] LOOP
    SET LOCAL ROLE service_role;
    BEGIN
      EXECUTE v_sql;
      v_refused := false;
    EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
    END;
    RESET ROLE;
    IF NOT v_refused THEN RAISE EXCEPTION 'service_role ran %', v_sql; END IF;
  END LOOP;
END
$do$;

-- ── 8. the bounds ───────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_msg text;
  v_case record;
BEGIN
  FOR v_case IN SELECT * FROM (VALUES
    ('more than 1000', format('SELECT public.save_variable_copies(%L::jsonb, 600)',
      (SELECT jsonb_agg(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), n, '2026-10-29T10:00:00Z', '{}', '[]', '[]')) FROM generate_series(1, 1001) n)), 'at most 1000 versions'),
    ('more than 500 names', format('SELECT public.save_variable_copies(%L::jsonb, 600)', jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 5, '2026-10-29T10:00:00Z', '{}', '[]',
      (SELECT jsonb_agg('N' || n) FROM generate_series(1, 501) n)))), 'at most 500 names'),
    ('a value over the size', format('SELECT public.save_variable_copies(%L::jsonb, 600)', jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 5, '2026-10-29T10:00:00Z',
      jsonb_build_object('BIG', repeat('x', 65537)), '[]', '[]'))), 'at most 65536 bytes'),
    ('a name that is no variable name', format('SELECT public.save_variable_copies(%L::jsonb, 600)', jsonb_build_array(pg_temp.vc_entry(pg_temp.vc_org(), pg_temp.vc_wf(1), 5, '2026-10-29T10:00:00Z',
      '{"bad-name": "x"}', '[]', '[]'))), 'not a variable name'),
    ('a confirm interval below 0', 'SELECT public.save_variable_copies(''[]''::jsonb, -1)', 'confirm every must be 0 to 3600'),
    ('a confirm interval over an hour', 'SELECT public.save_variable_copies(''[]''::jsonb, 3601)', 'confirm every must be 0 to 3600'),
    ('copies that are no array', 'SELECT public.save_variable_copies(''{}''::jsonb, 600)', 'the copies are an array')
  ) AS t(what, sql, says) LOOP
    v_msg := pg_temp.vc_refused(v_case.sql);
    IF v_msg IS NULL OR v_msg NOT LIKE '%' || v_case.says || '%' THEN RAISE EXCEPTION '% was not refused by name: %', v_case.what, v_msg; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.ops_variable_copy_versions WHERE version_number = 5) THEN RAISE EXCEPTION 'a refused call wrote a version'; END IF;
  INSERT INTO vc_cases VALUES ('each bound is refused by name');
END
$do$;

-- ── 9. variable_copies ──────────────────────────────────────────────────────
DO $do$
DECLARE
  v_rows jsonb;
  v_msg text;
BEGIN
  -- Another organization's copy of the same workflow id cannot exist here, so plant one directly to prove the read is scoped.
  INSERT INTO public.ops_variable_copy_versions (organization_id, workflow_id, version_number, served_at) VALUES (pg_temp.vc_org_b(), pg_temp.vc_wf(1), 3, now());
  INSERT INTO public.ops_variable_copies (organization_id, workflow_id, version_number, key, kind, value) VALUES (pg_temp.vc_org_b(), pg_temp.vc_wf(1), 3, 'OTHER', 'plain', 'theirs');
  SELECT jsonb_agg(to_jsonb(c) - 'confirmed_at' - 'db_now' - 'served_at') INTO v_rows FROM public.variable_copies(pg_temp.vc_org(),
    jsonb_build_array(jsonb_build_object('workflow_id', pg_temp.vc_wf(1), 'version_number', 3), jsonb_build_object('workflow_id', pg_temp.vc_wf(1), 'version_number', 9))) c;
  IF v_rows IS DISTINCT FROM jsonb_build_array(jsonb_build_object('workflow_id', pg_temp.vc_wf(1), 'version_number', 3,
      'plain_values', '{"API_BASE": "https://b.example.test", "REGION": "us", "NEW_ONE": "x"}'::jsonb, 'secret_keys', '["API_TOKEN"]'::jsonb, 'absent_keys', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'variable_copies answered %', v_rows;
  END IF;
  IF (SELECT db_now FROM public.variable_copies(pg_temp.vc_org(), jsonb_build_array(jsonb_build_object('workflow_id', pg_temp.vc_wf(1), 'version_number', 3)))) <> now() THEN
    RAISE EXCEPTION 'variable_copies does not answer the database clock';
  END IF;
  v_msg := pg_temp.vc_refused('SELECT * FROM public.variable_copies(''aaaaaaaa-0000-4000-8000-000000002999'', ''[{"workflow_id": "x", "version_number": 1}]''::jsonb)');
  IF v_msg IS NULL OR v_msg NOT LIKE 'variable_copies:%' THEN RAISE EXCEPTION 'a malformed request was not refused by name: %', v_msg; END IF;
  v_msg := pg_temp.vc_refused('SELECT * FROM public.variable_copies(NULL, ''[]''::jsonb)');
  IF v_msg IS NULL OR v_msg NOT LIKE 'variable_copies:%' THEN RAISE EXCEPTION 'a read with no organization was not refused by name: %', v_msg; END IF;
  DELETE FROM public.ops_variable_copy_versions WHERE organization_id = pg_temp.vc_org_b();
  INSERT INTO vc_cases VALUES ('variable_copies answers only the organization''s versions asked about');
END
$do$;

-- ── 10. purge_variable_copies ───────────────────────────────────────────────
DO $do$
DECLARE
  r record;
  v_msg text;
  v_limit integer;
BEGIN
  PERFORM pg_temp.vc_reset();
  -- Kept: workflow 1 version 3, fresh and on. Purged: workflow 1 version 2 (7 hours old),
  -- and a fresh copy of each of workflows 4 (off), 5 (deleted), 6 (withdrawn), 7 (no copy).
  INSERT INTO public.ops_variable_copy_versions (organization_id, workflow_id, version_number, served_at, confirmed_at) VALUES
    (pg_temp.vc_org(), pg_temp.vc_wf(1), 3, now(), now() - interval '5 hours 59 minutes'),
    (pg_temp.vc_org(), pg_temp.vc_wf(1), 2, now(), now() - interval '7 hours'),
    (pg_temp.vc_org(), pg_temp.vc_wf(4), 1, now(), now()),
    (pg_temp.vc_org(), pg_temp.vc_wf(5), 1, now(), now()),
    (pg_temp.vc_org(), pg_temp.vc_wf(6), 1, now(), now()),
    (pg_temp.vc_org(), pg_temp.vc_wf(7), 1, now(), now());
  INSERT INTO public.ops_variable_copies (organization_id, workflow_id, version_number, key, kind, value)
  SELECT organization_id, workflow_id, version_number, 'K', 'plain', 'v' FROM public.ops_variable_copy_versions;
  SELECT * INTO r FROM public.purge_variable_copies(3);
  IF r.purged <> 3 OR NOT r.more THEN RAISE EXCEPTION 'the first page purged % (more %), not 3 and more', r.purged, r.more; END IF;
  SELECT * INTO r FROM public.purge_variable_copies(3);
  IF r.purged <> 2 OR r.more THEN RAISE EXCEPTION 'the second page purged % (more %), not 2 and no more', r.purged, r.more; END IF;
  IF (SELECT array_agg(workflow_id::text || ':' || version_number) FROM public.ops_variable_copy_versions)
     IS DISTINCT FROM ARRAY[pg_temp.vc_wf(1)::text || ':3'] THEN
    RAISE EXCEPTION 'the purge left %', (SELECT array_agg(workflow_id::text || ':' || version_number) FROM public.ops_variable_copy_versions);
  END IF;
  IF (SELECT count(*) FROM public.ops_variable_copies) <> 1 THEN RAISE EXCEPTION 'a purged version''s key rows were left'; END IF;
  FOREACH v_limit IN ARRAY ARRAY[0, 1001] LOOP
    v_msg := pg_temp.vc_refused(format('SELECT public.purge_variable_copies(%s)', v_limit));
    IF v_msg IS NULL OR v_msg NOT LIKE '%limit must be 1 to 1000%' THEN RAISE EXCEPTION 'a limit of % was not refused by name', v_limit; END IF;
  END LOOP;
  INSERT INTO vc_cases VALUES ('the purge deletes stale copies and those of a workflow off, deleted, withdrawn or gone, a page at a time');
END
$do$;

-- ── 11. the ops rules ───────────────────────────────────────────────────────
DO $do$
DECLARE
  v_table text;
  v_role text;
  v_priv text;
  v_fn record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.ops_variable_copy_versions', 'public.ops_variable_copies'] LOOP
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
  END LOOP;
  FOR v_fn IN
    SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('save_variable_copies', 'variable_copies', 'purge_variable_copies')
  LOOP
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn.proname; END IF;
    IF v_fn.proconfig IS NULL OR NOT ('search_path=""' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn.proname; END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn.proname; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') OR has_function_privilege('public', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn.proname;
    END IF;
    IF (v_fn.proname = 'variable_copies') <> (v_fn.provolatile = 's') THEN RAISE EXCEPTION '% has the wrong volatility for a read or a write', v_fn.proname; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('save_variable_copies', 'variable_copies', 'purge_variable_copies')) <> 3 THEN
    RAISE EXCEPTION 'the copy functions do not have exactly one definition each';
  END IF;
  INSERT INTO vc_cases VALUES ('the tables and functions are under the ops rules');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM vc_cases);
BEGIN
  IF v_n <> 11 THEN RAISE EXCEPTION 'variable_copies: % of 11 cases ran', v_n; END IF;
  RAISE NOTICE 'variable_copies: % cases passed', v_n;
END
$do$;

ROLLBACK;
