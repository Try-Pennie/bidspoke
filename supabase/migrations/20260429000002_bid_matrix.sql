-- Bid matrix tables (Slice 2)
--
-- partner_bid_configs owns the matrix definition: which Salesforce object to pull
-- from, which payload fields map to the row/range dimensions, and whether the
-- config is canonical-in-Salesforce ('salesforce' sync_source) or canonical-in-
-- Bidspoke ('manual', a follow-up). One partner can have multiple configs but
-- exactly one is_default.
--
-- bid_matrix_rows holds the actual matrix cells. row_low/row_high is dimension 1;
-- range_low/range_high is the optional second dimension. is_sell_off marks rows
-- used by the sell-off pricing path (same table in Salesforce; we mirror that
-- structure for ease of sync).
--
-- bid_config_history captures every change to a config or its rows. Source =
-- 'salesforce_sync' for cron-driven changes, 'user_edit' for the future editor.

CREATE TABLE partner_bid_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES partner_configs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sync_source TEXT NOT NULL DEFAULT 'salesforce'
    CHECK (sync_source IN ('salesforce', 'manual')),
  sf_object TEXT,                      -- e.g. 'BidRangeRow__c' (when sync_source='salesforce')
  sf_filters JSONB,                    -- partner flag / SOQL clauses to scope the SF query
  dimensions JSONB NOT NULL DEFAULT '[]'::jsonb,
                                       -- [{ name, payload_field, column: 'row'|'range' }]
                                       -- max 2 entries in v1; column='row' uses row_low/row_high,
                                       -- column='range' uses range_low/range_high
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,
  updated_by UUID,
  updated_by_email TEXT,
  updated_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, slug)
);
CREATE UNIQUE INDEX partner_bid_configs_default_idx
  ON partner_bid_configs (partner_id) WHERE is_default;
CREATE INDEX partner_bid_configs_org_idx
  ON partner_bid_configs (organization_id);

CREATE TABLE bid_matrix_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES partner_bid_configs(id) ON DELETE CASCADE,
  is_sell_off BOOLEAN NOT NULL DEFAULT false,
  row_id TEXT,                          -- SF RowId__c (for traceability)
  row_low NUMERIC, row_high NUMERIC,    -- dimension 1
  range_low NUMERIC, range_high NUMERIC,-- dimension 2 (nullable for 1-D)
  bid_amount NUMERIC NOT NULL,
  source_id TEXT,                       -- SF record Id when sync_source='salesforce'
  source_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (config_id, source_id)
);
CREATE INDEX bid_matrix_rows_lookup_idx
  ON bid_matrix_rows (config_id, is_sell_off);

CREATE TABLE bid_config_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL REFERENCES partner_bid_configs(id) ON DELETE CASCADE,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by UUID,
  source TEXT NOT NULL CHECK (source IN ('salesforce_sync', 'user_edit')),
  diff JSONB NOT NULL
);
CREATE INDEX bid_config_history_config_idx
  ON bid_config_history (config_id, changed_at DESC);

-- RLS: scope all reads/writes to the organization. Worker uses the service role
-- key and bypasses these; the policies exist so the JWT-authed REST API can use
-- the same Supabase client without extra org filtering.
ALTER TABLE partner_bid_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_matrix_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE bid_config_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bid_configs_org" ON partner_bid_configs
  FOR ALL USING (organization_id = public.user_org_id());

CREATE POLICY "bid_matrix_rows_org" ON bid_matrix_rows
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM partner_bid_configs c
      WHERE c.id = config_id AND c.organization_id = public.user_org_id()
    )
  );

CREATE POLICY "bid_config_history_org" ON bid_config_history
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM partner_bid_configs c
      WHERE c.id = config_id AND c.organization_id = public.user_org_id()
    )
  );
