-- An ops run records the variables it started with (#2998, phase 2 of #2982).
-- Migration 20261029180000_run_variables_2998.sql.
--
-- WHAT IT PROVES (one DO block per case, counted at the bottom):
--   1. the first start records { source, served_at, values, secret_keys } on the
--      run and answers it; a start sent no variables records none;
--   2. the first start's record wins: a retry and a continuation each send
--      other values, and the run keeps, and answers, the first;
--   3. a start sent a record of the wrong shape is refused by name and changes
--      nothing, a secret_values key or a secret's value under any other key
--      included, so no start can keep a secret's value;
--   4. a direct write of a wrong shape is refused by the CHECK, even by the
--      table's owner, and service_role cannot write the column at all;
--   5. purge_run_variables clears the record of runs terminal more than 7
--      days, a page at a time, and leaves a recent run, a run still going and a
--      run a person kept;
--   6. the purge refuses a limit outside 1 to 1000;
--   7. the ops Worker deployed before this migration keeps working: one
--      definition of start_run_execution, which takes the four arguments it
--      sends (the fifth defaulted) and answers the columns it reads, and its
--      start records nothing;
--   8. start_run_execution and purge_run_variables are SECURITY DEFINER with a
--      fixed search_path and executable by service_role alone.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops). One transaction, rolled back at the end.

BEGIN;

CREATE TEMP TABLE rv_cases (name text PRIMARY KEY) ON COMMIT DROP;

CREATE FUNCTION pg_temp.rv_reset() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.send_ledger;
  DELETE FROM public.schedule_fires;
  DELETE FROM public.run_request_dedup_tombstones;
  DELETE FROM public.run_requests;
$f$;

CREATE FUNCTION pg_temp.rv_enqueue(p_key text) RETURNS uuid LANGUAGE sql AS $f$
  SELECT run_request_id FROM public.enqueue_run_request(
    p_organization_id => 'aaaaaaaa-0000-4000-8000-000000002998', p_workflow_id => '00000000-0000-4000-8000-0000000029c0', p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => p_key, p_max_attempts => 3);
$f$;

-- What one claim and start held.
CREATE TEMP TABLE rv_held (run_request_id uuid PRIMARY KEY, claim_token uuid, execution_id uuid, state_version bigint) ON COMMIT DROP;

