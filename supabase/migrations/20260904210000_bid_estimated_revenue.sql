-- ============================================================
-- Estimated revenue per bid attempt (#354)
-- ============================================================
-- Tripoint's createLead response carries no amount, so `bid_cents` is null on
-- every Tripoint row outside Main Flow: measured over the 7 days to 2026-09-04,
-- 503 of 3,163 accepted Tripoint bids carry a price, and all 503 come from Main
-- Flow, where a bid_group node resolves one. That is roughly 2,660 wins a week
-- with no record of what the lead was worth. The other three partners are
-- already complete (LendSwift 2,583 of 2,583, GigFi 1,357 of 1,357, AmOne 331
-- of 331), so this column exists for the Tripoint case.
--
-- WHY NOT bid_cents. `bid_cents` means what a buyer OFFERED us, on every row
-- that table holds. The figure filled here is
-- `Prospect__c.ExternalExchangeRevenue__c`, which Salesforce reports as
-- `DataType: Formula (Currency)`, `IsCalculated: true`: it is our own derivation
-- from the prospect's debt, not a number Tripoint sent. Sharing the column would
-- make every later sum part measurement and part estimate with nothing
-- announcing it, including in the Snowflake view. That is the same reasoning
-- that kept the quoted rate out of it in 20260904170000.
--
-- It is also known to disagree with Bidspoke's own Tripoint pricing by about
-- 10%: the config prices at 0.0013 of debt above $12,499 while the Salesforce
-- formula works out to roughly 0.00144 on live leads. Tracked separately as
-- #1166, and deliberately NOT reconciled here: recording the Salesforce figure
-- under its own name is honest about which system it came from, whereas writing
-- it into bid_cents would have hidden the disagreement.
--
-- Nullable with NO DEFAULT, so this is a metadata-only change. A defaulted
-- column would rewrite every monthly partition of a table the live bidding
-- engine writes to.
ALTER TABLE public.lead_sighting_bids
  ADD COLUMN IF NOT EXISTS estimated_revenue_cents INTEGER;

COMMENT ON COLUMN public.lead_sighting_bids.estimated_revenue_cents IS
  'Our ESTIMATE of what this lead was worth, in cents, read back from the Salesforce formula field Prospect__c.ExternalExchangeRevenue__c (#354). Not a partner-reported bid: bid_cents is the column for that. Null means no estimate was recorded, which includes every row written before this column and every row exported before the fill job reached it.';

-- NO INDEX on purpose. The fill job selects on `attempted_at_utc`, which is the
-- partition key, so the time bound prunes; within a partition it reads a window
-- of minutes, not the table. CREATE INDEX on a partitioned parent cascades to
-- every partition under ACCESS EXCLUSIVE, which is not a lock worth taking on
-- the table the bidding engine writes to for a job that runs on a few dozen rows.
