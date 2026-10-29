-- Purging finished ops runs, 90 days after they end (#3018).
--
-- Dan decided on 2026-10-29 (recorded on #3018): a finished ops run, its trigger
-- payload included, is kept 90 days after it ends, then the nightly purge
-- deletes it. The ops tick calls purge_terminal_run_requests (migration
-- 20261016200000) with a cutoff 90 days before the database clock
-- (FINISHED_RUN_KEPT_DAYS in apps/worker/src/ops/tick.ts). Migration
-- 20261030120000_schedule_fires_run_index_3018.sql indexes the one foreign key
-- into run_requests that had no index.
--
-- WHAT IT PROVES.
--   A. What deleting a finished run does to every row that names it: its
--      executions go (ON DELETE CASCADE), and their step records with them; a
--      schedule slot that started it stays, with its run_request_id set null
--      (ON DELETE SET NULL), so the slot still fires once; its send ledger rows
--      stay (no foreign key: the record of what was sent outlives the run).
--      A run ended 89 days ago, a kept run ended 200 days ago, and a run whose
--      chain still has a run going all stay.
--   B. schedule_fires has an index led by run_request_id, so the SET NULL each
--      deleted run sets off finds its slot through it: a page of purged runs
--      reads schedule_fires without a sequential scan. Without the index each
--      deleted run scanned the whole of schedule_fires, one row per slot every
--      ops schedule ever fired, and a nightly page would grow past the ops
--      project's 8 s statement timeout as the table grew.
--
-- TIME. now() is fixed inside a transaction, so time passing is simulated by
-- writing each row's terminal_at in the past as the table owner; no case sleeps.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE fp_cases (name text PRIMARY KEY);

-- From no run rows at all, rolled back with the rest: the purge is lane wide.
DELETE FROM public.send_ledger;
DELETE FROM public.schedule_fires;
DELETE FROM public.run_request_dedup_tombstones;
DELETE FROM public.run_requests;

-- One finished run as the table owner: ended p_ended_ago ago, from a schedule
-- slot, with one execution, one step record and one send ledger row.
CREATE FUNCTION pg_temp.fp_run(p_key text, p_ended_ago interval, p_chain uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_org constant uuid := 'aaaaaaaa-0000-4000-8000-000000003018';
  v_wf constant uuid := '00000000-0000-4000-8000-000000003018';
  v_id uuid := gen_random_uuid();
  v_exec uuid := gen_random_uuid();
  v_ended timestamptz := now() - p_ended_ago;
BEGIN
  INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, payload, status,
    not_before, max_attempts, dedup_expires_at, execution_chain_id, created_at, updated_at, terminal_at, attempts)
  VALUES (v_id, v_org, v_wf, 1, 'schedule', p_key, '{"scheduled_for": "x"}', 'done',
    v_ended - interval '1 minute', 3, v_ended + interval '30 days', coalesce(p_chain, v_id), v_ended - interval '1 minute', v_ended, v_ended, 1);
  INSERT INTO public.workflow_executions (id, organization_id, run_request_id, execution_chain_id, attempt, workflow_id, workflow_version,
    trigger_type, status, started_at, finished_at)
  VALUES (v_exec, v_org, v_id, coalesce(p_chain, v_id), 1, v_wf, 1, 'schedule', 'success', v_ended - interval '1 minute', v_ended);
  INSERT INTO public.ops_step_records (execution_id, seq, organization_id, run_request_id, workflow_id, execution_started_at,
    node_id, namespace, step_type, status, started_at, duration_ms)
  VALUES (v_exec, 0, v_org, v_id, v_wf, v_ended - interval '1 minute', 'n1', 'notify', 'app_action', 'completed', v_ended - interval '1 minute', 5);
  INSERT INTO public.send_ledger (organization_id, run_request_id, execution_chain_id, attempt, node_id, seq, method, host,
    idempotent, state_version, status, result_at)
  VALUES (v_org, v_id, coalesce(p_chain, v_id), 1, 'n1', 0, 'POST', 'hooks.example.test', false, 2, 'forwarded', v_ended);
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for, run_request_id, outcome)
  VALUES (v_org, v_wf, v_ended - interval '1 minute', v_id, 'enqueued');
  RETURN v_id;
END
$f$;

-- ── A. what deleting a finished run does to the rows that name it ─────────────
DO $do$
DECLARE
  v_old uuid;
  v_young uuid;
  v_kept uuid;
  v_blocked uuid;
  v_live uuid;
  v_old_exec uuid;
  r record;
BEGIN
  v_old := pg_temp.fp_run('old', interval '91 days');
  v_young := pg_temp.fp_run('young', interval '89 days');
  v_kept := pg_temp.fp_run('kept', interval '200 days');
  UPDATE public.run_requests SET kept_by = '00000000-0000-4000-8000-00000000babe', kept_at = now() WHERE id = v_kept;
  -- A finished run whose chain still has a run going (a rerun not yet ended).
  v_blocked := pg_temp.fp_run('blocked', interval '120 days');
  SELECT run_request_id INTO v_live FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000003018', p_workflow_id => '00000000-0000-4000-8000-000000003018',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'live');
  UPDATE public.run_requests SET execution_chain_id = v_blocked WHERE id = v_live;
  SELECT id INTO v_old_exec FROM public.workflow_executions WHERE run_request_id = v_old;

  SELECT * INTO r FROM public.purge_terminal_run_requests(now() - interval '90 days', 1000);
  IF r.purged <> 1 OR r.more THEN RAISE EXCEPTION 'the 90 day purge answered %, expected the one run ended 91 days ago', r; END IF;

  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_old) THEN RAISE EXCEPTION 'the run ended 91 days ago was not purged'; END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_old) THEN RAISE EXCEPTION 'the purged run left its execution'; END IF;
  IF EXISTS (SELECT 1 FROM public.ops_step_records WHERE execution_id = v_old_exec) THEN RAISE EXCEPTION 'the purged run left its step records'; END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_old) THEN RAISE EXCEPTION 'the purged run left a queue row'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schedule_fires WHERE scheduled_for = now() - interval '91 days' - interval '1 minute' AND run_request_id IS NULL) THEN
    RAISE EXCEPTION 'the purged run''s schedule slot was not kept with its run_request_id set null';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.send_ledger WHERE run_request_id = v_old) THEN RAISE EXCEPTION 'the purge took the send ledger with it'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_young) THEN RAISE EXCEPTION 'a run ended 89 days ago was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_kept) THEN RAISE EXCEPTION 'a kept run was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_blocked) THEN RAISE EXCEPTION 'a run whose chain is still going was purged'; END IF;
  IF (SELECT count(*) FROM public.schedule_fires WHERE run_request_id IN (v_young, v_kept, v_blocked)) <> 3 THEN
    RAISE EXCEPTION 'a slot of a run that was kept lost its run';
  END IF;
  INSERT INTO fp_cases VALUES ('A: a purged run takes its executions and step records, leaves its slot unlinked and its send ledger, and spares the young, the kept and the chained');
