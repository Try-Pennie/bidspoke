-- Webhook endpoints — custom *.trypennie.dev inbound URLs for partners
-- Each row maps (subdomain, path) → workflow_id so partners get branded URLs
-- instead of generic /webhooks/:id URLs.
--
-- Example: subdomain='tripoint', path='/bidding'
--   → POST https://tripoint.trypennie.dev/bidding executes workflow_id

CREATE TABLE webhook_endpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subdomain       TEXT NOT NULL,                    -- e.g. 'tripoint' (becomes tripoint.trypennie.dev)
  path            TEXT NOT NULL DEFAULT '/webhook', -- e.g. '/bidding'
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  source_name     TEXT NOT NULL,                    -- value of trigger.source in executions
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subdomain, path)
);

CREATE INDEX webhook_endpoints_subdomain_idx ON webhook_endpoints(subdomain);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_endpoints_org" ON webhook_endpoints
  FOR ALL USING (organization_id = public.user_org_id());
