-- A page that did not reach Slack (#3056). Before this the incident record heard
-- of a page only once Slack took it, so a page that was due and refused left no
-- row at all: four Lead Economy shifts went unpaged while Slack refused every
-- Worker alert (2026-10-23 and 26, #2808) and nothing recorded that they were
-- missed. Each delivery site now records every page it tries
-- (alert-recovery.ts, recordPageOutcome), and the drain moves an `undelivered`
-- outbox event here through record_alert_incident_undelivered.
--
-- TWO CASES, as the event says (p_unannounced):
--   - An incident is open, so somebody was told of it earlier: the refused page
--     counts against that incident (pages_undelivered), which stays open.
--   - None is open, so nobody was ever told: the incident that was due is kept
--     as its own row, started at the first refused page of the stretch, closed
--     at once as 'unannounced' with ended_at the latest refused page (a moment
--     it was seen, never when it cleared). Closed because no all-clear is owed
--     for an incident nobody saw, and none will come to close it; so the
--     drain's lapse check never reads it and the dashboard never shows it as
--     ongoing.
--
-- Like every transition here it accepts its event in any order and counts each
-- event once (undelivered_event_ids), so a drain run twice changes nothing.
--
-- Also (#3076): the COMMENT on execution_steps.timeout_kind named only the first
-- two of its values; it now names every value in TIMEOUT_KINDS
-- (apps/worker/src/engine/step-timeout.ts).
--
-- Expand/contract (ADR 0007): additive. Two columns with defaults on a table of
-- a few dozen rows, a CHECK widened by one value (every existing row satisfies
-- it, so it is added valid), one new function, comments. The deployed worker
-- writes no `undelivered` event and reads none of this until the code in the
-- same pull request ships, and that code's drain calls the new function only for
-- an event the new code wrote, so applying this first breaks nothing; the
-- required live objects check holds the deploy until the function exists.
--
-- Guarded by supabase/tests/alert_incidents_undelivered.test.sql.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.alert_incidents ADD COLUMN IF NOT EXISTS pages_undelivered integer NOT NULL DEFAULT 0;
ALTER TABLE public.alert_incidents ADD COLUMN IF NOT EXISTS undelivered_event_ids text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_incidents_undelivered_check' AND conrelid = 'public.alert_incidents'::regclass) THEN
    ALTER TABLE public.alert_incidents ADD CONSTRAINT alert_incidents_undelivered_check CHECK (pages_undelivered >= 0);
  END IF;
END
$$;

ALTER TABLE public.alert_incidents DROP CONSTRAINT IF EXISTS alert_incidents_reason_check;
ALTER TABLE public.alert_incidents ADD CONSTRAINT alert_incidents_reason_check
  CHECK (ended_reason IS NULL OR ended_reason IN ('all_clear', 'stood_down_by_design', 'handed_over', 'lapsed', 'unannounced'));

COMMENT ON COLUMN public.alert_incidents.pages_undelivered IS
  'Pages about the incident that were due and did not reach Slack (#3056): Slack refused them, or no request went out. An incident nobody was told of is recorded at most one a minute.';
COMMENT ON COLUMN public.alert_incidents.undelivered_event_ids IS
  'The outbox event ids already counted in pages_undelivered, so a refused page applied twice counts once.';
COMMENT ON COLUMN public.alert_incidents.ended_reason IS
  'Why the incident ended: all_clear, stood_down_by_design, handed_over (naming successor_signal), lapsed (its marker went with no end, so ended_at is NULL), or unannounced (no page about it ever reached Slack, so no all-clear is owed; ended_at is the latest refused page, #3056).';
COMMENT ON COLUMN public.alert_incidents.ended_at IS
  'The last sighting the all-clear reported, or for an unannounced incident the latest refused page. NULL means the end was not recorded; it is never guessed.';

-- ------------------------------------------------------------------
-- undelivered: a page about the incident was due and did not reach Slack
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_alert_incident_undelivered(
  p_signal text,
  p_subject text,
  p_subject_label text,
  p_scope text,
  p_organization_id uuid,
  p_started_at timestamptz,
  p_at timestamptz,
  p_event_id text,
  p_unannounced boolean,
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
    RAISE EXCEPTION 'an undelivered page needs its event id, or a drain run twice would count it twice' USING ERRCODE = '22023';
  END IF;
  IF p_unannounced IS NULL THEN
    RAISE EXCEPTION 'an undelivered page must say whether an incident was open' USING ERRCODE = '22023';
  END IF;
  -- An open incident whose start was moved earlier (a page carrying the old start).
  v_id := alert_incident_moved_from(p_signal, p_subject, p_started_at);
  IF v_id IS NOT NULL THEN
    UPDATE alert_incidents
    SET pages_undelivered = pages_undelivered + CASE WHEN p_event_id = ANY (undelivered_event_ids) THEN 0 ELSE 1 END,
        undelivered_event_ids = CASE WHEN p_event_id = ANY (undelivered_event_ids) THEN undelivered_event_ids ELSE undelivered_event_ids || p_event_id END,
        last_seen_at = greatest(last_seen_at, p_at),
        updated_at = now()
    WHERE id = v_id;
    RETURN v_id;
  END IF;
  INSERT INTO alert_incidents (
    signal, subject, subject_label, scope, organization_id, started_at, last_seen_at, window_minutes,
    pages_undelivered, undelivered_event_ids, ended_at, ended_reason, closed_at
  )
  VALUES (
    p_signal, p_subject, p_subject_label, p_scope, p_organization_id, p_started_at, greatest(p_started_at, p_at), p_window_minutes,
    1, ARRAY[p_event_id],
    CASE WHEN p_unannounced THEN greatest(p_started_at, p_at) END,
    CASE WHEN p_unannounced THEN 'unannounced' END,
    CASE WHEN p_unannounced THEN now() END
  )
  ON CONFLICT ON CONSTRAINT alert_incidents_key DO UPDATE
    SET pages_undelivered = alert_incidents.pages_undelivered + CASE WHEN p_event_id = ANY (alert_incidents.undelivered_event_ids) THEN 0 ELSE 1 END,
        undelivered_event_ids = CASE WHEN p_event_id = ANY (alert_incidents.undelivered_event_ids) THEN alert_incidents.undelivered_event_ids
                                     ELSE alert_incidents.undelivered_event_ids || p_event_id END,
        last_seen_at = greatest(alert_incidents.last_seen_at, p_at),
        -- Only an unannounced row's end follows its refused pages; a real end is never moved.
        ended_at = CASE WHEN alert_incidents.ended_reason = 'unannounced' THEN greatest(alert_incidents.ended_at, p_at) ELSE alert_incidents.ended_at END,
        subject_label = coalesce(EXCLUDED.subject_label, alert_incidents.subject_label),
        window_minutes = coalesce(alert_incidents.window_minutes, EXCLUDED.window_minutes),
        updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

COMMENT ON FUNCTION public.record_alert_incident_undelivered(text, text, text, text, uuid, timestamptz, timestamptz, text, boolean, integer) IS
  'The incident drain writes a page that did not reach Slack (#3056): against the open incident, or, when nobody was told (p_unannounced), as the incident that was due, closed as unannounced. Counts each event once.';

REVOKE ALL ON FUNCTION public.record_alert_incident_undelivered(text, text, text, text, uuid, timestamptz, timestamptz, text, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_alert_incident_undelivered(text, text, text, text, uuid, timestamptz, timestamptz, text, boolean, integer) TO service_role;

-- #3076: every value TIMEOUT_KINDS holds (apps/worker/src/engine/step-timeout.ts).
COMMENT ON COLUMN public.execution_steps.timeout_kind IS
  'Set only on a step a deadline stopped (#3047): step (its own timeout_ms), parallel_block (its block stopped waiting), code_chain (a chain of code nodes ran past its deadline), request (a node''s own request timer aborted its call), partner_bid (the partner bid''s timer aborted its request), bid_group (a highest bid race stopped waiting for this attempt), buyer_select (the buyer select node''s budget ran out), buyer_call (a buyer post''s own timer aborted it), achieve_offers (the achieve_offers node''s wait aborted its call) or click_post (buyer_click_send stopped waiting for its post). NULL on every other row, and on rows written before the marker. Values: TIMEOUT_KINDS in apps/worker/src/engine/step-timeout.ts.';