END
$do$;

-- ── B. the slot lookup each deleted run sets off is indexed ───────────────────
DO $do$
DECLARE
  v_seq_before bigint;
  v_seq_after bigint;
  r record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = 'public.schedule_fires'::regclass AND a.attname = 'run_request_id' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'schedule_fires has no index led by run_request_id, so every purged run scans the whole table to unlink its slot';
  END IF;

  -- History: 100,000 slots of other workflows, and 200 runs past the window, each from a slot.
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for, outcome)
  SELECT 'aaaaaaaa-0000-4000-8000-000000003018', ('00000000-0000-4000-8000-' || lpad(to_hex(10000 + g % 100), 12, '0'))::uuid,
    now() - g * interval '1 minute', 'enqueued'
  FROM generate_series(1, 100000) g;
  PERFORM pg_temp.fp_run('page-' || g, interval '100 days' + g * interval '1 second') FROM generate_series(1, 200) g;
  ANALYZE public.schedule_fires;
  ANALYZE public.run_requests;

  SELECT coalesce(seq_scan, 0) INTO v_seq_before FROM pg_stat_xact_user_tables WHERE relid = 'public.schedule_fires'::regclass;
  SELECT * INTO r FROM public.purge_terminal_run_requests(now() - interval '90 days', 1000);
  SELECT coalesce(seq_scan, 0) INTO v_seq_after FROM pg_stat_xact_user_tables WHERE relid = 'public.schedule_fires'::regclass;
  -- 200 of the page, plus the run ended 120 days ago, still held by its live chain.
  IF r.purged <> 200 THEN RAISE EXCEPTION 'the page purged %, expected 200', r.purged; END IF;
  IF v_seq_after <> v_seq_before THEN
    RAISE EXCEPTION 'purging 200 runs scanned schedule_fires sequentially % times', v_seq_after - v_seq_before;
  END IF;
  IF (SELECT count(*) FROM public.schedule_fires) < 100200 THEN RAISE EXCEPTION 'the purge deleted schedule slots'; END IF;
  INSERT INTO fp_cases VALUES ('B: a page of purged runs unlinks its slots through an index, never a scan of every slot');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM fp_cases);
BEGIN
  IF v_n <> 2 THEN RAISE EXCEPTION 'finished_run_purge: % of 2 cases ran', v_n; END IF;
  RAISE NOTICE 'finished_run_purge: % cases passed', v_n;
END
$do$;

ROLLBACK;
