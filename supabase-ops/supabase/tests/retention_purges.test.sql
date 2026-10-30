-- How long ops keeps the record of each schedule slot fired, the record of what
-- each run sent, and a purged run's dedup tombstone (#3052).
--
-- Dan decided on 2026-10-30 (recorded on #3052): schedule_fires is kept 6
-- months, send_ledger 1 year, and a dedup tombstone until its dedup window
-- ends. Migration 20261030210000_retention_purges_3052.sql adds
-- purge_schedule_fires and purge_send_ledger; purge_expired_dedup_tombstones
-- (20261016200000) already existed with no caller. The ops tick's nightly purge
-- (NIGHTLY_PURGE in apps/worker/src/ops/tick.ts) calls all three.
--
-- WHAT IT PROVES.
--   A. purge_schedule_fires deletes a slot more than 6 months old (one a minute
--      past the edge goes, one a minute short of it stays), and never a
--      workflow's latest slot however old, so the latest slot the tick plans
--      from (workflow_copies' last_served and replaced_last_slot) is the same
--      for every workflow before and after a purge.
--   B. purge_send_ledger deletes a row whose intent is more than a year old
--      (the same one minute edges), whether or not its run still exists, and
--      never a row of a run a person kept, of a run still waiting (for a
--      person, needs_human, or anything else not ended), or of a chain with a
--      run still going.
--   C. purge_expired_dedup_tombstones deletes a tombstone whose window has
--      ended and keeps one still open; and the nightly purge of finished runs
--      leaves no tombstone at all at today's windows (a run's dedup window is
--      30 days from its creation, and a run is purged 90 days after it ends),
--      which is why the tick sizes this purge at no rows a day.
--   D. Every lookup a page of either new purge makes has an index that keeps
--      it near the page, so a page's cost does not grow with the table: with
--      100,000 rows seeded and analysed and sequential scans priced out
--      (enable_seqscan off), a page of 1,000 reads under 20,000 rows and index
--      entries of schedule_fires and of send_ledger, and under 5,000 of the
--      20,000 run_requests, where a walk of a table reads all of it. At the suite's sizes the planner may
--      rightly prefer a scan, so this does not measure which plan production
--      gets, only that the near plan exists; without schedule_fires_age_idx
--      the only index path walks the whole unique key, and it fails.
--   E. Both refuse a limit outside 1 to 1000 by name, and answer more only
--      for a full page.
--   F. Both are SECURITY DEFINER with a fixed search_path, VOLATILE, and
--      executable by service_role alone; service_role still cannot delete
--      either table's rows directly.
--
-- TIME. now() is fixed inside a transaction, so time passing is simulated by
-- writing each row's times in the past as the table owner; no case sleeps.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE rp_cases (name text PRIMARY KEY);

-- From no rows at all, rolled back with the rest: every purge is lane wide.
DELETE FROM public.send_ledger;
DELETE FROM public.schedule_fires;
DELETE FROM public.run_request_dedup_tombstones;
DELETE FROM public.run_requests;

-- One slot fired for a workflow, as the table owner.
CREATE FUNCTION pg_temp.rp_fire(p_wf uuid, p_slot timestamptz)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for, outcome, recorded_at)
  VALUES ('aaaaaaaa-0000-4000-8000-000000003052', p_wf, p_slot, 'enqueued', p_slot)
  RETURNING id;
$f$;

-- One run as the table owner, in the status given (done ends it), created and
-- ended p_ago ago, in its own chain unless one is named.
CREATE FUNCTION pg_temp.rp_run(p_key text, p_status text, p_ago interval, p_chain uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_id uuid := gen_random_uuid();
  v_at timestamptz := now() - p_ago;
  v_ended boolean := p_status IN ('done', 'failed', 'dead', 'expired', 'skipped');
BEGIN
  INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, payload, status, status_reason,
    not_before, max_attempts, dedup_expires_at, execution_chain_id, created_at, updated_at, terminal_at, attempts)
  VALUES (v_id, 'aaaaaaaa-0000-4000-8000-000000003052', '00000000-0000-4000-8000-000000003052', 1, 'http_webhook', p_key, '{}', p_status,
    CASE p_status WHEN 'needs_human' THEN 'send_outcome_unknown' END,
    v_at, 3, v_at + interval '30 days', coalesce(p_chain, v_id), v_at, v_at, CASE WHEN v_ended THEN v_at END, 1);
  RETURN v_id;
END
$f$;

