-- The run engine under concurrent callers (#1948).
--
-- WHY. Minute ticks overlap (Spike 0, docs/ops-ceilings-spike.md P1 and P4: a
-- tick lives up to 15 minutes, so several are live at once) and Cloudflare
-- retries a killed cron, so every write here is assumed to run beside itself. A
-- one session test cannot see that (L693): these cases hold one caller's
-- transaction open at the decision point while a second caller arrives.
--
-- WHAT IT PROVES.
--   A. Two claimers at once never claim one run twice, and a workflow's
--      concurrency limit holds across them: the second skips a workflow the
--      first is claiming rather than reading its permits before they commit.
--      Seen red with the per workflow advisory lock removed (3 active under 2).
--   B. Two enqueues of one key at once make one row: the second answers
--      duplicate with the first's id when the first commits, and inserts when
--      the first rolls back.
--   C. Two fires of one schedule slot at once make one run.
--   D. Two lease sweeps at once process each lapsed lease once.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). Data is committed so the second session can see it,
-- and removed at the start and the end. dblink is created and dropped here if
-- the database did not already have it.

\if :{?self_host}
\else
  \echo 'run_engine_concurrency.test.sql needs -v self_host=<container address>; run it through scripts/sql-suite/run.sh'
  SELECT 1 / 0;
\endif
SELECT set_config('re_test.self_host', :'self_host', false) AS self_host_set \gset

CREATE TEMP TABLE re_cc_cases (name text PRIMARY KEY);

-- Waits until the given backend is blocked on a lock, rather than sleeping a
-- fixed time and hoping it got there (L290). Gives up after about 5 s.
CREATE FUNCTION pg_temp.re_cc_wait_blocked(p_pid integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_i integer;
BEGIN
  FOR v_i IN 1..250 LOOP
    IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = p_pid AND wait_event_type = 'Lock') THEN RETURN; END IF;
    PERFORM pg_sleep(0.02);
  END LOOP;
  RAISE EXCEPTION 'backend % never blocked on a lock, so the race was not set up', p_pid;
END
$f$;

-- Every run engine row, of any organization: the claim and the sweeps are lane
-- wide, so a row this file committed and an aborted run left behind would be
-- claimed by the next case. Throwaway database only.
CREATE FUNCTION pg_temp.re_cc_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

SELECT pg_temp.re_cc_reset();
SELECT NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'dblink') AS re_cc_created_dblink \gset
CREATE EXTENSION IF NOT EXISTS dblink;

-- ── A. Two claimers ──────────────────────────────────────────────────────────
-- Four workflows of three runs each, the first limited to two at a time, all
-- committed. Created in workflow order so the claim's order is known.
DO $do$
DECLARE
  v_w integer;
  v_i integer;
BEGIN
  FOR v_w IN 1..4 LOOP
    FOR v_i IN 1..3 LOOP
      PERFORM public.enqueue_run_request(
        p_organization_id => 'cccccccc-0000-4000-8000-000000001948',
        p_workflow_id => ('00000000-0000-4000-8000-0000000cc00' || v_w)::uuid,
        p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'cc-' || v_w || '-' || v_i,
        p_concurrency_limit => CASE WHEN v_w = 1 THEN 2 END);
    END LOOP;
    UPDATE public.run_queue SET created_at = now() - make_interval(mins => 10 - v_w)
    WHERE workflow_id = ('00000000-0000-4000-8000-0000000cc00' || v_w)::uuid;
  END LOOP;
END
$do$;

DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('re_test.self_host'));
  v_a integer;
  v_b integer;
  v_c integer;
  v_w1_active integer;
  v_dupes integer;
