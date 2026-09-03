-- Behavioural tests for the execution deletion gate (#873, #1014, #1137).
--
-- WHERE THIS RUNS. Against a THROWAWAY Supabase branch, never against production
-- and never against any database holding real executions. The procedures under
-- test empty and drop partitions, and no rollback can undo them here: they COMMIT
-- after each partition on purpose, to release the lock, so a wrapping transaction
-- is not available as isolation. The isolation is the DATABASE.
--
-- Create one with the Supabase MCP `create_branch` (about $0.013 an hour, deleted
-- afterwards), or any empty Postgres 17 with pg_cron. Then run this file top to
-- bottom. It asserts by RAISE EXCEPTION and counts the cases it ran, because a
-- suite that silently executed half its cases and reported nothing wrong is the
-- failure the count exists to catch (L288).
--
-- SEND ONE STATEMENT AT A TIME. psql does this by default; a tool that batches the
-- whole file into one request does NOT, and a batch is an implicit transaction, so
-- the first CALL dies with `2D000 invalid transaction termination` at its own
-- COMMIT. Measured 2026-09-03, and worth knowing for a second reason: that failure
-- rolls the batch back, INCLUDING the fixture rows inserted earlier in it, so the
-- next assertion reports a partition as wrongly dropped when what actually
-- happened is that its fixture row was never committed. The procedure was fine.
--
-- APPENDS USE `array_append`, NEVER `arr || 'literal'`. The `||` between TEXT[] and
-- an untyped literal resolves to array-concatenation, so Postgres tries to parse
-- the message AS an array and raises `22P02 malformed array literal`. plpgsql
-- compiles an expression on first execution, so this sat latent in every failure
-- branch here: the whole suite passed while being structurally unable to REPORT a
-- failure, and it surfaced only when a branch finally fired.
--
-- ASSERTIONS USE `IS DISTINCT FROM`, NEVER `<>`. Measured on 2026-09-03: with the
-- decision function mutated to always return NULL, the worst possible mutant
-- because every day is then authorised for deletion, `v_got <> 'executions-short'`
-- evaluates to NULL, a plpgsql IF does not fire on NULL, and the whole suite
-- passed. The exact trap the function under test exists to guard against was
-- reproduced inside its own test, and only a mutation run exposed it. With the
-- comparison fixed, the same mutant fails 11 of the 13 cases.
--
-- RESULTS, MEASURED 2026-09-03 on branch yqydqfqyzeosxgsitnwg:
--   decision cases                     13 of 13 passed
--   day list, execution parent         [08-30, 08-31, 09-01]
--   day list, step parent              [08-31, 09-01]   (08-30 excluded: 08-29 refused)
--   truncate against real partitions   5 of 5 as expected, the refused day KEPT its row
--   drop against real partitions       5 of 5 as expected, the non-empty one REFUSED
--
-- PRE-FLIGHT against production, read only, same date:
--   at retention 21 (live)   0 days expired, so the ungated job is deleting nothing
--   at retention 7 (#1038)   13 days expired, 13 verified, 0 refused, 1,064,596 executions freed

\set ON_ERROR_STOP on

-- ==================================================================
-- Part 1. The decision, from literals. No tables involved.
-- ==================================================================
DO $$
DECLARE
  v_fail  TEXT[] := '{}';
  v_ran   INTEGER := 0;
  v_now   TIMESTAMPTZ := '2026-09-03T12:00:00Z';
  v_age   INTERVAL := '36 hours';
  v_got   TEXT;
BEGIN
  -- a complete, fresh, agreeing day verifies
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, 0, TRUE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS NOT NULL THEN v_fail := array_append(v_fail, format('case 1: a good day should verify, got %L', v_got)); END IF;

  -- fewer executions in the archive than Postgres held
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 99, 1000, 1000, 0, TRUE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'executions-short' THEN v_fail := array_append(v_fail, format('case 2: expected executions-short, got %L', v_got)); END IF;

  -- MORE in the archive than Postgres held. Its own code: this is how a shortened
  -- retention shows up, and it is not a shortfall.
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 101, 1000, 1000, 0, TRUE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'executions-surplus' THEN v_fail := array_append(v_fail, format('case 3: expected executions-surplus, got %L', v_got)); END IF;

  -- steps disagree while executions match. The steps are the bulk of the data, so
  -- this must refuse on its own rather than be protected by proxy.
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 999, 0, TRUE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'steps-short' THEN v_fail := array_append(v_fail, format('case 4: expected steps-short, got %L', v_got)); END IF;

  -- steps whose execution was never archived have no copy anywhere
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, 3, TRUE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'orphan-executions' THEN v_fail := array_append(v_fail, format('case 5: expected orphan-executions, got %L', v_got)); END IF;

  -- counts agree and the payload probe failed. Matching counts are satisfied by
  -- 100,000 truncated or corrupt blobs, which is why the probe exists.
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, 0, FALSE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'probe-failed' THEN v_fail := array_append(v_fail, format('case 6: expected probe-failed, got %L', v_got)); END IF;

  -- rows archived at the deadline while still non-terminal
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, 0, TRUE, 2, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'incomplete-rows' THEN v_fail := array_append(v_fail, format('case 7: expected incomplete-rows, got %L', v_got)); END IF;

  -- #1137: complete, correct, and too OLD to authorise a deletion now
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, 0, TRUE, 0, v_now - interval '6 days', v_now, v_age);
  IF v_got IS DISTINCT FROM 'measurement-stale' THEN v_fail := array_append(v_fail, format('case 8: expected measurement-stale, got %L', v_got)); END IF;

  -- an erasure legitimately lowers the archive side and must NOT read as a
  -- shortfall, or a correct erasure blocks its day forever while the refusal
  -- names a remedy that cannot restore deliberately destroyed rows
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 5, 95, 1000, 1000, 0, TRUE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS NOT NULL THEN v_fail := array_append(v_fail, format('case 9: erasures should be accounted for, got %L', v_got)); END IF;

  -- A NULL input is NOT a pass. This is the shape that left pg_orphan_step_count
  -- NULL on every production row while still reading like one of the conditions.
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, 0, NULL, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'unmeasured' THEN v_fail := array_append(v_fail, format('case 10: a NULL probe result must refuse, got %L', v_got)); END IF;

  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, NULL, TRUE, 0, v_now - interval '1 hour', v_now, v_age);
  IF v_got IS DISTINCT FROM 'unmeasured' THEN v_fail := array_append(v_fail, format('case 11: a NULL orphan count must refuse, got %L', v_got)); END IF;

  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 100, 1000, 1000, 0, TRUE, 0, NULL, v_now, v_age);
  IF v_got IS DISTINCT FROM 'unmeasured' THEN v_fail := array_append(v_fail, format('case 12: a NULL measured_at must refuse, got %L', v_got)); END IF;

  -- when a reading is BOTH stale and disagreeing, staleness is reported: the
  -- numbers cannot be trusted, and the disagreement may already be repaired
  v_ran := v_ran + 1;
  v_got := verified_day_refusal(100, 0, 90, 1000, 1000, 0, TRUE, 0, v_now - interval '6 days', v_now, v_age);
  IF v_got IS DISTINCT FROM 'measurement-stale' THEN v_fail := array_append(v_fail, format('case 13: staleness outranks a stale disagreement, got %L', v_got)); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'verified_day_refusal: % of % cases failed\n  %',
      array_length(v_fail, 1), v_ran, array_to_string(v_fail, E'\n  ');
  END IF;
  IF v_ran <> 13 THEN RAISE EXCEPTION 'expected 13 decision cases, ran %', v_ran; END IF;
  RAISE NOTICE 'part 1: % of % decision cases passed', v_ran, v_ran;
