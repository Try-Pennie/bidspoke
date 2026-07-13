-- Make achieve_evaluations.is_sandbox fail SAFE.
--
-- The column shipped with DEFAULT FALSE while the node's logging hook defaults the flag to
-- TRUE when absent. Those disagree, and the database wins: during the deploy gap between the
-- migration (18:11 UTC) and the worker actually shipping the flag, every sandbox row was
-- inserted WITHOUT the column and silently took the DEFAULT FALSE, i.e. it claimed to be real
-- production data. 109 rows (85 accepted, 340 fabricated offers made to Achieve's seeded test
-- identity) were mislabelled that way. That is exactly the analysis poisoning the flag exists
-- to prevent.
--
-- An unflagged row must be assumed SANDBOX. The two errors are not symmetric: labelling
-- production data as sandbox merely excludes it from the analysis (recoverable, and obvious
-- when volume looks low); labelling sandbox data as production injects fake offer amounts and
-- APRs alongside real ones with nothing to tell them apart (silent, and it corrupts the answer).
ALTER TABLE achieve_evaluations
  ALTER COLUMN is_sandbox SET DEFAULT TRUE;

-- Repair the mislabelled rows. Every one is unambiguously a sandbox call: ACHIEVE_API_URL has
-- been api-stg since 15:54 UTC and the earliest bad row is 18:11 UTC, so no production traffic
-- exists in this window. (The only production attempts, 15:47-15:54, returned 401 and never
-- wrote a row.)
UPDATE achieve_evaluations
SET is_sandbox = TRUE
WHERE requested_at_utc >= '2026-07-13 18:00:00'   -- partition-key predicate: don't scan every partition
  AND is_sandbox = FALSE;