-- One send ledger row as the table owner, its intent written p_ago ago.
CREATE FUNCTION pg_temp.rp_send(p_run uuid, p_chain uuid, p_ago interval, p_seq integer DEFAULT 0)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.send_ledger (organization_id, run_request_id, execution_chain_id, attempt, node_id, seq, method, host,
    idempotent, state_version, status, intent_at, result_at)
  VALUES ('aaaaaaaa-0000-4000-8000-000000003052', p_run, p_chain, 1, 'n1', p_seq, 'POST', 'hooks.example.test',
    false, 2, 'forwarded', now() - p_ago, now() - p_ago + interval '1 second')
  RETURNING id;
$f$;

-- ── A. schedule_fires: 6 months, never a workflow's latest slot ────────────────
DO $do$
DECLARE
  v_wf constant uuid := '00000000-0000-4000-8000-00000000f001';
  v_lone constant uuid := '00000000-0000-4000-8000-00000000f002';
  v_old uuid;
  v_young uuid;
  v_latest uuid;
  v_lone_fire uuid;
  v_before jsonb;
  v_after jsonb;
  r record;
BEGIN
  v_old := pg_temp.rp_fire(v_wf, now() - interval '6 months' - interval '1 minute');
  v_young := pg_temp.rp_fire(v_wf, now() - interval '6 months' + interval '1 minute');
  v_latest := pg_temp.rp_fire(v_wf, now() - interval '1 day');
  -- A yearly schedule: its only slot is past the window, and it is that workflow's latest.
  v_lone_fire := pg_temp.rp_fire(v_lone, now() - interval '400 days');
  SELECT jsonb_object_agg(workflow_id, slot) INTO v_before FROM (SELECT workflow_id, max(scheduled_for) AS slot FROM public.schedule_fires GROUP BY 1) m;

  SELECT * INTO r FROM public.purge_schedule_fires(1000);
  IF r.purged <> 1 OR r.more THEN RAISE EXCEPTION 'the 6 month purge answered %, expected the one slot fired 6 months and a minute ago', r; END IF;
  IF EXISTS (SELECT 1 FROM public.schedule_fires WHERE id = v_old) THEN RAISE EXCEPTION 'the slot 6 months and a minute old was kept'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schedule_fires WHERE id = v_young) THEN RAISE EXCEPTION 'a slot a minute short of 6 months old was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schedule_fires WHERE id = v_latest) THEN RAISE EXCEPTION 'a workflow''s latest slot was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schedule_fires WHERE id = v_lone_fire) THEN
    RAISE EXCEPTION 'a workflow''s only slot was purged for its age, so the tick would plan it as never fired';
  END IF;
  SELECT jsonb_object_agg(workflow_id, slot) INTO v_after FROM (SELECT workflow_id, max(scheduled_for) AS slot FROM public.schedule_fires GROUP BY 1) m;
  IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'the purge moved a workflow''s latest slot: % became %', v_before, v_after; END IF;

  -- A second night finds nothing more to remove.
  SELECT * INTO r FROM public.purge_schedule_fires(1000);
  IF r.purged <> 0 OR r.more THEN RAISE EXCEPTION 'a second purge answered %, expected nothing', r; END IF;
  INSERT INTO rp_cases VALUES ('A: schedule_fires older than 6 months go at the minute edge, and every workflow keeps its latest slot');
END
$do$;

-- ── B. send_ledger: 1 year, never a kept, waiting or chained run's ─────────────
DO $do$
DECLARE
  v_gone_run uuid := gen_random_uuid();
  v_done uuid;
  v_kept uuid;
  v_waiting uuid;
  v_chain_old uuid;
  v_chain_live uuid;
  v_old uuid;
  v_young uuid;
  v_of_done uuid;
  v_of_kept uuid;
  v_of_waiting uuid;
  v_of_chain uuid;
  r record;
