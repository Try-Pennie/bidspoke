-- A failed login split by cause (Dan's decision 2) and the Google delegation
-- allowlist (finding F129), #2335 phase 5 of #1689.
-- Migration 20261018170000_refresh_failing_and_delegation_2335.sql.
--
-- WHAT IT PROVES.
--   A. The new objects are under the ops rules: google_delegation_subjects has
--      row level security on, organization_id uuid NOT NULL and never the nil
--      uuid (it is an organization's list), browser roles shut out and
--      service_role read only, so an entry arrives only by an approval
--      migration. record_connection_refresh and google_delegation_check are
--      SECURITY DEFINER with a fixed search_path and service_role alone may
--      run them; the write carries a 2 second lock_timeout, the read is STABLE.
--   B. Decision 2. A token endpoint that timed out or answered 5xx moves a
--      connection to refresh_failing, never straight to needs_reauth: four
--      failures in a burst stay refresh_failing, and so does a fifth inside
--      15 minutes of the first. A failure once there have been 5 or more AND
--      the first is 15 minutes old writes needs_reauth, through
--      record_connection_needs_reauth (the one writer of that column), with a
--      cause naming the exhausted refresh. A login that works clears the
--      streak. A Reconnect starts the count again from one.
--   C. Another organization is refused, a removed connection answers
--      connection_removed and writes nothing, a malformed call is refused.
--   D. The allowlist: a mailbox or drive is allowed only when its own
--      organization's list names it. A mailbox outside the list, the same
--      mailbox on another organization's list, and a drive outside the list
--      are each refused by name. Mailboxes compare without regard to case and
--      are stored lower case; a malformed entry is refused by the table.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE rd_cases (name text PRIMARY KEY);

CREATE FUNCTION pg_temp.rd_copy(p_conn uuid, p_org uuid)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('connection_id', p_conn, 'organization_id', p_org, 'service', 'google', 'generation', 1,
    'envelope', jsonb_build_object('v', 1, 'kid', 'ops-2026-10', 'wrapped_key', 'd3JhcHBlZA', 'iv', 'aXY', 'ct', 'Y3Q'),
    'public_config', jsonb_build_object('name', 'ops sheets'),
    'target', jsonb_build_object('subject', 'ops@example.invalid'),
    'serve_until', now() + interval '6 hours')
$f$;

-- ── A. The objects ───────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_role text;
  v_priv text;
  v_stmt text;
  v_fn record;
  v_name text;
BEGIN
  IF to_regclass('public.google_delegation_subjects') IS NULL THEN RAISE EXCEPTION 'public.google_delegation_subjects does not exist'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.google_delegation_subjects'::regclass) THEN
    RAISE EXCEPTION 'google_delegation_subjects has row level security off';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.google_delegation_subjects'::regclass AND a.attname = 'organization_id'
      AND a.attnotnull AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'google_delegation_subjects has no organization_id uuid NOT NULL column';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.google_delegation_subjects', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION '% holds a privilege on google_delegation_subjects', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.google_delegation_subjects', 'SELECT') THEN RAISE EXCEPTION 'service_role cannot read google_delegation_subjects'; END IF;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('service_role', 'public.google_delegation_subjects', v_priv) THEN RAISE EXCEPTION 'service_role holds % on google_delegation_subjects', v_priv; END IF;
  END LOOP;

  -- An entry is made only by an approval migration, never by the Worker.
  SET LOCAL ROLE service_role;
  BEGIN
    INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by)
    VALUES ('aaaaaaaa-0000-4000-8000-000000002335', 'mailbox', 'anyone@example.invalid', now(), 'worker');
    RAISE EXCEPTION 'service_role wrote a delegation subject';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Nor may it move the refresh columns by hand: only the function writes them.
  BEGIN
    UPDATE public.connection_health SET refresh_failures = 0;
    RAISE EXCEPTION 'service_role wrote connection_health directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  FOREACH v_stmt IN ARRAY ARRAY[
    -- An organization's list, never the lane's.
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES ('00000000-0000-0000-0000-000000000000', 'mailbox', 'a@example.invalid', now(), 'x')$s$,
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES (gen_random_uuid(), 'calendar', 'a@example.invalid', now(), 'x')$s$,
    -- Stored lower case, so one mailbox is one row.
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES (gen_random_uuid(), 'mailbox', 'Ops@Example.invalid', now(), 'x')$s$,
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES (gen_random_uuid(), 'mailbox', 'not a mailbox', now(), 'x')$s$,
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES (gen_random_uuid(), 'mailbox', '*@example.invalid', now(), 'x')$s$,
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES (gen_random_uuid(), 'drive', 'short', now(), 'x')$s$,
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES (gen_random_uuid(), 'drive', '0AaBbCcDdEe/../x', now(), 'x')$s$,
    $s$INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES (gen_random_uuid(), 'mailbox', 'a@example.invalid', now(), '')$s$,
    -- The refresh streak's columns move together.
    $s$INSERT INTO public.connection_health (connection_id, organization_id, refresh_failures) VALUES (gen_random_uuid(), gen_random_uuid(), 2)$s$,
    $s$INSERT INTO public.connection_health (connection_id, organization_id, refresh_failures, refresh_failing_since, refresh_last_failed_at, refresh_failure_cause) VALUES (gen_random_uuid(), gen_random_uuid(), -1, now(), now(), 'x')$s$,
    $s$INSERT INTO public.connection_health (connection_id, organization_id, refresh_failures, refresh_failing_since, refresh_last_failed_at, refresh_failure_cause) VALUES (gen_random_uuid(), gen_random_uuid(), 1, now(), now(), '')$s$
  ] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'the table took a row it must refuse: %', v_stmt;
    EXCEPTION WHEN check_violation OR not_null_violation THEN NULL;
    END;
  END LOOP;

  FOREACH v_name IN ARRAY ARRAY['record_connection_refresh', 'google_delegation_check', 'connection_status'] LOOP
    SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'public.% does not exist', v_name; END IF;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT ('search_path=""' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION '% has no empty fixed search_path: %', v_name, v_fn.proconfig; END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_name;
    END IF;
    IF v_name = 'record_connection_refresh' THEN
      IF v_fn.provolatile <> 'v' THEN RAISE EXCEPTION 'record_connection_refresh is not VOLATILE'; END IF;
      IF NOT ('lock_timeout=2s' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION 'record_connection_refresh has no 2s lock_timeout'; END IF;
    ELSIF v_fn.provolatile <> 's' THEN
      RAISE EXCEPTION 'the read function % is not STABLE', v_name;
    END IF;
  END LOOP;
  INSERT INTO rd_cases VALUES ('objects: the allowlist is read only to the Worker, the functions are definer, service_role only');
END
$do$;

-- ── B. Decision 2: refresh_failing first, needs_reauth only after a bound ─────
DO $do$
DECLARE
  v_conn uuid := '00000000-0000-4000-8000-0000000023b1';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002335';
  v_out text;
  v_s record;
  v_h record;
  i integer;
BEGIN
  PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.rd_copy(v_conn, v_org)));

  -- A burst of failures is refresh_failing, however many arrive at once.
  FOR i IN 1..4 LOOP
    v_out := public.record_connection_refresh(v_org, v_conn, false, 'token_endpoint_timeout');
    IF v_out <> 'refresh_failing' THEN RAISE EXCEPTION 'failure % answered %', i, v_out; END IF;
  END LOOP;
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'refresh_failing' THEN RAISE EXCEPTION 'four failed refreshes read as %', v_s.status; END IF;
  IF v_s.needs_reauth_at IS NOT NULL THEN RAISE EXCEPTION 'a timeout wrote needs_reauth'; END IF;
  SELECT * INTO v_h FROM public.connection_health WHERE connection_id = v_conn;
  IF v_h.refresh_failures <> 4 OR v_h.refresh_failure_cause <> 'token_endpoint_timeout' THEN RAISE EXCEPTION 'the streak reads %', v_h; END IF;

  -- A fifth inside 15 minutes of the first is still only refresh_failing.
  v_out := public.record_connection_refresh(v_org, v_conn, false, 'token_endpoint_5xx');
  IF v_out <> 'refresh_failing' THEN RAISE EXCEPTION 'a fifth failure inside 15 minutes answered %', v_out; END IF;

  -- With the streak 15 minutes old, the next failure is needs_reauth, written by its one writer.
  UPDATE public.connection_health SET refresh_failing_since = clock_timestamp() - interval '15 minutes' WHERE connection_id = v_conn;
  v_out := public.record_connection_refresh(v_org, v_conn, false, 'token_endpoint_5xx');
  IF v_out <> 'needs_reauth' THEN RAISE EXCEPTION 'an exhausted refresh answered %', v_out; END IF;
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'needs_reauth' THEN RAISE EXCEPTION 'an exhausted refresh reads as %', v_s.status; END IF;
  IF v_s.needs_reauth_cause <> 'refresh_failing_exhausted: token_endpoint_5xx' THEN RAISE EXCEPTION 'the cause reads %', v_s.needs_reauth_cause; END IF;

  -- A Reconnect clears needs_reauth; the next failure starts a new streak at one.
  PERFORM public.record_connection_reauth_cleared(v_org, v_conn);
  v_out := public.record_connection_refresh(v_org, v_conn, false, 'token_endpoint_timeout');
  SELECT * INTO v_h FROM public.connection_health WHERE connection_id = v_conn;
  IF v_out <> 'refresh_failing' OR v_h.refresh_failures <> 1 THEN RAISE EXCEPTION 'after a Reconnect a failure answered % with a streak of %', v_out, v_h.refresh_failures; END IF;
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'refresh_failing' THEN RAISE EXCEPTION 'after a Reconnect a failure reads as %', v_s.status; END IF;

  -- A login that works ends the streak, and touches nothing else.
  v_out := public.record_connection_refresh(v_org, v_conn, true, NULL);
  SELECT * INTO v_h FROM public.connection_health WHERE connection_id = v_conn;
  IF v_out <> 'recorded' OR v_h.refresh_failures <> 0 OR v_h.refresh_failing_since IS NOT NULL OR v_h.refresh_failure_cause IS NOT NULL THEN
    RAISE EXCEPTION 'a working login answered % and left %', v_out, v_h;
  END IF;
  IF v_h.reauth_cleared_at IS NULL OR v_h.needs_reauth_at IS NULL THEN RAISE EXCEPTION 'a working login moved another writer''s column'; END IF;
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'unchecked' THEN RAISE EXCEPTION 'a working login after a Reconnect reads as %', v_s.status; END IF;

  -- A working login with no streak writes nothing and makes no row.
  v_out := public.record_connection_refresh(v_org, '00000000-0000-4000-8000-0000000023b2', true, NULL);
  IF v_out <> 'recorded' OR EXISTS (SELECT 1 FROM public.connection_health WHERE connection_id = '00000000-0000-4000-8000-0000000023b2') THEN
    RAISE EXCEPTION 'a working login with no streak made a row';
  END IF;

  -- A needs_reauth from a refused login is not undone by a later working refresh.
  PERFORM public.record_connection_needs_reauth(v_org, v_conn, 'login_refused: invalid_grant');
  PERFORM public.record_connection_refresh(v_org, v_conn, true, NULL);
  SELECT * INTO v_s FROM public.connection_status(v_org, 1000) s WHERE s.connection_id = v_conn;
  IF v_s.status <> 'needs_reauth' THEN RAISE EXCEPTION 'a working refresh cleared needs_reauth: %', v_s.status; END IF;
  INSERT INTO rd_cases VALUES ('decision 2: refresh_failing first, needs_reauth only past the bound, a working login ends the streak');
