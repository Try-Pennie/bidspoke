-- ============================================================
-- lead_sightings.external_debt: which figure it holds, and from when (#1482)
-- ============================================================
-- Comment only; no data changes. The meaning of the column changed at a point
-- in time and rows before it are left as written (L61), so the boundary is
-- recorded where every reader of the column can see it.

COMMENT ON COLUMN public.lead_sightings.external_debt IS
  'The debt figure the pricing consulted, whole dollars. Main Flow: the bid_group context debt (finalDebt). Engine flow, rows finalized from 2026-09-23 about 22:30 UTC: tradeCalculations.engineDebt, the figure the Tripoint buyer profile prices on and the Salesforce ExternalExchangeRevenue__c formula multiplies (EngineDebt__c) since that day; once a buyer_select node is placed, the lead_debt it recorded. Engine rows before that: ExternalDebtAmount__c, which the patch copies from tradeCalculations.enrollableDebt, a different figure on about 46 percent of eligible sell off leads (#1482). Null where the flow carries no debt figure (RML).';