BEGIN
  -- A run already purged at its 90 days: its ledger rows stand alone (no foreign key).
  v_old := pg_temp.rp_send(v_gone_run, v_gone_run, interval '1 year' + interval '1 minute');
  v_young := pg_temp.rp_send(v_gone_run, v_gone_run, interval '1 year' - interval '1 minute', 1);
  -- A finished run that still exists (as one a person un-kept would): its row goes on its age alone.
  v_done := pg_temp.rp_run('done', 'done', interval '400 days');
  v_of_done := pg_temp.rp_send(v_done, v_done, interval '400 days');
  v_kept := pg_temp.rp_run('kept', 'done', interval '400 days');
  UPDATE public.run_requests SET kept_by = '00000000-0000-4000-8000-00000000babe', kept_at = now() WHERE id = v_kept;
  v_of_kept := pg_temp.rp_send(v_kept, v_kept, interval '400 days');
  -- Waiting for a person to say whether its send landed: the row is that person's evidence.
  v_waiting := pg_temp.rp_run('waiting', 'needs_human', interval '400 days');
  v_of_waiting := pg_temp.rp_send(v_waiting, v_waiting, interval '400 days');
  -- An ended run whose chain has a rerun still going.
  v_chain_old := pg_temp.rp_run('chain-old', 'done', interval '400 days');
  v_chain_live := pg_temp.rp_run('chain-live', 'queued', interval '1 minute', v_chain_old);
  v_of_chain := pg_temp.rp_send(v_chain_old, v_chain_old, interval '400 days');

  SELECT * INTO r FROM public.purge_send_ledger(1000);
  IF r.purged <> 2 OR r.more THEN RAISE EXCEPTION 'the 1 year purge answered %, expected the row a year and a minute old and the finished run''s', r; END IF;
  IF EXISTS (SELECT 1 FROM public.send_ledger WHERE id IN (v_old, v_of_done)) THEN RAISE EXCEPTION 'a send past a year was kept'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.send_ledger WHERE id = v_young) THEN RAISE EXCEPTION 'a send a minute short of a year old was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.send_ledger WHERE id = v_of_kept) THEN RAISE EXCEPTION 'the send of a kept run was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.send_ledger WHERE id = v_of_waiting) THEN RAISE EXCEPTION 'the send of a run waiting for a person was purged'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.send_ledger WHERE id = v_of_chain) THEN RAISE EXCEPTION 'the send of a run whose chain is still going was purged'; END IF;
  -- The purge touches only the ledger.
  IF (SELECT count(*) FROM public.run_requests WHERE id IN (v_done, v_kept, v_waiting, v_chain_old, v_chain_live)) <> 5 THEN
    RAISE EXCEPTION 'the send ledger purge deleted a run';
  END IF;
  INSERT INTO rp_cases VALUES ('B: sends older than a year go at the minute edge, never a kept, waiting or chained run''s');
END
$do$;

-- ── C. dedup tombstones: only past their window, and none written at 90 days ──
DO $do$
DECLARE
  v_run uuid;
  v_window interval;
  r record;
BEGIN
  INSERT INTO public.run_request_dedup_tombstones (workflow_id, trigger_kind, dedup_key, organization_id, run_request_id, dedup_expires_at)
  VALUES ('00000000-0000-4000-8000-000000003052', 'http_webhook', 'expired', 'aaaaaaaa-0000-4000-8000-000000003052', gen_random_uuid(), now() - interval '1 minute'),
         ('00000000-0000-4000-8000-000000003052', 'http_webhook', 'open', 'aaaaaaaa-0000-4000-8000-000000003052', gen_random_uuid(), now() + interval '1 minute');
  SELECT * INTO r FROM public.purge_expired_dedup_tombstones(1000);
  IF r.purged <> 1 OR r.more THEN RAISE EXCEPTION 'the tombstone purge answered %, expected the one past its window', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_request_dedup_tombstones WHERE dedup_key = 'open') THEN RAISE EXCEPTION 'a tombstone still in its window was purged'; END IF;

  -- The window a run is given when it is enqueued, read from the run itself.
  SELECT run_request_id INTO v_run FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000003052', p_workflow_id => '00000000-0000-4000-8000-000000003052',
    p_workflow_version => 1, p_trigger_kind => 'http_webhook', p_dedup_key => 'window');
  SELECT dedup_expires_at - created_at INTO v_window FROM public.run_requests WHERE id = v_run;
  IF v_window IS NULL OR v_window > interval '90 days' THEN
    RAISE EXCEPTION 'a run''s dedup window is %, longer than the 90 days a finished run is kept, so the nightly run purge writes tombstones', v_window;
  END IF;
  -- The same run, created, ended and so purged 91 days ago: its window closed long before.
  DELETE FROM public.run_queue WHERE run_request_id = v_run;
  UPDATE public.run_requests SET status = 'done', terminal_at = now() - interval '91 days', created_at = created_at - interval '91 days',
    updated_at = now() - interval '91 days', not_before = not_before - interval '91 days', dedup_expires_at = dedup_expires_at - interval '91 days'
  WHERE id = v_run;
  -- Case B's finished run, ended 400 days ago and not kept, goes in the same page.
  SELECT * INTO r FROM public.purge_terminal_run_requests(now() - interval '90 days', 1000);
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_run) THEN RAISE EXCEPTION 'the run ended 91 days ago was not purged'; END IF;
  IF r.tombstoned <> 0 OR EXISTS (SELECT 1 FROM public.run_request_dedup_tombstones WHERE run_request_id = v_run) THEN
    RAISE EXCEPTION 'purging runs 90 days after they ended answered %, and left a tombstone', r;
  END IF;
  INSERT INTO rp_cases VALUES ('C: tombstones go once their window ends, and the 90 day run purge writes none');
