-- Behavioural tests for the incident record of #2100 (alert_incidents and its
-- transition functions).
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production. The concurrency
-- case opens two extra connections to that same container through dblink, which
-- this file creates and drops itself; no migration depends on it.
--
-- WHAT IT PROVES.
--   A. Two opens of one incident make one row, including two that race.
--   B. A page counts once per event, however often the drain applies it, and a
--      page for an incident whose opening was lost creates it.
--   C. An end with no open row inserts the row already closed, keeping the
--      start and end it carried; an end applied twice changes nothing; an end
--      arriving after the row lapsed replaces the lapse with the real end.
--   D. A start moved earlier within one incident moves the row's start, with
--      least(), rather than opening a second incident, and a page or an end
--      still carrying the old start finds the moved row.
--   E. Scope: an org row must carry its organization, a platform row none.
--   F. Lapse: a marker absent on two drains at least four minutes apart closes
--      the row as lapsed with no end time; one present in between resets it.
--   G. The browser roles reach neither the table nor any function.
--   H. Retention removes rows the record closed over 90 days ago (a long
--      incident that lapsed recently is kept), never an open one, and is
--      scheduled in pg_cron.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom.

CREATE TEMP TABLE IF NOT EXISTS ai_cases (name text PRIMARY KEY);
DELETE FROM ai_cases;

DO $do$
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-4111-8111-111111112100', 'AI Org', 'ai-org-2100') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.alert_incidents WHERE subject LIKE 'ai-test-%';
END
$do$;

-- ── A. Two opens make one row ────────────────────────────────────────────────
DO $do$
DECLARE
  a uuid;
  b uuid;
BEGIN
  a := public.record_alert_incident_opened('volume-cliff', 'ai-test-a', 'Main Flow', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', NULL, 4);
  b := public.record_alert_incident_opened('volume-cliff', 'ai-test-a', 'Main Flow', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', NULL, 4);
  IF a IS NULL OR a <> b THEN RAISE EXCEPTION 'two opens of one incident returned % and %', a, b; END IF;
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject = 'ai-test-a') <> 1 THEN RAISE EXCEPTION 'two opens made more than one row'; END IF;
  IF (SELECT ended_reason FROM public.alert_incidents WHERE id = a) IS NOT NULL THEN RAISE EXCEPTION 'an opened incident is not open'; END IF;
  INSERT INTO ai_cases VALUES ('two opens of one incident make one row');
END
$do$;

-- Created here only when absent, and dropped at the end only if this file created
-- it, so a database that already had dblink keeps it.
SELECT NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') AS ai_created_dblink \gset
CREATE EXTENSION IF NOT EXISTS dblink;

-- run.sh hands over the container's own address (self_host): dblink lets a non
-- superuser connect only with a password the server actually asked for, and the
-- loopback is trust. Run by hand, pass it: psql -v self_host=<container ip>.
\if :{?self_host}
\else
  \echo 'alert_incidents.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('ai_test.self_host', :'self_host', false) AS self_host_set \gset

DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('ai_test.self_host'));
  call text := $q$SELECT public.record_alert_incident_opened('volume-cliff', 'ai-test-race', 'Main Flow', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', NULL, 4)::text$q$;
  second text;
BEGIN
  PERFORM dblink_connect('ai_a', conn);
  PERFORM dblink_connect('ai_b', conn);
  -- The first holds its insert uncommitted while the second arrives, so the second
  -- meets the conflict mid flight rather than after the fact.
  PERFORM dblink_exec('ai_a', 'BEGIN');
  PERFORM * FROM dblink('ai_a', call) AS t(id text);
  PERFORM dblink_send_query('ai_b', call);
  PERFORM pg_sleep(0.3);
  PERFORM dblink_exec('ai_a', 'COMMIT');
  SELECT id INTO second FROM dblink_get_result('ai_b') AS t(id text);
  PERFORM dblink_disconnect('ai_a');
  PERFORM dblink_disconnect('ai_b');
  IF second IS NULL THEN RAISE EXCEPTION 'the racing open returned no row'; END IF;
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject = 'ai-test-race') <> 1 THEN
    RAISE EXCEPTION 'two racing opens made % rows', (SELECT count(*) FROM public.alert_incidents WHERE subject = 'ai-test-race');
  END IF;
  INSERT INTO ai_cases VALUES ('two racing opens make one row');
END
$do$;

