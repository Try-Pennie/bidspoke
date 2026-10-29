-- An index on schedule_fires.run_request_id, for the purge of finished runs (#3018).
--
-- Dan decided on 2026-10-29 (recorded on #3018): a finished ops run is kept 90
-- days after it ends, then the nightly purge deletes it. The ops tick now calls
-- purge_terminal_run_requests (20261016200000) every night, up to 1,000 runs a
-- page.
--
-- schedule_fires.run_request_id REFERENCES run_requests ON DELETE SET NULL, so
-- every run the purge deletes makes Postgres look for the slot that started it.
-- That column had no index, so each look was a sequential scan of the whole of
-- schedule_fires, which keeps one row per slot every ops schedule ever fired and
-- is never purged: a page of 1,000 runs meant 1,000 full scans, past the ops
-- project's 8 s statement timeout once the table grows. Measured on the suite's
-- container before this index: a page of 200 runs scanned schedule_fires 200
-- times (finished_run_purge.test.sql case B).
--
-- The other tables that name a run need nothing here: run_queue's key and
-- workflow_executions' (run_request_id, attempt) key already lead with the run,
-- ops_step_records' key leads with the execution, and send_ledger and the dedup
-- tombstones have no foreign key to run_requests.
--
-- WHAT IT DOES TO PRODUCTION ROWS: none. It builds one index. While it builds,
-- writes to schedule_fires wait (CREATE INDEX holds a SHARE lock). The ops lane
-- runs in observe mode (OPS_TICK_MODE unset), which writes no schedule_fires
-- row, so the table is empty or nearly so and the build is immediate. IF NOT
-- EXISTS makes a second apply do nothing.
--
-- Additive only (ADR 0007): an index, no grant to change (an index has none).
-- Guarded by supabase-ops/supabase/tests/finished_run_purge.test.sql.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS schedule_fires_run_request_idx ON public.schedule_fires (run_request_id);
