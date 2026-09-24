-- ============================================================
-- lead_sightings.external_debt: the Engine window the trades fallback never fired (#1528)
-- ============================================================
-- Comment only; no data changes. The 2026-09-23 comment (#1482) says Engine rows
-- from about 22:30 UTC that day hold tradeCalculations.engineDebt. They do not,
-- yet: the fallback that reads the trades step gated on code nodes and the live
-- prospect_trades node is a Salesforce node, so until the #1528 deploy on
-- 2026-09-24 the figure landed only where the buyer_select node priced the lead
-- (its recorded lead_debt) and every other Engine row is null. Rows are left as
-- written (L61); the boundary is recorded where every reader of the column sees it.

COMMENT ON COLUMN public.lead_sightings.external_debt IS
  'The debt figure the pricing consulted, whole dollars. Main Flow: the bid_group context debt (finalDebt). Engine flow, rows finalized from the #1528 deploy on 2026-09-24 at 14:09 UTC: tradeCalculations.engineDebt from the prospect_trades step, the figure the Tripoint buyer profile prices on and the Salesforce ExternalExchangeRevenue__c formula multiplies (EngineDebt__c) since 2026-09-23; where a buyer_select node priced the lead, the lead_debt it recorded, which is the same figure. Engine rows finalized between 2026-09-23 about 22:30 UTC and that deploy: engineDebt where the node priced the lead, otherwise null, because the trades fallback read code nodes only and prospect_trades is a Salesforce node (#1528). Engine rows before 2026-09-23 about 22:30 UTC: ExternalDebtAmount__c, which the patch copies from tradeCalculations.enrollableDebt, a different figure on about 46 percent of eligible sell off leads (#1482). Null where the flow carries no debt figure (RML).';
