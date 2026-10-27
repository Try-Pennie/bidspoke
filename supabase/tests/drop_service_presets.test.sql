-- service_presets is dropped (#2638).
-- Migration 20261027210000_drop_service_presets_2638.sql.
--
-- WHAT IT PROVES.
--   A. After every migration the table is gone, and no function or view names it.
--   B. Run against the table holding a row, the migration RAISES by name, drops
--      nothing and keeps the row: a row that appeared after the drop was
--      decided is copied out first, never lost.
--   C. Once the table is empty the same file drops it, and it runs again
--      cleanly on a database where the table is already gone.
--
-- B and C run the migration file itself, read from the migrations folder the
-- harness copies into the container (scripts/sql-suite/project.sh).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds, inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE dsp_cases (name text PRIMARY KEY);

-- ── A. Gone after the migrations, and named by nothing ───────────────────────
DO $do$
BEGIN
  IF to_regclass('public.service_presets') IS NOT NULL THEN
    RAISE EXCEPTION 'service_presets still exists after every migration ran';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE prosrc ILIKE '%service_presets%') THEN
    RAISE EXCEPTION 'a function still names service_presets: %', (SELECT string_agg(proname, ', ') FROM pg_proc WHERE prosrc ILIKE '%service_presets%');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_views WHERE definition ILIKE '%service_presets%') THEN
    RAISE EXCEPTION 'a view still names service_presets';
  END IF;
  INSERT INTO dsp_cases VALUES ('gone: no table, and no function or view names it');
END
$do$;

-- ── B. Refused by name while the table holds a row, dropping nothing ─────────
DO $do$
DECLARE
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261027210000_drop_service_presets_2638.sql');
  v_message text;
BEGIN
  -- The table as it stood before the migration, with one row in it.
  CREATE TABLE public.service_presets (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    slug             TEXT        NOT NULL,
    auth_type        TEXT        NOT NULL DEFAULT 'none'
                                 CHECK (auth_type IN ('none', 'api_key', 'bearer', 'basic')),
    base_url         TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, slug)
  );
  INSERT INTO public.organizations (id, name, slug) VALUES ('aaaaaaaa-0000-4000-8000-000000002638', 'Drop presets test org', 'drop-presets-2638');
  INSERT INTO public.service_presets (organization_id, name, slug) VALUES ('aaaaaaaa-0000-4000-8000-000000002638', 'Lender API', 'lender-api');

  BEGIN
    EXECUTE v_file;
    RAISE EXCEPTION 'the migration dropped service_presets while it held a row';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'drop service_presets (#2638): it holds 1 row(s), so nothing was dropped%' THEN
      RAISE EXCEPTION 'the refusal did not say why: %', v_message;
    END IF;
  END;
  IF to_regclass('public.service_presets') IS NULL THEN RAISE EXCEPTION 'the refused migration dropped the table anyway'; END IF;
  IF (SELECT count(*) FROM public.service_presets) <> 1 THEN RAISE EXCEPTION 'the refused migration lost the row'; END IF;
  INSERT INTO dsp_cases VALUES ('refused: a table holding a row is kept, row and all, and the refusal says so');
END
$do$;

-- ── C. Drops an empty table, then reruns on a database without it ───────────
DO $do$
DECLARE
  v_file text := pg_read_file('/sql-suite-fixtures/supabase/20261027210000_drop_service_presets_2638.sql');
BEGIN
  DELETE FROM public.service_presets;
  EXECUTE v_file;
  IF to_regclass('public.service_presets') IS NOT NULL THEN RAISE EXCEPTION 'the migration left an empty service_presets in place'; END IF;
  EXECUTE v_file;
  INSERT INTO dsp_cases VALUES ('drops: an empty table is dropped, and a rerun without it is clean');
END
$do$;

DO $do$
DECLARE
  v_count integer := (SELECT count(*) FROM dsp_cases);
BEGIN
  IF v_count <> 3 THEN RAISE EXCEPTION 'drop_service_presets.test.sql: only % of 3 cases ran', v_count; END IF;
  RAISE NOTICE 'drop_service_presets.test.sql: % cases passed', v_count;
END
$do$;

ROLLBACK;
