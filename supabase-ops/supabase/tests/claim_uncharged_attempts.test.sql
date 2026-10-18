-- The claim answers uncharged_attempts (#2336, requirement of 2026-10-17 from
-- #2334 deploy 2).
--
-- WHY. Since resource_wait (migration 20261017230000) what a run is judged by
-- against max_attempts is its CHARGED count, attempts - uncharged_attempts, and
-- attempts keeps rising on every start because it is each execution's
-- identity. A claim that answered attempts and max_attempts alone left the
-- charged count to the database, so a run invocation comparing the two (to
-- decide a retry is its last) would misjudge every run that waited on the
-- Salesforce pool or had a lapse refunded.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a run that waited on the Salesforce pool is claimed with its uncharged
--      attempts, and the claim answer alone predicts whether a retry after this
--      claim's start ends the run, exactly as complete_run_request judges it,
--      where attempts and max_attempts alone would mispredict;
--   2. a lapse refunded by the sweep shows in the next claim's answer too;
--   3. a run that never waited answers 0, and every claimed row's answer is the
--      row's own column;
--   4. the claim keeps its one definition and its argument names, and answers
--      every column the Worker deployed before this migration reads, so the
--      migration can be applied before the code that reads the new column (L640).
--
-- The prediction the cases check, from the claim answer alone: a retry after
-- this claim's start ends the run dead when
--   attempts + 1 - uncharged_attempts - (1 if resume_reason is resource_wait) >= max_attempts,
-- because the start adds one attempt and, when resumed from a resource wait,
-- one uncharged attempt. lastChargedAttempt in apps/worker/src/ops/ops-writes.ts
-- is the Worker's copy of it.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE cu_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.cu_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.cu_enqueue(p_workflow uuid, p_key text, p_max_attempts integer DEFAULT 3)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000002336', p_workflow_id => p_workflow, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- The claim's answer for one run, as JSON so a case reads it by name.
CREATE FUNCTION pg_temp.cu_claim(p_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  v jsonb;
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT to_jsonb(c) INTO v FROM public.claim_run_requests('cu-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF v IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  RETURN v;
END
$f$;

CREATE FUNCTION pg_temp.cu_start(p_id uuid, p_claim jsonb) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000002336', p_id, (p_claim->>'claim_token')::uuid, gen_random_uuid());
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  RETURN (p_claim->>'claim_token')::uuid;
END
$f$;

-- A whole number from the claim answer. An absent key is an error, never NULL,
-- or every comparison with it would be NULL and the case would pass vacuously.
CREATE FUNCTION pg_temp.cu_n(p_claim jsonb, p_key text) RETURNS integer LANGUAGE plpgsql AS $f$
BEGIN
  IF jsonb_typeof(p_claim->p_key) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'the claim did not answer % as a number: %', p_key, p_claim;
  END IF;
  RETURN (p_claim->>p_key)::int;
END
$f$;

-- Whether a retry after this claim's start ends the run, from the answer alone.
CREATE FUNCTION pg_temp.cu_last(p_claim jsonb) RETURNS boolean LANGUAGE sql AS $f$
  SELECT pg_temp.cu_n(p_claim, 'attempts') + 1 - pg_temp.cu_n(p_claim, 'uncharged_attempts')
         - CASE WHEN p_claim->>'resume_reason' = 'resource_wait' THEN 1 ELSE 0 END >= pg_temp.cu_n(p_claim, 'max_attempts');
$f$;

CREATE FUNCTION pg_temp.cu_retry(p_id uuid, p_token uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT run_status FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000002336', p_id, p_token, 'retry', p_error => 'partner 503');
$f$;

CREATE FUNCTION pg_temp.cu_wait(p_id uuid, p_token uuid, p_cause text) RETURNS text LANGUAGE sql AS $f$
  SELECT run_status FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000002336', p_id, p_token, 'suspend',
    p_reason => 'resource_wait', p_error => p_cause, p_not_before => now());
$f$;

CREATE FUNCTION pg_temp.cu_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. a run that waited on the Salesforce pool ──────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  c jsonb;
BEGIN
  PERFORM pg_temp.cu_reset();
  v_id := pg_temp.cu_enqueue('00000000-0000-4000-8000-0000000023c1', 'waited-on-pool', 2);

  c := pg_temp.cu_claim(v_id);
  IF pg_temp.cu_n(c, 'attempts') <> 0 OR pg_temp.cu_n(c, 'uncharged_attempts') <> 0 THEN RAISE EXCEPTION 'a first claim answered %', c; END IF;
  v_tok := pg_temp.cu_start(v_id, c);                                   -- attempt 1, charged 1 of 2
  PERFORM pg_temp.cu_wait(v_id, v_tok, 'pool_full');
  c := pg_temp.cu_claim(v_id);
  v_tok := pg_temp.cu_start(v_id, c);                                   -- attempt 2, uncharged
  PERFORM pg_temp.cu_wait(v_id, v_tok, 'workflow_share_full');

  -- Claimed after two waits on the pool: attempts alone (2, so this start is
  -- the third of max 2) says the run is spent. One attempt is charged, and this
  -- start, resumed from a wait, is not, so a retry after it is not the last.
  c := pg_temp.cu_claim(v_id);
  IF pg_temp.cu_n(c, 'attempts') <> 2 OR pg_temp.cu_n(c, 'uncharged_attempts') <> 1 OR pg_temp.cu_n(c, 'max_attempts') <> 2 OR c->>'resume_reason' <> 'resource_wait' THEN
    RAISE EXCEPTION 'a claim after two waits on the pool answered %', c;
  END IF;
  IF pg_temp.cu_n(c, 'attempts') + 1 < pg_temp.cu_n(c, 'max_attempts') THEN RAISE EXCEPTION 'the case no longer separates attempts from the charged count'; END IF;
  IF pg_temp.cu_last(c) THEN RAISE EXCEPTION 'the claim answer predicts the end of a run with a charged attempt left: %', c; END IF;
  v_tok := pg_temp.cu_start(v_id, c);                                   -- attempt 3, uncharged
  IF pg_temp.cu_retry(v_id, v_tok) <> 'queued' THEN RAISE EXCEPTION 'the database ended a run the claim said had an attempt left: %', pg_temp.cu_row(v_id); END IF;

  -- Claimed as a retry: this start is charged, 2 of 2, so a retry after it ends the run.
  c := pg_temp.cu_claim(v_id);
  IF pg_temp.cu_n(c, 'attempts') <> 3 OR pg_temp.cu_n(c, 'uncharged_attempts') <> 2 OR c->>'resume_reason' <> 'retry' THEN
    RAISE EXCEPTION 'a retry claim after the waits answered %', c;
  END IF;
  IF NOT pg_temp.cu_last(c) THEN RAISE EXCEPTION 'the claim answer does not predict the end of a run on its last charged attempt: %', c; END IF;
  v_tok := pg_temp.cu_start(v_id, c);
  IF pg_temp.cu_retry(v_id, v_tok) <> 'dead' THEN RAISE EXCEPTION 'the database kept a run the claim said was spent: %', pg_temp.cu_row(v_id); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status_reason = 'max_attempts' AND attempts = 4 AND uncharged_attempts = 2) THEN
    RAISE EXCEPTION 'the spent run is %', pg_temp.cu_row(v_id);
  END IF;
  INSERT INTO cu_cases VALUES ('a run that waited on the Salesforce pool is claimed with its uncharged attempts, which predict the database''s own judgement');
END
$do$;

-- ── 2. a lapse refund shows in the next claim ────────────────────────────────
DO $do$
DECLARE
  v_id uuid;
  c jsonb;
BEGIN
  PERFORM pg_temp.cu_reset();
  v_id := pg_temp.cu_enqueue('00000000-0000-4000-8000-0000000023c2', 'lapsed', 1);
  c := pg_temp.cu_claim(v_id);
  PERFORM pg_temp.cu_start(v_id, c);
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_id;
  IF (SELECT retried FROM public.sweep_expired_leases(100)) <> 1 THEN RAISE EXCEPTION 'the lapse was not refunded: %', pg_temp.cu_row(v_id); END IF;
  c := pg_temp.cu_claim(v_id);
  IF pg_temp.cu_n(c, 'attempts') <> 1 OR pg_temp.cu_n(c, 'uncharged_attempts') <> 1 OR pg_temp.cu_n(c, 'max_attempts') <> 1 THEN
    RAISE EXCEPTION 'a claim after a refunded lapse answered %', c;
  END IF;
  IF NOT pg_temp.cu_last(c) THEN RAISE EXCEPTION 'the one charged attempt of a refunded run is not predicted last: %', c; END IF;
  INSERT INTO cu_cases VALUES ('a lapse refunded by the sweep shows in the next claim''s answer');
END
$do$;

-- ── 3. a run that never waited answers 0, and every answer is the row's ──────
DO $do$
DECLARE
  v_a uuid;
  v_b uuid;
  v_bad integer;
BEGIN
  PERFORM pg_temp.cu_reset();
  v_b := pg_temp.cu_enqueue('00000000-0000-4000-8000-0000000023c4', 'refunded');
  PERFORM pg_temp.cu_start(v_b, pg_temp.cu_claim(v_b));
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = v_b;
  PERFORM public.sweep_expired_leases(100);
  -- Enqueued only now, or the claim above (lane wide) would already have taken it.
  v_a := pg_temp.cu_enqueue('00000000-0000-4000-8000-0000000023c3', 'never-waited');
  UPDATE public.run_queue SET not_before = now() - interval '1 second';
  SELECT count(*) FILTER (WHERE c.uncharged_attempts IS DISTINCT FROM r.uncharged_attempts
                            OR (c.run_request_id = v_a AND c.uncharged_attempts <> 0)
                            OR (c.run_request_id = v_b AND c.uncharged_attempts <> 1))
         + 2 - count(*)
  INTO v_bad
  FROM public.claim_run_requests('cu-tick', 1000, 1000, 60) c JOIN public.run_requests r ON r.id = c.run_request_id;
  IF v_bad <> 0 THEN RAISE EXCEPTION '% claimed runs answered an uncharged count that is not the row''s, or were not claimed', v_bad; END IF;
  INSERT INTO cu_cases VALUES ('a run that never waited answers 0, and each answer is the row''s own column');
END
$do$;

-- ── 4. the Worker deployed before this migration keeps working ───────────────
-- What apps/worker/src/ops/ops-writes.ts on main at 9380ce0c (the code running
-- when this migration is applied) sends and reads, copied from it.
DO $do$
DECLARE
  v_fn record;
  v_args text[];
  v_cols text[];
  v_sent text[] := ARRAY['p_worker', 'p_limit', 'p_per_workflow', 'p_lease_seconds'];
  v_read text[] := ARRAY['run_request_id', 'organization_id', 'workflow_id', 'workflow_version', 'trigger_kind', 'claim_token',
    'claim_expires_at', 'state_version', 'attempts', 'max_attempts', 'resume_reason', 'execution_chain_id',
    'resumed_from_execution_id', 'payload', 'payload_ref'];
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'claim_run_requests') <> 1 THEN
    RAISE EXCEPTION 'claim_run_requests does not have exactly one definition, so PostgREST cannot resolve the deployed call';
  END IF;
  SELECT p.proargnames, p.pronargs INTO v_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'claim_run_requests';
  v_args := v_fn.proargnames[1:v_fn.pronargs];
  v_cols := v_fn.proargnames[v_fn.pronargs + 1:];
  IF v_args <> v_sent THEN RAISE EXCEPTION 'claim_run_requests takes %, the deployed Worker sends %', v_args, v_sent; END IF;
  IF NOT (v_cols @> v_read) THEN RAISE EXCEPTION 'claim_run_requests answers %, the deployed Worker reads %', v_cols, v_read; END IF;
  IF NOT ('uncharged_attempts' = ANY (v_cols)) THEN RAISE EXCEPTION 'claim_run_requests does not answer uncharged_attempts: %', v_cols; END IF;
  INSERT INTO cu_cases VALUES ('the claim keeps its definition and arguments, and answers every column the deployed Worker reads');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM cu_cases);
BEGIN
  IF v_n <> 4 THEN RAISE EXCEPTION 'claim_uncharged_attempts: % of 4 cases ran', v_n; END IF;
  RAISE NOTICE 'claim_uncharged_attempts: % cases passed', v_n;
END
$do$;

ROLLBACK;
