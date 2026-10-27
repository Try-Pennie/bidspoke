-- A run's acknowledged checkpoint (#1951). Migration 20261027150000_run_checkpoints_1951.sql.
--
-- A slice writes its checkpoint to R2 and then names it on its run with
-- record_run_checkpoint; the resume reads only the checkpoint the run names
-- (run_checkpoint), so one written and never acknowledged is never read.
--
-- WHAT IT PROVES.
--   A. The checkpoint columns are all set or all empty, and service_role cannot
--      write them except through the function.
--   B. record_run_checkpoint is fenced like every run write (#1698 D2): only the
--      holder of the running attempt, at the state version its start answered,
--      under a lease that has not lapsed, names a checkpoint; another token,
--      organization, execution or state version answers stale and writes nothing.
--   C. It is safe to repeat: the same checkpoint again is already_recorded; an
--      earlier checkpoint of the same holder after a later one is superseded and
--      changes nothing; the same key with another digest is refused by name.
--   D. It names only the key derived from the run, its state version and its
--      steps, and refuses a malformed digest, size or step count.
--   E. Assume it runs twice: a holder whose run was swept and re-claimed cannot
--      name a checkpoint any more, at its own state version or the new one's,
--      and the checkpoint it named before it lost the run is still the one the
--      run names (the resume source of the next slice), older than the new
--      holder's state version.
--   F. run_checkpoint answers the holder alone: the run's state version and the
--      checkpoint it names (nulls when none), and nothing to another token or
--      once the run has ended.
--   G. Both functions are SECURITY DEFINER with a fixed search_path,
--      executable by service_role alone, the read STABLE.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- (SQL_SUITE_PROJECT=ops), inside one transaction rolled back at the end.

BEGIN;

CREATE TEMP TABLE ck_cases (name text PRIMARY KEY);

CREATE TEMP TABLE ck_ids AS SELECT
  'aaaaaaaa-0000-4000-8000-000000001951'::uuid AS org,
  'aaaaaaaa-0000-4000-8000-0000000019a9'::uuid AS other_org,
  '00000000-0000-4000-8000-0000000019b0'::uuid AS wf,
  '00000000-0000-4000-8000-0000000019e1'::uuid AS exec1,
  '00000000-0000-4000-8000-0000000019e2'::uuid AS exec2,
  repeat('a', 64) AS sha_a,
  repeat('b', 64) AS sha_b;

-- Every case reads runs claimed by the lane wide claim, so no run of any other
-- organization may be waiting (run_engine_lifecycle.test.sql says why).
DELETE FROM public.send_ledger;
DELETE FROM public.schedule_fires;
DELETE FROM public.run_request_dedup_tombstones;
DELETE FROM public.run_requests;

-- One run, claimed and started as exec1. Its token and the state version its start answered are kept.
CREATE TEMP TABLE ck_run (run_request_id uuid, claim_token uuid, state_version bigint);
DO $do$
DECLARE
  i ck_ids%ROWTYPE;
  v_claim record;
  v_start record;
BEGIN
  SELECT * INTO i FROM ck_ids;
  PERFORM public.enqueue_run_request(
    p_organization_id => i.org, p_workflow_id => i.wf, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => 'lead-1951', p_payload => '{"amount": 3}');
  SELECT * INTO v_claim FROM public.claim_run_requests('tick-1951', 1, 1, 60);
  SELECT * INTO v_start FROM public.start_run_execution(i.org, v_claim.run_request_id, v_claim.claim_token, i.exec1);
  INSERT INTO ck_run VALUES (v_claim.run_request_id, v_claim.claim_token, v_start.state_version);
END
$do$;

-- The key a checkpoint of the run at p_version with p_steps steps must have.
CREATE FUNCTION pg_temp.ck_key(p_version bigint, p_steps integer) RETURNS text LANGUAGE sql AS $f$
  SELECT format('checkpoints/v1/%s/%s/%s-%s.json', (SELECT org FROM ck_ids), (SELECT run_request_id FROM ck_run), p_version, p_steps);
$f$;

-- Shorthand: the holder acknowledges a checkpoint of p_steps steps at its state version.
CREATE FUNCTION pg_temp.ck_ack(p_steps integer, p_sha text DEFAULT NULL, p_bytes integer DEFAULT 900) RETURNS text LANGUAGE sql AS $f$
  SELECT public.record_run_checkpoint(
    (SELECT org FROM ck_ids), (SELECT run_request_id FROM ck_run), (SELECT claim_token FROM ck_run), (SELECT exec1 FROM ck_ids),
    (SELECT state_version FROM ck_run), p_steps, pg_temp.ck_key((SELECT state_version FROM ck_run), p_steps),
    coalesce(p_sha, (SELECT sha_a FROM ck_ids)), p_bytes);
$f$;

-- ── A. The columns ───────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_wrote boolean;
  v_refused boolean := false;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'run_requests'
      AND column_name IN ('checkpoint_key', 'checkpoint_state_version', 'checkpoint_steps', 'checkpoint_sha256', 'checkpoint_bytes', 'checkpoint_execution_id', 'checkpoint_at')
      AND is_nullable = 'YES') <> 7 THEN
    RAISE EXCEPTION 'run_requests does not hold the seven nullable checkpoint columns';
  END IF;
  BEGIN
    UPDATE public.run_requests SET checkpoint_key = 'x' WHERE id = (SELECT run_request_id FROM ck_run);
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'a checkpoint key was stored without the rest of its pointer'; END IF;
  SET LOCAL ROLE service_role;
  BEGIN
    UPDATE public.run_requests SET checkpoint_at = now() WHERE id = (SELECT run_request_id FROM ck_run);
    v_wrote := true;
  EXCEPTION WHEN insufficient_privilege THEN
    v_wrote := false;
  END;
  RESET ROLE;
  IF v_wrote THEN RAISE EXCEPTION 'service_role wrote a checkpoint column directly'; END IF;
  INSERT INTO ck_cases VALUES ('columns: all set or all empty, never written directly by service_role');
