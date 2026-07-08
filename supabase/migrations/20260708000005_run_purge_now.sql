-- ============================================================
-- One-time manual run of the retried purge (verifying 20260708000004)
-- ============================================================
-- Runs a few hours ahead of the normal 03:30 UTC schedule to confirm the
-- retry fix actually clears the 2026-06-28/06-29/06-30 partitions that had
-- been stuck since before the fix, rather than waiting for tonight's run.
-- Idempotent: truncating an already-empty partition is a no-op.
CALL truncate_expired_execution_partitions(7);
