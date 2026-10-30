-- A run whose variables the bidding Worker refused fails by name (#3131).
-- Migration 20261031010000_variables_refused_3131.sql.
--
-- The minute tick asks the bidding Worker for a claimed run's variables before
-- it starts the run; a run the bidding Worker refuses is ended, never started
-- (run-variables.ts refusedRunEnd). Until this migration its status_reason was
-- NULL and nothing paged. The tick now sends the reason variables_refused,
-- which it pages for a switched on workflow.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. a claimed run, never started, that the holder fails with
--      variables_refused ends failed with that reason, its error kept, spends
--      no attempt and leaves the queue; a started run fails by it alike;
--   2. the CHECK holds the reason: written straight to a row it is accepted on
--      a failed run, and a reason the vocabulary does not name is still
--      refused;
--   3. a holder still cannot fail a run for an engine only reason (F122), a
--      failed with no reason still ends failed with NULL, as the ops Worker
--      deployed when this is applied may send it, and variable_unavailable and
--      retry_disabled still end failed by their own names;
--   4. the ops Worker deployed when this migration is applied keeps working:
--      one definition of complete_run_request, the arguments it sends and the
--      columns it reads; it is SECURITY DEFINER with a fixed search_path and
--      executable by service_role alone.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE vr_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.vr_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.vr_enqueue(p_key text, p_max_attempts integer)
RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000003131', p_workflow_id => '00000000-0000-4000-8000-0000000031a1', p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => p_max_attempts);
$f$;

-- Claim the one run (due now), as the tick does before it asks for the run's variables; answers the claim token.
CREATE FUNCTION pg_temp.vr_claim(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_tok uuid;
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT c.claim_token INTO v_tok FROM public.claim_run_requests('vr-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF v_tok IS NULL THEN RAISE EXCEPTION 'run % was not claimable: %', p_id, (SELECT row_to_json(x) FROM public.run_requests x WHERE id = p_id); END IF;
  RETURN v_tok;
END
$f$;

-- Claim the one run and start it; answers the claim token.
CREATE FUNCTION pg_temp.vr_claim_and_start(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_tok uuid := pg_temp.vr_claim(p_id);
  s record;
BEGIN
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000003131', p_id, v_tok, gen_random_uuid());
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  RETURN v_tok;
END
$f$;

CREATE FUNCTION pg_temp.vr_row(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT row_to_json(x)::text FROM public.run_requests x WHERE id = p_id;
$f$;

-- ── 1. a run failed with variables_refused ends failed by that name ──────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_attempts integer;
  c record;
  v_error text := 'variables_refused (secret_unreadable): the secret variable env.API_TOKEN would not decrypt on the bidding Worker, so nothing was run';
BEGIN
  PERFORM pg_temp.vr_reset();
  -- As the tick ends it: claimed, never started.
  v_id := pg_temp.vr_enqueue('refused-claimed', 5);
  v_tok := pg_temp.vr_claim(v_id);
  SELECT attempts INTO v_attempts FROM public.run_requests WHERE id = v_id;
  SELECT * INTO c FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003131', v_id, v_tok, 'failed',
    p_reason => 'variables_refused', p_error => v_error);
  IF c.outcome <> 'completed' OR c.run_status <> 'failed' THEN
    RAISE EXCEPTION 'a claimed run failed with variables_refused answered % and left %', c, pg_temp.vr_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'variables_refused'
                 AND terminal_at = now() AND claim_expires_at IS NULL AND attempts = v_attempts AND max_attempts = 5 AND last_error = v_error) THEN
    RAISE EXCEPTION 'a claimed run failed with variables_refused is %', pg_temp.vr_row(v_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_queue WHERE run_request_id = v_id) THEN
    RAISE EXCEPTION 'a run failed with variables_refused is still queued';
  END IF;

  -- A started run fails by it alike, its attempt ended failed with the error.
  v_id := pg_temp.vr_enqueue('refused-started', 5);
  v_tok := pg_temp.vr_claim_and_start(v_id);
  SELECT * INTO c FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003131', v_id, v_tok, 'failed',
    p_reason => 'variables_refused', p_error => v_error);
  IF c.outcome <> 'completed' OR NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = 'variables_refused') THEN
    RAISE EXCEPTION 'a started run failed with variables_refused is %', pg_temp.vr_row(v_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workflow_executions WHERE run_request_id = v_id AND attempt = 1 AND status = 'failed' AND error = v_error) THEN
    RAISE EXCEPTION 'the attempt of a started run failed with variables_refused was not ended failed with its error';
  END IF;
  INSERT INTO vr_cases VALUES ('a run a holder fails with variables_refused ends failed by that name, claimed or started, spending no attempt it did not start');
END
$do$;

-- ── 2. the CHECK holds the reason, and still refuses an unnamed one ──────────
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_refused boolean := false;
BEGIN
  PERFORM pg_temp.vr_reset();
  v_id := pg_temp.vr_enqueue('check-holds', 3);
  v_tok := pg_temp.vr_claim_and_start(v_id);
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003131', v_id, v_tok, 'failed', p_error => 'boom');
  -- As the table owner, straight to the row: the CHECK alone decides.
  UPDATE public.run_requests SET status_reason = 'variables_refused' WHERE id = v_id;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status_reason = 'variables_refused') THEN
    RAISE EXCEPTION 'the CHECK did not hold variables_refused on a failed run: %', pg_temp.vr_row(v_id);
  END IF;
  BEGIN
    UPDATE public.run_requests SET status_reason = 'secret_unreadable' WHERE id = v_id;
  EXCEPTION WHEN check_violation THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'the status reason CHECK took a reason it does not name'; END IF;
  INSERT INTO vr_cases VALUES ('the status reason CHECK holds variables_refused and still refuses a reason it does not name');
