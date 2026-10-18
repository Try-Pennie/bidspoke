-- Behavioural tests for bid_recording_coverage_v4, v3 with refusals counted apart (#2391).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. Its rows
-- live in October 2024 partitions it creates and removes. No real identity.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS coverage_v4_cases (name text PRIMARY KEY);
DELETE FROM coverage_v4_cases;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2024_10;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2024_10;
  CREATE TABLE public.lead_sightings_2024_10 PARTITION OF public.lead_sightings FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');
  CREATE TABLE public.lead_sighting_bids_2024_10 PARTITION OF public.lead_sighting_bids FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111112391', 'Coverage V4 Org', 'coverage-v4-org') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444442391', '11111111-1111-1111-1111-111111112391', 'Coverage V4 Flow') ON CONFLICT (id) DO NOTHING;
END
$do$;

-- The window is [10:00, 12:00). Six leads inside it, one row each: an accept
-- (no skip_reason), a decline ('rejected'), a plain skip, the two listed
-- refusals, and a lead with no row at all. One more lead AT the end, with a
-- refusal row, which the window must not count; and a test run inside it.
INSERT INTO public.lead_sightings (id, trace_id, execution_id, workflow_id, execution_started_at_et, execution_started_at_utc, outcome_state, is_test)
VALUES
  ('b2391000-0000-0000-0000-000000000001', 'v4:accept', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 06:00', '2024-10-08 10:00', 'finalized', false),
  ('b2391000-0000-0000-0000-000000000002', 'v4:decline', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 06:10', '2024-10-08 10:10', 'finalized', false),
  ('b2391000-0000-0000-0000-000000000003', 'v4:skip', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 06:20', '2024-10-08 10:20', 'finalized', false),
  ('b2391000-0000-0000-0000-000000000004', 'v4:below-min', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 06:30', '2024-10-08 10:30', 'finalized', false),
  ('b2391000-0000-0000-0000-000000000005', 'v4:missing', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 06:40', '2024-10-08 10:40', 'finalized', false),
  ('b2391000-0000-0000-0000-000000000006', 'v4:norow', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 06:50', '2024-10-08 10:50', 'finalized', false),
  ('b2391000-0000-0000-0000-000000000007', 'v4:at-end', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 08:00', '2024-10-08 12:00', 'in_flight', false),
  ('b2391000-0000-0000-0000-000000000008', 'v4:test', gen_random_uuid(), '44444444-4444-4444-4444-444444442391', '2024-10-08 07:30', '2024-10-08 11:30', 'finalized', true);

INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, classification, skip_reason, is_test)
VALUES
  ('b2391000-0000-0000-0000-000000000001', 'v4:accept', gen_random_uuid(), 'tripoint', '2024-10-08 10:00:03', '2024-10-08 06:00:03', 'accept', NULL, false),
  ('b2391000-0000-0000-0000-000000000002', 'v4:decline', gen_random_uuid(), 'tripoint', '2024-10-08 10:10:03', '2024-10-08 06:10:03', 'decline', 'rejected', false),
  ('b2391000-0000-0000-0000-000000000003', 'v4:skip', gen_random_uuid(), 'tripoint', '2024-10-08 10:20:03', '2024-10-08 06:20:03', NULL, 'skipped', false),
  ('b2391000-0000-0000-0000-000000000004', 'v4:below-min', gen_random_uuid(), 'tripoint', '2024-10-08 10:30:03', '2024-10-08 06:30:03', NULL, 'loan_amount_below_min', false),
  ('b2391000-0000-0000-0000-000000000005', 'v4:missing', gen_random_uuid(), 'tripoint', '2024-10-08 10:40:03', '2024-10-08 06:40:03', NULL, 'missing_lead_field', false),
  ('b2391000-0000-0000-0000-000000000007', 'v4:at-end', gen_random_uuid(), 'tripoint', '2024-10-08 12:00:03', '2024-10-08 08:00:03', NULL, 'loan_amount_below_min', false),
  ('b2391000-0000-0000-0000-000000000008', 'v4:test', gen_random_uuid(), 'tripoint', '2024-10-08 11:30:03', '2024-10-08 07:30:03', NULL, 'loan_amount_below_min', true);

-- ── 1. A refusal is neither an attempt nor a plain skip ──────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.bid_recording_coverage_v4('11111111-1111-1111-1111-111111112391', '2024-10-08 10:00Z', '2024-10-08 12:00Z');
  IF r.sightings IS DISTINCT FROM 6::bigint THEN RAISE EXCEPTION 'expected 6 leads in the window, got %', r.sightings; END IF;
  IF r.bid_rows IS DISTINCT FROM 5::bigint THEN RAISE EXCEPTION 'expected 5 bid rows, got %', r.bid_rows; END IF;
  IF r.attempt_rows IS DISTINCT FROM 2::bigint THEN RAISE EXCEPTION 'expected 2 attempts (the accept and the decline), got %', r.attempt_rows; END IF;
  IF r.refusal_rows IS DISTINCT FROM 2::bigint THEN RAISE EXCEPTION 'expected 2 refusals, got %', r.refusal_rows; END IF;
  IF r.workflow_name IS DISTINCT FROM 'Coverage V4 Flow' THEN RAISE EXCEPTION 'wrong workflow name %', r.workflow_name; END IF;
  INSERT INTO coverage_v4_cases(name) VALUES ('refusals counted apart from attempts and skips');
END
$do$;

-- ── 2. v3 over the same rows counts the refusals as attempts, which is why v4 exists
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.bid_recording_coverage_v3('11111111-1111-1111-1111-111111112391', '2024-10-08 10:00Z', '2024-10-08 12:00Z');
  IF r.attempt_rows IS DISTINCT FROM 4::bigint THEN RAISE EXCEPTION 'expected v3 to read 4 attempts here, got %', r.attempt_rows; END IF;
  INSERT INTO coverage_v4_cases(name) VALUES ('v3 cannot tell a refusal from an attempt');
END
$do$;

-- ── 3. The window end and test runs work as in v3 ────────────────────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.bid_recording_coverage_v4('11111111-1111-1111-1111-111111112391', '2024-10-08 10:00Z', '2024-10-08 12:01Z');
  IF r.sightings IS DISTINCT FROM 7::bigint THEN RAISE EXCEPTION 'expected 7 leads once the end moves past 12:00, got %', r.sightings; END IF;
  IF r.refusal_rows IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'expected its refusal counted too, got %', r.refusal_rows; END IF;
  INSERT INTO coverage_v4_cases(name) VALUES ('a later end takes the lead in; the test run never');
END
$do$;

-- ── 4. Another organization reads nothing ─────────────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bid_recording_coverage_v4('11111111-1111-1111-1111-111111111111', '2024-10-08 10:00Z', '2024-10-08 12:00Z')
             WHERE workflow_id = '44444444-4444-4444-4444-444444442391') THEN
    RAISE EXCEPTION 'another organization read this workflow';
  END IF;
  INSERT INTO coverage_v4_cases(name) VALUES ('scoped to the organization');
END
$do$;

-- ── 5. Same grants as v3: service_role only, and STABLE ───────────────────────
DO $do$
DECLARE
  sig text := 'public.bid_recording_coverage_v4(uuid, timestamptz, timestamptz)';
BEGIN
  IF has_function_privilege('anon', sig, 'EXECUTE') THEN RAISE EXCEPTION 'anon can execute v4'; END IF;
  IF has_function_privilege('authenticated', sig, 'EXECUTE') THEN RAISE EXCEPTION 'authenticated can execute v4'; END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute v4'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = sig::regprocedure) <> 's' THEN RAISE EXCEPTION 'v4 is not STABLE'; END IF;
  INSERT INTO coverage_v4_cases(name) VALUES ('grants and volatility');
END
$do$;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2024_10;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2024_10;
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM coverage_v4_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
