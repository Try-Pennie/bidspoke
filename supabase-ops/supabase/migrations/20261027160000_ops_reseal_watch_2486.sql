-- How long an ops key reseal has been switched on, and what its runs last said
-- (#2486), so a reseal that keeps leaving logins on the old key, or a switch
-- left on after the reseal finished, pages rather than going unseen.
--
-- WHY HERE. OPS_RESEAL is a var in wrangler.ops.toml, so the Worker can say
-- that it is set but not since when: module memory dies with every deploy and
-- isolate, and a deploy's own time moves with every unrelated merge. The
-- database keeps the one row both writers share.
--
-- THE ROW. ops_reseal_state is the lane's own state, which belongs to no
-- organization, so its one row carries the nil uuid as its key, held there by a
-- CHECK, as ops_lane_sweeps does (20261017090000_ops_tick_1949.sql).
--   mode, mode_since    the mode the switch was seen in, and since when
--   seen_at             the last time either function saw the switch set
--   last_run_*          the last reseal run's result: when, whether it left
--                       nothing, and how many logins it left (null when the
--                       run failed or was refused before it could count)
--   nothing_left_since  the first run in an unbroken line of runs that each
--                       left nothing; null once a run leaves something
--
-- THE TWO WRITERS, each one SECURITY DEFINER function, the only way to write it
-- (service_role holds SELECT alone):
--   observe_ops_reseal     the minute tick, every minute the switch is set
--                          (src/ops/tick.ts), which judges what it answers
--   record_ops_reseal_run  the reseal, after each run (src/ops/reseal-live.ts)
-- Each starts the clock afresh, forgetting the last run, when the mode it is
-- given differs from the stored one, or when the switch went unseen for longer
-- than p_restart_after_seconds (the Worker's RESEAL_RESTART_AFTER_MS): nothing
-- sees the switch while it is unset, so a long gap means it was switched off,
-- and a rotation months later must not inherit the last one's clock. Either
-- creates the row, so a run is never lost for want of an observation before it.
-- The clock is the database's (now()), the one the tick plans against.
--
-- Additive only (ADR 0007): a new table and two new functions. Guarded by
-- supabase-ops/supabase/tests/ops_reseal_watch.test.sql.

SET lock_timeout = '10s';

CREATE TABLE public.ops_reseal_state (
  -- The lane's own row, never an organization's.
  organization_id        uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000000'
    CONSTRAINT ops_reseal_state_lane_row CHECK (organization_id = '00000000-0000-0000-0000-000000000000'),
  mode                   text NOT NULL CONSTRAINT ops_reseal_state_mode_check CHECK (mode IN ('preview', 'apply')),
  mode_since             timestamptz NOT NULL,
  seen_at                timestamptz NOT NULL,
  last_run_at            timestamptz,
  last_run_nothing_left  boolean,
  last_run_left          integer CONSTRAINT ops_reseal_state_left_check CHECK (last_run_left >= 0),
  nothing_left_since     timestamptz,
  CONSTRAINT ops_reseal_state_run_check CHECK ((last_run_at IS NULL) = (last_run_nothing_left IS NULL)),
  CONSTRAINT ops_reseal_state_finished_check CHECK (nothing_left_since IS NULL OR last_run_nothing_left IS TRUE)
);

ALTER TABLE public.ops_reseal_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_reseal_state FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.ops_reseal_state FROM service_role;
GRANT SELECT ON public.ops_reseal_state TO service_role;

-- ── observe_ops_reseal ────────────────────────────────────────────────────────
-- The tick's sighting of the switch in p_mode: stamps seen_at, starting the
-- clock afresh first when the mode changed or the switch went unseen past the
-- window. Answers the row, whether this call restarted it, and the database's
-- clock to judge it by.
CREATE FUNCTION public.observe_ops_reseal(p_mode text, p_restart_after_seconds integer)
RETURNS TABLE (
  mode text, mode_since timestamptz, last_run_at timestamptz, last_run_nothing_left boolean, last_run_left integer,
  nothing_left_since timestamptz, restarted boolean, db_now timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_lane constant uuid := '00000000-0000-0000-0000-000000000000';
  v_row public.ops_reseal_state;
  v_restart boolean;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('preview', 'apply') THEN
    RAISE EXCEPTION 'observe_ops_reseal: the mode must be preview or apply, not %', p_mode USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_restart_after_seconds IS NULL OR p_restart_after_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'observe_ops_reseal: the restart window must be 60 to 86400 seconds, not %', p_restart_after_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_row FROM public.ops_reseal_state s WHERE s.organization_id = v_lane FOR UPDATE;
  v_restart := NOT FOUND OR v_row.mode <> p_mode OR v_row.seen_at < v_now - make_interval(secs => p_restart_after_seconds);
  IF v_restart THEN
    INSERT INTO public.ops_reseal_state AS s (organization_id, mode, mode_since, seen_at)
    VALUES (v_lane, p_mode, v_now, v_now)
    ON CONFLICT (organization_id) DO UPDATE SET
      mode = EXCLUDED.mode, mode_since = EXCLUDED.mode_since, seen_at = EXCLUDED.seen_at,
      last_run_at = NULL, last_run_nothing_left = NULL, last_run_left = NULL, nothing_left_since = NULL;
  ELSE
    UPDATE public.ops_reseal_state s SET seen_at = v_now WHERE s.organization_id = v_lane;
  END IF;

  RETURN QUERY
  SELECT s.mode, s.mode_since, s.last_run_at, s.last_run_nothing_left, s.last_run_left, s.nothing_left_since, v_restart, v_now
  FROM public.ops_reseal_state s WHERE s.organization_id = v_lane;
END
$fn$;

-- ── record_ops_reseal_run ─────────────────────────────────────────────────────
-- One reseal run's result in p_mode: p_nothing_left true only when the run
-- reported nothing_left (which then left 0), false for every other run, a
-- failed or refused one included, whose p_left is null. Restarts the clock as
-- observe_ops_reseal does, then keeps the run and the finished clock. Answers
-- as observe_ops_reseal does.
CREATE FUNCTION public.record_ops_reseal_run(p_mode text, p_nothing_left boolean, p_left integer, p_restart_after_seconds integer)
RETURNS TABLE (
  mode text, mode_since timestamptz, last_run_at timestamptz, last_run_nothing_left boolean, last_run_left integer,
  nothing_left_since timestamptz, restarted boolean, db_now timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_lane constant uuid := '00000000-0000-0000-0000-000000000000';
  v_row public.ops_reseal_state;
  v_restart boolean;
  v_finished_since timestamptz;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('preview', 'apply') THEN
    RAISE EXCEPTION 'record_ops_reseal_run: the mode must be preview or apply, not %', p_mode USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_nothing_left IS NULL THEN
    RAISE EXCEPTION 'record_ops_reseal_run: a run must say whether it left nothing' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_left IS NOT NULL AND p_left < 0 THEN
    RAISE EXCEPTION 'record_ops_reseal_run: a run cannot leave % logins', p_left USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_nothing_left AND p_left IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'record_ops_reseal_run: a run that left nothing cannot have left % logins', p_left USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_restart_after_seconds IS NULL OR p_restart_after_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'record_ops_reseal_run: the restart window must be 60 to 86400 seconds, not %', p_restart_after_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_row FROM public.ops_reseal_state s WHERE s.organization_id = v_lane FOR UPDATE;
  v_restart := NOT FOUND OR v_row.mode <> p_mode OR v_row.seen_at < v_now - make_interval(secs => p_restart_after_seconds);
  v_finished_since := CASE
    WHEN NOT p_nothing_left THEN NULL
    WHEN v_restart OR v_row.nothing_left_since IS NULL THEN v_now
    ELSE v_row.nothing_left_since
  END;

  INSERT INTO public.ops_reseal_state AS s (organization_id, mode, mode_since, seen_at, last_run_at, last_run_nothing_left, last_run_left, nothing_left_since)
  VALUES (v_lane, p_mode, v_now, v_now, v_now, p_nothing_left, p_left, v_finished_since)
  ON CONFLICT (organization_id) DO UPDATE SET
    mode = EXCLUDED.mode,
    mode_since = CASE WHEN v_restart THEN EXCLUDED.mode_since ELSE s.mode_since END,
    seen_at = EXCLUDED.seen_at,
    last_run_at = EXCLUDED.last_run_at,
    last_run_nothing_left = EXCLUDED.last_run_nothing_left,
    last_run_left = EXCLUDED.last_run_left,
    nothing_left_since = EXCLUDED.nothing_left_since;

  RETURN QUERY
  SELECT s.mode, s.mode_since, s.last_run_at, s.last_run_nothing_left, s.last_run_left, s.nothing_left_since, v_restart, v_now
  FROM public.ops_reseal_state s WHERE s.organization_id = v_lane;
END
$fn$;

REVOKE ALL ON FUNCTION public.observe_ops_reseal(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_ops_reseal(text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.record_ops_reseal_run(text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ops_reseal_run(text, boolean, integer, integer) TO service_role;
