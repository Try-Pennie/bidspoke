-- The Google mailboxes and drives list's write path (#2338, PR 2 of its build
-- plan; requirement R10, finding F129).
-- Migration 20261020190000_google_delegation_list_2338.sql.
--
-- WHAT IT PROVES.
--   A. The objects are under the ops rules: add_google_delegation_subject,
--      remove_google_delegation_subject and list_google_delegation_subjects are
--      SECURITY DEFINER with an empty fixed search_path, service_role alone may
--      run them, the two writes carry a 2 second lock_timeout and the read is
--      STABLE. service_role still only reads google_delegation_subjects, so these
--      functions are its only write path. The new display_name column is
--      nullable and holds a drive's name only.
--   B. Add. A mailbox is stored lower case and trimmed, the row says who added
--      it (the person's name) and when, and a change record is written in
--      ops_audit_log in the same call: who (id and email), when, what. Adding
--      the same entry again answers already_listed and writes no second record.
--      A malformed address or drive id answers subject_invalid, a display name
--      on a mailbox answers display_name_invalid, and each writes nothing. A
--      call with no organization, the lane's nil uuid or no actor is refused.
--   C. Another organization. A mailbox one organization lists cannot be added
--      by another (listed_by_another_organization, nothing written), nor
--      removed by it (not_listed, the entry stays), nor seen in its list.
--   D. A failed change record rolls the change back: with ops_audit_log made to
--      refuse the record, the add raises and leaves no entry, and the remove
--      raises and leaves the entry in place.
--   E. Remove. An entry is removed with its change record (the old values); a
--      remove of an entry that is not listed answers not_listed and writes no
--      record, never a silent success.
--   F. List. Exactly the organization's entries, mailboxes first, with each
--      drive's name, who added it and when; the limit is held to 1 to 1000.
--   G. The mint's check reads what these functions write: an added mailbox is
--      allowed by google_delegation_check, and a removed one is refused again.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE gd_cases (name text PRIMARY KEY);

-- ── A. The objects ───────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn record;
  v_name text;
  v_priv text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['add_google_delegation_subject', 'remove_google_delegation_subject', 'list_google_delegation_subjects'] LOOP
    SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'public.% does not exist', v_name; END IF;
    IF NOT v_fn.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_name; END IF;
    IF v_fn.proconfig IS NULL OR NOT ('search_path=""' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION '% has no empty fixed search_path: %', v_name, v_fn.proconfig; END IF;
    IF NOT has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_name; END IF;
    IF has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_name;
    END IF;
    IF v_name = 'list_google_delegation_subjects' THEN
      IF v_fn.provolatile <> 's' THEN RAISE EXCEPTION 'the read function % is not STABLE', v_name; END IF;
    ELSE
      IF v_fn.provolatile <> 'v' THEN RAISE EXCEPTION 'the write function % is not VOLATILE', v_name; END IF;
      IF NOT ('lock_timeout=2s' = ANY (v_fn.proconfig)) THEN RAISE EXCEPTION '% has no 2s lock_timeout', v_name; END IF;
    END IF;
  END LOOP;

  -- The functions are the only write path: service_role still only reads the table and the change records.
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('service_role', 'public.google_delegation_subjects', v_priv) THEN RAISE EXCEPTION 'service_role holds % on google_delegation_subjects', v_priv; END IF;
    IF has_table_privilege('service_role', 'public.ops_audit_log', v_priv) THEN RAISE EXCEPTION 'service_role holds % on ops_audit_log', v_priv; END IF;
  END LOOP;

  -- A drive's name: nullable, so the rows the minter already reads need none (ADR 0007).
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.google_delegation_subjects'::regclass AND a.attname = 'display_name'
      AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'google_delegation_subjects has no nullable display_name text column';
  END IF;
  BEGIN
    INSERT INTO public.google_delegation_subjects (organization_id, kind, subject, added_at, added_by, display_name)
    VALUES ('aaaaaaaa-0000-4000-8000-000000002338', 'mailbox', 'named@example.invalid', now(), 'x', 'A name');
    RAISE EXCEPTION 'the table took a display name on a mailbox';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO gd_cases VALUES ('objects: definer functions, service_role only, the table read only to it, a drive name column');
END
$do$;

-- ── B. Add ───────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002338';
  v_actor uuid := 'cccccccc-0000-4000-8000-000000002338';
  v_r record;
  v_a record;
  v_audits integer;
BEGIN
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'mailbox', '  Ops@Example.Invalid ', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'added' THEN RAISE EXCEPTION 'a new mailbox answered %', v_r.outcome; END IF;
  IF v_r.kind <> 'mailbox' OR v_r.subject <> 'ops@example.invalid' OR v_r.display_name IS NOT NULL OR v_r.added_by <> 'Dan Wright' OR v_r.added_at IS NULL THEN
    RAISE EXCEPTION 'the added mailbox came back as % % % % %', v_r.kind, v_r.subject, v_r.display_name, v_r.added_by, v_r.added_at;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.google_delegation_subjects s WHERE s.organization_id = v_org AND s.kind = 'mailbox' AND s.subject = 'ops@example.invalid'
      AND s.added_by = 'Dan Wright') THEN
    RAISE EXCEPTION 'the mailbox was not stored lower case and trimmed, with who added it';
  END IF;

  -- The change record: who, when and what, in the same call.
  SELECT * INTO v_a FROM public.ops_audit_log l WHERE l.organization_id = v_org AND l.subject_table = 'google_delegation_subjects';
  IF NOT FOUND THEN RAISE EXCEPTION 'the add wrote no change record'; END IF;
  IF v_a.actor_id <> v_actor OR v_a.actor_email <> 'dan@example.invalid' OR v_a.action <> 'add_google_delegation_subject' OR v_a.at IS NULL
      OR v_a.subject_id <> (SELECT s.id FROM public.google_delegation_subjects s WHERE s.organization_id = v_org AND s.subject = 'ops@example.invalid')
      OR v_a.new_values ->> 'subject' <> 'ops@example.invalid' OR v_a.new_values ->> 'kind' <> 'mailbox' OR v_a.new_values ->> 'added_by' <> 'Dan Wright'
      OR (v_a.old_values ->> 'listed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the change record does not say who, when and what: %', row_to_json(v_a);
  END IF;

  -- Twice is once: the same entry again answers already_listed and records nothing more.
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'mailbox', 'OPS@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'already_listed' OR v_r.subject <> 'ops@example.invalid' OR v_r.added_by <> 'Dan Wright' THEN
    RAISE EXCEPTION 'a repeated add answered % for %', v_r.outcome, v_r.subject;
  END IF;
  SELECT count(*) INTO v_audits FROM public.ops_audit_log l WHERE l.organization_id = v_org AND l.subject_table = 'google_delegation_subjects';
  IF v_audits <> 1 THEN RAISE EXCEPTION 'a repeated add wrote a change record (% in all)', v_audits; END IF;

  -- A shared drive, by id, with its name. With no name given, the person's email stands for who added it.
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'drive', '0AbCdEfGhIjKlMnOpQ', ' Partner reports ', v_actor, 'dan@example.invalid', NULL);
  IF v_r.outcome <> 'added' OR v_r.display_name <> 'Partner reports' OR v_r.added_by <> 'dan@example.invalid' THEN
    RAISE EXCEPTION 'a drive with its name answered % % %', v_r.outcome, v_r.display_name, v_r.added_by;
  END IF;

  -- Malformed entries are refused by name and write nothing.
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'mailbox', 'not a mailbox', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'subject_invalid' OR v_r.subject IS NOT NULL THEN RAISE EXCEPTION 'a malformed address answered %', v_r.outcome; END IF;
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'mailbox', '*@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'subject_invalid' THEN RAISE EXCEPTION 'a wildcard address answered %', v_r.outcome; END IF;
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'mailbox', '', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'subject_invalid' THEN RAISE EXCEPTION 'an empty address answered %', v_r.outcome; END IF;
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'drive', '0AaBbCcDdEe/../x', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'subject_invalid' THEN RAISE EXCEPTION 'a malformed drive id answered %', v_r.outcome; END IF;
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'mailbox', 'reports@example.invalid', 'Reports', v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'display_name_invalid' THEN RAISE EXCEPTION 'a mailbox with a display name answered %', v_r.outcome; END IF;
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_org, 'drive', '0ZzYyXxWwVvUuTtSsR', repeat('n', 201), v_actor, 'dan@example.invalid', 'Dan Wright');
  IF v_r.outcome <> 'display_name_invalid' THEN RAISE EXCEPTION 'a drive name of 201 characters answered %', v_r.outcome; END IF;
  IF EXISTS (SELECT 1 FROM public.google_delegation_subjects s WHERE s.organization_id = v_org AND s.subject IN ('not a mailbox', '*@example.invalid', 'reports@example.invalid', '0ZzYyXxWwVvUuTtSsR'))
      OR (SELECT count(*) FROM public.ops_audit_log l WHERE l.organization_id = v_org AND l.subject_table = 'google_delegation_subjects') <> 2 THEN
    RAISE EXCEPTION 'a refused add wrote something';
  END IF;

  -- A malformed call is refused outright.
  BEGIN
    PERFORM public.add_google_delegation_subject(NULL, 'mailbox', 'a@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
    RAISE EXCEPTION 'an add with no organization answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.add_google_delegation_subject('00000000-0000-0000-0000-000000000000', 'mailbox', 'a@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
    RAISE EXCEPTION 'an add for the lane''s nil organization answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.add_google_delegation_subject(v_org, 'mailbox', 'a@example.invalid', NULL, NULL, 'dan@example.invalid', 'Dan Wright');
    RAISE EXCEPTION 'an add with no actor answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.add_google_delegation_subject(v_org, 'mailbox', 'a@example.invalid', NULL, v_actor, NULL, '  ');
    RAISE EXCEPTION 'an add with neither a name nor an email for who added it answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.add_google_delegation_subject(v_org, 'calendar', 'a@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
    RAISE EXCEPTION 'an add of an unknown kind answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO gd_cases VALUES ('add: stored lower case with who and when, recorded once, malformed entries refused by name');
END
$do$;

-- ── C. Another organization ──────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002338';
  v_other uuid := 'bbbbbbbb-0000-4000-8000-000000002338';
  v_actor uuid := 'dddddddd-0000-4000-8000-000000002338';
  v_r record;
  v_out text;
BEGIN
  SELECT * INTO v_r FROM public.add_google_delegation_subject(v_other, 'mailbox', 'ops@example.invalid', NULL, v_actor, 'eve@example.invalid', 'Eve');
  IF v_r.outcome <> 'listed_by_another_organization' OR v_r.subject IS NOT NULL OR v_r.added_by IS NOT NULL THEN
    RAISE EXCEPTION 'another organization''s mailbox answered % and showed %', v_r.outcome, v_r.added_by;
  END IF;
  SELECT r.outcome INTO v_out FROM public.remove_google_delegation_subject(v_other, 'mailbox', 'ops@example.invalid', v_actor, 'eve@example.invalid', 'Eve') r;
  IF v_out <> 'not_listed' THEN RAISE EXCEPTION 'another organization''s remove answered %', v_out; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.google_delegation_subjects s WHERE s.organization_id = v_org AND s.subject = 'ops@example.invalid') THEN
    RAISE EXCEPTION 'another organization removed the entry';
  END IF;
  IF EXISTS (SELECT 1 FROM public.google_delegation_subjects s WHERE s.organization_id = v_other)
      OR EXISTS (SELECT 1 FROM public.ops_audit_log l WHERE l.organization_id = v_other) THEN
    RAISE EXCEPTION 'another organization''s refused calls wrote something';
  END IF;
  IF EXISTS (SELECT 1 FROM public.list_google_delegation_subjects(v_other, 100)) THEN
    RAISE EXCEPTION 'another organization''s list shows an entry it does not hold';
  END IF;
  INSERT INTO gd_cases VALUES ('another organization: cannot add, remove or see an entry it does not hold');
