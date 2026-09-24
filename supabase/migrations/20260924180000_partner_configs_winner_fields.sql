-- ============================================================
-- partner_configs: the two buyer facts the Engine scripts carried as Tripoint literals (#1416)
-- ============================================================
-- build_response_body and patch_prospect_body wrote the Salesforce routing code
-- (2) and the Success, Duplicate and Fail mapping (Tripoint's result codes) as
-- literals, so a second buyer would have been routed and classified as Tripoint.
-- Both become partner settings the buyer_select node puts on the winning sale:
--   external_routing_code: the ExternalRoutingCode__c the prospect patch carries
--     for a sale to this buyer. Null until set; validateProfile refuses to enable
--     a buyer profile without one (L72), so the patch never carries a guessed route.
--   duplicate_signals: the decline answers that mean the buyer already holds the
--     lead, in the same Signal shape as accept_signals and
--     response_classification.rejection_signals (L89: one rule shape). A decline
--     matching one is Duplicate, any other decline is Fail; an empty list means
--     every decline is Fail, which is honest for a buyer with no such answer.
-- Tripoint's values (2, and codes 1003, 1004, 1020) are entered through the
-- partner page, never by this migration: a data change is a person's decision.
--
-- Expand only: two nullable or defaulted columns. Code and schema deploy in
-- either order. Both are audited by the partner_configs trigger, which records
-- every column it is not told to exclude.

ALTER TABLE public.partner_configs
  ADD COLUMN IF NOT EXISTS external_routing_code smallint,
  ADD COLUMN IF NOT EXISTS duplicate_signals jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.partner_configs.external_routing_code IS
  'The ExternalRoutingCode__c the Salesforce prospect patch carries for a sale to this buyer (#1416). Null until set; a buyer profile cannot be enabled without one.';
COMMENT ON COLUMN public.partner_configs.duplicate_signals IS
  'Decline answers that mean this buyer already holds the lead (#1416): a decline matching any of them is recorded as Duplicate, any other decline as Fail. Same Signal shape as accept_signals. Empty means every decline is Fail.';