BEGIN
  PERFORM dblink_connect('re_a', conn);
  PERFORM dblink_connect('re_b', conn);
  -- A claims five (two per workflow) and holds its transaction open.
  PERFORM dblink_exec('re_a', 'BEGIN');
  SELECT n INTO v_a FROM dblink('re_a', $q$SELECT count(*) FROM public.claim_run_requests('tick-a', 5, 2, 60)$q$) AS t(n bigint);
  -- B arrives while A is mid claim.
  SELECT n INTO v_b FROM dblink('re_b', $q$SELECT count(*) FROM public.claim_run_requests('tick-b', 100, 10, 60)$q$) AS t(n bigint);
  PERFORM dblink_exec('re_a', 'COMMIT');
  -- C after both: workflow 1 already holds its two permits.
  SELECT n INTO v_c FROM dblink('re_b', $q$SELECT count(*) FROM public.claim_run_requests('tick-c', 100, 10, 60)$q$) AS t(n bigint);
  PERFORM dblink_disconnect('re_a');
  PERFORM dblink_disconnect('re_b');

  SELECT count(*) INTO v_w1_active FROM public.run_requests
  WHERE workflow_id = '00000000-0000-4000-8000-0000000cc001' AND status IN ('claimed', 'running');
  IF v_w1_active > 2 THEN RAISE EXCEPTION 'two concurrent claimers put % runs of a limit 2 workflow in flight (A %, B %, C %)', v_w1_active, v_a, v_b, v_c; END IF;
  IF v_a <> 5 THEN RAISE EXCEPTION 'A claimed %, expected 5', v_a; END IF;
  -- B skipped the three workflows A was claiming and took the fourth whole.
  IF v_b <> 3 THEN RAISE EXCEPTION 'B claimed %, expected the 3 of the workflow A was not claiming', v_b; END IF;
  -- Every run claimed exactly once, nothing left queued but workflow 1's third.
  SELECT count(*) - count(DISTINCT id) INTO v_dupes FROM public.run_requests WHERE organization_id = 'cccccccc-0000-4000-8000-000000001948' AND status = 'claimed';
  IF v_dupes <> 0 THEN RAISE EXCEPTION 'a run was claimed twice'; END IF;
  IF (SELECT count(*) FROM public.run_queue WHERE organization_id = 'cccccccc-0000-4000-8000-000000001948') <> 1 THEN
    RAISE EXCEPTION 'expected only workflow 1''s third run left queued, found %', (SELECT count(*) FROM public.run_queue WHERE organization_id = 'cccccccc-0000-4000-8000-000000001948');
  END IF;
  INSERT INTO re_cc_cases VALUES ('two claimers at once: no run claimed twice, a concurrency limit holds across them');
END
$do$;

SELECT pg_temp.re_cc_reset();

-- ── B. Two enqueues of one key ───────────────────────────────────────────────
DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('re_test.self_host'));
  call text := $q$SELECT outcome || ' ' || run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'cccccccc-0000-4000-8000-000000001948', p_workflow_id => '00000000-0000-4000-8000-0000000cc0e1',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'race-%s')$q$;
  v_first text;
  v_second text;
  v_round text;
  v_b_pid integer;
BEGIN
  PERFORM dblink_connect('re_a', conn);
  PERFORM dblink_connect('re_b', conn);
  SELECT pid INTO v_b_pid FROM dblink('re_b', 'SELECT pg_backend_pid()') AS t(pid integer);
  FOREACH v_round IN ARRAY ARRAY['COMMIT', 'ROLLBACK'] LOOP
    PERFORM dblink_exec('re_a', 'BEGIN');
    SELECT r INTO v_first FROM dblink('re_a', format(call, v_round)) AS t(r text);
    PERFORM dblink_send_query('re_b', format(call, v_round));
    -- B is now waiting on A's uncommitted row.
    PERFORM pg_temp.re_cc_wait_blocked(v_b_pid);
    PERFORM dblink_exec('re_a', v_round);
    SELECT r INTO v_second FROM dblink_get_result('re_b') AS t(r text);
    PERFORM * FROM dblink_get_result('re_b') AS t(r text);
    IF v_round = 'COMMIT' AND v_second <> 'duplicate ' || split_part(v_first, ' ', 2) THEN
      RAISE EXCEPTION 'a racing repeat after the first committed answered "%" (first "%")', v_second, v_first;
    END IF;
    IF v_round = 'ROLLBACK' AND split_part(v_second, ' ', 1) <> 'inserted' THEN
      RAISE EXCEPTION 'a racing enqueue after the first rolled back answered "%"', v_second;
    END IF;
  END LOOP;
  PERFORM dblink_disconnect('re_a');
  PERFORM dblink_disconnect('re_b');
  IF (SELECT count(*) FROM public.run_requests WHERE workflow_id = '00000000-0000-4000-8000-0000000cc0e1') <> 2 THEN
    RAISE EXCEPTION 'two racing pairs left % rows, expected 2', (SELECT count(*) FROM public.run_requests WHERE workflow_id = '00000000-0000-4000-8000-0000000cc0e1');
  END IF;
  INSERT INTO re_cc_cases VALUES ('two enqueues of one key at once: duplicate when the first commits, inserted when it rolls back');
