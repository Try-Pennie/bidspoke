-- Behavioural tests for the execution deletion gate (#873, #1014, #1137).
--
-- WHERE THIS RUNS, and it is not all one answer (#1252).
--
-- PART 1 RUNS READ ONLY AGAINST PRODUCTION, and should. `verified_day_refusal`
-- is IMMUTABLE, takes only scalars and touches no table, so every decision case
-- in part 1 is a pure function call: it reads nothing, writes nothing, and can
-- be evaluated as one SELECT against the live database. Verified that way on
-- 2026-09-10 while shipping #1249, all cases passing, including the four added
-- for it.
--
-- That matters because the branch instruction below is why these cases had gone
-- unrun: a branch is a cost, a setup step and a memory note about migrations
-- failing on it, so the cheap thing to do was skip the file entirely. The most
-- valuable half of it never needed one.
--
-- A MUTATION CHECK IS ALSO POSSIBLE READ ONLY: define the broken version of the
-- rule as a `pg_temp` function and evaluate the same cases against it in the
-- same statement. `pg_temp` is per session and touches nothing shared, so the
-- case can be SEEN to fail without altering the live routine (L1).
--
-- EVERYTHING FROM PART 2 ON NEEDS A THROWAWAY BRANCH, never production and never
-- any database holding real executions. Those procedures empty and drop
-- partitions, and no rollback can undo them here: they COMMIT after each
-- partition on purpose, to release the lock, so a wrapping transaction is not
-- available as isolation. The isolation is the DATABASE.
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
-- (the code #1143 renamed to `executions-disagree`)
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
-- RESULTS, MEASURED 2026-09-06 on branch emqdbtmnnaaeudmrhkex (#1196), with the
-- branch holding the gate as shipped first (parts 1 and 2 reproduced the lists
-- above exactly; part 2b failed on the missing column, its RED), then migration
-- 20260906200000 applied:
--   parts 1, 2, 2b                     passed
--   truncate                           emptied 08-30, 08-31, 09-01, stamped exactly those three
--   drop, run at 2026-09-10 04:00      with every reading stale, dropped the two empty stamped
--                                      shells, refused the non-empty one, kept 08-29 and 09-02
--   mutation: stamp clause removed     part 2b fails on 'a step day was refused although its
--                                      predecessor was stamped', so the assertion bites the rule
--
-- RESULTS, MEASURED 2026-09-07 on branch vxgsdctshwalvkdfgjmy (#1204), with the
-- branch holding the 20260906200000 procedures first: part 3b's first run failed on
-- '07-15 was not stamped when its step partition was emptied' (its RED, the exact
-- production failure of that morning), then migration 20260907150000 applied:
--   part 3b                            passed both runs: stamped at the first deletion,
--                                      completed three days later on a stale reading,
--                                      the unstamped stale day kept
--   parts 2, 3, 4                      re-passed unchanged with the new procedure
--   also caught here                   the first draft of 20260907150000 used CREATE OR REPLACE
--                                      with a new parameter list, which ADDS an overload and made
--                                      the routine name ambiguous; the migration now drops the
--                                      old signature first
--
-- CHANGED 2026-09-09 for #1143, NOT YET RUN. Part 1 grew from 13 cases to 21 and
-- every call now passes by name through a `pg_temp.refusal` wrapper holding one
-- good day as its defaults. The eight new cases cover the three conditions the
-- SQL copy could not answer (hours-missing, late-executions,
-- probe-sampled-nothing), the empty day that must stay exempt from the last of
-- them, their three NULL guards, and the precedence of hours-missing over a step
-- disagreement. Part 1b asserts the eleven argument arity is gone. None of this
-- has been executed against a database yet: it needs a throwaway branch, and
-- until that run happens the only thing standing behind #1143 is the CI guard
-- `apps/web/src/lib/__tests__/gate-copies-agree.test.ts`, which compares the two
-- vocabularies and cannot execute either of them.
--
-- PRE-FLIGHT against production, read only, same date:
--   at retention 21 (live)   0 days expired, so the ungated job is deleting nothing
--   at retention 7 (#1038)   13 days expired, 13 verified, 0 refused, 1,064,596 executions freed

\set ON_ERROR_STOP on

-- ==================================================================
-- Part 1. The decision, from literals. No tables involved.
-- ==================================================================
-- EVERY CASE NAMES ITS ARGUMENTS. The decision took eleven positional arguments
-- until #1143 and now takes fourteen, and a positional call is exactly the shape
-- that goes silently wrong when a parameter is inserted in the middle (L237).
-- The wrapper below holds one good day as its defaults and each case overrides
-- only the value it is about, so a case reads as the thing it tests rather than
-- as a row of numbers. The wrapper passes by name too, so it cannot itself be
-- the thing that transposes two arguments.
CREATE OR REPLACE FUNCTION pg_temp.refusal(
  p_pg_execution_count     BIGINT      DEFAULT 100,
  p_erased_execution_count BIGINT      DEFAULT 0,
  p_sf_execution_count     BIGINT      DEFAULT 100,
  p_pg_step_count          BIGINT      DEFAULT 1000,
  p_sf_step_count          BIGINT      DEFAULT 1000,
  p_orphan_execution_count BIGINT      DEFAULT 0,
  p_hours_recorded         BIGINT      DEFAULT 24,
  p_hours_execution_count  BIGINT      DEFAULT 100,
  p_probe_ok               BOOLEAN     DEFAULT TRUE,
  p_probe_sampled          INTEGER     DEFAULT 60,
  p_incomplete_count       BIGINT      DEFAULT 0,
  p_measured_at            TIMESTAMPTZ DEFAULT '2026-09-03T11:00:00Z',
  p_now                    TIMESTAMPTZ DEFAULT '2026-09-03T12:00:00Z',
  p_max_measurement_age    INTERVAL    DEFAULT '36 hours',
  -- #1249. Defaults FALSE, which is what a caller that cannot establish
  -- emptiness passes, so every existing case is judged exactly as before.
  p_partition_empty        BOOLEAN     DEFAULT FALSE
) RETURNS TEXT LANGUAGE sql AS $wrap$
  SELECT public.verified_day_refusal(
    p_pg_execution_count     => p_pg_execution_count,
    p_erased_execution_count => p_erased_execution_count,
    p_sf_execution_count     => p_sf_execution_count,
    p_pg_step_count          => p_pg_step_count,
    p_sf_step_count          => p_sf_step_count,
    p_orphan_execution_count => p_orphan_execution_count,
    p_hours_recorded         => p_hours_recorded,
    p_hours_execution_count  => p_hours_execution_count,
    p_probe_ok               => p_probe_ok,
    p_probe_sampled          => p_probe_sampled,
    p_incomplete_count       => p_incomplete_count,
    p_measured_at            => p_measured_at,
    p_now                    => p_now,
    p_max_measurement_age    => p_max_measurement_age,
    p_partition_empty        => p_partition_empty
  );
$wrap$;

DO $$
DECLARE
  v_fail  TEXT[] := '{}';
  v_ran   INTEGER := 0;
  v_stale TIMESTAMPTZ := '2026-08-28T12:00:00Z';  -- 6 days before p_now
  v_got   TEXT;

BEGIN
  -- a complete, fresh, agreeing day verifies
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal();
  IF v_got IS NOT NULL THEN v_fail := array_append(v_fail, format('case 1: a good day should verify, got %L', v_got)); END IF;

  -- fewer executions in the archive than Postgres held
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_sf_execution_count => 99);
  IF v_got IS DISTINCT FROM 'executions-disagree' THEN v_fail := array_append(v_fail, format('case 2: expected executions-disagree, got %L', v_got)); END IF;

  -- MORE in the archive than Postgres held. Its own code: this is how a shortened
  -- retention shows up, and it is not a shortfall.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_sf_execution_count => 101);
  IF v_got IS DISTINCT FROM 'executions-surplus' THEN v_fail := array_append(v_fail, format('case 3: expected executions-surplus, got %L', v_got)); END IF;

  -- steps disagree while executions match. The steps are the bulk of the data, so
  -- this must refuse on its own rather than be protected by proxy.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_sf_step_count => 999);
  IF v_got IS DISTINCT FROM 'steps-disagree' THEN v_fail := array_append(v_fail, format('case 4: expected steps-disagree, got %L', v_got)); END IF;

  -- steps whose execution was never archived have no copy anywhere
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_orphan_execution_count => 3);
  IF v_got IS DISTINCT FROM 'orphan-executions' THEN v_fail := array_append(v_fail, format('case 5: expected orphan-executions, got %L', v_got)); END IF;

  -- counts agree and the payload probe failed. Matching counts are satisfied by
  -- 100,000 truncated or corrupt blobs, which is why the probe exists.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_probe_ok => FALSE);
  IF v_got IS DISTINCT FROM 'probe-failed' THEN v_fail := array_append(v_fail, format('case 6: expected probe-failed, got %L', v_got)); END IF;

  -- rows archived at the deadline while still non-terminal
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_incomplete_count => 2);
  IF v_got IS DISTINCT FROM 'incomplete-rows' THEN v_fail := array_append(v_fail, format('case 7: expected incomplete-rows, got %L', v_got)); END IF;

  -- #1137: complete, correct, and too OLD to authorise a deletion now
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_measured_at => v_stale);
  IF v_got IS DISTINCT FROM 'stale-measurement' THEN v_fail := array_append(v_fail, format('case 8: expected stale-measurement, got %L', v_got)); END IF;

  -- an erasure legitimately lowers the archive side and must NOT read as a
  -- shortfall, or a correct erasure blocks its day forever while the refusal
  -- names a remedy that cannot restore deliberately destroyed rows
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_erased_execution_count => 5, p_sf_execution_count => 95);
  IF v_got IS NOT NULL THEN v_fail := array_append(v_fail, format('case 9: erasures should be accounted for, got %L', v_got)); END IF;

  -- A NULL input is NOT a pass. This is the shape that left pg_orphan_step_count
  -- NULL on every production row while still reading like one of the conditions.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_probe_ok => NULL);
  IF v_got IS DISTINCT FROM 'never-measured' THEN v_fail := array_append(v_fail, format('case 10: a NULL probe result must refuse, got %L', v_got)); END IF;

  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_orphan_execution_count => NULL);
  IF v_got IS DISTINCT FROM 'never-measured' THEN v_fail := array_append(v_fail, format('case 11: a NULL orphan count must refuse, got %L', v_got)); END IF;

  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_measured_at => NULL);
  IF v_got IS DISTINCT FROM 'never-measured' THEN v_fail := array_append(v_fail, format('case 12: a NULL measured_at must refuse, got %L', v_got)); END IF;

  -- when a reading is BOTH stale and disagreeing, staleness is reported: the
  -- numbers cannot be trusted, and the disagreement may already be repaired
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_sf_execution_count => 90, p_measured_at => v_stale);
  IF v_got IS DISTINCT FROM 'stale-measurement' THEN v_fail := array_append(v_fail, format('case 13: staleness outranks a stale disagreement, got %L', v_got)); END IF;

  -- ----------------------------------------------------------------
  -- #1249. An empty day proved empty NOW is exempt from the age rule.
  --
  -- 2026-08-14 and 2026-08-15 refused stale-measurement for ever, with zero
  -- hours and zero executions and readings 147 and 128 hours old, and each held
  -- back the following day's step partition. The gate only measures days inside
  -- its candidate window, so a day that leaves it unverified is never measured
  -- again and its reading only gets older.
  --
  -- Age matters because a reading may no longer describe the world. A day with
  -- nothing in it has nothing to describe and nothing to lose.
  -- ----------------------------------------------------------------

  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(
    p_measured_at => v_stale, p_partition_empty => TRUE,
    p_pg_execution_count => 0, p_hours_recorded => 0, p_hours_execution_count => 0,
    p_sf_execution_count => 0, p_pg_step_count => 0, p_sf_step_count => 0,
    p_probe_sampled => 0
  );
  IF v_got IS NOT NULL THEN v_fail := array_append(v_fail, format('case 1249a: an empty day proved empty now must not refuse on age, got %L', v_got)); END IF;

  -- The exemption is NOT taken on the strength of the stale reading alone.
  -- A caller that could not establish emptiness passes false, and the day goes
  -- on refusing, which is the fail-safe direction.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(
    p_measured_at => v_stale, p_partition_empty => FALSE,
    p_pg_execution_count => 0, p_hours_recorded => 0, p_hours_execution_count => 0,
    p_sf_execution_count => 0, p_pg_step_count => 0, p_sf_step_count => 0,
    p_probe_sampled => 0
  );
  IF v_got IS DISTINCT FROM 'stale-measurement' THEN v_fail := array_append(v_fail, format('case 1249b: without live proof of emptiness the age rule still applies, got %L', v_got)); END IF;

  -- A partition that is empty NOW but whose reading says the day HAD executions
  -- is not an empty day: its rows were removed by something other than this
  -- gate, and reading that as verified would vouch for data nobody archived.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_measured_at => v_stale, p_partition_empty => TRUE);
  IF v_got IS DISTINCT FROM 'stale-measurement' THEN v_fail := array_append(v_fail, format('case 1249c: an emptied partition whose reading had executions must still refuse, got %L', v_got)); END IF;

  -- The exemption does not leak into a FRESH day: a day with executions is
  -- judged on its numbers whatever its partition currently holds.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_partition_empty => TRUE, p_sf_execution_count => 90);
  IF v_got IS DISTINCT FROM 'executions-disagree' THEN v_fail := array_append(v_fail, format('case 1249d: emptiness must not excuse a real disagreement, got %L', v_got)); END IF;

  -- ----------------------------------------------------------------
  -- #1143. The three conditions the reporter had and this did not.
  -- ----------------------------------------------------------------

  -- An hour the archiver never recorded. The day is not finished, so nothing
  -- about it has been counted in full.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_hours_recorded => 23);
  IF v_got IS DISTINCT FROM 'hours-missing' THEN v_fail := array_append(v_fail, format('case 14: expected hours-missing, got %L', v_got)); END IF;

  -- Missing hours outrank a step disagreement, because pg_step_count is SUMMED
  -- from those hours: reporting the shortfall would name a quantity measured over
  -- a fraction of the day rather than the hour that is actually absent.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_hours_recorded => 20, p_sf_step_count => 1);
  IF v_got IS DISTINCT FROM 'hours-missing' THEN v_fail := array_append(v_fail, format('case 15: hours-missing must outrank steps-disagree, got %L', v_got)); END IF;

  -- Two independent Postgres counts of one population disagree, which happens
  -- only when executions arrived after their hour had been archived. Every hour
  -- reconciled at the time it ran, so nothing else would notice.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_hours_execution_count => 99);
  IF v_got IS DISTINCT FROM 'late-executions' THEN v_fail := array_append(v_fail, format('case 16: expected late-executions, got %L', v_got)); END IF;

  -- A probe that examined nothing is not a probe that passed. probe_ok is TRUE
  -- here, which is exactly how this escaped: the old CASE asked only that.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_probe_sampled => 0);
  IF v_got IS DISTINCT FROM 'probe-sampled-nothing' THEN v_fail := array_append(v_fail, format('case 17: expected probe-sampled-nothing, got %L', v_got)); END IF;

  -- A genuinely empty day is exempt: there is nothing to sample and its zero is
  -- honest. Without this the rule above would block every quiet day forever.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(
    p_pg_execution_count => 0, p_sf_execution_count => 0,
    p_pg_step_count => 0, p_sf_step_count => 0,
    p_hours_execution_count => 0, p_probe_sampled => 0
  );
  IF v_got IS NOT NULL THEN v_fail := array_append(v_fail, format('case 18: an empty day should verify, got %L', v_got)); END IF;

  -- The three new inputs are NULL guarded like every other. Without this, three
  -- valued logic makes `p_hours_recorded < 24` neither true nor false and the
  -- CASE falls through to verified on a reading nobody took.
  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_hours_recorded => NULL);
  IF v_got IS DISTINCT FROM 'never-measured' THEN v_fail := array_append(v_fail, format('case 19: a NULL hours_recorded must refuse, got %L', v_got)); END IF;

  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_hours_execution_count => NULL);
  IF v_got IS DISTINCT FROM 'never-measured' THEN v_fail := array_append(v_fail, format('case 20: a NULL hours_execution_count must refuse, got %L', v_got)); END IF;

  v_ran := v_ran + 1;
  v_got := pg_temp.refusal(p_probe_sampled => NULL);
  IF v_got IS DISTINCT FROM 'never-measured' THEN v_fail := array_append(v_fail, format('case 21: a NULL probe_sampled must refuse, got %L', v_got)); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'verified_day_refusal: % of % cases failed\n  %',
      array_length(v_fail, 1), v_ran, array_to_string(v_fail, E'\n  ');
  END IF;
  IF v_ran <> 21 THEN RAISE EXCEPTION 'expected 21 decision cases, ran %', v_ran; END IF;
  RAISE NOTICE 'part 1: % of % decision cases passed', v_ran, v_ran;