END
$do$;

-- ── C. Organization and removal ──────────────────────────────────────────────
DO $do$
DECLARE
  v_conn uuid := '00000000-0000-4000-8000-0000000023c1';
  v_gone uuid := '00000000-0000-4000-8000-0000000023c2';
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002335';
  v_other uuid := 'bbbbbbbb-0000-4000-8000-000000002335';
  v_out text;
BEGIN
  PERFORM public.save_connection_copies(now(), false, jsonb_build_array(pg_temp.rd_copy(v_conn, v_org)));
  BEGIN
    PERFORM public.record_connection_refresh(v_other, v_conn, false, 'token_endpoint_timeout');
    RAISE EXCEPTION 'another organization recorded a refresh failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM public.record_connection_refresh(v_org, v_conn, false, 'token_endpoint_timeout');
  BEGIN
    PERFORM public.record_connection_refresh(v_other, v_conn, true, NULL);
    RAISE EXCEPTION 'another organization cleared a refresh streak';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM public.record_connection_tombstone(v_org, v_gone, 1, now());
  v_out := public.record_connection_refresh(v_org, v_gone, false, 'token_endpoint_timeout');
  IF v_out <> 'connection_removed' OR EXISTS (SELECT 1 FROM public.connection_health WHERE connection_id = v_gone) THEN
    RAISE EXCEPTION 'a removed connection answered % or kept health', v_out;
  END IF;

  BEGIN
    PERFORM public.record_connection_refresh(v_org, v_conn, false, NULL);
    RAISE EXCEPTION 'a failure with no cause was recorded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_connection_refresh(v_org, v_conn, true, 'token_endpoint_timeout');
    RAISE EXCEPTION 'a working login with a cause was recorded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_connection_refresh(v_org, v_conn, false, repeat('x', 201));
    RAISE EXCEPTION 'a 201 character cause was recorded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO rd_cases VALUES ('organization and removal: another organization refused, a removed connection writes nothing');
