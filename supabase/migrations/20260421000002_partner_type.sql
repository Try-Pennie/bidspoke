ALTER TABLE partner_configs
  ADD COLUMN IF NOT EXISTS partner_type TEXT NOT NULL DEFAULT 'buyer'
    CHECK (partner_type IN ('source', 'buyer'));
