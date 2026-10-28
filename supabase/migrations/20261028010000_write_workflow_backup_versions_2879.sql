-- write_workflow answers the version a create or a duplicate writes, so both
-- are backed up to GitHub like a save (#2879). EXPAND only.
--
-- Since #2868 writeWorkflow pushes the GitHub backup of every version
-- write_workflow answers, and stamps the commit on that version row. Create and
-- duplicate answered none: a create wrote no version at all, so a new workflow
-- was missing from the backup until its first save, and a duplicate copied the
-- source's history without saying which copied version its definition is. The
-- duplicate also copied each version's commit_sha, so the copy's history
-- pointed at commits of the source's file, not its own.
--
-- What changes, in write_workflow only (same signature, same grants):
-- 1. create writes a first version (number 1, message 'Created') holding the
--    definition and stamp the new row holds, in the same transaction, and
--    answers its version_id and version_number. The first save is then v2.
-- 2. duplicate copies the source's history WITHOUT commit_sha: those commits
--    belong to the source's file, and the copy's own file is pushed and stamped
--    once it is written. It then answers the version its definition is: the
--    newest copied version when that holds exactly the copy's definition and
--    stamp, and otherwise a new version on top ('Duplicated from <source>')
--    holding the copy's definition, which the Worker cleans and stamps before
--    sending, so it can differ from the newest snapshot. A source never saved
--    gets that same new version as its copy's first, now holding the copy's
--    definition rather than the source row's. versions_copied counts the rows
--    copied from the source (0 for a source never saved, which answered 1).
-- 3. Every other op is unchanged, byte for byte.
--
-- Expand only (ADR 0007), so either order with the Worker is safe:
--  - Applied BEFORE the code that backs up create and duplicate deploys, the
--    running Worker reads only the workflow out of a create's or duplicate's
--    answer (writeWorkflow backs up save and restore alone) and ignores the
--    new keys; a created workflow gains a first version, which every reader of
--    workflow_versions (history, restore, the definition loader, the ops
--    gateway) already handles as it handles a saved one. Nothing is refused.
--  - Deployed BEFORE this is applied, the new code pushes a create or duplicate
--    with no version id to stamp, which it reports
--    (workflow_version_commit_sha_unset) and never fails the write on.
-- No column, type or signature changes, so the generated types do not move.

SET LOCAL lock_timeout = '5s';

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
  v_newest public.workflow_versions%ROWTYPE;
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
  -- A new workflow starts switched off on the money lane (#1706, #1707), with
  -- a first version of what it holds, so it is backed up at once (#2879).
  IF p_op = 'create' THEN
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'name_required' USING ERRCODE = 'BP422';
    END IF;
    INSERT INTO workflows (organization_id, name, description, definition, definition_schema_version, is_active, folder_id,
                           created_by, updated_by, updated_by_email, updated_by_name, last_save_id)
    VALUES (p_org, v_name, v_fields ->> 'description', v_def, v_stamp, false, v_folder,
            p_actor, p_actor, p_actor_email, nullif(p_actor_name, ''), p_save_id)
    RETURNING * INTO v_new;
    INSERT INTO workflow_versions (workflow_id, version_number, definition, definition_schema_version, created_by, message)
    VALUES (v_new.id, 1, v_new.definition, v_new.definition_schema_version, p_actor, 'Created')
    RETURNING id INTO v_version_id;
    RETURN jsonb_build_object('workflow', to_jsonb(v_new), 'version_id', v_version_id, 'version_number', 1);
  END IF;

  -- ── duplicate ──────────────────────────────────────────────────────────────
  -- p_id is the source. The copy is switched off, keeps the source's lane,
  -- folder, description and stamp, and its whole history without the source's
  -- commits, all in this transaction. It answers the version its definition is
  -- (#2879): the newest copied one when that holds exactly the copy's
  -- definition and stamp, otherwise a new one on top holding them.
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
    -- The caller's copy of the definition was read from the version it names;
    -- a save landing since would give the copy one definition and another's
    -- history and stamp, so it is refused and the copy made again.
    IF p_expected_version IS NOT NULL AND v_row.version <> p_expected_version THEN
      RAISE EXCEPTION 'stale_version' USING ERRCODE = 'BP409',
        DETAIL = jsonb_build_object('current', to_jsonb(v_row), 'last_save_id', v_row.last_save_id,
                                    'changed_by_name', v_row.updated_by_name, 'changed_at', v_row.updated_at)::text;
    END IF;
    INSERT INTO workflows (organization_id, name, description, definition, definition_schema_version, is_active, folder_id, lane,
                           created_by, updated_by, updated_by_email, updated_by_name, last_save_id)
    VALUES (p_org, v_name, v_row.description, v_def, v_row.definition_schema_version, false, v_row.folder_id, v_row.lane,
            p_actor, p_actor, p_actor_email, nullif(p_actor_name, ''), p_save_id)
    RETURNING * INTO v_new;
    -- commit_sha is left out: it names a commit of the source's file (#2879).
    INSERT INTO workflow_versions (workflow_id, version_number, definition, definition_schema_version, definition_report, created_by, created_at, message)
    SELECT v_new.id, v.version_number, v.definition, v.definition_schema_version, v.definition_report, v.created_by, v.created_at, v.message
    FROM workflow_versions v
    WHERE v.workflow_id = p_id;
    GET DIAGNOSTICS v_copied = ROW_COUNT;
    SELECT * INTO v_newest FROM workflow_versions v
    WHERE v.workflow_id = v_new.id
    ORDER BY v.version_number DESC
    LIMIT 1;
    IF v_newest.id IS NOT NULL AND v_newest.definition = v_new.definition
       AND v_newest.definition_schema_version IS NOT DISTINCT FROM v_new.definition_schema_version THEN
      v_version_id := v_newest.id;
      v_next := v_newest.version_number;
    ELSE
      v_next := coalesce(v_newest.version_number, 0) + 1;
      INSERT INTO workflow_versions (workflow_id, version_number, definition, definition_schema_version, created_by, message)
      VALUES (v_new.id, v_next, v_new.definition, v_new.definition_schema_version, p_actor, 'Duplicated from ' || v_row.name)
      RETURNING id INTO v_version_id;
    END IF;
    RETURN jsonb_build_object('workflow', to_jsonb(v_new), 'version_id', v_version_id, 'version_number', v_next,
                              'versions_copied', v_copied);
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
  'Every workflow write the Worker makes (#1947): create, duplicate, save, restore, patch (is_active, folder_id), delete (soft). Locks the row, refuses stale_version (BP409, DETAIL a JSON object: current row, last_save_id, changed_by_name, changed_at) when the stored version is not the expected one, writes a save''s or restore''s version snapshot in the same transaction, and takes a copied definition''s stamp from the row it copies. A create writes a first version and a duplicate copies the source''s history without its commit_sha, each answering the version its definition is, so the Worker backs it up at once (#2879). Refuses workflow_not_found, version_not_found and folder_not_found (P0002), and a malformed call by name (BP422). Returns {workflow, version_id?, version_number?, restored_from?, versions_copied?}; create, duplicate, save and restore answer version_id and version_number.';
REVOKE ALL ON FUNCTION public.write_workflow(text, uuid, uuid, integer, jsonb, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_workflow(text, uuid, uuid, integer, jsonb, uuid, uuid, text, text) TO service_role;
