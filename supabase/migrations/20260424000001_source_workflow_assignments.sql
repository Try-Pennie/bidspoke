-- Explicit assignment of API sources (keys) to workflows.
-- Semantics: empty = unrestricted; any row present for a source means that
-- source is locked to only the workflows listed. Enforced on the generic
-- /webhooks/:id path only; custom endpoints are self-granting.

CREATE TABLE source_workflow_assignments (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  source_name     TEXT NOT NULL,
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_name, workflow_id),
  FOREIGN KEY (organization_id, source_name)
    REFERENCES api_sources(organization_id, name) ON DELETE CASCADE
);

CREATE INDEX source_workflow_assignments_workflow
  ON source_workflow_assignments(workflow_id);
CREATE INDEX source_workflow_assignments_source
  ON source_workflow_assignments(organization_id, source_name);

ALTER TABLE source_workflow_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "source_workflow_assignments_org" ON source_workflow_assignments
  FOR ALL USING (organization_id = public.user_org_id());
