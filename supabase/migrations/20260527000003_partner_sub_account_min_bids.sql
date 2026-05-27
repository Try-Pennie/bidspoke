-- Per-sub-account minimum bid floors on partner_configs.
-- Shape: { "<sub-account-uuid>": <number>, ... }
-- Used for buyers that price by referrer (e.g. LendSwift takes leads
-- from N sub-accounts with N negotiated floors).
-- NULL = no per-UUID floors; partner_configs.min_bid is the only floor.

ALTER TABLE partner_configs
  ADD COLUMN IF NOT EXISTS sub_account_min_bids JSONB;
