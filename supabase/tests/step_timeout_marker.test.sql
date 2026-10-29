-- The step timeout marker (#3047), migration 20261029200000.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. Fixed ids, deleted
-- first, so a rerun starts clean. No real identity.
--
-- WHAT IT PROVES:
--   A. execution_steps has timeout_kind (text) and timed_out_after_ms (integer),
--      nullable with no default and no CHECK, on the parent and on a partition,
--      so adding them rewrote no row and a value added in code later cannot make
--      a step write fail (20260617000002).
--   B. step_timeout_audit_by_workflow counts a final failure the engine marked
--      'step', whatever its message; never one marked 'parallel_block', even
--      with the step deadline's message; and still a row written before the
--      marker, by its message alone.
--
-- Mutations tried on 2026-10-29 (each turned its case red, then the function was
-- put back): dropping `es.timeout_kind = 'step' OR` (B counted 1, not 3), and
-- dropping `es.timeout_kind IS NULL AND` (B counted 4).
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS stm_cases (name text PRIMARY KEY);
DELETE FROM stm_cases;

-- ── A. The columns ───────────────────────────────────────────────────────────
DO $do$
DECLARE
  c record;
  part regclass;
BEGIN
  SELECT inhrelid::regclass INTO part FROM pg_inherits WHERE inhparent = 'public.execution_steps'::regclass LIMIT 1;
  IF part IS NULL THEN RAISE EXCEPTION 'execution_steps has no partition to check'; END IF;
  FOR c IN
    SELECT t.rel, v.col, v.typ
    FROM (VALUES ('public.execution_steps'::regclass), (part)) AS t(rel)
    CROSS JOIN (VALUES ('timeout_kind', 'text'), ('timed_out_after_ms', 'integer')) AS v(col, typ)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.rel AND a.attname = c.col AND NOT a.attisdropped
        AND format_type(a.atttypid, a.atttypmod) = c.typ AND NOT a.attnotnull AND NOT a.atthasdef
    ) THEN
      RAISE EXCEPTION '%.% is missing, or not a nullable % with no default', c.rel, c.col, c.typ;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.execution_steps'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ '\m(timeout_kind|timed_out_after_ms)\M'
  ) THEN
    RAISE EXCEPTION 'a CHECK constrains the timeout marker, so a new kind in code would fail step writes';
  END IF;
  INSERT INTO stm_cases VALUES ('the marker columns are nullable, with no default and no CHECK, on the parent and its partitions');
END
$do$;

-- ── B. What the audit counts ─────────────────────────────────────────────────
DO $do$
DECLARE
  d date;
  t text;
  v_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workflow_executions', 'execution_steps'] LOOP
    FOREACH d IN ARRAY ARRAY[CURRENT_DATE - 3, CURRENT_DATE - 2, CURRENT_DATE - 1, CURRENT_DATE] LOOP
      v_name := t || '_' || to_char(d, 'YYYY_MM_DD');
      BEGIN
        EXECUTE format('CREATE TABLE %I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)', v_name, t, d, d + 1);
      EXCEPTION
        WHEN invalid_object_definition OR duplicate_table THEN NULL;
      END;
    END LOOP;
  END LOOP;
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111113047', 'STM Org', 'stm-org-3047') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444443047', '11111111-1111-1111-1111-111111113047', 'STM Flow')
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.execution_steps WHERE workflow_id = '44444444-4444-4444-4444-444444443047';
  DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444443047';
  INSERT INTO public.workflow_executions (id, workflow_id, status, started_at)
  VALUES ('55555555-5555-5555-5555-555555553047', '44444444-4444-4444-4444-444444443047', 'completed',
          (CURRENT_DATE - 3)::timestamp AT TIME ZONE 'UTC');
END
$do$;

-- step(offset from T0, message, timeout_kind, timed_out_after_ms), all final failures of 'post'.
INSERT INTO public.execution_steps (execution_id, execution_started_at, workflow_id, step_namespace, step_type, status, started_at, duration_ms, error_message, timeout_kind, timed_out_after_ms, is_test)
SELECT '55555555-5555-5555-5555-555555553047', (CURRENT_DATE - 3)::timestamp AT TIME ZONE 'UTC', '44444444-4444-4444-4444-444444443047', 'post', 'webhook', 'failed',
       ((CURRENT_DATE - 2)::timestamp AT TIME ZONE 'UTC') + at_offset, 4500, msg, kind, after_ms, false
FROM (VALUES
  -- Counted: marked by the engine, whatever the message says.
  (interval '1 hour', 'Step timed out, worded some new way', 'step', 4500),
  (interval '2 hours', 'Step timed out after 4500ms (in-flight upstream call canceled via abort signal)', 'step', 4500),
  -- Counted: written before the marker, read by its message.
  (interval '3 hours', 'Step timed out after 4500ms (in-flight upstream call canceled via abort signal)', NULL, NULL),
  -- Not counted: its block stopped waiting, so it is the block's timeout, whatever the message.
  (interval '4 hours', 'Parallel group timed out after 20000ms before this child completed', 'parallel_block', 20000),
  (interval '5 hours', 'Step timed out after 4500ms (in-flight upstream call canceled via abort signal)', 'parallel_block', 20000),
  -- Not counted: an ordinary failure.
  (interval '6 hours', 'HTTP 503', NULL, NULL)
) AS v(at_offset, msg, kind, after_ms);

DO $do$
DECLARE
  t0 timestamptz := (CURRENT_DATE - 2)::timestamp AT TIME ZONE 'UTC';
  r record;
BEGIN
  SELECT * INTO r FROM public.step_timeout_audit_by_workflow('44444444-4444-4444-4444-444444443047', t0, t0 + interval '48 hours', ARRAY['post'], 10);
  IF NOT FOUND THEN RAISE EXCEPTION 'post answered nothing'; END IF;
  IF r.timed_out <> 3 THEN RAISE EXCEPTION 'timed_out = %, expected 3', r.timed_out; END IF;
  IF r.timed_out_at IS DISTINCT FROM ARRAY[t0 + interval '3 hours', t0 + interval '2 hours', t0 + interval '1 hour'] THEN
    RAISE EXCEPTION 'timed_out_at = %', r.timed_out_at;
  END IF;
  INSERT INTO stm_cases VALUES ('counts a step marked as stopped by its own deadline, or an unmarked one by its message, never a parallel block''s');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.execution_steps WHERE workflow_id = '44444444-4444-4444-4444-444444443047';
DELETE FROM public.workflow_executions WHERE workflow_id = '44444444-4444-4444-4444-444444443047';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM stm_cases);
BEGIN
  IF n <> 2 THEN RAISE EXCEPTION 'expected 2 cases, % ran', n; END IF;
  RAISE NOTICE 'step_timeout_marker.test.sql: % cases passed', n;
END
$do$;
