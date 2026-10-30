-- Behavioural tests for a page that did not reach Slack (#3056):
-- record_alert_incident_undelivered and the columns it writes.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production.
--
-- WHAT IT PROVES.
--   A. A refused page about an open incident counts once per event against
--      that incident, however often the drain applies it, and leaves it open.
--   B. A refused page with no incident open (nobody was ever told) keeps the
--      incident that was due as a row closed as unannounced, its end the latest
--      refused page, counted once per event; a page for it arriving first
--      creates it, as every transition may arrive first.
--   C. It finds an incident whose start was moved, like a page does.
--   D. An event with no id is refused, so a drain run twice cannot count it twice.
--   E. The browser roles cannot call it; the worker's role can.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS aiu_cases (name text PRIMARY KEY);
DELETE FROM aiu_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-4111-8111-111111113056', 'AIU Org', 'aiu-org-3056') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.alert_incidents WHERE subject LIKE 'aiu-test-%';
END
$do$;

-- ── A. Against an open incident ──────────────────────────────────────────────
DO $do$
DECLARE
  opened uuid;
  a uuid;
  b uuid;
  r public.alert_incidents%ROWTYPE;
BEGIN
  opened := public.record_alert_incident_opened('lead-validation-rejection-rate', 'aiu-test-open', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', NULL, 120);
  a := public.record_alert_incident_undelivered('lead-validation-rejection-rate', 'aiu-test-open', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T16:00:00Z', 'ev-1', false, 120);
  b := public.record_alert_incident_undelivered('lead-validation-rejection-rate', 'aiu-test-open', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T16:00:00Z', 'ev-1', false, 120);
  PERFORM public.record_alert_incident_undelivered('lead-validation-rejection-rate', 'aiu-test-open', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T17:00:00Z', 'ev-2', false, 120);
  IF a IS DISTINCT FROM opened OR b IS DISTINCT FROM opened THEN RAISE EXCEPTION 'a refused page did not land on its open incident: % % %', opened, a, b; END IF;
  SELECT * INTO r FROM public.alert_incidents WHERE id = opened;
  IF r.pages_undelivered <> 2 THEN RAISE EXCEPTION 'expected 2 undelivered pages, got %', r.pages_undelivered; END IF;
  IF r.pages_sent <> 0 THEN RAISE EXCEPTION 'a refused page counted as sent'; END IF;
  IF r.ended_reason IS NOT NULL THEN RAISE EXCEPTION 'a refused page closed an open incident as %', r.ended_reason; END IF;
  IF r.last_seen_at <> '2026-10-23T17:00:00Z'::timestamptz THEN RAISE EXCEPTION 'last seen is %, not the latest refused page', r.last_seen_at; END IF;
  INSERT INTO aiu_cases VALUES ('a refused page counts once against its open incident');
END
$do$;

-- ── B. Nobody was told: the incident that was due, kept closed ───────────────
DO $do$
DECLARE
  a uuid;
  r public.alert_incidents%ROWTYPE;
BEGIN
  a := public.record_alert_incident_undelivered('lead-validation-rejection-rate', 'aiu-test-due', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T15:00:00Z', 'ev-1', true, 120);
  PERFORM public.record_alert_incident_undelivered('lead-validation-rejection-rate', 'aiu-test-due', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T17:00:00Z', 'ev-3', true, 120);
  -- Applied out of order, and one applied twice: neither moves the end back nor counts twice.
  PERFORM public.record_alert_incident_undelivered('lead-validation-rejection-rate', 'aiu-test-due', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T16:00:00Z', 'ev-2', true, 120);
  PERFORM public.record_alert_incident_undelivered('lead-validation-rejection-rate', 'aiu-test-due', 'Lead Economy', 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T16:00:00Z', 'ev-2', true, 120);
  SELECT * INTO r FROM public.alert_incidents WHERE id = a;
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject = 'aiu-test-due') <> 1 THEN RAISE EXCEPTION 'one stretch of refused pages made more than one row'; END IF;
  IF r.ended_reason IS DISTINCT FROM 'unannounced' THEN RAISE EXCEPTION 'the incident nobody was told of is %, not closed as unannounced', coalesce(r.ended_reason, 'open'); END IF;
  IF r.ended_at <> '2026-10-23T17:00:00Z'::timestamptz THEN RAISE EXCEPTION 'its end is %, not the latest refused page', r.ended_at; END IF;
  IF r.closed_at IS NULL THEN RAISE EXCEPTION 'a closed row has no closed_at'; END IF;
  IF r.pages_undelivered <> 3 OR r.pages_sent <> 0 THEN RAISE EXCEPTION 'expected 3 undelivered and 0 sent, got % and %', r.pages_undelivered, r.pages_sent; END IF;
  IF r.started_at <> '2026-10-23T15:00:00Z'::timestamptz THEN RAISE EXCEPTION 'its start moved to %', r.started_at; END IF;
  INSERT INTO aiu_cases VALUES ('a page nobody received keeps the incident that was due, closed as unannounced');
END
$do$;

-- ── C. A moved start ─────────────────────────────────────────────────────────
DO $do$
DECLARE
  opened uuid;
  a uuid;
BEGIN
  opened := public.record_alert_incident_opened('partner-reachability', 'aiu-test-moved', 'api.partner.test', 'platform', NULL, '2026-10-23T15:00:00Z', NULL, NULL);
  PERFORM public.record_alert_incident_opened('partner-reachability', 'aiu-test-moved', 'api.partner.test', 'platform', NULL, '2026-10-23T14:00:00Z', '2026-10-23T15:00:00Z', NULL);
  a := public.record_alert_incident_undelivered('partner-reachability', 'aiu-test-moved', 'api.partner.test', 'platform', NULL, '2026-10-23T15:00:00Z', '2026-10-23T16:00:00Z', 'ev-1', false, NULL);
  IF a IS DISTINCT FROM opened THEN RAISE EXCEPTION 'a refused page carrying the old start did not find the moved row'; END IF;
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject = 'aiu-test-moved') <> 1 THEN RAISE EXCEPTION 'a refused page carrying the old start made a second row'; END IF;
  IF (SELECT pages_undelivered FROM public.alert_incidents WHERE id = opened) <> 1 THEN RAISE EXCEPTION 'the refused page was not counted on the moved row'; END IF;
  INSERT INTO aiu_cases VALUES ('a refused page finds an incident whose start moved');
END
$do$;

-- ── D. No event id ───────────────────────────────────────────────────────────
DO $do$
BEGIN
  BEGIN
    PERFORM public.record_alert_incident_undelivered('volume-cliff', 'aiu-test-noid', NULL, 'org', '11111111-1111-4111-8111-111111113056', '2026-10-23T15:00:00Z', '2026-10-23T15:00:00Z', NULL, true, 4);
    RAISE EXCEPTION 'an undelivered page with no event id was taken';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
  INSERT INTO aiu_cases VALUES ('an undelivered page needs its event id');
END
$do$;

-- ── E. Who may call it ───────────────────────────────────────────────────────
DO $do$
DECLARE
  sig text := 'public.record_alert_incident_undelivered(text, text, text, text, uuid, timestamptz, timestamptz, text, boolean, integer)';
BEGIN
  IF has_function_privilege('anon', sig, 'EXECUTE') OR has_function_privilege('authenticated', sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can record an undelivered page';
  END IF;
  IF NOT has_function_privilege('service_role', sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'the worker''s role cannot record an undelivered page';
  END IF;
  INSERT INTO aiu_cases VALUES ('only the worker records an undelivered page');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.alert_incidents WHERE subject LIKE 'aiu-test-%';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM aiu_cases);
BEGIN
  IF n <> 5 THEN RAISE EXCEPTION 'expected 5 cases, % ran', n; END IF;
  RAISE NOTICE 'alert_incidents_undelivered.test.sql: % cases passed', n;
END
$do$;