\if :ai_created_dblink
DROP EXTENSION IF EXISTS dblink;
\endif

-- ── B. Pages ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  id1 uuid;
  id2 uuid;
BEGIN
  id1 := public.record_alert_incident_paged('volume-cliff', 'ai-test-a', 'Main Flow', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', '2026-10-14T10:01:00Z', 'event-1', 4);
  PERFORM public.record_alert_incident_paged('volume-cliff', 'ai-test-a', 'Main Flow', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', '2026-10-14T10:01:00Z', 'event-1', 4);
  PERFORM public.record_alert_incident_paged('volume-cliff', 'ai-test-a', 'Main Flow', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', '2026-10-14T10:31:00Z', 'event-2', 4);
  IF (SELECT pages_sent FROM public.alert_incidents WHERE id = id1) <> 2 THEN
    RAISE EXCEPTION 'two pages, one applied twice, counted %', (SELECT pages_sent FROM public.alert_incidents WHERE id = id1);
  END IF;
  IF (SELECT last_seen_at FROM public.alert_incidents WHERE id = id1) <> '2026-10-14T10:31:00Z' THEN RAISE EXCEPTION 'a page did not move the last sighting'; END IF;
  -- An incident whose opening was lost is created by its page.
  id2 := public.record_alert_incident_paged('pg-cron-watch', 'ai-test-lost-open', 'job', 'platform', NULL, '2026-10-14T09:00:00Z', '2026-10-14T09:05:00Z', 'event-3', NULL);
  IF id2 IS NULL OR (SELECT pages_sent FROM public.alert_incidents WHERE id = id2) <> 1 OR (SELECT ended_reason FROM public.alert_incidents WHERE id = id2) IS NOT NULL THEN
    RAISE EXCEPTION 'a page for an unrecorded incident did not create it open with one page';
  END IF;
  INSERT INTO ai_cases VALUES ('a page counts once per event and creates a missing incident');
END
$do$;

-- ── C. Ends ──────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  closed uuid;
  again uuid;
  r public.alert_incidents;
BEGIN
  -- No open row: the end inserts it already closed, with the start and end it carried.
  closed := public.record_alert_incident_ended('supabase-memory', 'ai-test-no-open', 'The database', 'platform', NULL, '2026-10-14T08:00:00Z', '2026-10-14T08:40:00Z', 'all_clear', NULL, NULL);
  SELECT * INTO r FROM public.alert_incidents WHERE id = closed;
  IF r.started_at <> '2026-10-14T08:00:00Z' OR r.ended_at <> '2026-10-14T08:40:00Z' OR r.ended_reason <> 'all_clear' THEN
    RAISE EXCEPTION 'a close with no open row did not insert a closed row carrying its times: %', row_to_json(r);
  END IF;
  -- Applied twice: lands, and changes nothing.
  again := public.record_alert_incident_ended('supabase-memory', 'ai-test-no-open', 'The database', 'platform', NULL, '2026-10-14T08:00:00Z', '2026-10-14T09:59:00Z', 'all_clear', NULL, NULL);
  IF again IS DISTINCT FROM closed OR (SELECT ended_at FROM public.alert_incidents WHERE id = closed) <> '2026-10-14T08:40:00Z' THEN
    RAISE EXCEPTION 'an end applied twice did not land idempotently';
  END IF;
  -- The open row from A closes.
  PERFORM public.record_alert_incident_ended('volume-cliff', 'ai-test-a', 'Main Flow', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z', 'all_clear', NULL, 4);
  IF (SELECT ended_reason FROM public.alert_incidents WHERE subject = 'ai-test-a') <> 'all_clear' THEN RAISE EXCEPTION 'an open row did not close'; END IF;
  -- A hand over must name its successor.
  PERFORM public.record_alert_incident_ended('field-presence-dead', 'ai-test-handed', 'wf f', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T07:00:00Z', NULL, 'handed_over', 'field-presence-wrong-path', 10080);
  IF (SELECT successor_signal FROM public.alert_incidents WHERE subject = 'ai-test-handed') <> 'field-presence-wrong-path' THEN RAISE EXCEPTION 'the successor was not kept'; END IF;
  BEGIN
    PERFORM public.record_alert_incident_ended('field-presence-dead', 'ai-test-handed-2', 'wf f', 'org', '11111111-1111-4111-8111-111111112100', '2026-10-14T07:00:00Z', NULL, 'handed_over', NULL, 10080);
    RAISE EXCEPTION 'a hand over without a successor was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO ai_cases VALUES ('an end with no open row inserts it closed, and an end is idempotent');
END
$do$;

-- ── D. A start moved earlier ─────────────────────────────────────────────────
DO $do$
DECLARE
  first uuid;
  moved uuid;
BEGIN
  first := public.record_alert_incident_opened('partner-reachability', 'ai-test-move', 'host', 'platform', NULL, '2026-10-14T10:00:00Z', NULL, NULL);
  moved := public.record_alert_incident_opened('partner-reachability', 'ai-test-move', 'host', 'platform', NULL, '2026-10-14T09:30:00Z', '2026-10-14T10:00:00Z', NULL);
  IF moved IS DISTINCT FROM first THEN RAISE EXCEPTION 'a moved start opened a second incident'; END IF;
  IF (SELECT started_at FROM public.alert_incidents WHERE id = first) <> '2026-10-14T09:30:00Z' THEN RAISE EXCEPTION 'the start did not move earlier'; END IF;
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject = 'ai-test-move') <> 1 THEN RAISE EXCEPTION 'a moved start made two rows'; END IF;
  -- A later "previous" never moves it later: least() keeps the earlier start.
  PERFORM public.record_alert_incident_opened('partner-reachability', 'ai-test-move', 'host', 'platform', NULL, '2026-10-14T09:45:00Z', '2026-10-14T09:30:00Z', NULL);
  IF (SELECT min(started_at) FROM public.alert_incidents WHERE subject = 'ai-test-move') <> '2026-10-14T09:30:00Z' THEN RAISE EXCEPTION 'a start moved later'; END IF;
  -- Events written before the move, drained after it, still carry the old start.
  IF public.record_alert_incident_paged('partner-reachability', 'ai-test-move', 'host', 'platform', NULL, '2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', 'event-move', NULL) IS DISTINCT FROM first THEN
    RAISE EXCEPTION 'a page carrying the old start did not find the moved row';
  END IF;
  IF public.record_alert_incident_opened('partner-reachability', 'ai-test-move', 'host', 'platform', NULL, '2026-10-14T10:00:00Z', NULL, NULL) IS DISTINCT FROM first THEN
    RAISE EXCEPTION 'an opening carrying the old start did not find the moved row';
  END IF;
  IF public.record_alert_incident_ended('partner-reachability', 'ai-test-move', 'host', 'platform', NULL, '2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z', 'all_clear', NULL, NULL) IS DISTINCT FROM first THEN
    RAISE EXCEPTION 'an end carrying the old start did not find the moved row';
  END IF;
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject = 'ai-test-move') <> 1 THEN RAISE EXCEPTION 'late events under the old start made a second row'; END IF;
  IF (SELECT pages_sent FROM public.alert_incidents WHERE id = first) <> 1 OR (SELECT ended_reason FROM public.alert_incidents WHERE id = first) <> 'all_clear' THEN
    RAISE EXCEPTION 'late events under the old start were not applied to the moved row';
  END IF;
  -- A move whose new start already has a row (an event carrying it landed first)
  -- folds the old row into it: one incident, its pages counted once.
  PERFORM public.record_alert_incident_paged('partner-reachability', 'ai-test-merge', 'host', 'platform', NULL, '2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', 'm-1', NULL);
  PERFORM public.record_alert_incident_paged('partner-reachability', 'ai-test-merge', 'host', 'platform', NULL, '2026-10-14T09:00:00Z', '2026-10-14T10:10:00Z', 'm-2', NULL);
  PERFORM public.record_alert_incident_opened('partner-reachability', 'ai-test-merge', 'host', 'platform', NULL, '2026-10-14T09:00:00Z', '2026-10-14T10:00:00Z', NULL);
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject = 'ai-test-merge') <> 1 THEN RAISE EXCEPTION 'a move onto an existing start left two rows for one incident'; END IF;
  IF (SELECT pages_sent FROM public.alert_incidents WHERE subject = 'ai-test-merge') <> 2 OR (SELECT started_at FROM public.alert_incidents WHERE subject = 'ai-test-merge') <> '2026-10-14T09:00:00Z' THEN
    RAISE EXCEPTION 'a merged incident lost a page or its start';
  END IF;
  IF public.record_alert_incident_paged('partner-reachability', 'ai-test-merge', 'host', 'platform', NULL, '2026-10-14T10:00:00Z', '2026-10-14T10:05:00Z', 'm-1', NULL) IS NULL
     OR (SELECT pages_sent FROM public.alert_incidents WHERE subject = 'ai-test-merge') <> 2 THEN
    RAISE EXCEPTION 'a page already counted under the old start was counted again after the merge';
  END IF;
  INSERT INTO ai_cases VALUES ('a start moved earlier moves the row, never later, and late events still find it');
END
$do$;

-- ── E. Scope ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  refused boolean;
BEGIN
  refused := false;
  BEGIN
    PERFORM public.record_alert_incident_opened('volume-cliff', 'ai-test-scope', NULL, 'org', NULL, '2026-10-14T10:00:00Z', NULL, 4);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'an org incident without an organization was accepted'; END IF;
  refused := false;
  BEGIN
    PERFORM public.record_alert_incident_opened('pg-cron-watch', 'ai-test-scope', NULL, 'platform', '11111111-1111-4111-8111-111111112100', '2026-10-14T10:00:00Z', NULL, NULL);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a platform incident carrying an organization was accepted'; END IF;
  refused := false;
  BEGIN
    PERFORM public.record_alert_incident_opened('pg-cron-watch', 'ai-test-scope', NULL, 'everyone', NULL, '2026-10-14T10:00:00Z', NULL, NULL);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'an unknown scope was accepted'; END IF;
  INSERT INTO ai_cases VALUES ('an org row carries its organization and a platform row none');
END
$do$;

-- ── F. Lapse ─────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  id1 uuid;
  verdict text;
  r public.alert_incidents;
BEGIN
  id1 := public.record_alert_incident_opened('workflow-schedule', 'ai-test-lapse', 'Deploy Drift', 'platform', NULL, '2026-10-12T10:00:00Z', NULL, NULL);
  verdict := public.record_alert_incident_marker_check(id1, false, '2026-10-14T12:00:00Z');
  IF verdict <> 'suspect' THEN RAISE EXCEPTION 'one absent marker gave %, expected suspect', verdict; END IF;
  -- A drain run again a minute later is not a second drain.
  verdict := public.record_alert_incident_marker_check(id1, false, '2026-10-14T12:01:00Z');
  IF verdict <> 'suspect' THEN RAISE EXCEPTION 'a rerun a minute later gave %, expected suspect', verdict; END IF;
  -- Present in between resets the count.
  verdict := public.record_alert_incident_marker_check(id1, true, '2026-10-14T12:05:00Z');
  IF verdict <> 'open' THEN RAISE EXCEPTION 'a present marker gave %', verdict; END IF;
  verdict := public.record_alert_incident_marker_check(id1, false, '2026-10-14T12:10:00Z');
  IF verdict <> 'suspect' THEN RAISE EXCEPTION 'absence after a reset gave %, expected suspect', verdict; END IF;
  verdict := public.record_alert_incident_marker_check(id1, false, '2026-10-14T12:15:00Z');
  IF verdict <> 'lapsed' THEN RAISE EXCEPTION 'two consecutive absent markers gave %, expected lapsed', verdict; END IF;
  SELECT * INTO r FROM public.alert_incidents WHERE id = id1;
  IF r.ended_reason <> 'lapsed' OR r.ended_at IS NOT NULL THEN RAISE EXCEPTION 'a lapse invented an end: %', row_to_json(r); END IF;
  IF r.closed_at IS NULL THEN RAISE EXCEPTION 'a lapse did not record when the row closed, so retention could not judge it'; END IF;
  IF public.record_alert_incident_marker_check(id1, false, '2026-10-14T12:20:00Z') <> 'closed' THEN RAISE EXCEPTION 'a closed row was judged again'; END IF;
  -- The real end, drained late, replaces the lapse.
  PERFORM public.record_alert_incident_ended('workflow-schedule', 'ai-test-lapse', 'Deploy Drift', 'platform', NULL, '2026-10-12T10:00:00Z', '2026-10-13T09:00:00Z', 'all_clear', NULL, NULL);
  SELECT * INTO r FROM public.alert_incidents WHERE id = id1;
  IF r.ended_reason <> 'all_clear' OR r.ended_at <> '2026-10-13T09:00:00Z' THEN RAISE EXCEPTION 'a late end did not replace the lapse'; END IF;
  -- A lapsed row may never carry an end time.
  BEGIN
    UPDATE public.alert_incidents SET ended_reason = 'lapsed', ended_at = now() WHERE id = id1;
    RAISE EXCEPTION 'a lapsed row with an end time was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO ai_cases VALUES ('two consecutive absent markers lapse a row with no end time');
END
$do$;

-- ── G. The browser roles reach nothing ───────────────────────────────────────
DO $do$
DECLARE
  r text;
  f text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.alert_incidents', 'SELECT')
       OR has_table_privilege(r, 'public.alert_incidents', 'INSERT')
       OR has_table_privilege(r, 'public.alert_incidents', 'UPDATE')
       OR has_table_privilege(r, 'public.alert_incidents', 'DELETE') THEN
      RAISE EXCEPTION '% can reach alert_incidents', r;
    END IF;
    FOREACH f IN ARRAY ARRAY[
      'public.record_alert_incident_opened(text, text, text, text, uuid, timestamptz, timestamptz, integer)',
      'public.record_alert_incident_paged(text, text, text, text, uuid, timestamptz, timestamptz, text, integer)',
      'public.record_alert_incident_ended(text, text, text, text, uuid, timestamptz, timestamptz, text, text, integer)',
      'public.record_alert_incident_marker_check(uuid, boolean, timestamptz)',
      'public.purge_alert_incidents()',
      'public.alert_incident_moved_from(text, text, timestamptz)'
    ] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN RAISE EXCEPTION '% can run %', r, f; END IF;
    END LOOP;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.alert_incidents'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on alert_incidents';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.record_alert_incident_opened(text, text, text, text, uuid, timestamptz, timestamptz, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the worker''s role cannot record an opening';
  END IF;
  INSERT INTO ai_cases VALUES ('anon and authenticated can neither read nor write the record');
END
$do$;

-- ── H. Retention ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  removed int;
BEGIN
  DELETE FROM public.alert_incidents WHERE subject LIKE 'ai-test-%';
  INSERT INTO public.alert_incidents (signal, subject, scope, started_at, last_seen_at, ended_at, ended_reason, closed_at) VALUES
    ('pg-cron-watch', 'ai-test-old-ended', 'platform', now() - interval '100 days', now() - interval '91 days', now() - interval '91 days', 'all_clear', now() - interval '91 days'),
    ('pg-cron-watch', 'ai-test-recent-ended', 'platform', now() - interval '100 days', now() - interval '89 days', now() - interval '89 days', 'all_clear', now() - interval '89 days'),
    ('pg-cron-watch', 'ai-test-old-lapsed', 'platform', now() - interval '93 days', now() - interval '93 days', NULL, 'lapsed', now() - interval '91 days'),
    -- Open for 120 days, lapsed yesterday: kept, since retention counts from when it closed.
    ('pg-cron-watch', 'ai-test-long-lapsed', 'platform', now() - interval '120 days', now() - interval '3 days', NULL, 'lapsed', now() - interval '1 day'),
    ('pg-cron-watch', 'ai-test-old-open', 'platform', now() - interval '200 days', now() - interval '200 days', NULL, NULL, NULL);
  removed := public.purge_alert_incidents();
  IF removed <> 2 THEN RAISE EXCEPTION 'purge removed % rows, expected 2', removed; END IF;
  IF EXISTS (SELECT 1 FROM public.alert_incidents WHERE subject IN ('ai-test-old-ended', 'ai-test-old-lapsed')) THEN RAISE EXCEPTION 'a row past 90 days survived'; END IF;
  IF (SELECT count(*) FROM public.alert_incidents WHERE subject IN ('ai-test-recent-ended', 'ai-test-long-lapsed', 'ai-test-old-open')) <> 3 THEN
    RAISE EXCEPTION 'the purge removed a recent, a recently lapsed or an open row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-alert-incidents' AND command LIKE '%purge_alert_incidents()%') THEN
    RAISE EXCEPTION 'the retention purge is not scheduled';
  END IF;
  INSERT INTO ai_cases VALUES ('retention removes only rows ended over 90 days ago');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.alert_incidents WHERE subject LIKE 'ai-test-%';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM ai_cases);
BEGIN
  IF n <> 9 THEN RAISE EXCEPTION 'expected 9 cases, % ran', n; END IF;
  RAISE NOTICE 'alert_incidents.test.sql: % cases passed', n;
END
$do$;
