-- Behavioural tests for the record of every Slack post (#2364),
-- slack_post_outcomes, which the tail worker writes from the Worker's
-- `[slack] post outcome` lines, and the two functions the minute refusal check
-- reads it through.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds
-- by replaying every migration from empty, never production.
--
-- WHAT IT PROVES.
--   A. A post written twice is one row: the tail worker's upsert, which ignores
--      a row already there, keeps the first copy.
--   B. Only the outcomes and kinds the Worker writes are accepted, a delivered
--      post carries no refusal kind and a refusal always carries one, and an
--      over long id, channel or title is refused.
--   C. The browser roles reach neither the table, the purge nor either read
--      function, and row level security is on; the worker's role can read and
--      write it.
--   D. Retention removes rows older than 7 days, keeps the rest, and is
--      scheduled in pg_cron with its own budget.
--   E. slack_refusal_runs returns, per channel, the newest delivered post and
--      ONLY the refusals after it: a refusal before a success is not in a run.
--   F. slack_refusal_summary counts every refusal of the named channels in a
--      window, by reason and by title, whether or not a success came between.
--   G. Both read functions are STABLE, so the local dev write guard can let
--      them through as reads.
--
-- HOW IT ASSERTS: RAISE EXCEPTION inside DO blocks, one case per block, counted
-- into a temp table and compared to the number at the bottom (L288).

CREATE TEMP TABLE IF NOT EXISTS spo_cases (name text PRIMARY KEY);
DELETE FROM spo_cases;
DELETE FROM public.slack_post_outcomes WHERE post_id LIKE 'spo-test-%';

-- ── A. One post, one row ─────────────────────────────────────────────────────
DO $do$
BEGIN
  INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, reason, kind, status, title)
  VALUES ('spo-test-a', now(), 'C0SPOTEST', 'refused', 'not_in_channel', 'destination', 200, 'Failure Spike')
  ON CONFLICT (post_id) DO NOTHING;
  INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, reason, kind, status, title)
  VALUES ('spo-test-a', now(), 'C0SPOTEST', 'delivered', NULL, NULL, 200, 'Failure Spike')
  ON CONFLICT (post_id) DO NOTHING;
  IF (SELECT count(*) FROM public.slack_post_outcomes WHERE post_id = 'spo-test-a') <> 1 THEN
    RAISE EXCEPTION 'one post written twice made more than one row';
  END IF;
  IF (SELECT outcome FROM public.slack_post_outcomes WHERE post_id = 'spo-test-a') <> 'refused' THEN
    RAISE EXCEPTION 'a second copy replaced the first';
  END IF;
  INSERT INTO spo_cases VALUES ('a post written twice is one row');
END
$do$;

-- ── B. Only what the Worker writes ───────────────────────────────────────────
DO $do$
BEGIN
  INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, reason, kind, status, title) VALUES
    ('spo-test-b1', now(), 'C0SPOTEST', 'delivered', NULL, NULL, 200, NULL),
    ('spo-test-b2', now(), 'C0SPOTEST', 'refused', NULL, 'transient', 429, 'Recovered'),
    ('spo-test-b3', now(), 'C0SPOTEST', 'no_answer', NULL, 'transient', NULL, NULL);
  BEGIN
    INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind) VALUES ('spo-test-bad1', now(), 'C0SPOTEST', 'exploded', 'transient');
    RAISE EXCEPTION 'an unknown outcome was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind) VALUES ('spo-test-bad2', now(), 'C0SPOTEST', 'refused', 'whatever');
    RAISE EXCEPTION 'an unknown kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind) VALUES ('spo-test-bad3', now(), 'C0SPOTEST', 'delivered', 'destination');
    RAISE EXCEPTION 'a delivered post with a refusal kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind) VALUES ('spo-test-bad4', now(), 'C0SPOTEST', 'refused', NULL);
    RAISE EXCEPTION 'a refusal with no kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind) VALUES ('spo-test-' || repeat('x', 92), now(), 'C0SPOTEST', 'refused', 'transient');
    RAISE EXCEPTION 'a 101 character id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind, title) VALUES ('spo-test-bad6', now(), 'C0SPOTEST', 'refused', 'transient', repeat('t', 201));
    RAISE EXCEPTION 'a 201 character title was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind) VALUES ('spo-test-bad7', now(), '', 'refused', 'transient');
    RAISE EXCEPTION 'an empty channel was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO spo_cases VALUES ('only the outcomes, kinds and sizes the Worker writes are accepted');
END
$do$;

