-- Behavioural tests for sightings_buffer_lag (#463).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. Its rows
-- live in January 2025 partitions it creates and removes, and every cutoff it
-- passes is in 2025, so no other file's rows can be counted and the result does
-- not depend on the date the suite runs (L130). No real identity appears in it.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS lag_cases (name text PRIMARY KEY);
DELETE FROM lag_cases;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2025_01;
  DROP TABLE IF EXISTS public.achieve_evaluations_2025_01;
  CREATE TABLE public.lead_sightings_2025_01 PARTITION OF public.lead_sightings FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  CREATE TABLE public.lead_sighting_bids_2025_01 PARTITION OF public.lead_sighting_bids FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  CREATE TABLE public.achieve_evaluations_2025_01 PARTITION OF public.achieve_evaluations FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111114630', 'Lag Org', 'lag-org') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444444630', '11111111-1111-1111-1111-111111114630', 'Lag Flow') ON CONFLICT (id) DO NOTHING;
END
$do$;

-- Sightings. Waiting before the 2025-01-20 cutoff: only the first row counts.
INSERT INTO public.lead_sightings (trace_id, execution_id, workflow_id, execution_started_at_et, execution_started_at_utc, outcome_state, is_test, exported_at, export_rejected_at)
VALUES
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', '2025-01-05', '2025-01-05', 'finalized', false, NULL, NULL),          -- waiting
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', '2025-01-04', '2025-01-04', 'in_flight', false, NULL, NULL),          -- not exportable yet
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', '2025-01-04', '2025-01-04', 'finalized', true, NULL, NULL),           -- a test row, never exported
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', '2025-01-04', '2025-01-04', 'finalized', false, NULL, '2025-01-06'),  -- set aside, alerted on its own
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', '2025-01-25', '2025-01-25', 'finalized', false, NULL, NULL),          -- newer than the cutoff
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', '2025-01-03', '2025-01-03', 'finalized', false, '2025-01-03', NULL),  -- exported, and overdue
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', '2025-01-26', '2025-01-26', 'finalized', false, '2025-01-26', NULL);  -- exported, not overdue

INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, is_test, exported_at, export_rejected_at)
VALUES
  (gen_random_uuid(), 'lag', gen_random_uuid(), 'lag', '2025-01-05', '2025-01-05', false, NULL, NULL),          -- waiting
  (gen_random_uuid(), 'lag', gen_random_uuid(), 'lag', '2025-01-06', '2025-01-06', false, NULL, NULL),          -- waiting
  (gen_random_uuid(), 'lag', gen_random_uuid(), 'lag', '2025-01-07', '2025-01-07', false, NULL, NULL),          -- waiting
  (gen_random_uuid(), 'lag', gen_random_uuid(), 'lag', '2025-01-04', '2025-01-04', false, NULL, '2025-01-06'),  -- set aside
  (gen_random_uuid(), 'lag', gen_random_uuid(), 'lag', '2025-01-02', '2025-01-02', false, '2025-01-02', NULL);  -- overdue

INSERT INTO public.achieve_evaluations (trace_id, execution_id, workflow_id, node_namespace, requested_at_utc, offer_count, is_test, is_sandbox, exported_at)
VALUES
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', 'lag', '2025-01-05', 0, false, false, NULL),         -- waiting
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', 'lag', '2025-01-05', 0, false, true, NULL),          -- sandbox, never exported
  ('lag', gen_random_uuid(), '44444444-4444-4444-4444-444444444630', 'lag', '2025-01-02', 0, false, false, '2025-01-02'); -- overdue

-- ── 1. Grants, and it is declared read only ─────────────────────────────────
DO $do$
DECLARE
  fn text := 'public.sightings_buffer_lag(text, timestamp without time zone, timestamp with time zone, integer)';
  bad text[] := '{}';
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN bad := array_append(bad, 'anon can execute'); END IF;
  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN bad := array_append(bad, 'authenticated can execute'); END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN bad := array_append(bad, 'service_role cannot execute'); END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = fn::regprocedure) <> 's' THEN bad := array_append(bad, 'not STABLE'); END IF;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'grants wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO lag_cases(name) VALUES ('grants');
END
$do$;

-- ── 2. A table it does not know is refused, never answered with zeros ───────
DO $do$
BEGIN
  BEGIN
    PERFORM public.sightings_buffer_lag('workflow_executions', '2025-01-20', '2025-01-20', 100);
    RAISE EXCEPTION 'an unknown table was answered';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'an unknown table was answered' THEN RAISE; END IF;
  END;
  INSERT INTO lag_cases(name) VALUES ('unknown table refused');
END
$do$;

-- ── 3. Sightings: only exportable, unset-aside, non-test rows count as waiting
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.sightings_buffer_lag('lead_sightings', '2025-01-20', '2025-01-20', 100);
  IF r.waiting_rows IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'sightings waiting: expected 1, got %', r.waiting_rows; END IF;
  IF r.oldest_waiting IS DISTINCT FROM '2025-01-05'::timestamp THEN RAISE EXCEPTION 'sightings oldest waiting: %', r.oldest_waiting; END IF;
  IF r.overdue_rows IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'sightings overdue: expected 1, got %', r.overdue_rows; END IF;
  IF r.oldest_exported_at IS DISTINCT FROM '2025-01-03'::timestamptz THEN RAISE EXCEPTION 'sightings oldest exported: %', r.oldest_exported_at; END IF;
  INSERT INTO lag_cases(name) VALUES ('sightings counted by the export filter');
END
$do$;

-- ── 4. Bids ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.sightings_buffer_lag('lead_sighting_bids', '2025-01-20', '2025-01-20', 100);
  IF r.waiting_rows IS DISTINCT FROM 3 OR r.overdue_rows IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'bids: waiting %, overdue %', r.waiting_rows, r.overdue_rows;
  END IF;
  INSERT INTO lag_cases(name) VALUES ('bids');
END
$do$;

-- ── 5. Achieve: a sandbox row is never exported, so it is not waiting ────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.sightings_buffer_lag('achieve_evaluations', '2025-01-20', '2025-01-20', 100);
  IF r.waiting_rows IS DISTINCT FROM 1 OR r.overdue_rows IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'achieve: waiting %, overdue %', r.waiting_rows, r.overdue_rows;
  END IF;
  INSERT INTO lag_cases(name) VALUES ('achieve');
END
$do$;

-- ── 6. The count stops at the cap, so a huge backlog cannot time the read out
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.sightings_buffer_lag('lead_sighting_bids', '2025-01-20', '2025-01-20', 2);
  IF r.waiting_rows IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'cap ignored: %', r.waiting_rows; END IF;
  INSERT INTO lag_cases(name) VALUES ('capped');
END
$do$;

-- ── 7. Nothing past the cutoffs reads as zero, with no oldest time ──────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.sightings_buffer_lag('lead_sightings', '2025-01-01', '2025-01-01', 100);
  IF r.waiting_rows IS DISTINCT FROM 0 OR r.overdue_rows IS DISTINCT FROM 0 OR r.oldest_waiting IS NOT NULL OR r.oldest_exported_at IS NOT NULL THEN
    RAISE EXCEPTION 'healthy read wrong: %', r;
  END IF;
  INSERT INTO lag_cases(name) VALUES ('healthy');
END
$do$;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2025_01;
  DROP TABLE IF EXISTS public.achieve_evaluations_2025_01;
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM lag_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
