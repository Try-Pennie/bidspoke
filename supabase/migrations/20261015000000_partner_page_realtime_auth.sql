-- Who may receive a partners page broadcast (#2131, PR0 of #2114).
--
-- The partners page will hear about another person's save over a Supabase
-- Realtime PRIVATE channel named partners:<organization id>. Realtime lets a
-- signed in person join a private channel only when Postgres lets that person
-- SELECT a broadcast row of realtime.messages with realtime.topic() set to the
-- channel's name. This policy is therefore the whole tenant boundary for the live
-- channel: a person may receive their own organization's topic and no other.
--
-- Deliberately absent:
--   * No INSERT policy. Nobody sends through the API with their own token; the
--     senders are the database (realtime.send from a trigger, as the writer's
--     role) or the Worker's REST call with the service key, and service_role and
--     postgres bypass row level security.
--   * No anon policy, and nothing for presence: the page uses broadcast only.
--
-- Applies as postgres even though supabase_realtime_admin owns realtime.messages:
-- supautils.policy_grants names realtime.messages for postgres (read from
-- production on 2026-10-15), the same route the dashboard's SQL editor takes.
--
-- Expand only: one new policy, no change to anything that exists. Proved by
-- supabase/tests/partner_page_realtime_auth.test.sql against the realtime stub in
-- scripts/sql-suite/bootstrap.sql; delivery itself is measured by
-- scripts/realtime-spike/run.mjs (docs/adr/0012-partner-page-live-channel.md).

CREATE POLICY partners_topic_read_own_org
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND realtime.topic() = 'partners:' || public.user_org_id()::text
  );