END
$do$;

-- ── B. Fenced ────────────────────────────────────────────────────────────────
DO $do$
DECLARE
  i ck_ids%ROWTYPE;
  r ck_run%ROWTYPE;
  v_row record;
BEGIN
  SELECT * INTO i FROM ck_ids;
  SELECT * INTO r FROM ck_run;
  IF pg_temp.ck_ack(2) <> 'recorded' THEN RAISE EXCEPTION 'the holder could not name its checkpoint'; END IF;
  SELECT * INTO v_row FROM public.run_requests WHERE id = r.run_request_id;
  IF v_row.checkpoint_key IS DISTINCT FROM pg_temp.ck_key(r.state_version, 2) OR v_row.checkpoint_state_version IS DISTINCT FROM r.state_version
      OR v_row.checkpoint_steps IS DISTINCT FROM 2 OR v_row.checkpoint_sha256 IS DISTINCT FROM i.sha_a OR v_row.checkpoint_bytes IS DISTINCT FROM 900
      OR v_row.checkpoint_execution_id IS DISTINCT FROM i.exec1 OR v_row.checkpoint_at IS NULL THEN
    RAISE EXCEPTION 'the run does not name the checkpoint as acknowledged: %', row_to_json(v_row);
  END IF;
  IF v_row.state_version <> r.state_version THEN
    RAISE EXCEPTION 'naming a checkpoint moved the state version, which would refuse the rest of the slice''s fenced writes';
  END IF;

  IF public.record_run_checkpoint(i.org, r.run_request_id, gen_random_uuid(), i.exec1, r.state_version, 3, pg_temp.ck_key(r.state_version, 3), i.sha_a, 9) <> 'stale' THEN
    RAISE EXCEPTION 'another claim token named a checkpoint';
  END IF;
  IF public.record_run_checkpoint(i.other_org, r.run_request_id, r.claim_token, i.exec1, r.state_version, 3,
      format('checkpoints/v1/%s/%s/%s-3.json', i.other_org, r.run_request_id, r.state_version), i.sha_a, 9) <> 'stale' THEN
    RAISE EXCEPTION 'another organization named a checkpoint';
  END IF;
  IF public.record_run_checkpoint(i.org, r.run_request_id, r.claim_token, gen_random_uuid(), r.state_version, 3, pg_temp.ck_key(r.state_version, 3), i.sha_a, 9) <> 'stale' THEN
    RAISE EXCEPTION 'a checkpoint was named under an execution that is not the running attempt';
  END IF;
  IF public.record_run_checkpoint(i.org, r.run_request_id, r.claim_token, i.exec1, r.state_version - 1, 3, pg_temp.ck_key(r.state_version - 1, 3), i.sha_a, 9) <> 'stale' THEN
    RAISE EXCEPTION 'a checkpoint was named at a state version the holder does not hold';
  END IF;
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = r.run_request_id;
  IF pg_temp.ck_ack(3) <> 'stale' THEN RAISE EXCEPTION 'a checkpoint was named under a lapsed lease'; END IF;
  UPDATE public.run_requests SET claim_expires_at = now() + interval '1 minute' WHERE id = r.run_request_id;
  IF (SELECT checkpoint_steps FROM public.run_requests WHERE id = r.run_request_id) <> 2 THEN RAISE EXCEPTION 'a stale acknowledgement changed the run'; END IF;
  INSERT INTO ck_cases VALUES ('fence: another token, organization, execution, state version or a lapsed lease answers stale and writes nothing');
