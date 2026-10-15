-- Who may receive a partners page broadcast (#2131, PR0 of #2114).
--
-- WHY. The partners page will hear about another person's save over a Supabase
-- Realtime PRIVATE channel named partners:<organization id>. Realtime decides
-- whether a signed in person may join such a channel by asking Postgres whether
-- that person can SELECT a broadcast row on that topic from realtime.messages,
-- with realtime.topic() set to the channel's name. So the one SELECT policy that
-- migration 20261015000000 adds is the whole of the tenant boundary: a person of
-- one organization must be refused the other organization's topic, in both
-- directions, and nobody may write a message through the API (no INSERT policy).
--
-- HOW. The same question Realtime asks is asked here directly: a broadcast row is
-- written on a topic, then read back as `authenticated` (or `anon`) with the JWT
-- claims and realtime.topic set the way Realtime sets them. realtime.send is also
-- called with and without the day's partition present, because a send into a
-- day with no partition is swallowed into a WARNING in production and nothing
-- arrives (measured 2026-10-15: production's newest partition was 2026-10-02).
--
-- WHAT THIS DOES NOT PROVE. The realtime schema here is the stub in
-- scripts/sql-suite/bootstrap.sql, with production's table shape, owner, grants
-- and send function copied from production on 2026-10-15. It proves the SQL (the
-- policy compiles, applies as postgres through supautils' policy grant, and
-- decides correctly), never the platform: whether Realtime itself delivers is
-- what scripts/realtime-spike/run.mjs measures against the live project.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh builds.

BEGIN;

DO $$
DECLARE
  v_org_a  uuid;
  v_org_b  uuid;
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_user_none uuid := gen_random_uuid();
  v_day    date := (now()::timestamp)::date;
  v_msg_a  uuid;
  v_msg_b  uuid;
  v_msg_presence uuid;
  v_seen   int;
  v_count  int;
  v_cmd    text;
  v_roles  name[];
  v_permissive text;
  v_cases  int := 0;
  v_marker text := 'realtime-auth-test-' || gen_random_uuid();
BEGIN
  -- 1. Shape: exactly one policy on realtime.messages, a permissive SELECT for
  --    authenticated. A second policy (an INSERT, or one for anon) fails here.
  SELECT count(*) INTO v_count FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'realtime.messages carries % policies, expected exactly 1 (the partners topic SELECT)', v_count;
  END IF;
  SELECT cmd, roles, permissive INTO v_cmd, v_roles, v_permissive
  FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages';
  IF v_cmd <> 'SELECT' OR v_roles <> ARRAY['authenticated']::name[] OR v_permissive <> 'PERMISSIVE' THEN
    RAISE EXCEPTION 'the realtime.messages policy is % % for %, expected PERMISSIVE SELECT for {authenticated}', v_permissive, v_cmd, v_roles;
  END IF;
  v_cases := v_cases + 1;

  -- Fixtures: two organizations, one person in each, and one signed in person
  -- with no users row at all.
  INSERT INTO public.organizations (name, slug) VALUES ('Realtime auth A', v_marker || '-a') RETURNING id INTO v_org_a;
  INSERT INTO public.organizations (name, slug) VALUES ('Realtime auth B', v_marker || '-b') RETURNING id INTO v_org_b;
  INSERT INTO public.users (id, organization_id, email) VALUES (v_user_a, v_org_a, v_marker || '-a@example.com');
  INSERT INTO public.users (id, organization_id, email) VALUES (v_user_b, v_org_b, v_marker || '-b@example.com');

  PERFORM sql_suite.create_realtime_partition(v_day);

  INSERT INTO realtime.messages (topic, extension, payload, event, private)
  VALUES ('partners:' || v_org_a, 'broadcast', '{}'::jsonb, 'probe', true) RETURNING id INTO v_msg_a;
  INSERT INTO realtime.messages (topic, extension, payload, event, private)
  VALUES ('partners:' || v_org_b, 'broadcast', '{}'::jsonb, 'probe', true) RETURNING id INTO v_msg_b;
  INSERT INTO realtime.messages (topic, extension, payload, event, private)
  VALUES ('partners:' || v_org_a, 'presence', '{}'::jsonb, 'probe', true) RETURNING id INTO v_msg_presence;

  -- 2. A person of A may read a broadcast on A's topic: the join Realtime allows.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('realtime.topic', 'partners:' || v_org_a, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_a;
  RESET ROLE;
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'a person of organization A could not read a broadcast on partners:<A> (saw %)', v_seen;
  END IF;
  v_cases := v_cases + 1;

  -- 3. A person of B is refused A's topic: the two organization negative control.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('realtime.topic', 'partners:' || v_org_a, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_a;
  RESET ROLE;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'a person of organization B read a broadcast on partners:<A>';
  END IF;
  v_cases := v_cases + 1;

  -- 4. And the other direction (L497): a person of A is refused B's topic, while
  --    a person of B reads it, so the refusal in case 3 is not B's token failing.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('realtime.topic', 'partners:' || v_org_b, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_b;
  RESET ROLE;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'a person of organization A read a broadcast on partners:<B>';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_b, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_b;
  RESET ROLE;
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'a person of organization B could not read a broadcast on partners:<B> (saw %)', v_seen;
  END IF;
  v_cases := v_cases + 1;

  -- 5. The topic is what is checked, not merely the row's own topic column: with
  --    realtime.topic unset, even A's own row is refused.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('realtime.topic', '', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_a;
  RESET ROLE;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'a broadcast was readable with realtime.topic unset';
  END IF;
  v_cases := v_cases + 1;

  -- 6. Broadcast only: a presence row on A's own topic is refused, so the policy
  --    does not also open presence, which the partners page does not use.
  PERFORM set_config('realtime.topic', 'partners:' || v_org_a, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_presence;
  RESET ROLE;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'a presence row on partners:<A> was readable; the policy must cover broadcast only';
  END IF;
  v_cases := v_cases + 1;

  -- 7. A signed in person with no users row (user_org_id() is null) reads nothing.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_none, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_a;
  RESET ROLE;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'a signed in person with no users row read a broadcast on partners:<A>';
  END IF;
  v_cases := v_cases + 1;

  -- 8. anon reads nothing, on any topic.
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  SET LOCAL ROLE anon;
  SELECT count(*) INTO v_seen FROM realtime.messages WHERE id = v_msg_a;
  RESET ROLE;
  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'anon read a broadcast on partners:<A>';
  END IF;
  v_cases := v_cases + 1;

  -- 9. Nobody signed in can send: with no INSERT policy, an authenticated insert
  --    on its own topic is refused by row level security.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('realtime.topic', 'partners:' || v_org_a, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO realtime.messages (topic, extension, payload, event, private)
    VALUES ('partners:' || v_org_a, 'broadcast', '{}'::jsonb, 'forged', true);
    RESET ROLE;
    RAISE EXCEPTION 'an authenticated person wrote a broadcast on partners:<A>' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
  END;
  v_cases := v_cases + 1;

  RAISE NOTICE 'partner_page_realtime_auth (policy): % cases passed', v_cases;
END $$;

ROLLBACK;

-- realtime.send, the database sender itself, as the Worker's role. Separate from
-- the block above so the policy cases name their own failure.
BEGIN;

DO $$
DECLARE
  v_day   date := (now()::timestamp)::date;
  v_topic text := 'partners:' || gen_random_uuid();
  v_found int;
  v_cases int := 0;
BEGIN
  -- 10. With no partition for today, send raises only a WARNING (production's
  --     own function swallows the insert error) and nothing is stored. This is
  --     the silent failure the live spike checks for before it concludes.
  PERFORM 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = 'realtime.messages'::regclass
    AND c.relname = 'messages_' || to_char(v_day, 'YYYY_MM_DD');
  IF FOUND THEN
    RAISE EXCEPTION 'a partition for % already exists before the test made one; the no partition case cannot be measured', v_day;
  END IF;
  SET LOCAL ROLE service_role;
  PERFORM realtime.send(jsonb_build_object('case', 10), 'probe', v_topic, true);
  RESET ROLE;
  SELECT count(*) INTO v_found FROM realtime.messages WHERE topic = v_topic;
  IF v_found <> 0 THEN
    RAISE EXCEPTION 'realtime.send stored % rows with no partition for today', v_found;
  END IF;
  v_cases := v_cases + 1;

  -- 11. With today's partition present, the same send as service_role stores one
  --     private broadcast row on the topic, which is what Realtime delivers.
  PERFORM sql_suite.create_realtime_partition(v_day);
  SET LOCAL ROLE service_role;
  PERFORM realtime.send(jsonb_build_object('case', 11), 'probe', v_topic, true);
  RESET ROLE;
  SELECT count(*) INTO v_found FROM realtime.messages
  WHERE topic = v_topic AND extension = 'broadcast' AND private IS TRUE AND payload ->> 'case' = '11';
  IF v_found <> 1 THEN
    RAISE EXCEPTION 'realtime.send as service_role stored % private broadcast rows, expected 1', v_found;
  END IF;
  v_cases := v_cases + 1;

  RAISE NOTICE 'partner_page_realtime_auth (send): % cases passed', v_cases;
END $$;

ROLLBACK;
