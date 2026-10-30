-- How long ops keeps the record of each schedule slot fired and the record of
-- what each run sent (#3052).
--
-- Dan decided on 2026-10-30 (recorded on #3052): schedule_fires is kept 6
-- months and send_ledger 1 year, then the nightly purge deletes them. Until now
-- nothing deleted either, so each grew without limit once the ops lane ran
-- workflows. The ops tick's nightly purge (NIGHTLY_PURGE in
-- apps/worker/src/ops/tick.ts, #3053) calls both functions below, and also
-- purge_expired_dedup_tombstones (20261016200000), which had no caller.
--
-- WHAT.
--   purge_schedule_fires(limit)  deletes up to limit slots fired more than 6
--     months before the database's now, oldest first, except each workflow's
--     LATEST slot, whatever its age. The window lives here, so no caller can
--     purge sooner. The latest slot stays because the tick plans every schedule
--     from it (workflow_copies' last_served, and replaced_last_slot for a
--     workflow that replaces another), and a schedule firing less often than
--     every 6 months would otherwise be planned as if it had never fired (L5),
--     as purge_schedule_observations keeps its latest observation (#1950).
--     A row deleted here therefore always has a later slot of its workflow, so
--     it is before the slot the tick plans from, which planFires never fires
--     again; and it is also months outside the furthest back any fire is
--     planned (the 5 minute due window and the 72 hour longest catch up
--     window, packages/workflow-definition MAX_FIRE_AGE_MS). The unique slot
--     key is never asked about it again.
--     It keeps no slot for its run: the run's own payload names its slot, and
--     the foreign key is from the slot to the run, so nothing else changes.
--   purge_send_ledger(limit)  deletes up to limit send ledger rows whose intent
--     was written more than a year before the database's now, oldest first,
--     except the rows of a run a person kept (kept means exempt from every
--     purge), of a run not ended (a run waiting for a person to say whether
--     its send landed, needs_human, is not terminal, and its ledger row is the
--     evidence that person reads), and of a chain with a run still going (the
--     run purge's own rule). The ledger has no foreign key to run_requests on
--     purpose, so it outlives the run's 90 days; most rows it deletes belong
--     to runs purged long before.
--   Both answer (purged, more), more saying a full page went; both refuse a
--   limit outside 1 to 1000 by name; both skip rows another session holds
--   rather than waiting on them, and set lock_timeout 2 s, inside the ops
--   project's 8 s statement timeout, as every run engine function does.
--
-- INDEXES. schedule_fires had no index its age could be read through: its
-- unique (workflow_id, scheduled_for) key leads with the workflow, so the only
-- index path for a page walked the whole key (measured: 312,894 entries read
-- for a page of 1,000 out of 105,000 slots). schedule_fires_age_idx
-- (scheduled_for, id) is the order the purge reads in; the latest slot check
-- is a probe of the unique key. send_ledger_intent_idx (intent_at,
-- 20261016200000) is already the order its purge reads in, and the run checks
-- are a probe of run_requests' key and of run_requests_live_chain_idx. Each
-- check is a correlated scalar subquery rather than EXISTS, so it always runs
-- as one probe per candidate row: Postgres turns an EXISTS into a join it may
-- plan as a hash over a scan of the other table, and at the suite's 20,000
-- runs it did. Each page then deletes its rows by key (id = ANY of the page's
-- ids), which the primary key serves. Postgres still chooses by cost, and at
-- the suite's sizes a scan can be the cheaper plan; what matters, and
-- retention_purges.test.sql case D proves with scans priced out, is that a
-- plan reading near the page exists for every step (about 4,000 entries read
-- for a page of 1,000). No table has a foreign key INTO schedule_fires or
-- send_ledger, so a delete sets off no other lookup.
--
-- WHAT IT DOES TO PRODUCTION ROWS: none when applied. It builds one index and
-- creates two functions; rows are deleted only when the tick calls them. While
-- the index builds, writes to schedule_fires wait (CREATE INDEX holds a SHARE
-- lock). The ops lane runs in observe mode (OPS_TICK_MODE unset), which writes
-- no schedule_fires row, so the table is empty or nearly so and the build is
-- immediate. IF NOT EXISTS makes a second apply build nothing. Once the tick
-- calls them, the first night deletes nothing that is not past its window: no
-- slot is 6 months old and no send a year old yet, since the run engine first
-- shipped on 2026-10-16.
--
-- Additive only (ADR 0007): an index and two new functions, nothing existing
-- changes. Guarded by supabase-ops/supabase/tests/retention_purges.test.sql.

SET lock_timeout = '5s';

-- ── purge_schedule_fires ─────────────────────────────────────────────────────
-- The purge reads by age, oldest first.
CREATE INDEX IF NOT EXISTS schedule_fires_age_idx ON public.schedule_fires (scheduled_for, id);

CREATE FUNCTION public.purge_schedule_fires(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - interval '6 months';
  v_ids uuid[];
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_schedule_fires: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT array_agg(old.id) INTO v_ids FROM (
    SELECT f.id FROM public.schedule_fires f
    WHERE f.scheduled_for < v_cutoff
      -- Never a workflow's latest slot: the tick plans the schedule from it.
      -- A scalar subquery, probed row by row (see INDEXES above).
      AND (SELECT 1 FROM public.schedule_fires n WHERE n.workflow_id = f.workflow_id AND n.scheduled_for > f.scheduled_for LIMIT 1) IS NOT NULL
    ORDER BY f.scheduled_for, f.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) old;
  -- By key, through the primary key (see INDEXES above).
  DELETE FROM public.schedule_fires f WHERE f.id = ANY (v_ids);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

-- ── purge_send_ledger ────────────────────────────────────────────────────────
CREATE FUNCTION public.purge_send_ledger(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - interval '1 year';
  v_ids uuid[];
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_send_ledger: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only ledger rows are locked, so the run engine's lock order (run_queue,
  -- run_requests, send_ledger) is never taken in reverse.
  SELECT array_agg(old.id) INTO v_ids FROM (
    SELECT l.id FROM public.send_ledger l
    WHERE l.intent_at < v_cutoff
      -- Never the send of a run a person kept, or of one not ended. Scalar
      -- subqueries, probed row by row (see INDEXES above).
      AND (SELECT 1 FROM public.run_requests r WHERE r.id = l.run_request_id AND (r.kept_by IS NOT NULL OR r.terminal_at IS NULL) LIMIT 1) IS NULL
      -- Nor of a chain with a run still going.
      AND (SELECT 1 FROM public.run_requests live WHERE live.execution_chain_id = l.execution_chain_id AND live.terminal_at IS NULL LIMIT 1) IS NULL
    ORDER BY l.intent_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) old;
  -- By key, as purge_schedule_fires deletes.
  DELETE FROM public.send_ledger l WHERE l.id = ANY (v_ids);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
-- service_role only, as #1948 left the run engine's. A new function begins with
-- the platform's default grants, so they are revoked again here.
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('purge_schedule_fires', 'purge_send_ledger')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

RESET lock_timeout;