END
$do$;

SELECT pg_temp.re_cc_reset();

-- ── C. Two fires of one slot ─────────────────────────────────────────────────
DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('re_test.self_host'));
  call text := $q$SELECT outcome FROM public.record_schedule_fire('cccccccc-0000-4000-8000-000000001948',
    '00000000-0000-4000-8000-0000000cc5c1', 1, '2026-10-16T14:00:00Z', NULL)$q$;
  v_first text;
  v_second text;
  v_b_pid integer;
BEGIN
  PERFORM dblink_connect('re_a', conn);
  PERFORM dblink_connect('re_b', conn);
  SELECT pid INTO v_b_pid FROM dblink('re_b', 'SELECT pg_backend_pid()') AS t(pid integer);
  PERFORM dblink_exec('re_a', 'BEGIN');
  SELECT r INTO v_first FROM dblink('re_a', call) AS t(r text);
  PERFORM dblink_send_query('re_b', call);
  PERFORM pg_temp.re_cc_wait_blocked(v_b_pid);
  PERFORM dblink_exec('re_a', 'COMMIT');
  SELECT r INTO v_second FROM dblink_get_result('re_b') AS t(r text);
  PERFORM * FROM dblink_get_result('re_b') AS t(r text);
  PERFORM dblink_disconnect('re_a');
  PERFORM dblink_disconnect('re_b');
  IF v_first <> 'enqueued' OR v_second <> 'already_recorded' THEN RAISE EXCEPTION 'racing fires answered % and %', v_first, v_second; END IF;
  IF (SELECT count(*) FROM public.run_requests WHERE workflow_id = '00000000-0000-4000-8000-0000000cc5c1') <> 1 THEN
    RAISE EXCEPTION 'two racing fires of one slot made % runs', (SELECT count(*) FROM public.run_requests WHERE workflow_id = '00000000-0000-4000-8000-0000000cc5c1');
  END IF;
  INSERT INTO re_cc_cases VALUES ('two fires of one slot at once make one run');
END
$do$;

SELECT pg_temp.re_cc_reset();

-- ── D. Two sweeps ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_i integer;
BEGIN
  FOR v_i IN 1..4 LOOP
    PERFORM public.enqueue_run_request(p_organization_id => 'cccccccc-0000-4000-8000-000000001948',
      p_workflow_id => '00000000-0000-4000-8000-0000000cc5e1', p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'sw-' || v_i);
  END LOOP;
  PERFORM public.claim_run_requests('tick-s', 10, 10, 60);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE workflow_id = '00000000-0000-4000-8000-0000000cc5e1';
END
$do$;

DO $do$
DECLARE
  conn text := format('host=%s user=postgres password=postgres dbname=postgres', current_setting('re_test.self_host'));
  v_a integer;
  v_b integer;
BEGIN
  PERFORM dblink_connect('re_a', conn);
  PERFORM dblink_connect('re_b', conn);
  PERFORM dblink_exec('re_a', 'BEGIN');
  SELECT n INTO v_a FROM dblink('re_a', $q$SELECT requeued FROM public.sweep_expired_leases(100)$q$) AS t(n integer);
  SELECT n INTO v_b FROM dblink('re_b', $q$SELECT requeued FROM public.sweep_expired_leases(100)$q$) AS t(n integer);
  PERFORM dblink_exec('re_a', 'COMMIT');
  PERFORM dblink_disconnect('re_a');
  PERFORM dblink_disconnect('re_b');
  IF v_a <> 4 OR v_b <> 0 THEN RAISE EXCEPTION 'concurrent sweeps requeued % and %, expected 4 and 0', v_a, v_b; END IF;
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE workflow_id = '00000000-0000-4000-8000-0000000cc5e1' AND lease_requeues <> 1) THEN
    RAISE EXCEPTION 'a lapsed lease was swept twice';
  END IF;
  INSERT INTO re_cc_cases VALUES ('two sweeps at once process each lapsed lease once');
END
$do$;

SELECT pg_temp.re_cc_reset();
\if :re_cc_created_dblink
  DROP EXTENSION dblink;
\endif

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM re_cc_cases);
BEGIN
  IF v_n <> 4 THEN RAISE EXCEPTION 'run_engine_concurrency: % of 4 cases ran', v_n; END IF;
  RAISE NOTICE 'run_engine_concurrency: % cases passed', v_n;
END
$do$;