END
$do$;

-- ── 3. engine only reasons stay refused, and the deployed reasons are unchanged ─
DO $do$
DECLARE
  v_id uuid;
  v_tok uuid;
  v_reason text;
  v_refused boolean;
  c record;
BEGIN
  PERFORM pg_temp.vr_reset();
  v_id := pg_temp.vr_enqueue('engine-only', 3);
  v_tok := pg_temp.vr_claim_and_start(v_id);
  FOREACH v_reason IN ARRAY ARRAY['resource_wait_exceeded', 'lease_lapsed_repeatedly', 'requeue_cap_reached', 'max_attempts', 'variable_refused', 'secret_unreadable'] LOOP
    v_refused := false;
    BEGIN
      PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003131', v_id, v_tok, 'failed', p_reason => v_reason, p_error => 'boom');
    EXCEPTION WHEN invalid_parameter_value THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a holder failed a run for %, which is not a holder reason: %', v_reason, pg_temp.vr_row(v_id); END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'running') THEN
    RAISE EXCEPTION 'a refused failed changed the run: %', pg_temp.vr_row(v_id);
  END IF;

  -- A failed with no reason, as an older Worker sends a refusal, still ends failed with NULL.
  SELECT * INTO c FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003131', v_id, v_tok, 'failed', p_error => 'refused');
  IF c.outcome <> 'completed' OR c.run_status <> 'failed' THEN RAISE EXCEPTION 'a reasonless failed answered %', c; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason IS NULL AND terminal_at = now()) THEN
    RAISE EXCEPTION 'a reasonless failed is %', pg_temp.vr_row(v_id);
  END IF;
  -- The deployed Worker's named failures are unchanged.
  FOREACH v_reason IN ARRAY ARRAY['variable_unavailable', 'retry_disabled'] LOOP
    PERFORM pg_temp.vr_reset();
    v_id := pg_temp.vr_enqueue('still-' || v_reason, 3);
    v_tok := pg_temp.vr_claim_and_start(v_id);
    SELECT * INTO c FROM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000003131', v_id, v_tok, 'failed', p_reason => v_reason, p_error => 'boom');
    IF c.outcome <> 'completed' OR NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'failed' AND status_reason = v_reason) THEN
      RAISE EXCEPTION 'a failed with % is now %', v_reason, pg_temp.vr_row(v_id);
    END IF;
  END LOOP;
  INSERT INTO vr_cases VALUES ('a holder still cannot fail a run for an engine only reason, a reasonless failed ends failed with NULL, and variable_unavailable and retry_disabled are unchanged');
END
$do$;

-- ── 4. the Worker deployed when this is applied keeps working ────────────────
-- What apps/worker/src/ops/ops-writes.ts sends and reads, unchanged by #3000
-- and by this change, copied from it.
DO $do$
DECLARE
  v_fn record;
  v_proc regprocedure;
  v_sent text[] := ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_outcome', 'p_reason', 'p_error', 'p_not_before', 'p_step', 'p_status'];
  v_read text[] := ARRAY['outcome', 'run_status'];
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'complete_run_request') <> 1 THEN
    RAISE EXCEPTION 'complete_run_request does not have exactly one definition, so PostgREST cannot resolve the deployed call';
  END IF;
  SELECT p.oid::regprocedure AS oid, p.proargnames, p.pronargs, p.pronargdefaults INTO v_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'complete_run_request';
  IF v_fn.proargnames[1:v_fn.pronargs] <> v_sent OR v_fn.pronargdefaults <> 5 THEN
    RAISE EXCEPTION 'complete_run_request takes % (% defaulted), the deployed Worker sends %', v_fn.proargnames[1:v_fn.pronargs], v_fn.pronargdefaults, v_sent;
  END IF;
  IF NOT (v_fn.proargnames[v_fn.pronargs + 1:] @> v_read) THEN
    RAISE EXCEPTION 'complete_run_request answers %, the deployed Worker reads %', v_fn.proargnames[v_fn.pronargs + 1:], v_read;
  END IF;
  v_proc := v_fn.oid;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_proc) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_proc; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_proc AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_proc; END IF;
  IF NOT has_function_privilege('service_role', v_proc, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_proc; END IF;
  IF has_function_privilege('anon', v_proc, 'EXECUTE') OR has_function_privilege('authenticated', v_proc, 'EXECUTE') OR has_function_privilege('public', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute %', v_proc;
  END IF;
  INSERT INTO vr_cases VALUES ('complete_run_request keeps its one definition, the deployed Worker''s arguments and answer, and service_role alone');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM vr_cases);
BEGIN
  IF v_n <> 4 THEN RAISE EXCEPTION 'variables_refused: % of 4 cases ran', v_n; END IF;
  RAISE NOTICE 'variables_refused: % cases passed', v_n;
END
$do$;

ROLLBACK;
