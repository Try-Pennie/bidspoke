-- Behavioural tests for bid_recording_coverage_v3, the ratio window with an end (#1929).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. Its rows
-- live in November 2024 partitions it creates and removes. No real identity.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS coverage_v3_cases (name text PRIMARY KEY);
DELETE FROM coverage_v3_cases;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2024_11;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2024_11;
  CREATE TABLE public.lead_sightings_2024_11 PARTITION OF public.lead_sightings FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');
  CREATE TABLE public.lead_sighting_bids_2024_11 PARTITION OF public.lead_sighting_bids FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111929', 'Coverage V3 Org', 'coverage-v3-org') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444441929', '11111111-1111-1111-1111-111111111929', 'Coverage V3 Flow') ON CONFLICT (id) DO NOTHING;
END
$do$;

-- The window is [10:00, 12:00). One lead before it, two inside it (one bid
-- with an attempt and a skipped row, one with no bid), one AT the end (still
-- running as far as the window is concerned), and one test run inside it.
INSERT INTO public.lead_sightings (id, trace_id, execution_id, workflow_id, execution_started_at_et, execution_started_at_utc, outcome_state, is_test)
VALUES
  ('b1929000-0000-0000-0000-000000000001', 'v3:before', gen_random_uuid(), '44444444-4444-4444-4444-444444441929', '2024-11-05 04:59', '2024-11-05 09:59', 'finalized', false),
  ('b1929000-0000-0000-0000-000000000002', 'v3:bid', gen_random_uuid(), '44444444-4444-4444-4444-444444441929', '2024-11-05 05:00', '2024-11-05 10:00', 'finalized', false),
  ('b1929000-0000-0000-0000-000000000003', 'v3:nobid', gen_random_uuid(), '44444444-4444-4444-4444-444444441929', '2024-11-05 06:00', '2024-11-05 11:00', 'finalized', false),
  ('b1929000-0000-0000-0000-000000000004', 'v3:at-end', gen_random_uuid(), '44444444-4444-4444-4444-444444441929', '2024-11-05 07:00', '2024-11-05 12:00', 'in_flight', false),
  ('b1929000-0000-0000-0000-000000000005', 'v3:test', gen_random_uuid(), '44444444-4444-4444-4444-444444441929', '2024-11-05 06:30', '2024-11-05 11:30', 'finalized', true);

INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, skip_reason, is_test)
VALUES
  ('b1929000-0000-0000-0000-000000000001', 'v3:before', gen_random_uuid(), 'p', '2024-11-05 09:59:30', '2024-11-05 04:59:30', NULL, false),
  -- A bid logged a few seconds after its lead started, and one skipped row.
  ('b1929000-0000-0000-0000-000000000002', 'v3:bid', gen_random_uuid(), 'p', '2024-11-05 10:00:03', '2024-11-05 05:00:03', NULL, false),
  ('b1929000-0000-0000-0000-000000000002', 'v3:bid', gen_random_uuid(), 'q', '2024-11-05 10:00:03', '2024-11-05 05:00:03', 'skipped', false),
  ('b1929000-0000-0000-0000-000000000004', 'v3:at-end', gen_random_uuid(), 'p', '2024-11-05 12:00:03', '2024-11-05 07:00:03', NULL, false),
  ('b1929000-0000-0000-0000-000000000005', 'v3:test', gen_random_uuid(), 'p', '2024-11-05 11:30:03', '2024-11-05 06:30:03', NULL, true);

-- ── 1. Counts only leads that started inside [since, until) ──────────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.bid_recording_coverage_v3('11111111-1111-1111-1111-111111111929', '2024-11-05 10:00Z', '2024-11-05 12:00Z');
  IF r.sightings IS DISTINCT FROM 2::bigint THEN RAISE EXCEPTION 'expected 2 leads in the window, got %', r.sightings; END IF;
  IF r.bid_rows IS DISTINCT FROM 2::bigint THEN RAISE EXCEPTION 'expected 2 bid rows, got %', r.bid_rows; END IF;
  IF r.attempt_rows IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'expected 1 attempt, got %', r.attempt_rows; END IF;
  IF r.workflow_name IS DISTINCT FROM 'Coverage V3 Flow' THEN RAISE EXCEPTION 'wrong workflow name %', r.workflow_name; END IF;
  INSERT INTO coverage_v3_cases(name) VALUES ('window is half open and excludes the lead at its end');
END
$do$;

-- ── 2. The end is what moves the lead in: a later end counts it ──────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.bid_recording_coverage_v3('11111111-1111-1111-1111-111111111929', '2024-11-05 10:00Z', '2024-11-05 12:01Z');
  IF r.sightings IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'expected 3 leads once the end moves past 12:00, got %', r.sightings; END IF;
  IF r.attempt_rows IS DISTINCT FROM 2::bigint THEN RAISE EXCEPTION 'expected its bid counted too, got % attempts', r.attempt_rows; END IF;
  INSERT INTO coverage_v3_cases(name) VALUES ('a later end takes the lead in');
END
$do$;

-- ── 3. Another organization reads nothing ─────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bid_recording_coverage_v3('11111111-1111-1111-1111-111111111111', '2024-11-05 10:00Z', '2024-11-05 12:00Z')
             WHERE workflow_id = '44444444-4444-4444-4444-444444441929') THEN
    RAISE EXCEPTION 'another organization read this workflow';
  END IF;
  INSERT INTO coverage_v3_cases(name) VALUES ('scoped to the organization');
END
$do$;

-- ── 4. Same grants as v2: service_role only, and STABLE ───────────────────────
DO $do$
DECLARE
  sig text := 'public.bid_recording_coverage_v3(uuid, timestamptz, timestamptz)';
BEGIN
  IF has_function_privilege('anon', sig, 'EXECUTE') THEN RAISE EXCEPTION 'anon can execute v3'; END IF;
  IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN RAISE EXCEPTION 'authenticated can execute v3'; END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute v3'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = sig::regprocedure) <> 's' THEN RAISE EXCEPTION 'v3 is not STABLE'; END IF;
  INSERT INTO coverage_v3_cases(name) VALUES ('grants and volatility');
END
$do$;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2024_11;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2024_11;
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM coverage_v3_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
