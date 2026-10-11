-- Behavioural tests for reduce_finalize_stranded after the literal-bounds rewrite (#1722).
--
-- WHY THIS EXISTS: the rewrite moved every scan inside EXECUTE format(...), so the
-- scan SQL is a string the migration replay only compiles as text, never runs. A
-- typo inside it (a wrong column, a bad cast) would pass the SQL suite's replay and
-- fail only when the cron finds a real strand, which is the one path nothing else
-- exercises (#1161). This runs the function against seeded strands so the dynamic
-- SQL is actually executed, and asserts both that the recovery still works and that
-- the lookback bound still excludes an old strand.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. It seeds rows dated
-- relative to now() (the drain's lookback is relative), creating whatever monthly
-- partitions those dates need. No real identity.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS strand_drain_cases (name text PRIMARY KEY);
DELETE FROM strand_drain_cases;

-- Create the monthly partitions the relative dates below fall in (canonical names,
-- skipped if a migration already made them).
DO $do$
DECLARE
  anchors timestamptz[] := ARRAY[now(), now() - interval '1 day', now() - interval '30 days', now() - interval '31 days', now() - interval '60 days'];
  a       timestamptz;
  parent  text;
  from_d  date;
  to_d    date;
  nm      text;
BEGIN
  FOREACH a IN ARRAY anchors LOOP
    from_d := date_trunc('month', a)::date;
    to_d   := (date_trunc('month', a) + interval '1 month')::date;
    FOREACH parent IN ARRAY ARRAY['workflow_executions', 'lead_sightings', 'lead_sighting_bids'] LOOP
      nm := parent || '_' || to_char(a, 'YYYY_MM');
      EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)', nm, parent, from_d, to_d);
    END LOOP;
  END LOOP;

  INSERT INTO public.organizations (id, name, slug)
  VALUES ('11111111-1111-1111-1111-111111111722', 'Strand Drain Org', 'strand-drain-org') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.workflows (id, organization_id, name)
  VALUES ('44444444-4444-4444-4444-444444441722', '11111111-1111-1111-1111-111111111722', 'Strand Drain Flow') ON CONFLICT (id) DO NOTHING;
END
$do$;

-- Three executions. Two recent (inside the 8-day lookback), one old (outside it).
INSERT INTO public.workflow_executions (id, workflow_id, status, started_at, completed_at, outcome, duration_ms, sighting_finalize)
VALUES
  -- rich: a full finalize payload the drain reads back, plus one bid attempt.
  ('e1722000-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444441722', 'completed', now() - interval '1 day', now() - interval '1 day', 'bid_won', 1234,
   jsonb_build_object(
     'outcome', 'bid_won', 'terminal_node_id', 'node-9', 'terminal_node_label', 'Respond with offer',
     'response_status_code', 200, 'prospect_id', 'PRO-1722', 'equifax_status', 'ok', 'equifax_score', 712,
     'winning_partner_slug', 'tripoint', 'winning_bid_cents', 12345, 'quoted_rate_cents', 999,
     'external_debt', 50000, 'partners_attempted', 2, 'partners_responded', 1, 'reject_reason', NULL,
     'bid_attempts', jsonb_build_array(
       jsonb_build_object('partner_slug', 'tripoint', 'http_status', 200, 'bid_cents', 12345, 'classification', 'accepted', 'resolver_type', 'code')
     )
   )),
  -- reduced: no finalize payload, so the drain falls back to the reduced path.
  ('e1722000-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444441722', 'completed', now() - interval '2 days', now() - interval '2 days', 'no_winner', 2345, NULL),
  -- old: inside the function only if the lookback bound were wrong.
  ('e1722000-0000-0000-0000-000000000003', '44444444-4444-4444-4444-444444441722', 'completed', now() - interval '30 days', now() - interval '30 days', 'bid_won', 3456, NULL);

INSERT INTO public.lead_sightings (id, trace_id, execution_id, workflow_id, execution_started_at_et, execution_started_at_utc, outcome_state)
VALUES
  ('a1722000-0000-0000-0000-000000000001', 'strand:rich',    'e1722000-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444441722', now() - interval '1 day',  (now() - interval '1 day')  AT TIME ZONE 'UTC', 'in_flight'),
  ('a1722000-0000-0000-0000-000000000002', 'strand:reduced', 'e1722000-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444441722', now() - interval '2 days', (now() - interval '2 days') AT TIME ZONE 'UTC', 'in_flight'),
  ('a1722000-0000-0000-0000-000000000003', 'strand:old',     'e1722000-0000-0000-0000-000000000003', '44444444-4444-4444-4444-444444441722', now() - interval '30 days', (now() - interval '30 days') AT TIME ZONE 'UTC', 'in_flight');

-- Run the drain. Capture its return (count of sightings finalized in the first UPDATE).
DO $do$
DECLARE
  finalized int;
BEGIN
  finalized := public.reduce_finalize_stranded(8);
  IF finalized IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'expected 2 recent strands finalized, got %', finalized;
  END IF;
  INSERT INTO strand_drain_cases(name) VALUES ('returns the count of recent strands finalized');
END
$do$;

-- ── 1. The rich strand is finalized from its payload ─────────────────────────
DO $do$
DECLARE s public.lead_sightings;
BEGIN
  SELECT * INTO s FROM public.lead_sightings WHERE trace_id = 'strand:rich';
  IF s.outcome_state IS DISTINCT FROM 'finalized'      THEN RAISE EXCEPTION 'rich strand not finalized: %', s.outcome_state; END IF;
  IF s.recovered_by IS DISTINCT FROM 'rich'            THEN RAISE EXCEPTION 'rich strand recovered_by = %', s.recovered_by; END IF;
  IF s.winning_partner_slug IS DISTINCT FROM 'tripoint' THEN RAISE EXCEPTION 'winning_partner_slug = %', s.winning_partner_slug; END IF;
  IF s.winning_bid_cents IS DISTINCT FROM 12345        THEN RAISE EXCEPTION 'winning_bid_cents = %', s.winning_bid_cents; END IF;
  IF s.quoted_rate_cents IS DISTINCT FROM 999          THEN RAISE EXCEPTION 'quoted_rate_cents = %', s.quoted_rate_cents; END IF;
  IF s.external_debt IS DISTINCT FROM 50000            THEN RAISE EXCEPTION 'external_debt = %', s.external_debt; END IF;
  IF s.equifax_score IS DISTINCT FROM 712              THEN RAISE EXCEPTION 'equifax_score = %', s.equifax_score; END IF;
  IF s.partners_attempted IS DISTINCT FROM 2           THEN RAISE EXCEPTION 'partners_attempted = %', s.partners_attempted; END IF;
  INSERT INTO strand_drain_cases(name) VALUES ('rich strand finalized from its payload');
END
$do$;

-- ── 2. The lost per-attempt bid row is re-inserted and marked winner ─────────
DO $do$
DECLARE b public.lead_sighting_bids;
BEGIN
  SELECT * INTO b FROM public.lead_sighting_bids WHERE trace_id = 'strand:rich' AND partner_slug = 'tripoint';
  IF b IS NULL                 THEN RAISE EXCEPTION 'the rich strand bid attempt was not re-inserted'; END IF;
  IF b.is_winner IS NOT TRUE   THEN RAISE EXCEPTION 'the re-inserted bid was not marked winner'; END IF;
  IF b.bid_cents IS DISTINCT FROM 12345      THEN RAISE EXCEPTION 'bid_cents = %', b.bid_cents; END IF;
  IF b.classification IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'classification = %', b.classification; END IF;
  INSERT INTO strand_drain_cases(name) VALUES ('lost bid attempt re-inserted as winner');
END
$do$;

-- ── 3. A strand with no finalize payload takes the reduced path ──────────────
DO $do$
DECLARE s public.lead_sightings;
BEGIN
  SELECT * INTO s FROM public.lead_sightings WHERE trace_id = 'strand:reduced';
  IF s.outcome_state IS DISTINCT FROM 'finalized'        THEN RAISE EXCEPTION 'reduced strand not finalized: %', s.outcome_state; END IF;
  IF s.recovered_by IS DISTINCT FROM 'reduced'           THEN RAISE EXCEPTION 'reduced strand recovered_by = %', s.recovered_by; END IF;
  IF s.reject_reason IS DISTINCT FROM 'reduced_finalize' THEN RAISE EXCEPTION 'reduced strand reject_reason = %', s.reject_reason; END IF;
  IF s.outcome IS DISTINCT FROM 'no_winner'              THEN RAISE EXCEPTION 'reduced strand outcome = %', s.outcome; END IF;
  INSERT INTO strand_drain_cases(name) VALUES ('reduced strand finalized without a payload');
END
$do$;

-- ── 4. A strand older than the lookback is left alone ────────────────────────
DO $do$
DECLARE s public.lead_sightings;
BEGIN
  SELECT * INTO s FROM public.lead_sightings WHERE trace_id = 'strand:old';
  IF s.outcome_state IS DISTINCT FROM 'in_flight' THEN
    RAISE EXCEPTION 'a strand older than the 8-day lookback was finalized: %', s.outcome_state;
  END IF;
  INSERT INTO strand_drain_cases(name) VALUES ('strand older than the lookback is excluded');
END
$do$;

-- Clean up the seeded rows (leave the partitions; they may be shared).
DELETE FROM public.lead_sighting_bids WHERE trace_id IN ('strand:rich', 'strand:reduced', 'strand:old');
DELETE FROM public.lead_sightings     WHERE trace_id IN ('strand:rich', 'strand:reduced', 'strand:old');
DELETE FROM public.workflow_executions WHERE id IN (
  'e1722000-0000-0000-0000-000000000001', 'e1722000-0000-0000-0000-000000000002', 'e1722000-0000-0000-0000-000000000003');

DO $do$
DECLARE n int := (SELECT count(*) FROM strand_drain_cases);
BEGIN
  IF n IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'reduce_finalize_stranded.test.sql: % cases passed', n;
END
$do$;
