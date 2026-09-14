-- Geoff's Equifax figures from Salesforce, stored beside our own rather than instead of them.
--
-- The two are both correct and answer different questions. Ours, in achieve-credit-metrics.ts,
-- describe the consumer's credit profile, which is what Achieve underwrite against: their
-- reason code says "ratio of balance to limit on bank revolving or other rev accts". Geoff's
-- describe what Pennie could enrol, after excluding credit unions, student loans, cross
-- collateralised accounts and excluded creditors.
--
-- Measured 2026-09-14 across the 12 leads sent to Achieve that day, the two disagreed on 9. On
-- one, the credit report held three open revolving accounts totalling 6,091 of 7,500 while
-- Salesforce held 0 of 1,400, which is exactly one of the three. So Salesforce counts a
-- different SET of accounts, not a different total, and replacing ours with these would import
-- Pennie's enrollment rules into a dataset built to predict somebody else's underwriting.
--
-- Filled at EXPORT time from the submission id each row already carries, which keeps Salesforce
-- off the live lead path and lets rows already collected be filled too.
--
-- Expand only: nullable with no default, so code and schema deploy in either order. See #1350.
ALTER TABLE public.achieve_evaluations
  ADD COLUMN IF NOT EXISTS enrollment_view jsonb;

COMMENT ON COLUMN public.achieve_evaluations.enrollment_view IS
  'Equifax figures from the Salesforce Submission record: the ENROLLMENT view, meaning debt Pennie could enrol after excluding credit unions, student loans, cross collateralised and excluded creditors. Stored beside credit_metrics, never instead of it: the two count different sets of accounts and answer different questions. Filled at export time from the submission id on the row. Null where the record or the credentials could not be read. See issue 1350.';
