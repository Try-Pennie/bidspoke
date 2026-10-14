-- The incident record (#2100, under #818): one row per alert incident, from the
-- moment its recovery marker appeared to the moment it ended, so "what went wrong
-- this month, for how long, and how often were we paged" has an answer that does
-- not depend on scrolling Slack.
--
-- HOW ROWS ARRIVE. Never from the alert path. Each check writes its incident's
-- transitions (opened, paged, ended) to a KV outbox (apps/worker/src/lib/
-- incident-outbox.ts), because three of the signals happen exactly while this
-- database is failing. A drain on the five minute cron (incident-drain.ts) moves
-- the events here through the functions below, one per transition, and removes
-- each event only once the function returned the row it wrote.
--
-- THE KEY is (signal, subject, started_at), not (signal, subject): a close that
-- was lost must not merge the next incident on the same subject into this one.
-- PostgREST can neither increment a counter nor target a conflict, so every
-- write is a function.
--
-- ORDER. KV cannot promise the drain sees events in the order they were written
-- across isolates, so each function accepts its event in any order: a page or an
-- end for an incident whose opening never arrived creates the row (an end
-- creates it already closed), an opening never reopens a closed row, and a page
-- carries its event id so a drain that runs twice counts it once.
--
-- ENDS. ended_at is the last sighting the all-clear reported, or NULL when none
-- was recorded: "end not recorded" is a normal state (several incidents a month
-- never get an all-clear), and nothing here invents one. ended_reason says why:
-- all_clear, stood_down_by_design, handed_over (naming the successor signal), or
-- lapsed, which the drain sets when the incident's KV marker has been absent on
-- two drains at least four minutes apart. A lapsed row never carries an end
-- time. A real end that arrives after a lapse replaces it.
--
-- SCOPE. Every row is either an organization's (org, with organization_id) or
-- the platform's (platform, with none), never a third thing, so a missing
-- organization can never read as visible to everyone. The worker reads this
-- table as service_role and scopes in the route; the browser roles are revoked
-- outright (L124).
--
-- MOVED STARTS. keepAlerted can move an incident's start earlier (a caller
-- holding an earlier first sighting). The row's start moves with it, and the
-- start it replaced is kept in previous_starts, so a page or an end written
-- before the move but drained after it still finds this row rather than
-- inserting a second incident under the old start.
--
-- RETENTION. A daily pg_cron job deletes rows closed over 90 days ago, judged by
-- closed_at, when the record learned the row was closed (an end, or a lapse),
-- never by its start: an incident open for months that lapses yesterday is kept
-- its full 90 days. closed_at is bookkeeping, not an end time; ended_at stays
-- NULL for a lapse. An open row is never deleted.
-- The pg_cron watch reads cron.job and covers the job without registration.
--
-- Expand/contract (ADR 0007): additive. A new table, six functions and a cron
-- job; nothing the deployed worker reads changes. The deployed worker writes no
-- outbox events until the code in the same pull request ships, and the drain
-- reads nothing until then either.
--
-- Guarded by supabase/tests/alert_incidents.test.sql.

CREATE TABLE IF NOT EXISTS public.alert_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal            text NOT NULL,
  subject           text NOT NULL,
  subject_label     text,
  scope             text NOT NULL,
  organization_id   uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  started_at        timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  ended_at          timestamptz,
  ended_reason      text,
  successor_signal  text,
  pages_sent        integer NOT NULL DEFAULT 0,
  paged_event_ids   text[] NOT NULL DEFAULT '{}',
  window_minutes    integer,
  failed_runs       integer,
  marker_missing_at timestamptz,
  previous_starts   timestamptz[] NOT NULL DEFAULT '{}',
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_incidents_key UNIQUE (signal, subject, started_at),
  CONSTRAINT alert_incidents_scope_check CHECK (scope IN ('org', 'platform')),
  CONSTRAINT alert_incidents_scope_org_check CHECK ((scope = 'org') = (organization_id IS NOT NULL)),
  CONSTRAINT alert_incidents_reason_check CHECK (ended_reason IS NULL OR ended_reason IN ('all_clear', 'stood_down_by_design', 'handed_over', 'lapsed')),
  CONSTRAINT alert_incidents_end_needs_reason CHECK (ended_at IS NULL OR ended_reason IS NOT NULL),
  CONSTRAINT alert_incidents_lapse_has_no_end CHECK (ended_reason IS DISTINCT FROM 'lapsed' OR ended_at IS NULL),
  CONSTRAINT alert_incidents_successor_check CHECK ((ended_reason IS NOT DISTINCT FROM 'handed_over') = (successor_signal IS NOT NULL)),
  CONSTRAINT alert_incidents_pages_check CHECK (pages_sent >= 0),
  CONSTRAINT alert_incidents_closed_check CHECK ((ended_reason IS NULL) = (closed_at IS NULL))
);

