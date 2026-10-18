-- A failed login split by cause (Dan's decision 2) and the Google delegation
-- allowlist (finding F129). #2335, phase 5 of #1689; plan: discussion #2329,
-- part 2. Applied to the ops project ("Bidspoke Ops"), never the bidding one.
--
-- DECISION 2 (2026-10-17). A login the provider REFUSED (invalid_grant,
-- invalid_client) goes to needs_reauth at once, as before
-- (record_connection_needs_reauth, called by connectionFetch). A token
-- endpoint that timed out or answered 5xx is retried under a named
-- refresh_failing state first, and goes to needs_reauth only once the failure
-- has held past a bound. This migration is that state:
--   connection_health gains the streak: refresh_failures (consecutive failed
--                   logins since the last one that worked or the last
--                   Reconnect), refresh_failing_since, refresh_last_failed_at
--                   and refresh_failure_cause. Written only by
--                   record_connection_refresh (L53), and moved together, held
--                   by a CHECK.
--   record_connection_refresh(org, connection, ok, cause)  connectionFetch's
--                   writer. A failure adds one to the streak, or starts a new
--                   one when there is none or a Reconnect came after it began.
--                   Once the streak holds REFRESH_FAILURE_LIMIT (5) failures
--                   AND began REFRESH_FAILING_SPAN (15 minutes) ago, the
--                   failure writes needs_reauth through
--                   record_connection_needs_reauth, the one writer of that
--                   column, with the cause 'refresh_failing_exhausted: <cause>',
--                   and answers needs_reauth. Both bounds, because either alone
--                   is wrong: a count alone sends a connection to needs_reauth
--                   on a 30 second outage that a burst of parallel steps meets
--                   five times (L36, a person Reconnects for nothing); a span
--                   alone lets a single slow failure an hour later do it. A
--                   login that works ends the streak (ok, no cause): it writes
--                   only when there is a streak, so the common case writes
--                   nothing. It never clears needs_reauth: only Reconnect does.
--   connection_status  replaced with the same arguments and result columns,
--                   deriving one more status: refresh_failing, after
--                   needs_reauth and before check_failing, while a streak
--                   begun after the last Reconnect stands.
--
-- F129 (finding, 2026-10-17; Dan's note on decision 11). Domain wide
-- delegation lets the ops Google service account act as EVERY mailbox in the
-- Workspace for its scopes, and Dan granted broad scopes once (decision 11).
-- So which mailboxes and shared drives a Google connection may name is an
-- organization's own list:
--   google_delegation_subjects  one row per organization, kind (mailbox or
--                   drive) and subject. STATED, NEVER DEFAULTED (L72), as the
--                   Salesforce caps are: service_role may only read it, so an
--                   entry arrives only by an approval migration that names who
--                   approved it. A mailbox is stored lower case and compared
--                   without regard to case. An organization's row, never the
--                   lane's: the nil uuid is refused.
--   google_delegation_check(org, mailbox, drives)  read only. Answers allowed,
--                   or the first refusal by name: mailbox_not_allowed,
--                   drive_not_allowed. The Google minter calls it on every
--                   authorize, before any token is minted or reused, so a
--                   subject taken off the list stops at once rather than when
--                   a held token expires; verify calls it at save (PR 8 of
--                   phase 5), since a Connections page save verifies before
--                   the bidding row is committed.
--
-- SAFE TO APPLY BEFORE ITS CODE (L640). Nothing calls either function yet:
-- connectionFetch has no caller in production, and the new columns default to
-- an empty streak. No delegation subject is listed by this migration, so every
-- Google mint is refused until Dan approves entries.
--
-- Additive (ADR 0007): new columns with a default, a new table, two new
-- functions, and connection_status replaced in place with the same signature.
-- Guarded by supabase-ops/supabase/tests/refresh_failing_and_delegation.test.sql.

SET lock_timeout = '5s';

-- ── connection_health: the refresh streak ─────────────────────────────────────
ALTER TABLE public.connection_health
  ADD COLUMN refresh_failures integer NOT NULL DEFAULT 0 CONSTRAINT connection_health_refresh_failures_check CHECK (refresh_failures >= 0),
  ADD COLUMN refresh_failing_since timestamptz,
  ADD COLUMN refresh_last_failed_at timestamptz,
  ADD COLUMN refresh_failure_cause text CONSTRAINT connection_health_refresh_cause_length CHECK (length(refresh_failure_cause) BETWEEN 1 AND 200),
  ADD CONSTRAINT connection_health_refresh_streak_shape CHECK (
    (refresh_failures = 0) = (refresh_failing_since IS NULL)
    AND (refresh_failing_since IS NULL) = (refresh_last_failed_at IS NULL)
    AND (refresh_failing_since IS NULL) = (refresh_failure_cause IS NULL));

-- ── record_connection_refresh ─────────────────────────────────────────────────
CREATE FUNCTION public.record_connection_refresh(p_organization_id uuid, p_connection_id uuid, p_ok boolean, p_cause text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  -- Decision 2's bound, stated once (see the header for why both).
  c_limit CONSTANT integer := 5;
  c_span CONSTANT interval := interval '15 minutes';
  v_at timestamptz := clock_timestamp();
  v_org uuid;
  v_failures integer;
  v_since timestamptz;
BEGIN
  IF p_organization_id IS NULL OR p_connection_id IS NULL OR p_ok IS NULL THEN
    RAISE EXCEPTION 'record_connection_refresh: organization, connection and the result are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ok AND p_cause IS NOT NULL THEN
    RAISE EXCEPTION 'record_connection_refresh: a login that worked carries no cause' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT p_ok AND (p_cause IS NULL OR length(p_cause) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'record_connection_refresh: a failed login needs a cause of 1 to 200 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id) THEN
    SELECT t.organization_id INTO v_org FROM public.connection_tombstones_ops t WHERE t.connection_id = p_connection_id;
    IF v_org <> p_organization_id THEN
      RAISE EXCEPTION 'record_connection_refresh: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN 'connection_removed';
  END IF;
  SELECT coalesce(c.organization_id, h.organization_id) INTO v_org
  FROM (SELECT 1) one
  LEFT JOIN public.connection_copies c ON c.connection_id = p_connection_id
  LEFT JOIN public.connection_health h ON h.connection_id = p_connection_id;
  IF v_org IS NOT NULL AND v_org <> p_organization_id THEN
    RAISE EXCEPTION 'record_connection_refresh: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_ok THEN
    -- Only a streak is written over, so a working login with none writes nothing.
    UPDATE public.connection_health h
    SET refresh_failures = 0, refresh_failing_since = NULL, refresh_last_failed_at = NULL, refresh_failure_cause = NULL
    WHERE h.connection_id = p_connection_id AND h.organization_id = p_organization_id AND h.refresh_failures > 0;
    RETURN 'recorded';
  END IF;

  INSERT INTO public.connection_health AS h (connection_id, organization_id, refresh_failures, refresh_failing_since, refresh_last_failed_at, refresh_failure_cause)
  VALUES (p_connection_id, p_organization_id, 1, v_at, v_at, p_cause)
  ON CONFLICT (connection_id) DO UPDATE
  SET refresh_failures = CASE
        WHEN h.refresh_failing_since IS NULL OR h.refresh_failing_since <= coalesce(h.reauth_cleared_at, '-infinity'::timestamptz) THEN 1
        ELSE h.refresh_failures + 1
      END,
      refresh_failing_since = CASE
        WHEN h.refresh_failing_since IS NULL OR h.refresh_failing_since <= coalesce(h.reauth_cleared_at, '-infinity'::timestamptz) THEN v_at
        ELSE h.refresh_failing_since
      END,
      refresh_last_failed_at = v_at,
      refresh_failure_cause = p_cause
  WHERE h.organization_id = p_organization_id
  RETURNING h.refresh_failures, h.refresh_failing_since INTO v_failures, v_since;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_connection_refresh: connection % belongs to another organization', p_connection_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_failures >= c_limit AND v_at - v_since >= c_span THEN
    PERFORM public.record_connection_needs_reauth(p_organization_id, p_connection_id, left('refresh_failing_exhausted: ' || p_cause, 200));
    RETURN 'needs_reauth';
  END IF;
  RETURN 'refresh_failing';
END
$fn$;

-- ── connection_status, replaced: one more derived status ───────────────────────
-- Same arguments and result columns. needs_reauth first (L53: whatever the
-- other columns say); then refresh_failing while a streak begun after the last
-- Reconnect stands; then the still valid check's statuses as before.
CREATE OR REPLACE FUNCTION public.connection_status(p_organization_id uuid, p_limit integer)
RETURNS TABLE (connection_id uuid, service text, generation bigint, status text, last_check_ok_at timestamptz, last_check_failed_at timestamptz,
  last_check_cause text, needs_reauth_at timestamptz, needs_reauth_cause text, reauth_cleared_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'connection_status: an organization is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'connection_status: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.connection_id, c.service, c.generation,
    CASE
      WHEN h.needs_reauth_at > coalesce(h.reauth_cleared_at, '-infinity'::timestamptz) THEN 'needs_reauth'
      WHEN h.refresh_failures > 0 AND h.refresh_failing_since > coalesce(h.reauth_cleared_at, '-infinity'::timestamptz) THEN 'refresh_failing'
      WHEN h.last_check_failed_at > coalesce(h.last_check_ok_at, '-infinity'::timestamptz) THEN 'check_failing'
      WHEN h.last_check_ok_at IS NOT NULL THEN 'healthy'
      ELSE 'unchecked'
    END,
    h.last_check_ok_at, h.last_check_failed_at, h.last_check_cause, h.needs_reauth_at, h.needs_reauth_cause, h.reauth_cleared_at
  FROM public.connection_copies c
  LEFT JOIN public.connection_health h ON h.connection_id = c.connection_id AND h.organization_id = c.organization_id
  WHERE c.organization_id = p_organization_id AND c.withdrawn_at IS NULL
  ORDER BY c.connection_id
  LIMIT p_limit;
END
$fn$;

-- ── google_delegation_subjects ────────────────────────────────────────────────
CREATE TABLE public.google_delegation_subjects (
  -- An organization's list. Never the lane's nil uuid.
  organization_id  uuid NOT NULL CONSTRAINT google_delegation_subjects_organization_check CHECK (organization_id <> '00000000-0000-0000-0000-000000000000'),
  kind             text NOT NULL CONSTRAINT google_delegation_subjects_kind_check CHECK (kind IN ('mailbox', 'drive')),
  subject          text NOT NULL,
  approved_at      timestamptz NOT NULL,
  approved_by      text NOT NULL CONSTRAINT google_delegation_subjects_approved_by_check CHECK (length(approved_by) BETWEEN 1 AND 200),
  PRIMARY KEY (organization_id, kind, subject),
  -- A mailbox is one exact address, lower case; a shared drive is its id. No pattern, no wildcard.
  CONSTRAINT google_delegation_subjects_subject_shape CHECK (
    (kind = 'mailbox' AND subject = lower(subject) AND length(subject) <= 254 AND subject ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$')
    OR (kind = 'drive' AND subject ~ '^[A-Za-z0-9_-]{10,128}$'))
);

ALTER TABLE public.google_delegation_subjects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_delegation_subjects FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.google_delegation_subjects FROM service_role;
GRANT SELECT ON public.google_delegation_subjects TO service_role;

-- ── google_delegation_check ───────────────────────────────────────────────────
CREATE FUNCTION public.google_delegation_check(p_organization_id uuid, p_mailbox text, p_drives text[])
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  IF p_organization_id IS NULL OR p_mailbox IS NULL THEN
    RAISE EXCEPTION 'google_delegation_check: organization and mailbox are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(cardinality(p_drives), 0) > 100 THEN
    RAISE EXCEPTION 'google_delegation_check: at most 100 drives, not %', cardinality(p_drives) USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.google_delegation_subjects s
      WHERE s.organization_id = p_organization_id AND s.kind = 'mailbox' AND s.subject = lower(p_mailbox)) THEN
    RETURN 'mailbox_not_allowed';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_drives, ARRAY[]::text[])) AS d(drive)
      WHERE d.drive IS NULL OR NOT EXISTS (SELECT 1 FROM public.google_delegation_subjects s
        WHERE s.organization_id = p_organization_id AND s.kind = 'drive' AND s.subject = d.drive)) THEN
    RETURN 'drive_not_allowed';
  END IF;
  RETURN 'allowed';
END
$fn$;

REVOKE ALL ON FUNCTION public.record_connection_refresh(uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_connection_refresh(uuid, uuid, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.google_delegation_check(uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.google_delegation_check(uuid, text, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.connection_status(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connection_status(uuid, integer) TO service_role;
