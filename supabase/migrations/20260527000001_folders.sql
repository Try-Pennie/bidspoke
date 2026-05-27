-- ============================================================
-- Folders: nested organizer for workflows
-- ============================================================
-- One workflow lives in at most one folder. Folders can nest via parent_id.
-- Delete is blocked at the DB level when a folder contains other folders
-- (ON DELETE RESTRICT) so non-empty deletes return a clean 409 from the API.
-- workflows.folder_id ON DELETE SET NULL is defensive — direct SQL deletes
-- leave workflows at the root rather than failing the delete.
-- ============================================================

CREATE TABLE folders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id       UUID REFERENCES folders(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX folders_org_idx        ON folders (organization_id);
CREATE INDEX folders_org_parent_idx ON folders (organization_id, parent_id);

CREATE TRIGGER folders_updated_at
  BEFORE UPDATE ON folders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "folders_org" ON folders
  FOR ALL USING (organization_id = public.user_org_id());

-- Data API GRANTs (Oct 2026 PostgREST default change)
GRANT SELECT, INSERT, UPDATE, DELETE ON folders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON folders TO service_role;

-- Cycle guard: walk parent chain on insert/update, raise if it loops to self.
CREATE OR REPLACE FUNCTION folders_prevent_cycle()
RETURNS TRIGGER AS $$
DECLARE cursor_id UUID := NEW.parent_id;
BEGIN
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'folder parent cycle detected';
    END IF;
    SELECT parent_id INTO cursor_id FROM folders WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER folders_prevent_cycle_trigger
  BEFORE INSERT OR UPDATE OF parent_id ON folders
  FOR EACH ROW EXECUTE FUNCTION folders_prevent_cycle();

-- ============================================================
-- workflows.folder_id
-- ============================================================
ALTER TABLE workflows
  ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX workflows_folder_id_idx ON workflows (folder_id) WHERE folder_id IS NOT NULL;
