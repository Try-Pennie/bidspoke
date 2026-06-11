-- Trades payload joined onto achieve_evaluations at export time (issue #28).
--
-- Geoff's Achieve/FDR analysis needs offer outcomes joined against the trades
-- data, but trades step payloads live in execution_steps, whose rows age out
-- on the 7-day partition retention -- any query-time join has a short shelf
-- life. Instead the nightly export backfills this column from the execution's
-- trades_request step output (rows are at most ~1 day old at export, well
-- inside retention) and pushes the combined row to Snowflake, where it lives
-- permanently as a simple query.
ALTER TABLE achieve_evaluations ADD COLUMN IF NOT EXISTS trades JSONB;