END
$do$;

-- ── D. each page reads near the page, never the whole table ──────────────────
-- Rows and index entries a table has given up in this transaction so far.
CREATE FUNCTION pg_temp.rp_read(p_rel regclass)
RETURNS bigint LANGUAGE sql AS $f$
  SELECT coalesce((SELECT seq_tup_read FROM pg_stat_xact_user_tables WHERE relid = p_rel), 0)
    + coalesce((SELECT sum(pg_stat_get_xact_tuples_returned(i.indexrelid)) FROM pg_index i WHERE i.indrelid = p_rel), 0);
$f$;

DO $do$
DECLARE
  v_fires bigint;
  v_ledger bigint;
  v_runs bigint;
  r record;
BEGIN
  -- A year of slots of 100 workflows every 5 minutes (105,000 rows), half past 6 months.
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for, outcome)
  SELECT 'aaaaaaaa-0000-4000-8000-000000003052', ('00000000-0000-4000-8000-' || lpad(to_hex(20000 + g % 100), 12, '0'))::uuid,
    now() - g * interval '5 minutes', 'enqueued'
  FROM generate_series(1, 105000) g;
  -- 20,000 finished runs inside their 90 days, and two years of sends (100,000 rows), half past a year.
  INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, payload, status,
    not_before, max_attempts, dedup_expires_at, execution_chain_id, created_at, updated_at, terminal_at, attempts)
  SELECT id, 'aaaaaaaa-0000-4000-8000-000000003052', '00000000-0000-4000-8000-000000003052', 1, 'http_webhook', 'seed-' || g, '{}', 'done',
    now() - g * interval '6 minutes', 3, now(), id, now() - g * interval '6 minutes', now(), now() - g * interval '6 minutes', 1
  FROM (SELECT gen_random_uuid() AS id, g FROM generate_series(1, 20000) g) s;
  INSERT INTO public.send_ledger (organization_id, run_request_id, execution_chain_id, attempt, node_id, seq, method, host,
    idempotent, state_version, status, intent_at, result_at)
  SELECT 'aaaaaaaa-0000-4000-8000-000000003052', run_id, run_id, 1, 'n1', 0, 'POST', 'hooks.example.test', false, 2, 'forwarded',
    now() - g * interval '10 minutes', now() - g * interval '10 minutes'
  FROM (SELECT gen_random_uuid() AS run_id, g FROM generate_series(1, 100000) g) s;
  ANALYZE public.schedule_fires;
  ANALYZE public.send_ledger;
  ANALYZE public.run_requests;

  -- Sequential scans priced out, so the planner takes an index path wherever one
  -- serves; what it then reads says whether that path stays near the page.
  PERFORM set_config('enable_seqscan', 'off', true);
  v_fires := pg_temp.rp_read('public.schedule_fires');
  SELECT * INTO r FROM public.purge_schedule_fires(1000);
  IF r.purged <> 1000 OR NOT r.more THEN RAISE EXCEPTION 'a full page of slots answered %', r; END IF;
  v_fires := pg_temp.rp_read('public.schedule_fires') - v_fires;

  v_ledger := pg_temp.rp_read('public.send_ledger');
  v_runs := pg_temp.rp_read('public.run_requests');
  SELECT * INTO r FROM public.purge_send_ledger(1000);
  IF r.purged <> 1000 OR NOT r.more THEN RAISE EXCEPTION 'a full page of sends answered %', r; END IF;
  v_ledger := pg_temp.rp_read('public.send_ledger') - v_ledger;
  v_runs := pg_temp.rp_read('public.run_requests') - v_runs;
  PERFORM set_config('enable_seqscan', 'on', true);

  -- A page of 1,000 reads a few entries a row (its candidates, one probe each,
  -- its deletes); a walk of the whole table reads 100,000 or more.
  IF v_fires > 20000 THEN RAISE EXCEPTION 'a page of 1,000 slots read % entries of schedule_fires, a walk of the table', v_fires; END IF;
  IF v_ledger > 20000 THEN RAISE EXCEPTION 'a page of 1,000 sends read % entries of send_ledger, a walk of the table', v_ledger; END IF;
  -- run_requests holds 20,000 here, so a walk of it reads 20,000; a probe that finds no run reads none.
  IF v_runs > 5000 THEN RAISE EXCEPTION 'a page of 1,000 sends read % entries of run_requests, a walk of the table', v_runs; END IF;
  RAISE NOTICE 'retention_purges D: a page read % schedule_fires entries, % send_ledger and % run_requests', v_fires, v_ledger, v_runs;
  INSERT INTO rp_cases VALUES ('D: a page of either purge reads near the page through an index, never the whole of schedule_fires, send_ledger or run_requests');