-- ── C. The browser roles reach nothing ───────────────────────────────────────
DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(r, 'public.slack_post_outcomes', 'SELECT')
       OR has_table_privilege(r, 'public.slack_post_outcomes', 'INSERT')
       OR has_table_privilege(r, 'public.slack_post_outcomes', 'UPDATE')
       OR has_table_privilege(r, 'public.slack_post_outcomes', 'DELETE') THEN
      RAISE EXCEPTION '% can reach slack_post_outcomes', r;
    END IF;
    IF has_function_privilege(r, 'public.purge_slack_post_outcomes()', 'EXECUTE') THEN
      RAISE EXCEPTION '% can run the purge', r;
    END IF;
    IF has_function_privilege(r, 'public.slack_refusal_runs(timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION '% can read the refusal runs', r;
    END IF;
    IF has_function_privilege(r, 'public.slack_refusal_summary(text[], timestamptz, timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION '% can read the refusal summary', r;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.slack_post_outcomes'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on slack_post_outcomes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.slack_post_outcomes', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.slack_post_outcomes', 'INSERT')
     OR NOT has_function_privilege('service_role', 'public.slack_refusal_runs(timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.slack_refusal_summary(text[], timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the worker''s role cannot read and write the record';
  END IF;
  INSERT INTO spo_cases VALUES ('anon and authenticated reach neither the record nor its functions');
END
$do$;

-- ── D. Retention ─────────────────────────────────────────────────────────────
DO $do$
DECLARE
  removed int;
BEGIN
  DELETE FROM public.slack_post_outcomes;
  INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, kind) VALUES
    ('spo-test-old', now() - interval '7 days 1 minute', 'C0SPOTEST', 'refused', 'transient'),
    ('spo-test-recent', now() - interval '6 days 23 hours', 'C0SPOTEST', 'refused', 'transient'),
    ('spo-test-today', now() - interval '1 hour', 'C0SPOTEST', 'delivered', NULL);
  removed := public.purge_slack_post_outcomes();
  IF removed <> 1 THEN RAISE EXCEPTION 'purge removed % rows, expected 1', removed; END IF;
  IF EXISTS (SELECT 1 FROM public.slack_post_outcomes WHERE post_id = 'spo-test-old') THEN RAISE EXCEPTION 'a row past 7 days survived'; END IF;
  IF (SELECT count(*) FROM public.slack_post_outcomes WHERE post_id IN ('spo-test-recent', 'spo-test-today')) <> 2 THEN
    RAISE EXCEPTION 'the purge removed a row inside 7 days';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'purge-slack-post-outcomes'
      AND command LIKE '%purge_slack_post_outcomes()%'
      AND command LIKE '%statement_timeout = ''30s''%'
  ) THEN
    RAISE EXCEPTION 'the retention purge is not scheduled with its budget';
  END IF;
  INSERT INTO spo_cases VALUES ('retention removes only rows over 7 days old');
END
$do$;

-- ── E. A run is the refusals after the newest success ───────────────────────
DO $do$
DECLARE
  r record;
  n int := 0;
BEGIN
  DELETE FROM public.slack_post_outcomes;
  INSERT INTO public.slack_post_outcomes (post_id, occurred_at, channel, outcome, reason, kind, status, title) VALUES
    -- C0RUN: two refusals, a success, then three refusals: the run is the last three.
    ('spo-test-e1', '2026-10-23T02:00:00Z', 'C0RUN', 'refused', 'not_in_channel', 'destination', 200, 'Old Refusal'),
    ('spo-test-e2', '2026-10-23T02:01:00Z', 'C0RUN', 'refused', 'not_in_channel', 'destination', 200, 'Old Refusal'),
    ('spo-test-e3', '2026-10-23T02:05:00Z', 'C0RUN', 'delivered', NULL, NULL, 200, 'Recovered'),
    ('spo-test-e4', '2026-10-23T02:10:00Z', 'C0RUN', 'refused', 'not_in_channel', 'destination', 200, 'Failure Spike'),
    ('spo-test-e5', '2026-10-23T02:11:00Z', 'C0RUN', 'refused', NULL, 'transient', 429, 'Failure Spike'),
    ('spo-test-e6', '2026-10-23T02:12:00Z', 'C0RUN', 'no_answer', NULL, 'transient', NULL, 'Workflow Execution Failed'),
    -- C0OK: refusals then a success: no run.
    ('spo-test-e7', '2026-10-23T02:00:00Z', 'C0OK', 'refused', NULL, 'transient', 503, 'X'),
    ('spo-test-e8', '2026-10-23T02:30:00Z', 'C0OK', 'delivered', NULL, NULL, 200, 'Y'),
    -- C0NEVER: never delivered, one refusal: a run with no newest success.
    ('spo-test-e9', '2026-10-23T02:20:00Z', 'C0NEVER', 'refused', 'channel_not_found', 'destination', 200, NULL),
    -- Before the window: ignored entirely.
    ('spo-test-e0', '2026-10-22T00:00:00Z', 'C0OLD', 'refused', 'invalid_auth', 'destination', 200, 'Ancient');

  FOR r IN SELECT * FROM public.slack_refusal_runs('2026-10-23T00:00:00Z') ORDER BY channel LOOP
    n := n + 1;
    IF r.channel = 'C0RUN' THEN
      IF r.last_delivered_at <> '2026-10-23T02:05:00Z' THEN RAISE EXCEPTION 'C0RUN newest success is %', r.last_delivered_at; END IF;
      IF r.refused <> 3 THEN RAISE EXCEPTION 'C0RUN run holds % refusals, expected the 3 after the success', r.refused; END IF;
      IF r.destination <> 1 THEN RAISE EXCEPTION 'C0RUN run holds % destination refusals, expected 1', r.destination; END IF;
      IF r.first_refused_at <> '2026-10-23T02:10:00Z' OR r.last_refused_at <> '2026-10-23T02:12:00Z' THEN
        RAISE EXCEPTION 'C0RUN run spans % to %', r.first_refused_at, r.last_refused_at;
      END IF;
      IF (SELECT sum((x->>'refused')::int) FROM jsonb_array_elements(r.reasons) x) <> 3 THEN RAISE EXCEPTION 'C0RUN reasons do not add up: %', r.reasons; END IF;
      IF NOT r.reasons @> '[{"reason": "not_in_channel", "status": 200, "kind": "destination", "refused": 1}, {"reason": null, "status": 429, "kind": "transient", "refused": 1}, {"reason": null, "status": null, "kind": "transient", "refused": 1}]'::jsonb THEN
        RAISE EXCEPTION 'C0RUN reasons are %', r.reasons;
      END IF;
      IF r.titles <> '[{"title": "Failure Spike", "refused": 2}, {"title": "Workflow Execution Failed", "refused": 1}]'::jsonb THEN
        RAISE EXCEPTION 'C0RUN titles are %', r.titles;
      END IF;
    ELSIF r.channel = 'C0OK' THEN
      IF r.refused <> 0 OR r.last_delivered_at <> '2026-10-23T02:30:00Z' THEN RAISE EXCEPTION 'C0OK is % refusals after %', r.refused, r.last_delivered_at; END IF;
    ELSIF r.channel = 'C0NEVER' THEN
      IF r.refused <> 1 OR r.destination <> 1 OR r.last_delivered_at IS NOT NULL THEN RAISE EXCEPTION 'C0NEVER is % refusals after %', r.refused, r.last_delivered_at; END IF;
      IF r.titles <> '[{"title": null, "refused": 1}]'::jsonb THEN RAISE EXCEPTION 'C0NEVER titles are %', r.titles; END IF;
    ELSE
      RAISE EXCEPTION 'unexpected channel % in the runs (a row before p_since?)', r.channel;
    END IF;
  END LOOP;
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 channels, got %', n; END IF;
  INSERT INTO spo_cases VALUES ('a run holds only the refusals after the newest success');
