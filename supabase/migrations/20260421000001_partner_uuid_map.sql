-- partner_uuid_map: maps external sub-account UUIDs → partner slugs
-- Multiple UUIDs per partner supported (e.g. SoFi has several sub-accounts)
CREATE TABLE partner_uuid_map (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_slug TEXT NOT NULL,
  uuid         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, uuid)
);

ALTER TABLE partner_uuid_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation" ON partner_uuid_map
  USING (org_id = (SELECT organization_id FROM users WHERE id = auth.uid()));

-- Sell-off offer copy — stored on partner_configs, shown by Constants node
ALTER TABLE partner_configs
  ADD COLUMN IF NOT EXISTS sell_off_offer_title TEXT,
  ADD COLUMN IF NOT EXISTS sell_off_offer_details TEXT;