END
$do$;

-- ── E. the limit, and more only for a full page ──────────────────────────────
DO $do$
DECLARE
  v_fn text;
  v_limit integer;
  v_refused text;
  r record;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['purge_schedule_fires', 'purge_send_ledger'] LOOP
    FOREACH v_limit IN ARRAY ARRAY[0, 1001] LOOP
      v_refused := NULL;
      BEGIN
        EXECUTE format('SELECT * FROM public.%I($1)', v_fn) USING v_limit;
      EXCEPTION WHEN invalid_parameter_value THEN v_refused := SQLERRM;
      END;
      IF v_refused IS NULL OR v_refused NOT LIKE v_fn || ': limit must be 1 to 1000%' THEN RAISE EXCEPTION '% did not refuse a limit of % by name', v_fn, v_limit; END IF;
    END LOOP;
    BEGIN
      EXECUTE format('SELECT * FROM public.%I(NULL)', v_fn);
      RAISE EXCEPTION '% accepted a null limit', v_fn;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;

  DELETE FROM public.schedule_fires;
  DELETE FROM public.send_ledger;
  PERFORM pg_temp.rp_fire('00000000-0000-4000-8000-00000000f003', now() - interval '300 days' + g * interval '1 day') FROM generate_series(1, 4) g;
  PERFORM pg_temp.rp_send(gen_random_uuid(), gen_random_uuid(), interval '500 days') FROM generate_series(1, 3) g;
  SELECT * INTO r FROM public.purge_schedule_fires(2);
  IF r.purged <> 2 OR NOT r.more THEN RAISE EXCEPTION 'a full page of 2 slots answered %', r; END IF;
  SELECT * INTO r FROM public.purge_schedule_fires(2);
  IF r.purged <> 1 OR r.more THEN RAISE EXCEPTION 'the last slot of 3 past the window answered %', r; END IF;
  SELECT * INTO r FROM public.purge_send_ledger(2);
  IF r.purged <> 2 OR NOT r.more THEN RAISE EXCEPTION 'a full page of 2 sends answered %', r; END IF;
  SELECT * INTO r FROM public.purge_send_ledger(2);
  IF r.purged <> 1 OR r.more THEN RAISE EXCEPTION 'the last send of 3 answered %', r; END IF;
  INSERT INTO rp_cases VALUES ('E: both refuse a limit outside 1 to 1000 by name, and answer more only for a full page');
END
$do$;

-- ── F. privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
  v_n integer := 0;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('purge_schedule_fires', 'purge_send_ledger')
  LOOP
    v_n := v_n + 1;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = v_fn) <> 'v' THEN RAISE EXCEPTION 'the write function % is not VOLATILE', v_fn; END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn;
    END IF;
  END LOOP;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected purge_schedule_fires and purge_send_ledger once each, found % definitions', v_n; END IF;
  IF has_table_privilege('service_role', 'public.schedule_fires', 'DELETE') OR has_table_privilege('service_role', 'public.send_ledger', 'DELETE') THEN
    RAISE EXCEPTION 'service_role can delete schedule_fires or send_ledger rows directly, round the purge functions';
  END IF;
  INSERT INTO rp_cases VALUES ('F: both purges are definer, fixed search_path, volatile, service_role alone, and the tables stay read only to it');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM rp_cases);
BEGIN
  IF v_n <> 6 THEN RAISE EXCEPTION 'retention_purges: % of 6 cases ran', v_n; END IF;
  RAISE NOTICE 'retention_purges: % cases passed', v_n;
END
$do$;

ROLLBACK;
