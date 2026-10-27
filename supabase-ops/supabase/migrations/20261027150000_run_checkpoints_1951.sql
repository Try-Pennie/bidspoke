-- A run's acknowledged checkpoint (#1951, track B4 of the #1698 run engine).
--
-- A slice of an ops run writes where it got to (its checkpoint) to the
-- OPS_CHECKPOINTS R2 bucket (apps/worker/src/ops/checkpoint.ts) and then names
-- it on its run here. The resume reads only the checkpoint its run names, so a
-- checkpoint written and never acknowledged (a crash between the two) is never
-- read, and one a stale holder wrote is never named: the name is fenced like
-- every run write (#1698 D2).
--
--  - run_requests gains the pointer: the key, the state version and step count
--    it was written at, its digest and size (so the reader can refuse any other
--    object at that key, L617), the attempt that wrote it and when. All set or
--    all empty. The pointer outlives the claim, so the next holder of a swept
--    or suspended run can resume from it; it goes with the run when the run is
--    purged.
--  - record_run_checkpoint: the holder of the running attempt, at the state
--    version its start answered, under a lease that has not lapsed, names one
--    checkpoint. It does not move the state version: it is not a change of
--    status, and moving it would refuse the rest of the slice's fenced writes.
--  - run_checkpoint: the holder reads the run's state version and the
--    checkpoint it names.
--
-- Additive only (ADR 0007): seven nullable columns, two constraints that every
-- existing row (all empty) satisfies, and two new functions. Nothing calls them
-- until the ops Worker runs with OPS_CONTINUATION set. Guarded by
-- supabase-ops/supabase/tests/run_checkpoints.test.sql.

SET lock_timeout = '5s';

ALTER TABLE public.run_requests
  ADD COLUMN checkpoint_key            text,
  ADD COLUMN checkpoint_state_version  bigint,
  ADD COLUMN checkpoint_steps          integer,
  ADD COLUMN checkpoint_sha256         text,
  ADD COLUMN checkpoint_bytes          integer,
  ADD COLUMN checkpoint_execution_id   uuid,
  ADD COLUMN checkpoint_at             timestamptz,
  ADD CONSTRAINT run_requests_checkpoint_whole CHECK (
    (checkpoint_key IS NULL AND checkpoint_state_version IS NULL AND checkpoint_steps IS NULL AND checkpoint_sha256 IS NULL
      AND checkpoint_bytes IS NULL AND checkpoint_execution_id IS NULL AND checkpoint_at IS NULL)
    OR (checkpoint_key IS NOT NULL AND checkpoint_state_version IS NOT NULL AND checkpoint_steps IS NOT NULL AND checkpoint_sha256 IS NOT NULL
      AND checkpoint_bytes IS NOT NULL AND checkpoint_execution_id IS NOT NULL AND checkpoint_at IS NOT NULL)),
  ADD CONSTRAINT run_requests_checkpoint_shape CHECK (
    checkpoint_key IS NULL OR (checkpoint_sha256 ~ '^[0-9a-f]{64}$' AND checkpoint_bytes > 0 AND checkpoint_steps >= 1 AND checkpoint_state_version >= 1));

-- The holder names one checkpoint. Answers recorded, already_recorded (the run
-- names this key with this digest already: a repeat after a lost answer),
-- superseded (the run names a later checkpoint of this holder at this state
-- version, so nothing was written) or stale (the run is not this holder's
-- running attempt at this state version under a live lease: another token,
-- organization, execution or state version, an ended run or a lapsed lease;
-- nothing was written). Refuses by name a key that is not the one derived from
-- the run, its state version and its steps, the same key with another digest,
-- and a malformed digest, size or step count.
CREATE FUNCTION public.record_run_checkpoint(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_execution_id     uuid,
  p_state_version    bigint,
  p_steps            integer,
  p_checkpoint_key   text,
  p_sha256           text,
  p_bytes            integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_run record;
  v_key text;
BEGIN
  IF p_organization_id IS NULL OR p_run_request_id IS NULL OR p_claim_token IS NULL OR p_execution_id IS NULL OR p_state_version IS NULL
      OR p_steps IS NULL OR p_checkpoint_key IS NULL OR p_sha256 IS NULL OR p_bytes IS NULL THEN
    RAISE EXCEPTION 'record_run_checkpoint: organization, run, claim token, execution, state version, steps, key, digest and size are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_steps < 1 OR p_state_version < 1 THEN
    RAISE EXCEPTION 'record_run_checkpoint: a checkpoint holds at least one step at a state version from 1, not % at %', p_steps, p_state_version
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'record_run_checkpoint: the digest is 64 lowercase hex characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_bytes < 1 THEN
    RAISE EXCEPTION 'record_run_checkpoint: a checkpoint has a size, not %', p_bytes USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_key := format('checkpoints/v1/%s/%s/%s-%s.json', p_organization_id, p_run_request_id, p_state_version, p_steps);
  IF p_checkpoint_key <> v_key THEN
    RAISE EXCEPTION 'record_run_checkpoint: % is not this checkpoint''s key, %', p_checkpoint_key, v_key USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The run's running attempt under this token, at this state version, with its lease live.
  SELECT r.id, r.checkpoint_key, r.checkpoint_state_version, r.checkpoint_steps, r.checkpoint_sha256, r.checkpoint_bytes INTO v_run
  FROM public.run_requests r JOIN public.workflow_executions e ON e.run_request_id = r.id AND e.attempt = r.attempts
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token AND r.status = 'running'
    AND r.state_version = p_state_version AND r.claim_expires_at > now() AND e.id = p_execution_id AND e.status = 'running'
  FOR NO KEY UPDATE OF r;
  IF NOT FOUND THEN
    RETURN 'stale';
  END IF;

  IF v_run.checkpoint_key = p_checkpoint_key THEN
    IF v_run.checkpoint_sha256 = p_sha256 AND v_run.checkpoint_bytes = p_bytes THEN
      RETURN 'already_recorded';
    END IF;
    RAISE EXCEPTION 'record_run_checkpoint: % is already named with another digest or size', p_checkpoint_key USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_run.checkpoint_state_version = p_state_version AND v_run.checkpoint_steps >= p_steps THEN
    RETURN 'superseded';
  END IF;

  UPDATE public.run_requests r
  SET checkpoint_key = p_checkpoint_key, checkpoint_state_version = p_state_version, checkpoint_steps = p_steps,
      checkpoint_sha256 = p_sha256, checkpoint_bytes = p_bytes, checkpoint_execution_id = p_execution_id, checkpoint_at = now(),
      updated_at = now()
  WHERE r.id = v_run.id;
  RETURN 'recorded';
END
$fn$;

-- The holder reads its run's state version and the checkpoint the run names.
-- One row to the holder of a claimed or running run (the checkpoint columns
-- null when it names none); no row to anyone else, or once the run has ended.
CREATE FUNCTION public.run_checkpoint(p_organization_id uuid, p_run_request_id uuid, p_claim_token uuid)
RETURNS TABLE (state_version bigint, checkpoint_key text, checkpoint_state_version bigint, checkpoint_steps integer, checkpoint_sha256 text,
  checkpoint_bytes integer, checkpoint_execution_id uuid, checkpoint_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT r.state_version, r.checkpoint_key, r.checkpoint_state_version, r.checkpoint_steps, r.checkpoint_sha256,
    r.checkpoint_bytes, r.checkpoint_execution_id, r.checkpoint_at
  FROM public.run_requests r
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token
    AND r.status IN ('claimed', 'running');
$fn$;

REVOKE ALL ON FUNCTION public.record_run_checkpoint(uuid, uuid, uuid, uuid, bigint, integer, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_run_checkpoint(uuid, uuid, uuid, uuid, bigint, integer, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.run_checkpoint(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_checkpoint(uuid, uuid, uuid) TO service_role;

RESET lock_timeout;