END
$do$;

-- ── C. Safe to repeat ────────────────────────────────────────────────────────
DO $do$
DECLARE
  i ck_ids%ROWTYPE;
  r ck_run%ROWTYPE;
  v_refused boolean := false;
BEGIN
  SELECT * INTO i FROM ck_ids;
  SELECT * INTO r FROM ck_run;
  IF pg_temp.ck_ack(2) <> 'already_recorded' THEN RAISE EXCEPTION 'a repeat of the named checkpoint was not already_recorded'; END IF;
  BEGIN
    PERFORM pg_temp.ck_ack(2, i.sha_b);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'the named key was acknowledged again with another digest'; END IF;
  IF pg_temp.ck_ack(5, i.sha_b) <> 'recorded' THEN RAISE EXCEPTION 'a later checkpoint of the holder was not named'; END IF;
  IF pg_temp.ck_ack(4) <> 'superseded' THEN RAISE EXCEPTION 'an earlier checkpoint after a later one was not superseded'; END IF;
  IF (SELECT checkpoint_steps FROM public.run_requests WHERE id = r.run_request_id) <> 5
      OR (SELECT checkpoint_sha256 FROM public.run_requests WHERE id = r.run_request_id) <> i.sha_b THEN
    RAISE EXCEPTION 'a superseded checkpoint changed the one the run names';
  END IF;
  INSERT INTO ck_cases VALUES ('repeat: the same again is already_recorded, an earlier one after a later one superseded, another digest refused');
END
$do$;

-- ── D. The key and the refusals ──────────────────────────────────────────────
DO $do$
DECLARE
  i ck_ids%ROWTYPE;
  r ck_run%ROWTYPE;
  v_refused integer := 0;
BEGIN
  SELECT * INTO i FROM ck_ids;
  SELECT * INTO r FROM ck_run;
  BEGIN
    PERFORM public.record_run_checkpoint(i.org, r.run_request_id, r.claim_token, i.exec1, r.state_version, 6,
      format('checkpoints/v1/%s/%s/%s-6.json', i.org, gen_random_uuid(), r.state_version), i.sha_a, 9);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM public.record_run_checkpoint(i.org, r.run_request_id, r.claim_token, i.exec1, r.state_version, 6, pg_temp.ck_key(r.state_version, 6), 'ABC', 9);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM public.record_run_checkpoint(i.org, r.run_request_id, r.claim_token, i.exec1, r.state_version, 6, pg_temp.ck_key(r.state_version, 6), i.sha_a, 0);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM public.record_run_checkpoint(i.org, r.run_request_id, r.claim_token, i.exec1, r.state_version, 0, pg_temp.ck_key(r.state_version, 1), i.sha_a, 9);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1;
  END;
  BEGIN
    PERFORM public.record_run_checkpoint(i.org, r.run_request_id, NULL, i.exec1, r.state_version, 6, pg_temp.ck_key(r.state_version, 6), i.sha_a, 9);
  EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1;
  END;
  IF v_refused <> 5 THEN RAISE EXCEPTION 'refused % of 5 malformed acknowledgements', v_refused; END IF;
  INSERT INTO ck_cases VALUES ('key: only the derived key; a malformed digest, size, step count or a missing token refused by name');
