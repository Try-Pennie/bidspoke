-- The claim path never reads history (#1948, #1698 design D9).
--
-- WHY. run_requests keeps every run, 30 days of terminal rows by default, beside
-- the few waiting ones. A claim or sweep that scans that history gets slower as
-- it grows (graphile measured about 40 against 843 claims a second for stuck rows
-- in the claim index) and, on the ops project's 8 s statement timeout
-- (docs/ops-ceilings-spike.md P8), eventually stops answering at all. So waiting
-- runs are claimed from run_queue, and every periodic read of run_requests is
-- served by a partial index over the live rows it needs.
--
-- HOW. 30 days of terminal rows at the modelled volume (50,000 a day, P9 of the
-- spike, so 1,500,000 rows) plus a queued backlog are seeded and analysed, then
-- each periodic function is called and the table's own counters for THIS
-- transaction (pg_stat_xact_user_tables) are read: no sequential scan of
-- run_requests, and no more rows fetched than the work could need. Measured on
-- the real functions, not on a copy of their SQL beside them.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back.

BEGIN;

CREATE TEMP TABLE re_cp_cases (name text PRIMARY KEY) ON COMMIT DROP;

-- From no run rows at all (the claim is lane wide, so a leftover would change
-- every count below), rolled back with the rest.
DELETE FROM public.send_ledger;
DELETE FROM public.run_requests;

-- 30 days of terminal runs over 200 workflows, and 2,000 waiting runs over 50.
INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, status,
  not_before, max_attempts, dedup_expires_at, execution_chain_id, created_at, updated_at, terminal_at, attempts)
SELECT id, 'dddddddd-0000-4000-8000-000000001948', ('00000000-0000-4000-8000-' || lpad(to_hex(g % 200), 12, '0'))::uuid, 1,
  'http_webhook', 'hist-' || g, 'done', ts, 3, ts + interval '30 days', id, ts, ts, ts, 1
FROM (SELECT g, gen_random_uuid() AS id, now() - (g * interval '1728 milliseconds') AS ts FROM generate_series(1, 1500000) g) s;

DO $do$
BEGIN
  PERFORM public.enqueue_run_request(
    p_organization_id => 'dddddddd-0000-4000-8000-000000001948',
    p_workflow_id => ('00000000-0000-4000-8000-' || lpad(to_hex(1000 + g % 50), 12, '0'))::uuid,
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'wait-' || g)
  FROM generate_series(1, 2000) g;
END
$do$;

ANALYZE public.run_requests;
ANALYZE public.run_queue;

CREATE TEMP TABLE re_cp_before ON COMMIT DROP AS
SELECT relname, seq_scan, coalesce(idx_tup_fetch, 0) AS idx_tup_fetch, seq_tup_read FROM pg_stat_xact_user_tables WHERE relname = 'run_requests';

-- Reads one function's cost on run_requests since the last call, and resets the baseline.
CREATE FUNCTION pg_temp.re_cp_cost(p_what text, p_max_fetch bigint) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  b record;
  a record;
BEGIN
  SELECT * INTO b FROM re_cp_before;
  SELECT seq_scan, coalesce(idx_tup_fetch, 0) AS idx_tup_fetch, seq_tup_read INTO a FROM pg_stat_xact_user_tables WHERE relname = 'run_requests';
  -- A NULL bound is the test's own setup: only the baseline moves.
  IF p_max_fetch IS NOT NULL AND a.seq_scan - b.seq_scan <> 0 THEN
    RAISE EXCEPTION '% scanned run_requests sequentially (% scans, % rows read)', p_what, a.seq_scan - b.seq_scan, a.seq_tup_read - b.seq_tup_read;
  END IF;
  IF a.idx_tup_fetch - b.idx_tup_fetch > p_max_fetch THEN
    RAISE EXCEPTION '% fetched % run_requests rows through an index, more than the % its work needs', p_what, a.idx_tup_fetch - b.idx_tup_fetch, p_max_fetch;
  END IF;
  UPDATE re_cp_before SET seq_scan = a.seq_scan, idx_tup_fetch = a.idx_tup_fetch, seq_tup_read = a.seq_tup_read;
END
$f$;

DO $do$
DECLARE v_n integer;
BEGIN
  PERFORM pg_temp.re_cp_cost('seeding', NULL);
  SELECT count(*) INTO v_n FROM public.claim_run_requests('tick-cp', 100, 5, 60);
  IF v_n <> 100 THEN RAISE EXCEPTION 'the claim took %, expected 100', v_n; END IF;
  -- Measured: 100 (the claimed rows). The bounds here are set well above the
  -- work and far below history (1.5 million), so they fail on a read of history,
  -- not on a planner choosing a different index over the live rows.
  PERFORM pg_temp.re_cp_cost('claim_run_requests', 1000);
  INSERT INTO re_cp_cases VALUES ('claim: no sequential scan of 1.5 million terminal rows');
END
$do$;

DO $do$
BEGIN
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE organization_id = 'dddddddd-0000-4000-8000-000000001948' AND status = 'claimed';
  PERFORM pg_temp.re_cp_cost('setting up the sweep', NULL);
  IF (SELECT requeued FROM public.sweep_expired_leases(1000)) <> 100 THEN RAISE EXCEPTION 'the sweep did not requeue the 100 lapsed leases'; END IF;
  -- Measured: 400 (100 lapsed leases, each read, updated and requeued).
  PERFORM pg_temp.re_cp_cost('sweep_expired_leases', 2000);
  PERFORM public.expire_overdue_run_requests(1000);
  PERFORM pg_temp.re_cp_cost('expire_overdue_run_requests', 1000);
  PERFORM count(*) FROM public.run_queue_disagreements(1000);
  -- Measured: 4,004 (each of the 2,000 waiting runs read from the queue's side
  -- and from its own): proportional to what waits, never to history.
  PERFORM pg_temp.re_cp_cost('run_queue_disagreements', 10000);
  INSERT INTO re_cp_cases VALUES ('sweep, expiry and agreement: no sequential scan of history');
END
$do$;

DO $do$
BEGIN
  IF (SELECT purged FROM public.purge_terminal_run_requests(now() - interval '29 days', 1000)) <> 1000 THEN RAISE EXCEPTION 'the purge did not take a page of 1000'; END IF;
  -- Measured: 2,002 (1,000 deleted, each checked against its chain through the
  -- live chain index).
  PERFORM pg_temp.re_cp_cost('purge_terminal_run_requests', 10000);
  INSERT INTO re_cp_cases VALUES ('purge: a page of 1000 without a sequential scan of history');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM re_cp_cases);
BEGIN
  IF v_n <> 3 THEN RAISE EXCEPTION 'run_engine_claim_path: % of 3 cases ran', v_n; END IF;
  RAISE NOTICE 'run_engine_claim_path: % cases passed', v_n;
END
$do$;

ROLLBACK;