END
$do$;

-- ── F. The all clear's summary ───────────────────────────────────────────────
DO $do$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM public.slack_refusal_summary(ARRAY['C0RUN', 'C0NEVER'], '2026-10-23T02:00:00Z', '2026-10-23T02:15:00Z');
  -- Every refusal of the two channels in the window, a success between them or
  -- not, a post with no answer included: five on C0RUN, and C0NEVER's one is
  -- after the window.
  IF s.refused <> 5 THEN RAISE EXCEPTION 'summary counts % refusals, expected 5', s.refused; END IF;
  IF s.first_refused_at <> '2026-10-23T02:00:00Z' OR s.last_refused_at <> '2026-10-23T02:12:00Z' THEN
    RAISE EXCEPTION 'summary spans % to %', s.first_refused_at, s.last_refused_at;
  END IF;
  IF NOT s.reasons @> '[{"reason": "not_in_channel", "status": 200, "kind": "destination", "refused": 3}]'::jsonb THEN
    RAISE EXCEPTION 'summary reasons are %', s.reasons;
  END IF;
  IF s.titles <> '[{"title": "Failure Spike", "refused": 2}, {"title": "Old Refusal", "refused": 2}, {"title": "Workflow Execution Failed", "refused": 1}]'::jsonb THEN
    RAISE EXCEPTION 'summary titles are %', s.titles;
  END IF;
  SELECT * INTO s FROM public.slack_refusal_summary(ARRAY['C0NONE'], '2026-10-23T02:00:00Z', '2026-10-23T02:15:00Z');
  IF s.refused <> 0 OR s.reasons <> '[]'::jsonb OR s.titles <> '[]'::jsonb OR s.first_refused_at IS NOT NULL THEN
    RAISE EXCEPTION 'an empty summary is % refusals, % reasons, % titles', s.refused, s.reasons, s.titles;
  END IF;
  INSERT INTO spo_cases VALUES ('the summary counts every refusal in the window by reason and title');
END
$do$;

-- ── G. Both reads are STABLE ─────────────────────────────────────────────────
DO $do$
BEGIN
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.slack_refusal_runs(timestamptz)'::regprocedure) <> 's'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.slack_refusal_summary(text[], timestamptz, timestamptz)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'a refusal read is not STABLE';
  END IF;
  INSERT INTO spo_cases VALUES ('both reads are STABLE');
END
$do$;

-- ── Clean up ─────────────────────────────────────────────────────────────────
DELETE FROM public.slack_post_outcomes WHERE post_id LIKE 'spo-test-%';

DO $do$
DECLARE
  n int := (SELECT count(*) FROM spo_cases);
BEGIN
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 cases, % ran', n; END IF;
  RAISE NOTICE 'slack_post_outcomes.test.sql: % cases passed', n;
END
$do$;