END
$do$;

-- ── D. A failed change record rolls the change back ──────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002338';
  v_actor uuid := 'cccccccc-0000-4000-8000-000000002338';
  v_audits integer := (SELECT count(*) FROM public.ops_audit_log);
BEGIN
  -- The change record is refused, as a full disk or a broken constraint would refuse it.
  ALTER TABLE public.ops_audit_log ADD CONSTRAINT gd_refuse_delegation_records CHECK (subject_table <> 'google_delegation_subjects') NOT VALID;
  BEGIN
    PERFORM public.add_google_delegation_subject(v_org, 'mailbox', 'unrecorded@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
    RAISE EXCEPTION 'an add whose change record failed answered';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.google_delegation_subjects s WHERE s.subject = 'unrecorded@example.invalid') THEN
    RAISE EXCEPTION 'an add whose change record failed left its entry';
  END IF;
  BEGIN
    PERFORM public.remove_google_delegation_subject(v_org, 'mailbox', 'ops@example.invalid', v_actor, 'dan@example.invalid', 'Dan Wright');
    RAISE EXCEPTION 'a remove whose change record failed answered';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.google_delegation_subjects s WHERE s.organization_id = v_org AND s.subject = 'ops@example.invalid') THEN
    RAISE EXCEPTION 'a remove whose change record failed removed the entry';
  END IF;
  ALTER TABLE public.ops_audit_log DROP CONSTRAINT gd_refuse_delegation_records;
  IF (SELECT count(*) FROM public.ops_audit_log) <> v_audits THEN RAISE EXCEPTION 'a failed change wrote a record'; END IF;
  INSERT INTO gd_cases VALUES ('a failed change record: the add and the remove are rolled back');
END
$do$;

-- ── E. Remove ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002338';
  v_actor uuid := 'cccccccc-0000-4000-8000-000000002338';
  v_out text;
  v_a record;
  v_id uuid;
BEGIN
  PERFORM public.add_google_delegation_subject(v_org, 'mailbox', 'leaving@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  SELECT s.id INTO v_id FROM public.google_delegation_subjects s WHERE s.organization_id = v_org AND s.subject = 'leaving@example.invalid';
  SELECT r.outcome INTO v_out FROM public.remove_google_delegation_subject(v_org, 'mailbox', 'Leaving@Example.invalid', v_actor, 'dan@example.invalid', 'Dan Wright') r;
  IF v_out <> 'removed' THEN RAISE EXCEPTION 'a listed mailbox''s remove answered %', v_out; END IF;
  IF EXISTS (SELECT 1 FROM public.google_delegation_subjects s WHERE s.subject = 'leaving@example.invalid') THEN RAISE EXCEPTION 'the removed entry is still listed'; END IF;
  SELECT * INTO v_a FROM public.ops_audit_log l WHERE l.subject_id = v_id AND l.action = 'remove_google_delegation_subject';
  IF NOT FOUND OR v_a.actor_id <> v_actor OR v_a.organization_id <> v_org OR v_a.old_values ->> 'subject' <> 'leaving@example.invalid'
      OR v_a.old_values ->> 'added_by' <> 'Dan Wright' OR (v_a.new_values ->> 'listed')::boolean IS DISTINCT FROM false OR v_a.new_values ->> 'removed_by' <> 'Dan Wright' THEN
    RAISE EXCEPTION 'the remove''s change record does not say who, when and what was removed';
  END IF;

  -- Says so, rather than succeeding silently.
  SELECT r.outcome INTO v_out FROM public.remove_google_delegation_subject(v_org, 'mailbox', 'leaving@example.invalid', v_actor, 'dan@example.invalid', 'Dan Wright') r;
  IF v_out <> 'not_listed' THEN RAISE EXCEPTION 'a second remove answered %', v_out; END IF;
  SELECT r.outcome INTO v_out FROM public.remove_google_delegation_subject(v_org, 'drive', 'never-listed-drive-id', v_actor, 'dan@example.invalid', 'Dan Wright') r;
  IF v_out <> 'not_listed' THEN RAISE EXCEPTION 'a remove of a drive never listed answered %', v_out; END IF;
  IF (SELECT count(*) FROM public.ops_audit_log l WHERE l.subject_id = v_id) <> 2 THEN RAISE EXCEPTION 'a remove of nothing wrote a change record'; END IF;
  BEGIN
    PERFORM public.remove_google_delegation_subject(v_org, 'mailbox', 'ops@example.invalid', NULL, 'dan@example.invalid', 'Dan Wright');
    RAISE EXCEPTION 'a remove with no actor answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO gd_cases VALUES ('remove: recorded with what was removed, and a remove of nothing says not_listed');
END
$do$;

-- ── F. List ──────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002338';
  v_third uuid := 'eeeeeeee-0000-4000-8000-000000002338';
  v_actor uuid := 'cccccccc-0000-4000-8000-000000002338';
  v_got text[];
  v_r record;
BEGIN
  -- A third organization's entry, which the list must leave out.
  PERFORM public.add_google_delegation_subject(v_third, 'mailbox', 'third@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');
  PERFORM public.add_google_delegation_subject(v_org, 'mailbox', 'reports@example.invalid', NULL, v_actor, 'dan@example.invalid', 'Dan Wright');

  SELECT array_agg(l.kind || ':' || l.subject ORDER BY ord) INTO v_got
  FROM public.list_google_delegation_subjects(v_org, 100) WITH ORDINALITY AS l(kind, subject, display_name, added_by, added_at, ord);
  IF v_got IS DISTINCT FROM ARRAY['mailbox:ops@example.invalid', 'mailbox:reports@example.invalid', 'drive:0AbCdEfGhIjKlMnOpQ'] THEN
    RAISE EXCEPTION 'the list answered %', v_got;
  END IF;
  SELECT * INTO v_r FROM public.list_google_delegation_subjects(v_org, 100) l WHERE l.kind = 'drive';
  IF v_r.display_name <> 'Partner reports' OR v_r.added_by <> 'dan@example.invalid' OR v_r.added_at IS NULL THEN
    RAISE EXCEPTION 'the drive came back as % % %', v_r.display_name, v_r.added_by, v_r.added_at;
  END IF;
  IF (SELECT count(*) FROM public.list_google_delegation_subjects(v_org, 2)) <> 2 THEN RAISE EXCEPTION 'the list did not hold to its limit'; END IF;
  IF EXISTS (SELECT 1 FROM public.list_google_delegation_subjects('ffffffff-0000-4000-8000-000000002338', 100)) THEN
    RAISE EXCEPTION 'an organization with no entries listed some';
  END IF;
  BEGIN
    PERFORM public.list_google_delegation_subjects(v_org, 0);
    RAISE EXCEPTION 'a list of 0 answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.list_google_delegation_subjects(NULL, 10);
    RAISE EXCEPTION 'a list with no organization answered';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO gd_cases VALUES ('list: exactly the organization''s entries, mailboxes first, within its limit');
END
$do$;

-- ── G. The mint's check reads what these write ───────────────────────────────
DO $do$
DECLARE
  v_org uuid := 'aaaaaaaa-0000-4000-8000-000000002338';
  v_actor uuid := 'cccccccc-0000-4000-8000-000000002338';
  v_out text;
BEGIN
  v_out := public.google_delegation_check(v_org, 'reports@example.invalid', ARRAY['0AbCdEfGhIjKlMnOpQ']);
  IF v_out <> 'allowed' THEN RAISE EXCEPTION 'an added mailbox and drive answered %', v_out; END IF;
  PERFORM public.remove_google_delegation_subject(v_org, 'mailbox', 'reports@example.invalid', v_actor, 'dan@example.invalid', 'Dan Wright');
  v_out := public.google_delegation_check(v_org, 'reports@example.invalid', ARRAY[]::text[]);
  IF v_out <> 'mailbox_not_allowed' THEN RAISE EXCEPTION 'a removed mailbox answered %', v_out; END IF;
  INSERT INTO gd_cases VALUES ('the mint''s check: allowed once added, refused once removed');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM gd_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'google_delegation_list: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'google_delegation_list: % cases passed', v_n;
END
$do$;

ROLLBACK;
