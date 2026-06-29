-- #419 / #410: dark write-time field-presence capture.
--
-- Stores a per-execution boolean map of whether each watched output field
-- carried a value this run. Computed at engine finalize from in-memory step
-- outputs, BEFORE PII redaction; only booleans persist, so no raw value is
-- stored. One row per execution (never per step), off the high-growth
-- execution_steps table. Key present => the producing node ran this execution
-- (the ran_count denominator); value => the field was non-null (present_count).
-- Read later by the Phase 2 field_presence_daily rollup.
--
-- Expand/contract: additive, nullable, no default. Existing rows keep NULL.
-- Adding the column to the partitioned parent applies it to all existing and
-- future partitions. Safe to deploy in either order; the FIELD_PRESENCE_CAPTURE
-- flag stays off until this is applied.

ALTER TABLE public.workflow_executions
  ADD COLUMN IF NOT EXISTS field_presence jsonb;

COMMENT ON COLUMN public.workflow_executions.field_presence IS
  'Per-execution boolean map: watched field path -> carried a value (non-null). Key present means the producing node ran. Booleans only; computed before PII redaction (#419).';
