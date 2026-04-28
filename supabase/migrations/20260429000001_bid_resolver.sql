-- Bid resolver abstraction (Slice 1)
--
-- Adds bid_resolver_type + bid_resolver_config + outbound_field_mapping to partner_configs.
-- The resolver type discriminates how a Partner Bid node gets a bid for this partner:
--   'formula' — evaluate bid_resolver_config.formula against the trigger payload
--   'matrix'  — look up bid_resolver_config.bid_config_id in partner_bid_configs (Slice 2)
--   'api'     — call the partner API endpoint and read the bid from the response
--
-- bid_formula is kept for one release (expand-contract). resolveBid reads bid_resolver_*
-- first, with a legacy fallback to bid_formula / api_endpoint so the old code path is
-- bit-identical until backfill lands.

ALTER TABLE partner_configs
  ADD COLUMN bid_resolver_type TEXT NOT NULL DEFAULT 'api'
    CHECK (bid_resolver_type IN ('formula', 'matrix', 'api')),
  ADD COLUMN bid_resolver_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN outbound_field_mapping JSONB;

-- Backfill: partners with a non-empty bid_formula and no api_endpoint -> 'formula' resolver.
-- Order matters: api_endpoint takes precedence in the legacy code path (partner-bid.ts:158),
-- so partners with both default to 'api' to preserve behavior.

UPDATE partner_configs
SET bid_resolver_type = 'formula',
    bid_resolver_config = jsonb_build_object('formula', bid_formula)
WHERE (api_endpoint IS NULL OR api_endpoint = '')
  AND bid_formula IS NOT NULL
  AND bid_formula <> '';

UPDATE partner_configs
SET bid_resolver_type = 'api'
WHERE api_endpoint IS NOT NULL AND api_endpoint <> '';