END $$;

-- The eleven argument signature must be GONE, not merely superseded: Postgres
-- overloads on arity, so the old one would still be callable and would still
-- authorise a deletion without the three conditions above (#1143).
DO $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'verified_day_refusal';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one verified_day_refusal, found % (a weaker arity is still callable)', v_n;
  END IF;
  RAISE NOTICE 'part 1b: exactly one verified_day_refusal exists';
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
-- Part 2b. The real cron instant, and the stamp (#1196).
-- ==================================================================
-- The gate measures at 13:00 UTC and the purge runs at 03:30 UTC. At retention 7,
-- day 2026-07-30 is first eligible on the night of 2026-08-07, so the readings the
-- purge can see are the ones taken on 08-06 (14.5 hours old) or 08-05 (38.5
-- hours old). July dates, so Part 3's fixture below is left exactly as Part 2 set it. Both are in the fixture at once (L159): the pass and the refusal
-- are decided at the SAME instant, so an always-empty list cannot satisfy this.
DELETE FROM public.execution_archive_days WHERE archive_day BETWEEN '2026-07-28' AND '2026-07-31';
INSERT INTO public.execution_archive_days
  (archive_day, pg_execution_count, erased_execution_count, sf_execution_count,
   pg_step_count, sf_step_count, orphan_execution_count, probe_ok, incomplete_count, measured_at)
VALUES
  ('2026-07-29', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-08-05T13:00:00Z'),  -- 38.5 h at the cron
  ('2026-07-30', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-08-06T13:00:00Z');  -- 14.5 h at the cron

DO $$
DECLARE
  v_cron TIMESTAMPTZ := '2026-08-07T03:30:00Z';
  v_age  INTERVAL := '36 hours';
  v_exec DATE[];
  v_step DATE[];
  v_fail TEXT[] := '{}';
BEGIN
  v_exec := verified_purgeable_days(7, 'workflow_executions', v_age, v_cron);
  v_step := verified_purgeable_days(7, 'execution_steps', v_age, v_cron);

  -- measured at 13:00 the day before the purge: fresh, in the list
  IF NOT ('2026-07-30'::date = ANY(v_exec)) THEN v_fail := array_append(v_fail, 'a day measured 14.5 hours before the purge was not authorised'); END IF;
  -- measured a day earlier: stale, excluded. This is the reading the old window left every day with.
  IF '2026-07-29'::date = ANY(v_exec) THEN v_fail := array_append(v_fail, 'a day measured 38.5 hours before the purge was authorised despite the 36 hour bound'); END IF;
  -- the step day needs its predecessor, which is stale and unstamped
  IF '2026-07-30'::date = ANY(v_step) THEN v_fail := array_append(v_fail, 'a step day was allowed while its predecessor was stale and unstamped'); END IF;

  -- Now the predecessor carries the stamp the truncate writes when it empties a
  -- day's execution partition after a fresh verification. Its measurement is as
  -- stale as before; the stamp is what changes.
  UPDATE public.execution_archive_days SET executions_truncated_at = '2026-08-06T03:30:00Z' WHERE archive_day = '2026-07-29';
  v_exec := verified_purgeable_days(7, 'workflow_executions', v_age, v_cron);
  v_step := verified_purgeable_days(7, 'execution_steps', v_age, v_cron);

  IF NOT ('2026-07-30'::date = ANY(v_step)) THEN v_fail := array_append(v_fail, 'a step day was refused although its predecessor was stamped as truncated after verification'); END IF;
  -- a stamped day is verified for the execution parent too, which is what lets the Sunday reaper drop its empty shell
  IF NOT ('2026-07-29'::date = ANY(v_exec)) THEN v_fail := array_append(v_fail, 'a stamped day was not treated as verified for the execution parent'); END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'verified_purgeable_days at the cron instant:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'part 2b: the cron instant accepts the 14.5 hour reading, refuses the 38.5 hour one, and the stamp admits the step day';
END $$;
-- Tidy, so the stamped July day cannot leak into a later part's day list.
DELETE FROM public.execution_archive_days WHERE archive_day BETWEEN '2026-07-28' AND '2026-07-31';

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

  -- #1196: every day whose execution partition was emptied carries the stamp, at
  -- the procedure's own p_now, and nothing else does. The stamp is what lets the
  -- next night's step partition go once this day's reading has aged out.
  IF (SELECT count(*) FROM public.execution_archive_days
      WHERE archive_day IN ('2026-08-30', '2026-08-31', '2026-09-01')
        AND executions_truncated_at = '2026-09-03T12:00:00Z') <> 3 THEN
    v_fail := array_append(v_fail, 'the emptied days were not all stamped executions_truncated_at at the run instant');
  END IF;
  IF (SELECT count(*) FROM public.execution_archive_days
      WHERE archive_day IN ('2026-08-29', '2026-09-02') AND executions_truncated_at IS NOT NULL) <> 0 THEN
    v_fail := array_append(v_fail, 'a day that was refused or inside retention was stamped as truncated');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'truncate_verified_execution_partitions:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'part 3: truncate acted on the verified days and spared the refused one';
END $$;

-- ==================================================================
-- Part 3b. #1204: a run that dies between the step loop and the execution
--          loop must not strand the day.
-- ==================================================================
-- The first unaided run (2026-09-07 03:30) truncated 08-30's steps and then
-- lost a 2 second lock race on its executions. Re-measured, the day refused
-- (`probe-failed`: the probe reads live steps, which were gone), so its
-- executions could never be authorised again and 08-31's steps were blocked
-- behind it. The stamp must therefore be written at the FIRST irreversible
-- action, so a partial run is completed by the next one instead of stranded.
--
-- July dates, so Part 2's fixture and Part 4 below are untouched.
DELETE FROM public.execution_archive_days WHERE archive_day BETWEEN '2026-07-13' AND '2026-07-16';
INSERT INTO public.execution_archive_days
  (archive_day, pg_execution_count, erased_execution_count, sf_execution_count,
   pg_step_count, sf_step_count, orphan_execution_count, probe_ok, incomplete_count, measured_at)
VALUES
  ('2026-07-14', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-07-16T13:00:00Z'),  -- verified, fresh at the first run
  ('2026-07-15', 100, 0, 100, 1000, 1000, 0, TRUE, 0, '2026-07-16T13:00:00Z');  -- verified, fresh at the first run

-- A step fixture holding only 07-15 (07-14's steps are imagined already gone),
-- and an execution fixture holding both days.
DROP TABLE IF EXISTS public.t_gate_steps CASCADE;
CREATE TABLE public.t_gate_steps (id INT, started_at TIMESTAMPTZ NOT NULL) PARTITION BY RANGE (started_at);
CREATE TABLE public.t_gate_steps_2026_07_15 PARTITION OF public.t_gate_steps
  FOR VALUES FROM ('2026-07-15 00:00:00+00') TO ('2026-07-16 00:00:00+00');
INSERT INTO public.t_gate_steps VALUES (1, '2026-07-15T05:00:00Z');
DROP TABLE IF EXISTS public.t_gate_execs2 CASCADE;
CREATE TABLE public.t_gate_execs2 (id INT, started_at TIMESTAMPTZ NOT NULL) PARTITION BY RANGE (started_at);
CREATE TABLE public.t_gate_execs2_2026_07_14 PARTITION OF public.t_gate_execs2
  FOR VALUES FROM ('2026-07-14 00:00:00+00') TO ('2026-07-15 00:00:00+00');
CREATE TABLE public.t_gate_execs2_2026_07_15 PARTITION OF public.t_gate_execs2
  FOR VALUES FROM ('2026-07-15 00:00:00+00') TO ('2026-07-16 00:00:00+00');
INSERT INTO public.t_gate_execs2 VALUES (1, '2026-07-14T05:00:00Z'), (1, '2026-07-15T05:00:00Z');

-- FIRST RUN, fresh: the step loop runs; the execution parent does not exist, which
-- stands in for the run dying (or losing its lock) before the execution loop.
CALL public.truncate_verified_execution_partitions(
  1, 't_gate_steps', 't_gate_execs2_absent', interval '36 hours', '2026-07-17T03:30:00Z');

DO $$
DECLARE v_fail TEXT[] := '{}';
BEGIN
  IF (SELECT count(*) FROM public.t_gate_steps_2026_07_15) <> 0 THEN
    v_fail := array_append(v_fail, '07-15 steps were verified and should have been emptied');
  END IF;
  -- THE ASSERTION THAT MATTERS: the day is stamped by its first deletion, not its last.
  IF (SELECT executions_truncated_at FROM public.execution_archive_days WHERE archive_day = '2026-07-15') IS DISTINCT FROM '2026-07-17T03:30:00Z'::timestamptz THEN
    v_fail := array_append(v_fail, '07-15 was not stamped when its step partition was emptied, so a run that dies here strands the day');
  END IF;
  IF (SELECT executions_truncated_at FROM public.execution_archive_days WHERE archive_day = '2026-07-14') IS NOT NULL THEN
    v_fail := array_append(v_fail, '07-14 had no partition emptied and must not be stamped');
  END IF;
  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'truncate, first run of a partial day:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
END $$;

-- SECOND RUN, three days later: every reading is stale. Only the stamp can
-- authorise anything, and it must authorise exactly the day whose deletion began.
CALL public.truncate_verified_execution_partitions(
  1, 't_gate_steps_absent', 't_gate_execs2', interval '36 hours', '2026-07-20T03:30:00Z');

DO $$
DECLARE v_fail TEXT[] := '{}';
BEGIN
  -- POSITIVE: the stamped day's executions go despite the stale reading.
  IF (SELECT count(*) FROM public.t_gate_execs2_2026_07_15) <> 0 THEN
    v_fail := array_append(v_fail, '07-15 executions were not emptied on the next run although the day was stamped');
  END IF;
  -- NEGATIVE, same run (L159): an unstamped day with a stale reading is kept.
  IF (SELECT count(*) FROM public.t_gate_execs2_2026_07_14) <> 1 THEN
    v_fail := array_append(v_fail, '07-14 was never stamped and its stale reading must not authorise a truncate');
  END IF;
  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'truncate, completing a partial day:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'part 3b: a partial run stamps at its first deletion and the next run completes the day';
END $$;

DROP TABLE IF EXISTS public.t_gate_steps CASCADE;
DROP TABLE IF EXISTS public.t_gate_execs2 CASCADE;
DELETE FROM public.execution_archive_days WHERE archive_day BETWEEN '2026-07-13' AND '2026-07-16';

-- ==================================================================
-- Part 4. #1014: the reaper refuses a partition that still holds rows.
--         #1196: and it drops stamped shells whose readings have gone stale.
-- ==================================================================
-- Put a row back into a VERIFIED day's partition, so the drop meets a partition
-- the gate cleared but which is not empty. The procedure it replaced selected
-- purely by age and never checked, so it could destroy a full partition the gate
-- had deliberately spared.
INSERT INTO public.t_gate_execs VALUES (99, '2026-08-30T05:00:00Z');

-- Run a WEEK after every measurement above. The real reaper runs on Sunday
-- against shells emptied up to seven nights earlier, whose readings are all past
-- the 36 hour bound, so before #1196 it could never drop anything. At this
-- instant the stamp the truncate wrote in part 3 is the only thing that can
-- authorise a drop, and 2026-09-02, never truncated and never stamped, is now
-- past retention too and must stay.
CALL public.drop_verified_execution_partitions(
  1, 't_gate_steps_absent', 't_gate_execs', interval '36 hours', '2026-09-10T04:00:00Z');

DO $$
DECLARE v_fail TEXT[] := '{}';
BEGIN
  -- NEGATIVE: stamped, past retention, and NOT empty, so refused.
  IF to_regclass('public.t_gate_execs_2026_08_30') IS NULL THEN
    v_fail := array_append(v_fail, 'a partition that still held rows was dropped: the emptiness check did not hold');
  END IF;
  -- POSITIVE, in the same run, or the refusal above is satisfied by the procedure
  -- dropping nothing at all. Only the stamp can have authorised these.
  IF to_regclass('public.t_gate_execs_2026_08_31') IS NOT NULL THEN
    v_fail := array_append(v_fail, 'an empty stamped partition was not dropped although its measurement was stale');
  END IF;
  IF to_regclass('public.t_gate_execs_2026_09_01') IS NOT NULL THEN
    v_fail := array_append(v_fail, 'an empty stamped partition was not dropped although its measurement was stale');
  END IF;
  -- never a candidate, and it must still hold its data rather than merely exist
  IF to_regclass('public.t_gate_execs_2026_08_29') IS NULL THEN
    v_fail := array_append(v_fail, 'the refused day 2026-08-29 was dropped');
  ELSIF (SELECT count(*) FROM public.t_gate_execs_2026_08_29) <> 1 THEN
    v_fail := array_append(v_fail, 'the refused day 2026-08-29 survived as an empty shell, so its data went anyway');
  END IF;
  -- unstamped and stale: past retention at this instant, yet not verified, so kept with its row
  IF to_regclass('public.t_gate_execs_2026_09_02') IS NULL THEN
    v_fail := array_append(v_fail, '2026-09-02 was never truncated or stamped and its stale reading must not authorise a drop');
  ELSIF (SELECT count(*) FROM public.t_gate_execs_2026_09_02) <> 1 THEN
    v_fail := array_append(v_fail, '2026-09-02 lost its row');
  END IF;

  IF array_length(v_fail, 1) > 0 THEN
    RAISE EXCEPTION E'drop_verified_execution_partitions:\n  %', array_to_string(v_fail, E'\n  ');
  END IF;
  RAISE NOTICE 'part 4: the reaper dropped the stamped empty shells at a stale instant and refused the one still holding rows';
END $$;

-- Tidy the fixture, so a branch reused for another run starts clean.
DROP TABLE IF EXISTS public.t_gate_execs CASCADE;
DELETE FROM public.execution_archive_days WHERE archive_day BETWEEN '2026-08-28' AND '2026-09-03';