END
$do$;

-- ── D. The delegation allowlist (F129) ───────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002335';
  v_other uuid := 'bbbbbbbb-0000-4000-8000-000000002335';
  v_out text;
BEGIN
  -- As an approval migration would.
  INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, approved_at, approved_by) VALUES
    (v_org, 'mailbox', 'ops@example.invalid', now(), 'Dan (test)'),
    (v_org, 'drive', '0AbCdEfGhIjKlMnOpQ', now(), 'Dan (test)'),
    (v_other, 'mailbox', 'ceo@example.invalid', now(), 'Dan (test)');

  v_out := public.google_delegation_check(v_org, 'ops@example.invalid', ARRAY[]::text[]);
  IF v_out <> 'allowed' THEN RAISE EXCEPTION 'a listed mailbox answered %', v_out; END IF;
  v_out := public.google_delegation_check(v_org, 'OPS@Example.Invalid', ARRAY['0AbCdEfGhIjKlMnOpQ']);
  IF v_out <> 'allowed' THEN RAISE EXCEPTION 'a listed mailbox in capitals with a listed drive answered %', v_out; END IF;
  v_out := public.google_delegation_check(v_org, 'ops@example.invalid', NULL);
  IF v_out <> 'allowed' THEN RAISE EXCEPTION 'a listed mailbox with no drives answered %', v_out; END IF;

  -- The forbidden cases, attempted.
  v_out := public.google_delegation_check(v_org, 'someone.else@example.invalid', ARRAY[]::text[]);
  IF v_out <> 'mailbox_not_allowed' THEN RAISE EXCEPTION 'a mailbox outside the list answered %', v_out; END IF;
  v_out := public.google_delegation_check(v_org, 'ceo@example.invalid', ARRAY[]::text[]);
  IF v_out <> 'mailbox_not_allowed' THEN RAISE EXCEPTION 'another organization''s mailbox answered %', v_out; END IF;
  v_out := public.google_delegation_check(v_org, 'ops@example.invalid', ARRAY['0AbCdEfGhIjKlMnOpQ', '0ZzYyXxWwVvUuTtSsR']);
  IF v_out <> 'drive_not_allowed' THEN RAISE EXCEPTION 'a drive outside the list answered %', v_out; END IF;
  v_out := public.google_delegation_check(v_other, 'ops@example.invalid', ARRAY[]::text[]);
  IF v_out <> 'mailbox_not_allowed' THEN RAISE EXCEPTION 'one organization''s mailbox was allowed to another: %', v_out; END IF;

  BEGIN
    PERFORM public.google_delegation_check(v_org, NULL, ARRAY[]::text[]);
    RAISE EXCEPTION 'a check with no mailbox answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.google_delegation_check(NULL, 'ops@example.invalid', ARRAY[]::text[]);
    RAISE EXCEPTION 'a check with no organization answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.google_delegation_check(v_org, 'ops@example.invalid', array_fill('0AbCdEfGhIjKlMnOpQ'::text, ARRAY[101]));
    RAISE EXCEPTION 'a check naming 101 drives answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO rd_cases VALUES ('allowlist: only the organization''s own listed mailbox and drives, each refusal by name');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM rd_cases);
BEGIN
  IF v_n <> 4 THEN RAISE EXCEPTION 'refresh_failing_and_delegation: % of 4 cases ran', v_n; END IF;
  RAISE NOTICE 'refresh_failing_and_delegation: % cases passed', v_n;
END
$do$;

ROLLBACK;