-- Claim the run and start it with p_variables; answers what the start answered as run_variables.
CREATE FUNCTION pg_temp.rv_start(p_id uuid, p_variables jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r record;
  s record;
  v_exec uuid := gen_random_uuid();
BEGIN
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = p_id;
  SELECT * INTO r FROM public.claim_run_requests('rv-tick', 1000, 1000, 60) c WHERE c.run_request_id = p_id;
  IF r.run_request_id IS NULL THEN RAISE EXCEPTION 'run % was not claimable', p_id; END IF;
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000002998', p_id, r.claim_token, v_exec, p_variables);
  IF s.outcome <> 'started' THEN RAISE EXCEPTION 'run % did not start: %', p_id, s; END IF;
  DELETE FROM rv_held WHERE run_request_id = p_id;
  INSERT INTO rv_held VALUES (p_id, r.claim_token, v_exec, s.state_version);
  RETURN s.run_variables;
END
$f$;

CREATE FUNCTION pg_temp.rv_complete(p_id uuid, p_outcome text) RETURNS void LANGUAGE sql AS $f$
  SELECT FROM rv_held h, public.complete_run_request('aaaaaaaa-0000-4000-8000-000000002998', h.run_request_id, h.claim_token, p_outcome) c
  WHERE h.run_request_id = p_id;
$f$;

CREATE FUNCTION pg_temp.rv_vars(p_served text, p_values jsonb, p_secret_keys jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('source', 'bidding', 'served_at', p_served, 'values', p_values, 'secret_keys', p_secret_keys);
$f$;

CREATE FUNCTION pg_temp.rv_held_vars(p_id uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT run_variables FROM public.run_requests WHERE id = p_id;
$f$;

-- ── 1. the first start records and answers the run's variables ──────────────
DO $do$
DECLARE
  v_id uuid;
  v_sent jsonb := pg_temp.rv_vars('2026-10-29T14:00:00.000Z', '{"API_BASE": "https://api.example.test"}', '["API_TOKEN"]');
  v_answer jsonb;
BEGIN
  PERFORM pg_temp.rv_reset();
  v_id := pg_temp.rv_enqueue('first');
  v_answer := pg_temp.rv_start(v_id, v_sent);
  IF v_answer IS DISTINCT FROM v_sent OR pg_temp.rv_held_vars(v_id) IS DISTINCT FROM v_sent THEN
    RAISE EXCEPTION 'the first start answered % and kept %, not %', v_answer, pg_temp.rv_held_vars(v_id), v_sent;
  END IF;
  v_id := pg_temp.rv_enqueue('none-sent');
  IF pg_temp.rv_start(v_id, NULL) IS NOT NULL OR pg_temp.rv_held_vars(v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'a start sent no variables recorded some';
  END IF;
  INSERT INTO rv_cases VALUES ('the first start records and answers the run''s variables; one sent none records none');
END
$do$;

-- ── 2. the first start's record wins over a retry and a continuation ────────
DO $do$
DECLARE
  v_id uuid;
  v_first jsonb := pg_temp.rv_vars('2026-10-29T14:00:00.000Z', '{"API_BASE": "first"}', '[]');
  v_later jsonb := pg_temp.rv_vars('2026-10-29T14:05:00.000Z', '{"API_BASE": "changed since"}', '[]');
  v_answer jsonb;
  v_held record;
BEGIN
  PERFORM pg_temp.rv_reset();
  v_id := pg_temp.rv_enqueue('kept');
  PERFORM pg_temp.rv_start(v_id, v_first);
  PERFORM pg_temp.rv_complete(v_id, 'retry');
  v_answer := pg_temp.rv_start(v_id, v_later);
  IF v_answer IS DISTINCT FROM v_first OR pg_temp.rv_held_vars(v_id) IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'a retry''s start answered % and kept %, not the first start''s %', v_answer, pg_temp.rv_held_vars(v_id), v_first;
  END IF;
  -- A continuation: name a checkpoint, suspend to continue, start again.
  SELECT * INTO v_held FROM rv_held WHERE run_request_id = v_id;
  PERFORM public.record_run_checkpoint('aaaaaaaa-0000-4000-8000-000000002998', v_id, v_held.claim_token, v_held.execution_id, v_held.state_version, 1,
    format('checkpoints/v1/%s/%s/%s-%s.json', 'aaaaaaaa-0000-4000-8000-000000002998', v_id, v_held.state_version, 1), repeat('c', 64), 900);
  PERFORM public.complete_run_request('aaaaaaaa-0000-4000-8000-000000002998', v_id, v_held.claim_token, 'suspend', p_reason => 'continue', p_not_before => now());
  v_answer := pg_temp.rv_start(v_id, v_later);
  IF v_answer IS DISTINCT FROM v_first OR pg_temp.rv_held_vars(v_id) IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'a continuation''s start answered % and kept %, not the first start''s %', v_answer, pg_temp.rv_held_vars(v_id), v_first;
  END IF;
  INSERT INTO rv_cases VALUES ('the first start''s record wins over a retry and a continuation');
END
$do$;

-- ── 3. a start sent the wrong shape is refused by name ──────────────────────
DO $do$
DECLARE
  v_id uuid;
  v_bad jsonb;
  v_refused text;
  v_good jsonb := pg_temp.rv_vars('2026-10-29T14:00:00.000Z', '{"A": "1"}', '["S"]');
  v_n integer := 0;
BEGIN
  PERFORM pg_temp.rv_reset();
  FOR v_bad IN SELECT * FROM (VALUES
    (v_good || '{"secret_values": {"S": "planted-secret-value"}}'),
    (v_good - 'secret_keys'),
    (v_good || '{"source": "kv"}'),
    (v_good || '{"source": 7}'),
    (v_good || '{"served_at": "yesterday"}'),
    (v_good || '{"values": {"A": 1}}'),
    (v_good || '{"values": {"not a name": "x"}}'),
    (v_good || '{"values": []}'),
    (v_good || '{"secret_keys": "S"}'),
    (v_good || '{"secret_keys": [1]}'),
    (v_good || '{"secret_keys": ["A"]}'),
    ('"a string"'::jsonb),
    ('[]'::jsonb)
  ) AS b(v)
  LOOP
    v_n := v_n + 1;
    v_id := pg_temp.rv_enqueue('shape-' || v_n);
    v_refused := NULL;
    BEGIN
      PERFORM pg_temp.rv_start(v_id, v_bad);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := SQLERRM;
    END;
    IF v_refused IS NULL OR v_refused NOT LIKE '%p_variables is not { source, served_at, values, secret_keys }%' THEN
      RAISE EXCEPTION 'a start sent % was not refused by name: %', v_bad, coalesce(v_refused, pg_temp.rv_held_vars(v_id)::text);
    END IF;
    -- The refusal raised, so the claim and start it was part of left the run as it was.
    IF pg_temp.rv_held_vars(v_id) IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.run_requests WHERE id = v_id AND status = 'queued' AND attempts = 0) THEN
      RAISE EXCEPTION 'a refused start changed the run';
    END IF;
  END LOOP;
  IF v_n <> 13 THEN RAISE EXCEPTION 'only % shapes were tried', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE run_variables::text LIKE '%planted-secret-value%') THEN
    RAISE EXCEPTION 'a secret''s value was kept';
  END IF;
  INSERT INTO rv_cases VALUES ('a start sent a record of the wrong shape, a secret''s value included, is refused by name and changes nothing');
END
$do$;

-- ── 4. the CHECK holds a direct write, and service_role cannot write ────────
DO $do$
DECLARE
  v_id uuid;
  v_refused boolean;
BEGIN
  PERFORM pg_temp.rv_reset();
  v_id := pg_temp.rv_enqueue('direct');
  BEGIN
    UPDATE public.run_requests SET run_variables = pg_temp.rv_vars('2026-10-29T14:00:00.000Z', '{}', '[]') || '{"secret_values": {"S": "x"}}' WHERE id = v_id;
    v_refused := false;
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'the owner wrote a run_variables with a secret_values key'; END IF;
  BEGIN
    UPDATE public.run_requests SET run_variables = '"text"'::jsonb WHERE id = v_id;
    v_refused := false;
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'the owner wrote a run_variables that is not an object'; END IF;
  SET LOCAL ROLE service_role;
  BEGIN
    UPDATE public.run_requests SET run_variables = pg_temp.rv_vars('2026-10-29T14:00:00.000Z', '{}', '[]');
    v_refused := false;
  EXCEPTION WHEN insufficient_privilege THEN v_refused := true;
  END;
  RESET ROLE;
  IF NOT v_refused THEN RAISE EXCEPTION 'service_role wrote run_variables directly'; END IF;
  INSERT INTO rv_cases VALUES ('the CHECK holds a direct write, and service_role cannot write the column');
END
$do$;

-- ── 5. the purge clears records of runs terminal more than 7 days ───────────
DO $do$
DECLARE
  v_old uuid[] := ARRAY[]::uuid[];
  v_recent uuid;
  v_kept uuid;
  v_going uuid;
  v_id uuid;
  r record;
  v_vars jsonb := pg_temp.rv_vars('2026-10-29T14:00:00.000Z', '{"A": "1"}', '[]');
BEGIN
  PERFORM pg_temp.rv_reset();
  FOR i IN 1..3 LOOP
    v_id := pg_temp.rv_enqueue('old-' || i);
    PERFORM pg_temp.rv_start(v_id, v_vars);
    PERFORM pg_temp.rv_complete(v_id, 'done');
    v_old := v_old || v_id;
  END LOOP;
  UPDATE public.run_requests SET terminal_at = now() - interval '8 days' WHERE id = ANY (v_old);
  v_recent := pg_temp.rv_enqueue('recent');
  PERFORM pg_temp.rv_start(v_recent, v_vars);
  PERFORM pg_temp.rv_complete(v_recent, 'done');
  UPDATE public.run_requests SET terminal_at = now() - interval '6 days' WHERE id = v_recent;
  v_kept := pg_temp.rv_enqueue('kept');
  PERFORM pg_temp.rv_start(v_kept, v_vars);
  PERFORM pg_temp.rv_complete(v_kept, 'done');
  UPDATE public.run_requests SET terminal_at = now() - interval '30 days', kept_by = gen_random_uuid(), kept_at = now() WHERE id = v_kept;
  v_going := pg_temp.rv_enqueue('going');
  PERFORM pg_temp.rv_start(v_going, v_vars);

  SELECT * INTO r FROM public.purge_run_variables(2);
  IF r.purged <> 2 OR NOT r.more THEN RAISE EXCEPTION 'the first page purged % (more %), not 2 and more', r.purged, r.more; END IF;
  SELECT * INTO r FROM public.purge_run_variables(2);
  IF r.purged <> 1 OR r.more THEN RAISE EXCEPTION 'the second page purged % (more %), not 1 and no more', r.purged, r.more; END IF;
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id = ANY (v_old) AND run_variables IS NOT NULL) THEN
    RAISE EXCEPTION 'a run terminal 8 days ago kept its variables';
  END IF;
  IF EXISTS (SELECT 1 FROM public.run_requests WHERE id IN (v_recent, v_kept, v_going) AND run_variables IS NULL) THEN
    RAISE EXCEPTION 'the purge cleared a recent, kept or running run''s variables';
  END IF;
  INSERT INTO rv_cases VALUES ('the purge clears runs terminal more than 7 days, a page at a time, and leaves recent, kept and running runs');
END
$do$;

-- ── 6. the purge's limit ─────────────────────────────────────────────────────
DO $do$
DECLARE
  v_limit integer;
  v_refused text;
BEGIN
  FOREACH v_limit IN ARRAY ARRAY[0, 1001] LOOP
    v_refused := NULL;
    BEGIN
      PERFORM public.purge_run_variables(v_limit);
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := SQLERRM;
    END;
    IF v_refused IS NULL OR v_refused NOT LIKE '%limit must be 1 to 1000%' THEN RAISE EXCEPTION 'a limit of % was not refused by name', v_limit; END IF;
  END LOOP;
  BEGIN
    PERFORM public.purge_run_variables(NULL);
    RAISE EXCEPTION 'a null limit was not refused';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  INSERT INTO rv_cases VALUES ('the purge refuses a limit outside 1 to 1000');
END
$do$;

-- ── 7. the ops Worker deployed before this migration keeps working ──────────
-- What apps/worker/src/ops/ops-writes.ts on main at b1b4bbee9 (the code running
-- when this migration is applied) sends and reads, copied from it.
DO $do$
DECLARE
  v_fn record;
  v_args text[];
  v_cols text[];
  v_id uuid;
  r record;
  s record;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'start_run_execution') <> 1 THEN
    RAISE EXCEPTION 'start_run_execution does not have exactly one definition, so PostgREST cannot resolve the deployed call';
  END IF;
  SELECT p.proargnames, p.pronargs, p.pronargdefaults INTO v_fn
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'start_run_execution';
  v_args := v_fn.proargnames[1:v_fn.pronargs];
  v_cols := v_fn.proargnames[v_fn.pronargs + 1:];
  IF v_args[1:4] <> ARRAY['p_organization_id', 'p_run_request_id', 'p_claim_token', 'p_execution_id'] OR v_fn.pronargs - 4 > v_fn.pronargdefaults THEN
    RAISE EXCEPTION 'start_run_execution takes % (% defaulted), the deployed Worker sends four', v_args, v_fn.pronargdefaults;
  END IF;
  IF NOT (v_cols @> ARRAY['outcome', 'state_version', 'attempt', 'continuations']) THEN
    RAISE EXCEPTION 'start_run_execution answers %, the deployed Worker reads outcome, state_version, attempt, continuations', v_cols;
  END IF;

  PERFORM pg_temp.rv_reset();
  v_id := pg_temp.rv_enqueue('deployed-shape');
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = v_id;
  SELECT * INTO r FROM public.claim_run_requests('rv-tick', 1000, 1000, 60) c WHERE c.run_request_id = v_id;
  SELECT * INTO s FROM public.start_run_execution('aaaaaaaa-0000-4000-8000-000000002998', v_id, r.claim_token, gen_random_uuid());
  IF s.outcome <> 'started' OR pg_temp.rv_held_vars(v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'the deployed Worker''s four argument start answered % and kept %', s, pg_temp.rv_held_vars(v_id);
  END IF;
  INSERT INTO rv_cases VALUES ('the deployed Worker''s start resolves to one definition and records nothing');
END
$do$;

-- ── 8. privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('start_run_execution', 'purge_run_variables')
  LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('service_role', 'public.run_variables_shape_ok(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role can execute the shape check, which only the CHECK and the definer start need';
  END IF;
  INSERT INTO rv_cases VALUES ('start_run_execution and purge_run_variables are definer, fixed search_path, service_role alone');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM rv_cases);
BEGIN
  IF v_n <> 8 THEN RAISE EXCEPTION 'run_variables: % of 8 cases ran', v_n; END IF;
  RAISE NOTICE 'run_variables: % cases passed', v_n;
END
$do$;

ROLLBACK;
