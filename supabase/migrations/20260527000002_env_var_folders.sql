-- ============================================================
-- Env var folders: nested organizer for environment_variables
-- ============================================================
-- Mirrors the workflows-folders model (20260527000001_folders.sql).
-- Folders are org-scoped; any env var (global or workflow-scoped) can be
-- filed into any folder — folder_id is UI organization metadata only, not
-- a scope constraint. Engine reads env vars by key/scope/workflow_id and
-- never touches folder_id.
-- ============================================================

CREATE TABLE env_var_folders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id       UUID REFERENCES env_var_folders(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX env_var_folders_org_idx        ON env_var_folders (organization_id);
CREATE INDEX env_var_folders_org_parent_idx ON env_var_folders (organization_id, parent_id);

CREATE TRIGGER env_var_folders_updated_at
  BEFORE UPDATE ON env_var_folders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE env_var_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "env_var_folders_org" ON env_var_folders
  FOR ALL USING (organization_id = public.user_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON env_var_folders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON env_var_folders TO service_role;

CREATE OR REPLACE FUNCTION env_var_folders_prevent_cycle()
RETURNS TRIGGER AS $$
DECLARE cursor_id UUID := NEW.parent_id;
BEGIN
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'env_var_folder parent cycle detected';
    END IF;
    SELECT parent_id INTO cursor_id FROM env_var_folders WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER env_var_folders_prevent_cycle_trigger
  BEFORE INSERT OR UPDATE OF parent_id ON env_var_folders
  FOR EACH ROW EXECUTE FUNCTION env_var_folders_prevent_cycle();

-- ============================================================
-- environment_variables.folder_id
-- ============================================================
ALTER TABLE environment_variables
  ADD COLUMN folder_id UUID REFERENCES env_var_folders(id) ON DELETE SET NULL;

CREATE INDEX env_vars_folder_id_idx ON environment_variables (folder_id) WHERE folder_id IS NOT NULL;
