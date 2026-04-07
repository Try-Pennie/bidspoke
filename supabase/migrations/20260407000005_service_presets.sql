-- Service presets: org-defined HTTP service configs available in Integration nodes

CREATE TABLE service_presets (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL,
  auth_type        TEXT        NOT NULL DEFAULT 'none'
                               CHECK (auth_type IN ('none', 'api_key', 'bearer', 'basic')),
  base_url         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, slug)
);

ALTER TABLE service_presets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_presets_org" ON service_presets
  FOR ALL USING (organization_id = public.user_org_id());
