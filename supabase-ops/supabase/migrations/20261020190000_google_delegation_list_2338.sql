-- The Google mailboxes and drives list's write path (#2338, PR 2 of its build
-- plan; requirement R10, finding F129). Applied to the ops project ("Bidspoke
-- Ops"), never the bidding one.
--
-- google_delegation_subjects (migration 20261018170000) is each organization's
-- list of the mailboxes and shared drives its Google connections may act as or
-- name, read by google_delegation_check on every Google mint. Until now it had
-- no write path, so every Google mint was refused. Dan's decision on #2411
-- (2026-10-18): any signed in user of the organization adds to it from the
-- Connections page, not an approval migration, and every change is audited with
-- who made it and when. This migration is the ops half of that write path; the
-- bidding Worker's routes reach it through the OpsConnections entrypoint (PR 6).
--
--   google_delegation_subjects gains
--     id            a uuid per entry, the subject_id of its change records.
--     display_name  a shared drive's name, shown on the page in place of its id
--                   (D10). Nullable: a drive saved without one shows its id, a
--                   mailbox never has one (its address is its name).
--     one organization per entry: a mailbox or drive on one organization's list
--                   cannot be put on another's. Domain wide delegation is one
--                   service account over one Workspace, so two organizations
--                   naming the same mailbox would each act as it.
--
--   add_google_delegation_subject(org, kind, subject, display_name, actor id,
--                   actor email, actor name)  adds one entry and its change
--                   record in ops_audit_log in the same transaction, so a change
--                   record that cannot be written rolls the entry back. A mailbox
--                   is trimmed and stored lower case. Answers added, or by name
--                   already_listed (nothing written: a repeat is the same add),
--                   listed_by_another_organization, subject_invalid (the table's
--                   own shape check refused it, the one home of that shape) or
--                   display_name_invalid. added_by is the person's name, or their
--                   email when no name is given.
--   remove_google_delegation_subject(org, kind, subject, actor ...)  deletes one
--                   entry of the organization's own and writes its change record
--                   (the old values) in the same transaction. Answers removed, or
--                   not_listed when the organization holds no such entry: never a
--                   silent success. The minter's check reads the list on every
--                   mint, so a removed mailbox stops at once.
--   list_google_delegation_subjects(org, limit)  read only: the organization's
--                   entries, mailboxes first, each with its drive name, who added
--                   it and when.
--
-- service_role keeps SELECT only on google_delegation_subjects and
-- ops_audit_log (#1948), so these functions are the only way to write either.
--
-- SAFE TO APPLY BEFORE ITS CODE, AND ITS CODE SAFE BEFORE IT (L640). Nothing
-- calls the new functions until the bidding Worker's list routes ship (PR 6);
-- the ops Worker's new OpsConnections methods that call them are not in the
-- binding's method list until then. google_delegation_check reads only the
-- columns it read before. The new columns are a defaulted id and a nullable
-- name, and the one organization index is built on a table that has had no
-- write path.
--
-- Additive (ADR 0007): two new columns, two new indexes, three new functions.
-- Guarded by supabase-ops/supabase/tests/google_delegation_list.test.sql.

SET lock_timeout = '5s';

-- ── google_delegation_subjects: an id per entry, and a drive's name ───────────
ALTER TABLE public.google_delegation_subjects
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN display_name text,
  ADD CONSTRAINT google_delegation_subjects_display_name_check CHECK (
    display_name IS NULL
    OR (kind = 'drive' AND display_name = btrim(display_name) AND length(display_name) BETWEEN 1 AND 200 AND display_name !~ '[[:cntrl:]]'));

CREATE UNIQUE INDEX google_delegation_subjects_id_key ON public.google_delegation_subjects (id);
-- One organization per mailbox or drive (see the header).
CREATE UNIQUE INDEX google_delegation_subjects_one_organization ON public.google_delegation_subjects (kind, subject);

COMMENT ON TABLE public.google_delegation_subjects IS
  'F129: the mailboxes and shared drives a Google connection of this organization may act as or name, one organization per entry. '
  'Added and removed by signed-in users of the organization through the Connections page (#2338), only through '
  'add_google_delegation_subject and remove_google_delegation_subject, each writing its change record in ops_audit_log in the same '
  'transaction. Read on every Google mint through google_delegation_check.';
COMMENT ON COLUMN public.google_delegation_subjects.display_name IS
  'A shared drive''s name, shown in place of its id. Null for every mailbox, and for a drive saved without one.';

-- ── add_google_delegation_subject ─────────────────────────────────────────────
CREATE FUNCTION public.add_google_delegation_subject(
  p_organization_id uuid,
  p_kind            text,
  p_subject         text,
  p_display_name    text,
  p_actor_id        uuid,
  p_actor_email     text,
  p_actor_name      text
) RETURNS TABLE (outcome text, kind text, subject text, display_name text, added_by text, added_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_subject text;
  v_name text := nullif(btrim(p_display_name), '');
  v_email text := nullif(btrim(p_actor_email), '');
  v_by text := coalesce(nullif(btrim(p_actor_name), ''), nullif(btrim(p_actor_email), ''));
  v_constraint text;
  v_row public.google_delegation_subjects%ROWTYPE;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id = '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION 'add_google_delegation_subject: an organization is required, never the lane''s' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('mailbox', 'drive') THEN
    RAISE EXCEPTION 'add_google_delegation_subject: the kind must be mailbox or drive' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_actor_id IS NULL OR v_by IS NULL OR length(v_by) > 200 OR length(v_email) > 320 THEN
    RAISE EXCEPTION 'add_google_delegation_subject: who is adding is required, by id and by a name or email of at most 200 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_subject := CASE WHEN p_kind = 'mailbox' THEN lower(btrim(p_subject)) ELSE btrim(p_subject) END;

  -- The table's own checks judge the entry, so its shape has one home.
  BEGIN
    INSERT INTO public.google_delegation_subjects AS s (organization_id, kind, subject, display_name, added_at, added_by)
    VALUES (p_organization_id, p_kind, v_subject, v_name, v_now, v_by)
    ON CONFLICT (kind, subject) DO NOTHING
    RETURNING s.* INTO v_row;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'google_delegation_subjects_display_name_check' THEN
      RETURN QUERY SELECT 'display_name_invalid'::text, p_kind, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
    ELSE
      RETURN QUERY SELECT 'subject_invalid'::text, p_kind, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
    END IF;
    RETURN;
  END;

  IF v_row.id IS NULL THEN
    SELECT s.* INTO v_row FROM public.google_delegation_subjects s WHERE s.kind = p_kind AND s.subject = v_subject;
    IF NOT FOUND THEN
      -- Removed between the conflict and this read: nothing was written, and a retry decides afresh.
      RAISE EXCEPTION 'add_google_delegation_subject: the entry changed while it was being added; add it again' USING ERRCODE = 'serialization_failure';
    END IF;
    IF v_row.organization_id <> p_organization_id THEN
      -- Nothing about the other organization's entry is answered.
      RETURN QUERY SELECT 'listed_by_another_organization'::text, p_kind, NULL::text, NULL::text, NULL::text, NULL::timestamptz;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'already_listed'::text, v_row.kind, v_row.subject, v_row.display_name, v_row.added_by, v_row.added_at;
    RETURN;
  END IF;

  -- The change record, in this transaction: if it fails, so does the add (L593).
  INSERT INTO public.ops_audit_log (organization_id, actor_id, actor_email, action, subject_table, subject_id, old_values, new_values, at)
  VALUES (p_organization_id, p_actor_id, v_email, 'add_google_delegation_subject', 'google_delegation_subjects', v_row.id,
    jsonb_build_object('listed', false),
    jsonb_build_object('listed', true, 'kind', v_row.kind, 'subject', v_row.subject, 'display_name', v_row.display_name, 'added_by', v_row.added_by),
    v_now);
  RETURN QUERY SELECT 'added'::text, v_row.kind, v_row.subject, v_row.display_name, v_row.added_by, v_row.added_at;
END
$fn$;

-- ── remove_google_delegation_subject ──────────────────────────────────────────
CREATE FUNCTION public.remove_google_delegation_subject(
  p_organization_id uuid,
  p_kind            text,
  p_subject         text,
  p_actor_id        uuid,
  p_actor_email     text,
  p_actor_name      text
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_email text := nullif(btrim(p_actor_email), '');
  v_by text := coalesce(nullif(btrim(p_actor_name), ''), nullif(btrim(p_actor_email), ''));
  v_row public.google_delegation_subjects%ROWTYPE;
BEGIN
  IF p_organization_id IS NULL OR p_organization_id = '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION 'remove_google_delegation_subject: an organization is required, never the lane''s' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('mailbox', 'drive') OR p_subject IS NULL THEN
    RAISE EXCEPTION 'remove_google_delegation_subject: the kind (mailbox or drive) and the entry are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_actor_id IS NULL OR v_by IS NULL OR length(v_by) > 200 OR length(v_email) > 320 THEN
    RAISE EXCEPTION 'remove_google_delegation_subject: who is removing is required, by id and by a name or email of at most 200 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.google_delegation_subjects s
  WHERE s.organization_id = p_organization_id AND s.kind = p_kind
    AND s.subject = CASE WHEN p_kind = 'mailbox' THEN lower(btrim(p_subject)) ELSE btrim(p_subject) END
  RETURNING s.* INTO v_row;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_listed'::text;
    RETURN;
  END IF;

  INSERT INTO public.ops_audit_log (organization_id, actor_id, actor_email, action, subject_table, subject_id, old_values, new_values, at)
  VALUES (p_organization_id, p_actor_id, v_email, 'remove_google_delegation_subject', 'google_delegation_subjects', v_row.id,
    jsonb_build_object('listed', true, 'kind', v_row.kind, 'subject', v_row.subject, 'display_name', v_row.display_name,
      'added_by', v_row.added_by, 'added_at', v_row.added_at),
    jsonb_build_object('listed', false, 'removed_by', v_by),
    v_now);
  RETURN QUERY SELECT 'removed'::text;
END
$fn$;

-- ── list_google_delegation_subjects ───────────────────────────────────────────
CREATE FUNCTION public.list_google_delegation_subjects(p_organization_id uuid, p_limit integer)
RETURNS TABLE (kind text, subject text, display_name text, added_by text, added_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'list_google_delegation_subjects: an organization is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'list_google_delegation_subjects: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT s.kind, s.subject, s.display_name, s.added_by, s.added_at
  FROM public.google_delegation_subjects s
  WHERE s.organization_id = p_organization_id
  -- Mailboxes first, then drives by the name the page shows.
  ORDER BY (s.kind = 'drive'), coalesce(s.display_name, s.subject), s.subject
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.add_google_delegation_subject(uuid, text, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_google_delegation_subject(uuid, text, text, text, uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.remove_google_delegation_subject(uuid, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_google_delegation_subject(uuid, text, text, uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.list_google_delegation_subjects(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_google_delegation_subjects(uuid, integer) TO service_role;
