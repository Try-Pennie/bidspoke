-- #332: attribute upstream-outage alerts to the actual failing service.
--
-- Records the node type of the step that failed on each failed execution, so the
-- upstream-outage aggregation (lib/upstream-outage.ts) can re-attribute a generic
-- timeout/abort failure to the upstream that was actually slow (e.g. a Salesforce
-- step that timed out) instead of bucketing it as a vague "Upstream timeout".
--
-- Expand/contract: additive, nullable, no default. Existing rows keep NULL (the
-- aggregation treats NULL as "no attribution" and falls back to the error-message
-- bucket). Safe to deploy in either order. Adding the column to the partitioned
-- parent applies it to all existing and future partitions.

ALTER TABLE public.workflow_executions
  ADD COLUMN IF NOT EXISTS failed_step_type text;

COMMENT ON COLUMN public.workflow_executions.failed_step_type IS
  'Node type of the step that failed (e.g. salesforce, code, partner_bid). Set at finalize for failed runs; used to attribute generic timeout/abort failures to the right upstream (#332).';
