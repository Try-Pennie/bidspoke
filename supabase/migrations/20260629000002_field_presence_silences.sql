-- Phase 4a (#423) of silent-output-field detection (#410). Author-set silences:
-- a (workflow, field) the detector should skip because the field is legitimately
-- allowed to be empty. reason is required so the coverage manifest can show why.
-- Additive/expand-only. Set/cleared via the field-coverage worker API.

CREATE TABLE field_presence_silences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL,
  field_path   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  UNIQUE (workflow_id, field_path)
);

CREATE INDEX field_presence_silences_workflow_idx ON field_presence_silences (workflow_id);

-- RLS: org-scoped via the workflows join (table has workflow_id, no
-- organization_id), identical shape to field_presence_daily_org. The worker uses
-- the service_role key and bypasses RLS; this gates direct PostgREST access.
ALTER TABLE field_presence_silences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "field_presence_silences_org" ON field_presence_silences
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );
