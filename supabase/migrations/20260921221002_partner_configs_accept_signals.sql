-- The accept half of a partner's response rules, and a key the buyer profile
-- tables can reference (#1409).
--
-- A partner's response rules have one home (L89). The decline half is the
-- existing response_classification, which Main Flow's bid group reads through
-- the classifier. The accept half is this column: the buyer_select node records
-- a sale as accepted only when EVERY accept signal matches (L181). The default is
-- an empty list, which accepts NOTHING: an empty accept list means the profile
-- cannot be enabled, which validateProfile and the form refuse (L72). Shape is
-- the same Signal shape as response_classification.rejection_signals, matched by
-- @bidspoke/buyer-profile.
--
-- The unique key on (id, organization_id) lets a child table reference both, so
-- the database itself forbids a profile row whose organization differs from its
-- partner's. The id is already unique, so this refuses nothing that exists.
--
-- Expand only: a nullable free column with a default and an index. Code and
-- schema deploy in either order.
ALTER TABLE public.partner_configs
  ADD COLUMN IF NOT EXISTS accept_signals jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.partner_configs.accept_signals IS
  'Accept rules for a sale to this partner: a sale is accepted only when every signal matches (#1409). Same Signal shape as response_classification.rejection_signals. Empty accepts nothing.';

ALTER TABLE public.partner_configs
  ADD CONSTRAINT partner_configs_id_organization_id_key UNIQUE (id, organization_id);
