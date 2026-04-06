-- API sources table — stores source name + key for UI retrieval
-- Keys are org-scoped via RLS; the same key lives in API_KEY_MAP worker secret for auth

CREATE TABLE api_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  api_key         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, name)
);

ALTER TABLE api_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_sources_org" ON api_sources
  FOR ALL USING (organization_id = public.user_org_id());
