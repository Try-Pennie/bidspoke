-- ============================================================
-- Make bid-attempt writes idempotent under replay (#340)
-- ============================================================
-- recordBidAttempt (engine/lead-sightings.ts) retries transient failures via
-- withDbRetry. A retry whose first write LANDED but whose response was lost
-- would insert a second bid row, inflating Snowflake bid counts. This UNIQUE
-- constraint lets the write be ON CONFLICT DO NOTHING (the engine now upserts
-- with ignoreDuplicates), so a replay is a no-op.
--
-- The unique key MUST include attempted_at_utc: lead_sighting_bids is RANGE
-- partitioned on attempted_at_utc, and Postgres requires a unique constraint on
-- a partitioned table to contain the partition column. (execution_id,
-- partner_slug) alone is rejected.
--
-- This does NOT collapse legitimate double-pings of the same partner in one run:
-- each attempt stamps a distinct attempted_at_utc (set once at attempt start in
-- BidAttemptInsert), so the third key column keeps both rows. Note the finalize
-- winner UPDATE matches on (execution_id, partner_slug) only (lead-sightings.ts)
-- and the #88 ordering rule (partner-bid.ts) still holds — this constraint only
-- de-dupes a replay of the SAME logical attempt, never two real attempts.

ALTER TABLE lead_sighting_bids
  ADD CONSTRAINT lead_sighting_bids_attempt_uniq
  UNIQUE (execution_id, partner_slug, attempted_at_utc);
