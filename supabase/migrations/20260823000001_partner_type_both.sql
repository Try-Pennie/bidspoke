-- #306 / ADR 0001: a partner can be a source AND a buyer at once.
--
-- Engine supplies free leads inbound and acts as the fallback buyer outbound,
-- which the exclusive source | buyer vocabulary could only express as two
-- partner records for one company. A third value `both` carries both roles on
-- one record.
--
-- Expand-only and backward compatible: this WIDENS the accepted set, so code
-- deployed before this migration keeps writing 'source'/'buyer' unaffected, and
-- code deployed after it can write 'both' the moment the constraint is applied.
-- No existing row changes value, and nothing needs a contract step later.
--
-- The original constraint came from an inline CHECK on ADD COLUMN
-- (20260421000002_partner_type.sql), so Postgres named it
-- partner_configs_partner_type_check. Dropped by that name and re-added
-- explicitly named, so a future widening has a name to target rather than
-- depending on the auto-naming rule again.

ALTER TABLE partner_configs
  DROP CONSTRAINT IF EXISTS partner_configs_partner_type_check;

ALTER TABLE partner_configs
  ADD CONSTRAINT partner_configs_partner_type_check
    CHECK (partner_type IN ('source', 'buyer', 'both'));