COMMENT ON TABLE public.alert_incidents IS
  'One row per alert incident (#2100, #818), written only by the incident drain from the KV outbox. Service role only; rows ended over 90 days ago are purged daily.';
COMMENT ON COLUMN public.alert_incidents.subject IS
  'The recovery id the check keys its markers on (a workflow id, a host, a job name). subject_label is how a reader knows it.';
COMMENT ON COLUMN public.alert_incidents.ended_at IS
  'The last sighting the all-clear reported. NULL means the end was not recorded; it is never guessed.';
COMMENT ON COLUMN public.alert_incidents.paged_event_ids IS
  'The outbox event ids already counted in pages_sent, so a page applied twice counts once.';
COMMENT ON COLUMN public.alert_incidents.failed_runs IS
  'failure-rate only: the matching failed runs. Not yet written (#2099 phase 4).';
COMMENT ON COLUMN public.alert_incidents.previous_starts IS
  'Starts this incident had before keepAlerted moved its start earlier, so late events carrying one still find this row.';
COMMENT ON COLUMN public.alert_incidents.closed_at IS
  'When the record learned the incident closed (ended or lapsed). Retention keys on it. Not an end time.';
COMMENT ON COLUMN public.alert_incidents.marker_missing_at IS
  'When a drain first found the incident''s KV marker absent; a second drain at least four minutes later closes it as lapsed.';

CREATE INDEX IF NOT EXISTS alert_incidents_open_idx
  ON public.alert_incidents (signal, subject)
  WHERE ended_reason IS NULL;
CREATE INDEX IF NOT EXISTS alert_incidents_org_started_idx
  ON public.alert_incidents (organization_id, started_at DESC);

ALTER TABLE public.alert_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.alert_incidents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_incidents TO service_role;

-- ------------------------------------------------------------------
-- The row an event belongs to when its start is one the row moved away from
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alert_incident_moved_from(p_signal text, p_subject text, p_started_at timestamptz)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT id FROM alert_incidents
  WHERE signal = p_signal AND subject = p_subject AND p_started_at = ANY (previous_starts)
  ORDER BY started_at
  LIMIT 1
$fn$;

