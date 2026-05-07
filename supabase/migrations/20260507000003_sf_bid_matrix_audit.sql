-- SF Bid Matrix Audit
--
-- Standalone hourly snapshot of every BidRangeRow__c row in Salesforce, kept
-- purely for change auditing. Independent of partner_bid_configs / bid_matrix_rows —
-- those exist for the bidding hot path; this exists so any human edit to the
-- matrix in Salesforce gets caught and posted to Slack, even if no Bidspoke
-- partner is currently configured to use the matrix as a resolver.
--
-- One row per SF Id. Cron compares the snapshot to a fresh SF query and
-- upserts the new state. No history table — Slack is the audit surface.

CREATE TABLE sf_bid_matrix_audit (
  source_id TEXT PRIMARY KEY,           -- SF record Id
  is_sell_off BOOLEAN NOT NULL DEFAULT false,
  row_id TEXT,                          -- SF RowId__c (for traceability)
  row_low NUMERIC, row_high NUMERIC,    -- dimension 1
  range_low NUMERIC, range_high NUMERIC,-- dimension 2 (nullable for 1-D)
  bid_amount NUMERIC NOT NULL,
  partner_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
                                        -- {IsSoFi__c: true, IsEPCVIP__c: false, ...}
                                        -- captured so flag-only edits also alert
  source_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No RLS: worker uses service-role key; no UI reads this table directly.
