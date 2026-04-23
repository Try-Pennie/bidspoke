-- Add estimated cost column to workflow_executions.
-- The main engine writes the step-based slice at finalize time (partner + code
-- + Supabase). The tail-consumer worker adds the main-Worker CPU slice once
-- Cloudflare reports true cpuTime for the invocation.
--
-- cpu_ms is written by the tail consumer for visibility.

ALTER TABLE workflow_executions
  ADD COLUMN cost_usd NUMERIC(12, 8),
  ADD COLUMN cpu_ms INTEGER;