-- ------------------------------------------------------------------
-- opened: the marker appeared, or its start moved earlier
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_alert_incident_opened(
  p_signal text,
  p_subject text,
  p_subject_label text,
  p_scope text,
  p_organization_id uuid,
  p_started_at timestamptz,
  p_previous_started_at timestamptz,
  p_window_minutes integer
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  -- A start moved earlier within one incident (keepAlerted given an earlier first
  -- sighting) moves the row, with least(), rather than opening a second incident.
  -- Skipped when a row already holds the new start, which then simply stands.
  IF p_previous_started_at IS NOT NULL THEN
    UPDATE alert_incidents
    SET started_at = least(started_at, p_started_at),
        previous_starts = CASE WHEN p_started_at < started_at THEN previous_starts || started_at ELSE previous_starts END,
        subject_label = coalesce(p_subject_label, subject_label),
        updated_at = now()
    WHERE signal = p_signal AND subject = p_subject AND started_at = p_previous_started_at
      AND NOT EXISTS (SELECT 1 FROM alert_incidents WHERE signal = p_signal AND subject = p_subject AND started_at = p_started_at)
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  -- An opening that arrives after its start was moved belongs to the moved row.
  v_id := alert_incident_moved_from(p_signal, p_subject, p_started_at);
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO alert_incidents (signal, subject, subject_label, scope, organization_id, started_at, last_seen_at, window_minutes)
  VALUES (p_signal, p_subject, p_subject_label, p_scope, p_organization_id, p_started_at, p_started_at, p_window_minutes)
  ON CONFLICT ON CONSTRAINT alert_incidents_key DO UPDATE
    SET subject_label = coalesce(EXCLUDED.subject_label, alert_incidents.subject_label),
        window_minutes = coalesce(alert_incidents.window_minutes, EXCLUDED.window_minutes),
        updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

-- ------------------------------------------------------------------
-- paged: a page about the incident reached Slack
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_alert_incident_paged(
  p_signal text,
  p_subject text,
  p_subject_label text,
  p_scope text,
  p_organization_id uuid,
  p_started_at timestamptz,
  p_paged_at timestamptz,
  p_event_id text,
  p_window_minutes integer
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_event_id IS NULL OR p_event_id = '' THEN
    RAISE EXCEPTION 'a page needs its event id, or a drain run twice would count it twice' USING ERRCODE = '22023';
  END IF;
  v_id := alert_incident_moved_from(p_signal, p_subject, p_started_at);
  IF v_id IS NOT NULL THEN
    UPDATE alert_incidents
    SET pages_sent = pages_sent + CASE WHEN p_event_id = ANY (paged_event_ids) THEN 0 ELSE 1 END,
        paged_event_ids = CASE WHEN p_event_id = ANY (paged_event_ids) THEN paged_event_ids ELSE paged_event_ids || p_event_id END,
        last_seen_at = greatest(last_seen_at, p_paged_at),
        updated_at = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;
  INSERT INTO alert_incidents (signal, subject, subject_label, scope, organization_id, started_at, last_seen_at, window_minutes, pages_sent, paged_event_ids)
  VALUES (p_signal, p_subject, p_subject_label, p_scope, p_organization_id, p_started_at, greatest(p_started_at, p_paged_at), p_window_minutes, 1, ARRAY[p_event_id])
  ON CONFLICT ON CONSTRAINT alert_incidents_key DO UPDATE
    SET pages_sent = alert_incidents.pages_sent + CASE WHEN p_event_id = ANY (alert_incidents.paged_event_ids) THEN 0 ELSE 1 END,
        paged_event_ids = CASE WHEN p_event_id = ANY (alert_incidents.paged_event_ids) THEN alert_incidents.paged_event_ids
                               ELSE alert_incidents.paged_event_ids || p_event_id END,
        last_seen_at = greatest(alert_incidents.last_seen_at, p_paged_at),
        subject_label = coalesce(EXCLUDED.subject_label, alert_incidents.subject_label),
        window_minutes = coalesce(alert_incidents.window_minutes, EXCLUDED.window_minutes),
        updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

-- ------------------------------------------------------------------
-- ended: settled by an all-clear, a stand down or a hand over
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_alert_incident_ended(
  p_signal text,
  p_subject text,
  p_subject_label text,
  p_scope text,
  p_organization_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_reason text,
  p_successor text,
  p_window_minutes integer
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_id uuid;
  v_moved uuid;
BEGIN
  v_moved := alert_incident_moved_from(p_signal, p_subject, p_started_at);
  IF v_moved IS NOT NULL THEN
    UPDATE alert_incidents
    SET ended_at = p_ended_at,
        ended_reason = p_reason,
        successor_signal = p_successor,
        closed_at = now(),
        last_seen_at = greatest(last_seen_at, coalesce(p_ended_at, last_seen_at)),
        marker_missing_at = NULL,
        updated_at = now()
    WHERE id = v_moved AND (ended_reason IS NULL OR ended_reason = 'lapsed');
    RETURN v_moved;
  END IF;

  INSERT INTO alert_incidents (signal, subject, subject_label, scope, organization_id, started_at, last_seen_at, window_minutes, ended_at, ended_reason, successor_signal, closed_at)
  VALUES (p_signal, p_subject, p_subject_label, p_scope, p_organization_id, p_started_at, greatest(p_started_at, coalesce(p_ended_at, p_started_at)),
          p_window_minutes, p_ended_at, p_reason, p_successor, now())
  ON CONFLICT ON CONSTRAINT alert_incidents_key DO UPDATE
    SET ended_at = p_ended_at,
        ended_reason = p_reason,
        successor_signal = p_successor,
        closed_at = now(),
        last_seen_at = greatest(alert_incidents.last_seen_at, coalesce(p_ended_at, alert_incidents.last_seen_at)),
        subject_label = coalesce(EXCLUDED.subject_label, alert_incidents.subject_label),
        window_minutes = coalesce(alert_incidents.window_minutes, EXCLUDED.window_minutes),
        marker_missing_at = NULL,
        updated_at = now()
    -- Open, or closed only by a lapse the real end now replaces. An end that
    -- already landed is left as it is.
    WHERE alert_incidents.ended_reason IS NULL OR alert_incidents.ended_reason = 'lapsed'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- Already ended: this event has landed before, so report the row it landed on.
    SELECT id INTO v_id FROM alert_incidents WHERE signal = p_signal AND subject = p_subject AND started_at = p_started_at;
  END IF;
  RETURN v_id;
END;
$fn$;

-- ------------------------------------------------------------------
-- lapsed: the drain's check of an open row's KV marker
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_alert_incident_marker_check(
  p_id uuid,
  p_marker_present boolean,
  p_now timestamptz
)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  r alert_incidents%ROWTYPE;
BEGIN
  SELECT * INTO r FROM alert_incidents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF r.ended_reason IS NOT NULL THEN
    RETURN 'closed';
  END IF;
  IF p_marker_present THEN
    UPDATE alert_incidents SET marker_missing_at = NULL, updated_at = now() WHERE id = p_id AND marker_missing_at IS NOT NULL;
    RETURN 'open';
  END IF;
  -- The first absence, or a second inside four minutes (the same drain run twice,
  -- not two drains): suspected, not yet lapsed. KV lists late by up to a minute,
  -- so an ended event can be invisible to the drain that sees its marker gone.
  IF r.marker_missing_at IS NULL OR r.marker_missing_at > p_now - interval '4 minutes' THEN
    UPDATE alert_incidents SET marker_missing_at = coalesce(marker_missing_at, p_now), updated_at = now() WHERE id = p_id;
    RETURN 'suspect';
  END IF;
  UPDATE alert_incidents SET ended_reason = 'lapsed', ended_at = NULL, closed_at = now(), updated_at = now() WHERE id = p_id;
  RETURN 'lapsed';
END;
$fn$;

-- ------------------------------------------------------------------
-- Retention: 90 days after an incident ended, never while open
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_alert_incidents()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM alert_incidents
  WHERE closed_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_alert_incident_opened(text, text, text, text, uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_alert_incident_paged(text, text, text, text, uuid, timestamptz, timestamptz, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_alert_incident_ended(text, text, text, text, uuid, timestamptz, timestamptz, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_alert_incident_marker_check(uuid, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_alert_incidents() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.alert_incident_moved_from(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_alert_incident_opened(text, text, text, text, uuid, timestamptz, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_alert_incident_paged(text, text, text, text, uuid, timestamptz, timestamptz, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_alert_incident_ended(text, text, text, text, uuid, timestamptz, timestamptz, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_alert_incident_marker_check(uuid, boolean, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_alert_incidents() TO service_role;
GRANT EXECUTE ON FUNCTION public.alert_incident_moved_from(text, text, timestamptz) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-alert-incidents') THEN
    PERFORM cron.schedule(
      'purge-alert-incidents',
      '29 6 * * *',
      $cmd$SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT public.purge_alert_incidents()$cmd$
    );
  END IF;
END
$$;