END
$do$;

-- ── E. Assume it runs twice: swept, re-claimed, and the old holder wakes ────
DO $do$
DECLARE
  i ck_ids%ROWTYPE;
  r ck_run%ROWTYPE;
  v_claim record;
  v_start record;
  v_row record;
BEGIN
  SELECT * INTO i FROM ck_ids;
  SELECT * INTO r FROM ck_run;
  -- Holder A's lease lapses with no send made: the sweep returns the run to the queue.
  UPDATE public.run_requests SET claim_expires_at = now() - interval '1 second' WHERE id = r.run_request_id;
  PERFORM public.sweep_expired_leases(100);
  UPDATE public.run_queue SET not_before = now() - interval '1 second' WHERE run_request_id = r.run_request_id;
  UPDATE public.run_requests SET not_before = now() - interval '1 second' WHERE id = r.run_request_id;
  SELECT * INTO v_claim FROM public.claim_run_requests('tick-1951-b', 1, 1, 60);
  IF v_claim.run_request_id IS DISTINCT FROM r.run_request_id THEN RAISE EXCEPTION 'the swept run was not claimed again'; END IF;
  SELECT * INTO v_start FROM public.start_run_execution(i.org, r.run_request_id, v_claim.claim_token, i.exec2);
  IF v_start.state_version <= r.state_version THEN RAISE EXCEPTION 'the new holder''s state version did not move past the old one''s'; END IF;

  -- The run still names A's last acknowledged checkpoint, older than B's state version: the next slice's resume source.
  SELECT * INTO v_row FROM public.run_checkpoint(i.org, r.run_request_id, v_claim.claim_token);
  IF v_row.checkpoint_key IS DISTINCT FROM pg_temp.ck_key(r.state_version, 5) OR v_row.checkpoint_state_version >= v_row.state_version THEN
    RAISE EXCEPTION 'the re-claimed run does not name its last acknowledged checkpoint as older than the new holder: %', row_to_json(v_row);
  END IF;

  -- A wakes and tries to name a later checkpoint, at its own state version and at B's: both stale.
  IF pg_temp.ck_ack(7) <> 'stale' THEN RAISE EXCEPTION 'the swept holder named a checkpoint at its own state version'; END IF;
  IF public.record_run_checkpoint(i.org, r.run_request_id, r.claim_token, i.exec1, v_start.state_version, 7, pg_temp.ck_key(v_start.state_version, 7), i.sha_a, 9) <> 'stale' THEN
    RAISE EXCEPTION 'the swept holder named a checkpoint at the new holder''s state version';
  END IF;
  IF (SELECT checkpoint_steps FROM public.run_requests WHERE id = r.run_request_id) <> 5 THEN RAISE EXCEPTION 'the swept holder changed the named checkpoint'; END IF;
  -- B names its own.
  IF public.record_run_checkpoint(i.org, r.run_request_id, v_claim.claim_token, i.exec2, v_start.state_version, 3, pg_temp.ck_key(v_start.state_version, 3), i.sha_a, 9) <> 'recorded' THEN
    RAISE EXCEPTION 'the new holder could not name its checkpoint';
  END IF;
  UPDATE ck_run SET claim_token = v_claim.claim_token, state_version = v_start.state_version;
  INSERT INTO ck_cases VALUES ('twice: a swept holder cannot name a checkpoint at either state version; the run keeps its last named one for the new holder');
