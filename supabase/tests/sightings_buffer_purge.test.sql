-- Behavioural tests for purge_exported_sightings (#541).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. Its rows
-- live in January 2025 partitions it creates and removes, so the result does
-- not depend on the date the suite runs (L130). No real identity appears in it.
--
-- The procedure COMMITs between batches, so it is CALLed at the top level and
-- every assertion reads what the call left behind.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS purge_cases (name text PRIMARY KEY);
DELETE FROM purge_cases;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2025_01;
  DROP TABLE IF EXISTS public.achieve_evaluations_2025_01;
  CREATE TABLE public.lead_sightings_2025_01 PARTITION OF public.lead_sightings FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  CREATE TABLE public.lead_sighting_bids_2025_01 PARTITION OF public.lead_sighting_bids FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  CREATE TABLE public.achieve_evaluations_2025_01 PARTITION OF public.achieve_evaluations FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111115410', 'Purge Org', 'purge-org') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444445410', '11111111-1111-1111-1111-111111115410', 'Purge Flow') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.job_runs WHERE job = 'sightings-buffer-purge';
END
$do$;

-- trace_id says what each row is, so the assertions can name it.
INSERT INTO public.lead_sightings (trace_id, execution_id, workflow_id, execution_started_at_et, execution_started_at_utc, outcome_state, exported_at, export_rejected_at)
VALUES
  ('purge:past-grace', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', '2025-01-05', '2025-01-05', 'finalized', now() - interval '48 hours', NULL),
  ('purge:within-grace', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', '2025-01-05', '2025-01-05', 'finalized', now() - interval '1 hour', NULL),
  ('purge:unexported', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', '2025-01-05', '2025-01-05', 'finalized', NULL, NULL),
  ('purge:set-aside', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', '2025-01-05', '2025-01-05', 'finalized', NULL, now() - interval '72 hours');

INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at, export_rejected_at)
VALUES
  (gen_random_uuid(), 'purge:past-grace', gen_random_uuid(), 'purge', '2025-01-05', '2025-01-05', now() - interval '48 hours', NULL),
  (gen_random_uuid(), 'purge:within-grace', gen_random_uuid(), 'purge', '2025-01-05', '2025-01-05', now() - interval '1 hour', NULL),
  (gen_random_uuid(), 'purge:unexported', gen_random_uuid(), 'purge', '2025-01-05', '2025-01-05', NULL, NULL),
  (gen_random_uuid(), 'purge:set-aside', gen_random_uuid(), 'purge', '2025-01-05', '2025-01-05', NULL, now() - interval '72 hours');

INSERT INTO public.achieve_evaluations (trace_id, execution_id, workflow_id, node_namespace, requested_at_utc, offer_count, is_sandbox, exported_at)
VALUES
  ('purge:past-grace', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', 'purge', '2025-01-05', 0, false, now() - interval '48 hours'),
  ('purge:unexported', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', 'purge', '2025-01-05', 0, false, NULL),
  ('purge:sandbox', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', 'purge', '2025-01-05', 0, true, NULL);

-- ── 1. A run with no time does nothing, and says it stopped for the budget ───
CALL public.purge_exported_sightings(p_budget => interval '0 seconds');

DO $do$
DECLARE
  r record;
BEGIN
  IF (SELECT count(*) FROM public.lead_sightings WHERE trace_id LIKE 'purge:%') <> 4 THEN RAISE EXCEPTION 'a zero budget deleted rows'; END IF;
  SELECT * INTO r FROM public.job_runs WHERE job = 'sightings-buffer-purge' ORDER BY started_at DESC LIMIT 1;
  IF r.finished_at IS NULL THEN RAISE EXCEPTION 'the run record was left open'; END IF;
  IF r.outcome IS DISTINCT FROM 'budget' THEN RAISE EXCEPTION 'a run that stopped for its budget reported %', r.outcome; END IF;
  INSERT INTO purge_cases(name) VALUES ('stops at its budget and says so');
END
$do$;

-- ── The real run ─────────────────────────────────────────────────────────────
DELETE FROM public.job_runs WHERE job = 'sightings-buffer-purge';
CALL public.purge_exported_sightings();

-- ── 2. Exported rows past the grace are gone, in all three tables ────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lead_sightings WHERE trace_id = 'purge:past-grace') THEN RAISE EXCEPTION 'sightings: a past-grace row survived'; END IF;
  IF EXISTS (SELECT 1 FROM public.lead_sighting_bids WHERE trace_id = 'purge:past-grace') THEN RAISE EXCEPTION 'bids: a past-grace row survived'; END IF;
  IF EXISTS (SELECT 1 FROM public.achieve_evaluations WHERE trace_id = 'purge:past-grace') THEN RAISE EXCEPTION 'achieve: a past-grace row survived'; END IF;
  INSERT INTO purge_cases(name) VALUES ('past-grace rows deleted');
END
$do$;

-- ── 3. Nothing that is not safely in Snowflake is touched ────────────────────
DO $do$
DECLARE
  kept text;
BEGIN
  SELECT string_agg(trace_id, ',' ORDER BY trace_id) INTO kept FROM public.lead_sightings WHERE trace_id LIKE 'purge:%';
  IF kept IS DISTINCT FROM 'purge:set-aside,purge:unexported,purge:within-grace' THEN RAISE EXCEPTION 'sightings kept: %', kept; END IF;
  SELECT string_agg(trace_id, ',' ORDER BY trace_id) INTO kept FROM public.lead_sighting_bids WHERE trace_id LIKE 'purge:%';
  IF kept IS DISTINCT FROM 'purge:set-aside,purge:unexported,purge:within-grace' THEN RAISE EXCEPTION 'bids kept: %', kept; END IF;
  SELECT string_agg(trace_id, ',' ORDER BY trace_id) INTO kept FROM public.achieve_evaluations WHERE trace_id LIKE 'purge:%';
  IF kept IS DISTINCT FROM 'purge:sandbox,purge:unexported' THEN RAISE EXCEPTION 'achieve kept: %', kept; END IF;
  INSERT INTO purge_cases(name) VALUES ('unexported, set aside, within grace and sandbox rows kept');
END
$do$;

-- ── 4. The run is recorded in job_runs with what it deleted ──────────────────
DO $do$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.job_runs WHERE job = 'sightings-buffer-purge' ORDER BY started_at DESC LIMIT 1;
  IF r IS NULL OR r.finished_at IS NULL THEN RAISE EXCEPTION 'no closed run record'; END IF;
  IF r.outcome IS DISTINCT FROM 'ok' THEN RAISE EXCEPTION 'a drained run reported %', r.outcome; END IF;
  IF (r.summary->>'lead_sightings')::int IS DISTINCT FROM 1
     OR (r.summary->>'lead_sighting_bids')::int IS DISTINCT FROM 1
     OR (r.summary->>'achieve_evaluations')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'summary wrong: %', r.summary;
  END IF;
  INSERT INTO purge_cases(name) VALUES ('recorded in job_runs');
END
$do$;

-- ── 5. Small batches still drain every table (round robin, not one starving the rest)
INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at)
SELECT gen_random_uuid(), 'purge:batch', gen_random_uuid(), 'purge', '2025-01-06', '2025-01-06', now() - interval '48 hours' FROM generate_series(1, 5);
INSERT INTO public.lead_sightings (trace_id, execution_id, workflow_id, execution_started_at_et, execution_started_at_utc, outcome_state, exported_at)
SELECT 'purge:batch', gen_random_uuid(), '44444444-4444-4444-4444-444444445410', '2025-01-06', '2025-01-06', 'finalized', now() - interval '48 hours' FROM generate_series(1, 3);

CALL public.purge_exported_sightings(p_batch => 2);

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lead_sighting_bids WHERE trace_id = 'purge:batch') THEN RAISE EXCEPTION 'bids not drained in small batches'; END IF;
  IF EXISTS (SELECT 1 FROM public.lead_sightings WHERE trace_id = 'purge:batch') THEN RAISE EXCEPTION 'sightings not drained in small batches'; END IF;
  INSERT INTO purge_cases(name) VALUES ('drains in batches');
END
$do$;

-- ── 6. Only the database's own scheduler may run it, hourly ──────────────────
DO $do$
DECLARE
  fn text := 'public.purge_exported_sightings(interval, integer, interval)';
  bad text[] := '{}';
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN bad := array_append(bad, 'anon can execute'); END IF;
  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN bad := array_append(bad, 'authenticated can execute'); END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-exported-sightings' AND schedule = '13 * * * *' AND active) THEN
    bad := array_append(bad, 'no active hourly pg_cron job');
  END IF;
  IF array_length(bad, 1) IS NOT NULL THEN RAISE EXCEPTION 'wrong: %', array_to_string(bad, '; '); END IF;
  INSERT INTO purge_cases(name) VALUES ('grants and schedule');
END
$do$;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2025_01;
  DROP TABLE IF EXISTS public.achieve_evaluations_2025_01;
  DELETE FROM public.job_runs WHERE job = 'sightings-buffer-purge';
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM purge_cases);
BEGIN
  IF n <> 6 THEN RAISE EXCEPTION 'expected 6 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
