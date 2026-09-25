-- Behavioural tests for holding a bid row as long as its sighting (#1167).
--
-- WHERE THIS RUNS: only on the throwaway database `scripts/sql-suite/run.sh`
-- builds by replaying every migration from empty, never production. Its rows
-- live in January 2025 partitions it creates and removes. No real identity.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS held_bid_cases (name text PRIMARY KEY);
DELETE FROM held_bid_cases;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2025_01;
  CREATE TABLE public.lead_sightings_2025_01 PARTITION OF public.lead_sightings FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  CREATE TABLE public.lead_sighting_bids_2025_01 PARTITION OF public.lead_sighting_bids FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111167', 'Held Bid Org', 'held-bid-org') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name) VALUES ('44444444-4444-4444-4444-444444441167', '11111111-1111-1111-1111-111111111167', 'Held Bid Flow') ON CONFLICT (id) DO NOTHING;
END
$do$;

-- Four sightings, each with one bid exported two days ago (so past the grace on
-- its own). Which bids go depends only on whether their sighting goes.
INSERT INTO public.lead_sightings (id, trace_id, execution_id, workflow_id, execution_started_at_et, execution_started_at_utc, outcome_state, exported_at, export_rejected_at)
VALUES
  ('a1167000-0000-0000-0000-000000000001', 'held:purged', gen_random_uuid(), '44444444-4444-4444-4444-444444441167', '2025-01-05', '2025-01-05', 'finalized', now() - interval '48 hours', NULL),
  ('a1167000-0000-0000-0000-000000000002', 'held:late-export', gen_random_uuid(), '44444444-4444-4444-4444-444444441167', '2025-01-05', '2025-01-05', 'finalized', now() - interval '1 hour', NULL),
  ('a1167000-0000-0000-0000-000000000004', 'held:set-aside', gen_random_uuid(), '44444444-4444-4444-4444-444444441167', '2025-01-05', '2025-01-05', 'finalized', NULL, now() - interval '72 hours');

INSERT INTO public.lead_sighting_bids (sighting_id, trace_id, execution_id, partner_slug, attempted_at_utc, attempted_at_et, exported_at)
VALUES
  ('a1167000-0000-0000-0000-000000000001', 'held:purged', gen_random_uuid(), 'held', '2025-01-05', '2025-01-05', now() - interval '48 hours'),
  ('a1167000-0000-0000-0000-000000000002', 'held:late-export', gen_random_uuid(), 'held', '2025-01-05', '2025-01-05', now() - interval '48 hours'),
  ('a1167000-0000-0000-0000-000000000003', 'held:no-sighting', gen_random_uuid(), 'held', '2025-01-05', '2025-01-05', now() - interval '48 hours'),
  ('a1167000-0000-0000-0000-000000000004', 'held:set-aside', gen_random_uuid(), 'held', '2025-01-05', '2025-01-05', now() - interval '48 hours');

CALL public.purge_exported_sightings();

-- ── 1. A bid goes in the same run as its sighting ────────────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lead_sightings WHERE trace_id = 'held:purged') THEN RAISE EXCEPTION 'the purgeable sighting survived'; END IF;
  IF EXISTS (SELECT 1 FROM public.lead_sighting_bids WHERE trace_id = 'held:purged') THEN RAISE EXCEPTION 'its bid survived the run that purged the sighting'; END IF;
  INSERT INTO held_bid_cases(name) VALUES ('bid purged with its sighting');
END
$do$;

-- ── 2. A bid whose sighting is still kept stays, however old its own export ──
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lead_sighting_bids WHERE trace_id = 'held:late-export') THEN
    RAISE EXCEPTION 'a bid was purged while its sighting (exported late) is still in Supabase';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lead_sighting_bids WHERE trace_id = 'held:set-aside') THEN
    RAISE EXCEPTION 'a bid was purged while its sighting is set aside';
  END IF;
  INSERT INTO held_bid_cases(name) VALUES ('bid held while its sighting is kept');
END
$do$;

-- ── 3. A bid with no sighting at all is not held for ever ────────────────────
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lead_sighting_bids WHERE trace_id = 'held:no-sighting') THEN
    RAISE EXCEPTION 'a bid whose sighting never existed was held';
  END IF;
  INSERT INTO held_bid_cases(name) VALUES ('orphan bid purged');
END
$do$;

-- ── 4. Once the kept sighting goes, its bid goes with it ─────────────────────
UPDATE public.lead_sightings SET exported_at = now() - interval '48 hours' WHERE trace_id = 'held:late-export';
CALL public.purge_exported_sightings();

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.lead_sighting_bids WHERE trace_id = 'held:late-export') THEN
    RAISE EXCEPTION 'the held bid outlived its sighting';
  END IF;
  INSERT INTO held_bid_cases(name) VALUES ('held bid released with its sighting');
END
$do$;

DO $do$
BEGIN
  DROP TABLE IF EXISTS public.lead_sightings_2025_01;
  DROP TABLE IF EXISTS public.lead_sighting_bids_2025_01;
  DELETE FROM public.job_runs WHERE job = 'sightings-buffer-purge';
END
$do$;

DO $do$
DECLARE
  n int := (SELECT count(*) FROM held_bid_cases);
BEGIN
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 cases, % ran', n; END IF;
  RAISE NOTICE '% cases passed', n;
END
$do$;
