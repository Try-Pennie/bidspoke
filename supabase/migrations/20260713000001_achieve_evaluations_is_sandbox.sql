-- Flag Achieve evaluations that were made against the SANDBOX endpoint.
--
-- Off production the achieve_offers node substitutes Achieve's seeded showroom identity
-- (their sandbox only returns offers for its own seeded profiles). So the offers and the
-- accept/decline on those rows describe a FAKE person and say nothing about our real leads.
--
-- The rows are NOT worthless: the lead volume and the real debt figure sent are genuine, and
-- volume is exactly what the FDR analysis is for. So we flag rather than hide them. Using
-- is_test would have hidden them from the Snowflake export and from every documented
-- analysis query, throwing away the real volume signal with the fake offer signal.
--
-- Additive and defaulted (expand/contract safe): existing code that never writes the column
-- keeps working, and old rows are backfilled below.
ALTER TABLE achieve_evaluations
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN achieve_evaluations.is_sandbox IS
  'True when the call went to Achieve''s sandbox, where the request carries their seeded showroom identity. Offers and accept/decline on these rows are for a fake person; lead volume and the debt sent are real. Exclude from any offer-quality analysis.';

-- Every row written before this migration was a sandbox call: ACHIEVE_API_URL pointed at
-- api-stg for the whole period, and the one brief production window (2026-07-13 15:47-15:49
-- UTC) returned 401s that never produced a row. So the backfill is unconditional.
UPDATE achieve_evaluations
SET is_sandbox = TRUE
WHERE requested_at_utc >= '2026-07-01'   -- partition-key predicate: avoids scanning every partition
  AND is_sandbox = FALSE;

-- Lets the analysis and the export filter on the flag without a seq scan as the table grows.
CREATE INDEX IF NOT EXISTS achieve_evaluations_is_sandbox_idx
  ON achieve_evaluations (is_sandbox, requested_at_utc);