END
$do$;

-- ── F. The read ──────────────────────────────────────────────────────────────
DO $do$
DECLARE
  i ck_ids%ROWTYPE;
  r ck_run%ROWTYPE;
  v_row record;
  v_none uuid;
  v_claim record;
BEGIN
  SELECT * INTO i FROM ck_ids;
  SELECT * INTO r FROM ck_run;
  IF EXISTS (SELECT 1 FROM public.run_checkpoint(i.org, r.run_request_id, gen_random_uuid())) THEN RAISE EXCEPTION 'another token read the checkpoint'; END IF;
  IF EXISTS (SELECT 1 FROM public.run_checkpoint(i.other_org, r.run_request_id, r.claim_token)) THEN RAISE EXCEPTION 'another organization read the checkpoint'; END IF;
  SELECT * INTO v_row FROM public.run_checkpoint(i.org, r.run_request_id, r.claim_token);
  IF v_row.checkpoint_steps IS DISTINCT FROM 3 OR v_row.checkpoint_sha256 IS DISTINCT FROM i.sha_a OR v_row.checkpoint_bytes IS DISTINCT FROM 9
      OR v_row.state_version IS DISTINCT FROM r.state_version THEN
    RAISE EXCEPTION 'the holder did not read the checkpoint its run names: %', row_to_json(v_row);
  END IF;
  PERFORM public.complete_run_request(i.org, r.run_request_id, r.claim_token, 'done');
  IF EXISTS (SELECT 1 FROM public.run_checkpoint(i.org, r.run_request_id, r.claim_token)) THEN RAISE EXCEPTION 'a checkpoint was read after its run ended'; END IF;

  -- A run that names no checkpoint answers one row of nulls to its holder (a write never acknowledged is never read).
  PERFORM public.enqueue_run_request(
    p_organization_id => i.org, p_workflow_id => i.wf, p_workflow_version => 1,
    p_trigger_kind => 'http_webhook', p_dedup_key => 'lead-1951-none', p_payload => '{}');
  SELECT * INTO v_claim FROM public.claim_run_requests('tick-1951-c', 1, 1, 60);
  SELECT * INTO v_row FROM public.run_checkpoint(i.org, v_claim.run_request_id, v_claim.claim_token);
  IF NOT FOUND OR v_row.checkpoint_key IS NOT NULL OR v_row.state_version IS NULL THEN
    RAISE EXCEPTION 'a claimed run with no checkpoint did not answer its holder one row of nulls';
  END IF;
  INSERT INTO ck_cases VALUES ('read: the holder alone, the named checkpoint or nulls, nothing once the run ended');
END
$do$;

-- ── G. Privileges ────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('record_run_checkpoint', 'run_checkpoint') LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN RAISE EXCEPTION '% is not SECURITY DEFINER', v_fn; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND proconfig @> ARRAY['search_path=""']) THEN RAISE EXCEPTION '% has no fixed search_path', v_fn; END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN RAISE EXCEPTION 'service_role cannot execute %', v_fn; END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'a browser role can execute %', v_fn;
    END IF;
  END LOOP;
  IF (SELECT provolatile FROM pg_proc WHERE proname = 'run_checkpoint') <> 's' THEN RAISE EXCEPTION 'run_checkpoint is not STABLE'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('record_run_checkpoint', 'run_checkpoint')) <> 2 THEN
    RAISE EXCEPTION 'the two checkpoint functions are not each defined once';
  END IF;
  INSERT INTO ck_cases VALUES ('privileges: definer, fixed search_path, service_role alone, the read STABLE');
END
$do$;

DO $do$
DECLARE v_n integer := (SELECT count(*) FROM ck_cases);
BEGIN
  IF v_n <> 7 THEN RAISE EXCEPTION 'run_checkpoints: % of 7 cases ran', v_n; END IF;
  RAISE NOTICE 'run_checkpoints: % cases passed', v_n;
END
$do$;

ROLLBACK;
