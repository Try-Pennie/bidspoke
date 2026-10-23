-- write_workflow: one database function for every workflow write the Worker
-- makes (#1947, the third change, A2 of plan discussion #1945). EXPAND only.
--
-- Until now the Worker wrote workflows and workflow_versions with plain
-- INSERTs and UPDATEs from seven route handlers, a save as two statements (the
-- version snapshot, then the row), and nothing stopped a save made on top of
-- someone else's newer save from silently putting their change back. This
-- gives the table a version every writer moves, and one function that owns
-- every write of a workflow's definition, is_active, lane and deleted_at.
--
-- 1. workflows.version, moved by the BEFORE UPDATE trigger
--    workflows_bump_version whenever a column outside
--    workflows_unversioned_columns() changes, whoever the writer is (a route,
--    hand run SQL). The version is the version of what a save writes: the
--    definition, its stamp, name, description, Slack channel, lane and
--    anything added later (L657). It does not move for bookkeeping, for
--    is_active, deleted_at, folder_id or test_payloads, which no save writes,
--    so switching a workflow on, moving it to a folder or saving its test
--    payloads never makes an open canvas's save stale.
-- 2. workflows.last_save_id: the save press that last wrote the row, so a
--    retried press whose answer was lost can tell its own landed save from
--    someone else's (as partner saves do, #2132).
-- 3. workflow_versions.definition_report: what validateDefinition found in the
--    snapshot's definition when it was written (the Worker's report only pass),
--    so whether the enforcement flip would refuse anything is measured from the
--    table, not from logs that age out. Null for every snapshot written before.
-- 4. write_workflow(op, org, id, expected_version, fields, save_id, actor...):
--    create, duplicate, save, restore, patch (is_active, folder_id) and delete.
--    Every op on an existing row locks it FOR UPDATE among the organization's
--    rows that are not soft deleted. save and restore compare the stored
--    version with the expected one and refuse a stale save by name (BP409
--    stale_version, DETAIL the current row, its last_save_id and who last
--    changed it and when); patch and delete compare it when one is given, and
--    switching a workflow on must give one, the version whose definition the
--    caller checked. A save or restore writes its version snapshot and the row
--    in one transaction, numbering the snapshot under the row lock, so two
--    saves can no longer race for one version number, and a refusal by
--    workflows_refuse_missing_connections (#2338) takes the snapshot back with
--    the row. A written definition (create, save) must carry its stamp; a
--    copied one (duplicate, restore) takes the stamp of the row it copies,
--    decided here, never by the caller.
-- 5. anon and authenticated lose INSERT, UPDATE and DELETE on workflows and
--    workflow_versions. Both held them (measured 2026-10-22), and the
--    workflows_org policy let any signed in user write their own
--    organization's definitions straight through PostgREST, past every check
--    the Worker makes. No browser code writes either table (it reads neither).
--
-- Expand only (ADR 0007): two columns with constant or no defaults (no
-- rewrite), one nullable column, new functions and a trigger. The code
-- running when this is applied never names the new columns or the function,
-- and its direct writes keep working; the trigger only moves a column it never
-- reads. The browser revokes take nothing the running code uses. Apply this
-- BEFORE the code that calls write_workflow deploys. Removing service_role's
-- direct writes is the contract step, a later migration applied only once that
-- code is live (L640).

SET LOCAL lock_timeout = '5s';

-- ── Columns ──────────────────────────────────────────────────────────────────

ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS last_save_id uuid NULL;
ALTER TABLE public.workflow_versions ADD COLUMN IF NOT EXISTS definition_report jsonb NULL;

COMMENT ON COLUMN public.workflows.version IS
  'Moved by the workflows_bump_version trigger on every change to a column outside workflows_unversioned_columns() (#1947). write_workflow refuses a save or restore made from any other version (stale_version).';
COMMENT ON COLUMN public.workflows.last_save_id IS
  'The save press that last wrote this row through write_workflow (#1947), so a retried press can recognise its own landed save.';
COMMENT ON COLUMN public.workflow_versions.definition_report IS
  'What validateDefinition found in this snapshot''s definition when write_workflow wrote it (#1947, report only): the verdict, problems by rule, and what the rules would refuse. Null for snapshots written before 2026-10-23.';

-- ── The one list of unversioned columns ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.workflows_unversioned_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT ARRAY['updated_at', 'updated_by', 'updated_by_email', 'updated_by_name', 'version', 'last_save_id',
               'is_active', 'deleted_at', 'folder_id', 'test_payloads']
$$;
COMMENT ON FUNCTION public.workflows_unversioned_columns() IS
  'The workflows columns whose change does not move version (#1947): bookkeeping, and state no save writes (is_active, deleted_at, folder_id, test_payloads). Every other column moves it, by default.';
REVOKE ALL ON FUNCTION public.workflows_unversioned_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflows_unversioned_columns() TO service_role;

-- ── The version trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.workflows_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_unversioned text[] := public.workflows_unversioned_columns();
BEGIN
  IF (to_jsonb(NEW) - v_unversioned) IS DISTINCT FROM (to_jsonb(OLD) - v_unversioned) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION public.workflows_bump_version() IS
  'Moves workflows.version by one when a versioned column changes, and otherwise keeps it, so no writer can set it (#1947).';
REVOKE ALL ON FUNCTION public.workflows_bump_version() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS workflows_bump_version ON public.workflows;
CREATE TRIGGER workflows_bump_version
  BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.workflows_bump_version();

-- ── write_workflow ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.write_workflow(
  p_op text,
  p_org uuid,
  p_id uuid,
  p_expected_version integer,
  p_fields jsonb,
  p_save_id uuid,
  p_actor uuid,
  p_actor_email text,
  p_actor_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_allowed text[];
  v_key text;
  v_has_def boolean;
  v_def jsonb;
  v_stamp_text text;
  v_stamp smallint;
  v_name text;
  v_folder uuid;
  v_row public.workflows%ROWTYPE;
  v_new public.workflows%ROWTYPE;
  v_source public.workflow_versions%ROWTYPE;
  v_next integer;
  v_version_id uuid;
  v_copied integer;
  v_last_name text;
  v_last_at timestamptz;
BEGIN
  IF jsonb_typeof(v_fields) <> 'object' THEN
    RAISE EXCEPTION 'fields_not_object' USING ERRCODE = 'BP422';
  END IF;

  -- The fields each op may carry. A copied definition's stamp (duplicate,
  -- restore) is never one of them: it is read here from the row it copies.
  v_allowed := CASE p_op
    WHEN 'create' THEN ARRAY['name', 'description', 'folder_id', 'definition', 'definition_schema_version']
    WHEN 'duplicate' THEN ARRAY['name', 'definition']
    WHEN 'save' THEN ARRAY['name', 'description', 'slack_channel', 'definition', 'definition_schema_version', 'message', 'definition_report']
    WHEN 'restore' THEN ARRAY['version_id', 'definition', 'definition_report']
    WHEN 'patch' THEN ARRAY['is_active', 'folder_id']
    WHEN 'delete' THEN ARRAY[]::text[]
  END;
  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'op_unknown' USING ERRCODE = 'BP422', DETAIL = coalesce(p_op, 'null');
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_fields) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'field_not_writable' USING ERRCODE = 'BP422', DETAIL = v_key;
    END IF;
  END LOOP;

  v_has_def := v_fields ? 'definition';
  IF v_has_def THEN
    v_def := v_fields -> 'definition';
    IF jsonb_typeof(v_def) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'definition_not_object' USING ERRCODE = 'BP422';
    END IF;
  ELSIF p_op IN ('create', 'duplicate', 'restore') THEN
    RAISE EXCEPTION 'definition_required' USING ERRCODE = 'BP422';
  END IF;

  -- A definition this write authors carries the stamp the Worker checked it by.
  IF p_op IN ('create', 'save') THEN
    v_stamp_text := v_fields ->> 'definition_schema_version';
    IF v_has_def AND v_stamp_text IS NULL THEN
      RAISE EXCEPTION 'schema_version_required' USING ERRCODE = 'BP422';
    ELSIF NOT v_has_def AND v_fields ? 'definition_schema_version' THEN
      RAISE EXCEPTION 'schema_version_without_definition' USING ERRCODE = 'BP422';
    ELSIF v_stamp_text IS NOT NULL THEN
      IF jsonb_typeof(v_fields -> 'definition_schema_version') <> 'number' OR v_stamp_text !~ '^[1-9][0-9]{0,3}$' THEN
        RAISE EXCEPTION 'schema_version_invalid' USING ERRCODE = 'BP422', DETAIL = v_stamp_text;
      END IF;
      v_stamp := v_stamp_text::smallint;
    END IF;
  END IF;

  IF v_fields ? 'name' THEN
    v_name := btrim(coalesce(v_fields ->> 'name', ''));
    IF v_name = '' THEN
      RAISE EXCEPTION 'name_required' USING ERRCODE = 'BP422';
    END IF;
  END IF;

  IF v_fields ? 'folder_id' AND jsonb_typeof(v_fields -> 'folder_id') <> 'null' THEN
    BEGIN
      v_folder := (v_fields ->> 'folder_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'folder_not_found' USING ERRCODE = 'P0002';
    END;
    IF NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = v_folder AND f.organization_id = p_org) THEN
      RAISE EXCEPTION 'folder_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- ── create ─────────────────────────────────────────────────────────────────
  -- A new workflow starts switched off on the money lane (#1706, #1707).
  IF p_op = 'create' THEN
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'name_required' USING ERRCODE = 'BP422';
    END IF;
    INSERT INTO workflows (organization_id, name, description, definition, definition_schema_version, is_active, folder_id,
                           created_by, updated_by, updated_by_email, updated_by_name, last_save_id)
    VALUES (p_org, v_name, v_fields ->> 'description', v_def, v_stamp, false, v_folder,
            p_actor, p_actor, p_actor_email, nullif(p_actor_name, ''), p_save_id)
    RETURNING * INTO v_new;
    RETURN jsonb_build_object('workflow', to_jsonb(v_new));
  END IF;

  -- ── duplicate ──────────────────────────────────────────────────────────────
  -- p_id is the source. The copy is switched off, keeps the source's lane,
  -- folder, description and stamp, and its whole history, or a first version
  -- of the source when it has none, all in this transaction.
  IF p_op = 'duplicate' THEN
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'name_required' USING ERRCODE = 'BP422';
    END IF;
    SELECT * INTO v_row FROM workflows w
    WHERE w.id = p_id AND w.organization_id = p_org AND w.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workflow_not_found' USING ERRCODE = 'P0002';
    END IF;
    INSERT INTO workflows (organization_id, name, description, definition, definition_schema_version, is_active, folder_id, lane,
                           created_by, updated_by, updated_by_email, updated_by_name, last_save_id)
    VALUES (p_org, v_name, v_row.description, v_def, v_row.definition_schema_version, false, v_row.folder_id, v_row.lane,
            p_actor, p_actor, p_actor_email, nullif(p_actor_name, ''), p_save_id)
    RETURNING * INTO v_new;
    INSERT INTO workflow_versions (workflow_id, version_number, definition, definition_schema_version, definition_report, commit_sha, created_by, created_at, message)
    SELECT v_new.id, v.version_number, v.definition, v.definition_schema_version, v.definition_report, v.commit_sha, v.created_by, v.created_at, v.message
    FROM workflow_versions v
    WHERE v.workflow_id = p_id;
    GET DIAGNOSTICS v_copied = ROW_COUNT;
    IF v_copied = 0 THEN
      INSERT INTO workflow_versions (workflow_id, version_number, definition, definition_schema_version, created_by, message)
      VALUES (v_new.id, 1, v_row.definition, v_row.definition_schema_version, p_actor, 'Duplicated from ' || v_row.name);
      v_copied := 1;
    END IF;
    RETURN jsonb_build_object('workflow', to_jsonb(v_new), 'versions_copied', v_copied);
  END IF;

  -- ── Every other op changes an existing workflow ────────────────────────────
  SELECT * INTO v_row FROM workflows w
  WHERE w.id = p_id AND w.organization_id = p_org AND w.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_version IS NULL AND (
       p_op IN ('save', 'restore')
       OR (p_op = 'patch' AND v_fields ? 'is_active' AND jsonb_typeof(v_fields -> 'is_active') = 'boolean'
           AND (v_fields ->> 'is_active')::boolean AND NOT v_row.is_active)
     ) THEN
    RAISE EXCEPTION 'expected_version_required' USING ERRCODE = 'BP422';
  END IF;

  IF p_expected_version IS NOT NULL AND v_row.version <> p_expected_version THEN
    -- Who last changed what a save writes: the newest snapshot's author and
    -- time, since every write of a versioned column through this function
    -- takes one. A hand write takes none, and falls back to the row.
    SELECT u.display_name, v.created_at
    INTO v_last_name, v_last_at
    FROM workflow_versions v
    LEFT JOIN users u ON u.id = v.created_by
    WHERE v.workflow_id = p_id
    ORDER BY v.version_number DESC
    LIMIT 1;
    RAISE EXCEPTION 'stale_version' USING ERRCODE = 'BP409',
      DETAIL = jsonb_build_object(
        'current', to_jsonb(v_row),
        'last_save_id', v_row.last_save_id,
        'changed_by_name', coalesce(v_last_name, v_row.updated_by_name),
        'changed_at', coalesce(v_last_at, v_row.updated_at)
      )::text;
  END IF;

  -- ── save ───────────────────────────────────────────────────────────────────
  -- A snapshot of what the row holds after the save (the definition sent, or
  -- the stored one), numbered under the lock, then the row.
  IF p_op = 'save' THEN
    SELECT coalesce(max(v.version_number), 0) + 1 INTO v_next FROM workflow_versions v WHERE v.workflow_id = p_id;
    INSERT INTO workflow_versions (workflow_id, version_number, definition, definition_schema_version, definition_report, created_by, message)
    VALUES (p_id, v_next,
            CASE WHEN v_has_def THEN v_def ELSE v_row.definition END,
            CASE WHEN v_has_def THEN v_stamp ELSE v_row.definition_schema_version END,
            CASE WHEN v_has_def THEN v_fields -> 'definition_report' END,
            p_actor, v_fields ->> 'message')
    RETURNING id INTO v_version_id;
    UPDATE workflows w SET
      name = CASE WHEN v_fields ? 'name' THEN v_name ELSE w.name END,
      description = CASE WHEN v_fields ? 'description' THEN v_fields ->> 'description' ELSE w.description END,
      slack_channel = CASE WHEN v_fields ? 'slack_channel' THEN v_fields ->> 'slack_channel' ELSE w.slack_channel END,
      definition = CASE WHEN v_has_def THEN v_def ELSE w.definition END,
      definition_schema_version = CASE WHEN v_has_def THEN v_stamp ELSE w.definition_schema_version END,
      updated_by = p_actor, updated_by_email = p_actor_email, updated_by_name = nullif(p_actor_name, ''),
      last_save_id = p_save_id
    WHERE w.id = p_id
    RETURNING * INTO v_new;
    RETURN jsonb_build_object('workflow', to_jsonb(v_new), 'version_id', v_version_id, 'version_number', v_next);
  END IF;

  -- ── restore ────────────────────────────────────────────────────────────────
  -- The old definition (as the Worker cleaned it) becomes a new version and
  -- the row's definition, keeping the stamp its version row carries.
  IF p_op = 'restore' THEN
    BEGIN
      SELECT * INTO v_source FROM workflow_versions v
      WHERE v.id = (v_fields ->> 'version_id')::uuid AND v.workflow_id = p_id;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'version_not_found' USING ERRCODE = 'P0002';
    END;
    IF v_source.id IS NULL THEN
      RAISE EXCEPTION 'version_not_found' USING ERRCODE = 'P0002';
    END IF;
    SELECT coalesce(max(v.version_number), 0) + 1 INTO v_next FROM workflow_versions v WHERE v.workflow_id = p_id;
    INSERT INTO workflow_versions (workflow_id, version_number, definition, definition_schema_version, definition_report, created_by, message)
    VALUES (p_id, v_next, v_def, v_source.definition_schema_version, v_fields -> 'definition_report', p_actor,
            'Restored from v' || v_source.version_number)
    RETURNING id INTO v_version_id;
    UPDATE workflows w SET
      definition = v_def,
      definition_schema_version = v_source.definition_schema_version,
      updated_by = p_actor, updated_by_email = p_actor_email, updated_by_name = nullif(p_actor_name, ''),
      last_save_id = p_save_id
    WHERE w.id = p_id
    RETURNING * INTO v_new;
    RETURN jsonb_build_object('workflow', to_jsonb(v_new), 'version_id', v_version_id, 'version_number', v_next,
                              'restored_from', v_source.version_number);
  END IF;

  -- ── patch ──────────────────────────────────────────────────────────────────
  IF p_op = 'patch' THEN
    IF v_fields ? 'is_active' AND jsonb_typeof(v_fields -> 'is_active') <> 'boolean' THEN
      RAISE EXCEPTION 'is_active_not_boolean' USING ERRCODE = 'BP422';
    END IF;
    UPDATE workflows w SET
      is_active = CASE WHEN v_fields ? 'is_active' THEN (v_fields ->> 'is_active')::boolean ELSE w.is_active END,
      folder_id = CASE WHEN v_fields ? 'folder_id' THEN v_folder ELSE w.folder_id END,
      updated_by = p_actor, updated_by_email = p_actor_email, updated_by_name = nullif(p_actor_name, '')
    WHERE w.id = p_id
    RETURNING * INTO v_new;
    RETURN jsonb_build_object('workflow', to_jsonb(v_new));
  END IF;

  -- ── delete ─────────────────────────────────────────────────────────────────
  -- A soft delete: deleted_at and switched off, nothing else. Executions keep
  -- their RESTRICT foreign key and the history stays. What it does to state
  -- derived from the workflow is in the Worker's delete route and the ops
  -- tick (a deleted copy never starts).
  UPDATE workflows w SET
    deleted_at = now(),
    is_active = false,
    updated_by = p_actor, updated_by_email = p_actor_email, updated_by_name = nullif(p_actor_name, '')
  WHERE w.id = p_id
  RETURNING * INTO v_new;
  RETURN jsonb_build_object('workflow', to_jsonb(v_new));
END
$$;
COMMENT ON FUNCTION public.write_workflow(text, uuid, uuid, integer, jsonb, uuid, uuid, text, text) IS
  'Every workflow write the Worker makes (#1947): create, duplicate, save, restore, patch (is_active, folder_id), delete (soft). Locks the row, refuses stale_version (BP409, DETAIL a JSON object: current row, last_save_id, changed_by_name, changed_at) when the stored version is not the expected one, writes a save''s or restore''s version snapshot in the same transaction, and takes a copied definition''s stamp from the row it copies. Refuses workflow_not_found, version_not_found and folder_not_found (P0002), and a malformed call by name (BP422). Returns {workflow, version_id?, version_number?, restored_from?, versions_copied?}.';
REVOKE ALL ON FUNCTION public.write_workflow(text, uuid, uuid, integer, jsonb, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_workflow(text, uuid, uuid, integer, jsonb, uuid, uuid, text, text) TO service_role;

-- ── The browser roles write neither table ────────────────────────────────────

REVOKE INSERT, UPDATE, DELETE ON public.workflows FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.workflow_versions FROM anon, authenticated;