END $$;

-- ==================================================================
-- Part 2. The day list, including both directions of the step rule.
-- ==================================================================
-- L159: the positive case is proved in the SAME fixture as the negative. An empty
-- step list on its own is satisfied by the whole branch being broken.
DELETE FROM public.execution_archive_days WHERE archive_day BETWEEN '2026-08-28' AND '2026-09-03';
INSERT INTO public.execution_archive_days
  (archive_day, pg_execution_count, erased_execution_count, sf_execution_count,
   pg_step_count, sf_step_count, orphan_execution_count, probe_ok, incomplete_count, measured_at)
VALUES
  ('2026-08-29', 100, 0,  90, 1000, 1000, 0, TRUE, 0, '2026-09-03T11:00:00Z'),  -- refused
  ('2026-08-30', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-09-03T11:00:00Z'),
  ('2026-08-31', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-09-03T11:00:00Z'),
  ('2026-09-01', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-09-03T11:00:00Z'),
  ('2026-09-02', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-09-03T11:00:00Z');

DO $$
DECLARE
  v_now  TIMESTAMPTZ := '2026-09-03T12:00:00Z';
  v_age  INTERVAL := '36 hours';
  v_exec DATE[];
  v_step DATE[];
  v_fail TEXT[] := '{}';
BEGIN
  v_exec := verified_purgeable_days(1, 'workflow_executions', v_age, v_now);
  v_step := verified_purgeable_days(1, 'execution_steps', v_age, v_now);

  -- the refused day is in neither list
  IF '2026-08-29'::date = ANY(v_exec) THEN v_fail := array_append(v_fail, 'a refused day appears in the execution list'); END IF;

  -- the execution parent is unaffected by the day before
  IF NOT ('2026-08-30'::date = ANY(v_exec)) THEN v_fail := array_append(v_fail, 'a verified day is missing from the execution list'); END IF;

  -- NEGATIVE: a step day whose PREDECESSOR is refused may not go, because day D's
  -- step partition holds the post-midnight steps of day D-1's executions
  IF '2026-08-30'::date = ANY(v_step) THEN v_fail := array_append(v_fail, 'a step day was allowed while the day before it was refused'); END IF;

  -- POSITIVE: a step day whose predecessor IS verified may go. Without this the
  -- assertion above is satisfied by the step list always being empty.
  IF NOT ('2026-08-31'::date = ANY(v_step)) THEN v_fail := array_append(v_fail, 'a step day with a verified predecessor was not allowed'); END IF;

  -- nothing old enough means an empty array, never NULL
  IF verified_purgeable_days(90, 'workflow_executions', v_age, v_now) IS DISTINCT FROM '{}'::date[] THEN
    v_fail := array_append(v_fail, 'no eligible day should give an empty array, not NULL');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'verified_purgeable_days:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'part 2: the day list and both directions of the step rule passed';
END $$;

-- ==================================================================
-- Part 3. The procedures, against real partitions holding real rows.
-- ==================================================================
DROP TABLE IF EXISTS public.t_gate_execs CASCADE;
CREATE TABLE public.t_gate_execs (id INT, started_at TIMESTAMPTZ NOT NULL) PARTITION BY RANGE (started_at);
DO $$
DECLARE d DATE;
BEGIN
  FOR d IN SELECT generate_series('2026-08-29'::date, '2026-09-02'::date, interval '1 day')::date LOOP
    EXECUTE format(
      'CREATE TABLE public.t_gate_execs_%s PARTITION OF public.t_gate_execs FOR VALUES FROM (%L) TO (%L)',
      to_char(d, 'YYYY_MM_DD'), d::timestamptz, (d + 1)::timestamptz);
    EXECUTE format('INSERT INTO public.t_gate_execs VALUES (1, %L)', d::timestamptz + interval '5 hours');
  END LOOP;
END $$;

-- The bounds these fixtures produce are character for character the production
-- form, `FOR VALUES FROM ('2026-08-29 00:00:00+00') TO ('2026-08-30 00:00:00+00')`,
-- so the regex is checked against a real bound rather than a remembered one.

-- The step parent is deliberately a name that does not exist, so this call can
-- only touch the execution fixture.
CALL public.truncate_verified_execution_partitions(
  1, 't_gate_steps_absent', 't_gate_execs', interval '36 hours', '2026-09-03T12:00:00Z');

DO $$
DECLARE v_fail TEXT[] := '{}';
BEGIN
  -- THE ASSERTION THAT MATTERS: the refused day KEPT its data.
  IF (SELECT count(*) FROM public.t_gate_execs_2026_08_29) <> 1 THEN
    v_fail := array_append(v_fail, 'the refused day 2026-08-29 lost its row: the gate did not hold');
  END IF;
  IF (SELECT count(*) FROM public.t_gate_execs_2026_08_30) <> 0 THEN
    v_fail := array_append(v_fail, '2026-08-30 was verified and should have been emptied');
  END IF;
  IF (SELECT count(*) FROM public.t_gate_execs_2026_08_31) <> 0 THEN
    v_fail := array_append(v_fail, '2026-08-31 was verified and should have been emptied');
  END IF;
  IF (SELECT count(*) FROM public.t_gate_execs_2026_09_01) <> 0 THEN
    v_fail := array_append(v_fail, '2026-09-01 was verified and should have been emptied');
  END IF;
  -- inside retention, so not a candidate at all
  IF (SELECT count(*) FROM public.t_gate_execs_2026_09_02) <> 1 THEN
    v_fail := array_append(v_fail, '2026-09-02 is inside retention and should be untouched');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'truncate_verified_execution_partitions:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'part 3: truncate acted on the verified days and spared the refused one';
END $$;

-- ==================================================================
-- Part 4. #1014: the reaper refuses a partition that still holds rows.
-- ==================================================================
-- Put a row back into a VERIFIED day's partition, so the drop meets a partition
-- the gate cleared but which is not empty. The procedure it replaced selected
-- purely by age and never checked, so it could destroy a full partition the gate
-- had deliberately spared.
INSERT INTO public.t_gate_execs VALUES (99, '2026-08-30T05:00:00Z');

CALL public.drop_verified_execution_partitions(
  1, 't_gate_steps_absent', 't_gate_execs', interval '36 hours', '2026-09-03T12:00:00Z');

DO $$
DECLARE v_fail TEXT[] := '{}';
BEGIN
  -- NEGATIVE: verified, past retention, and NOT empty, so refused.
  IF to_regclass('public.t_gate_execs_2026_08_30') IS NULL THEN
    v_fail := array_append(v_fail, 'a partition that still held rows was dropped: the emptiness check did not hold');
  END IF;
  -- POSITIVE, in the same run, or the refusal above is satisfied by the procedure
  -- dropping nothing at all.
  IF to_regclass('public.t_gate_execs_2026_08_31') IS NOT NULL THEN
    v_fail := array_append(v_fail, 'an empty verified partition was not dropped');
  END IF;
  IF to_regclass('public.t_gate_execs_2026_09_01') IS NOT NULL THEN
    v_fail := array_append(v_fail, 'an empty verified partition was not dropped');
  END IF;
  -- never a candidate, and it must still hold its data rather than merely exist
  IF to_regclass('public.t_gate_execs_2026_08_29') IS NULL THEN
    v_fail := array_append(v_fail, 'the refused day 2026-08-29 was dropped');
  ELSIF (SELECT count(*) FROM public.t_gate_execs_2026_08_29) <> 1 THEN
    v_fail := array_append(v_fail, 'the refused day 2026-08-29 survived as an empty shell, so its data went anyway');
  END IF;
  IF to_regclass('public.t_gate_execs_2026_09_02') IS NULL THEN
    v_fail := array_append(v_fail, '2026-09-02 is inside retention and was dropped');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'drop_verified_execution_partitions:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'part 4: the reaper dropped the empty shells and refused the one still holding rows';
END $$;

-- Tidy the fixture, so a branch reused for another run starts clean.
DROP TABLE IF EXISTS public.t_gate_execs CASCADE;
