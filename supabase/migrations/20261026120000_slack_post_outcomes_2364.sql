-- One row per Slack post of the bidding Worker, and the reads the minute
-- refusal check makes of it (#2364).
--
-- WHY. From 2026-10-23 to 26 about 3,400 alert posts were refused with
-- not_in_channel (a Reconnect at 10:05 PM ET on 2026-10-22 saved a bot token
-- that was not in #statuspage) and nothing paged: a refusal reached only a free
-- text log line, and every page that could have said so was itself a Slack
-- post. The minute check (apps/worker/src/lib/slack-refusal-watch.ts) reads
-- this record and pages through Better Stack instead.
--
-- HOW ROWS ARRIVE. deliverMessage and sendThreadReply (lib/slack.ts) log one
-- `[slack] post outcome` line per post (lib/slack-post-outcome.ts). The tail
-- worker (apps/worker-tail/src/slack-posts.ts) copies each here. Written by a
-- different worker, later, into a different store from the post itself, so it
-- does not share the post's failure (L561).
--
-- THE KEY is the post id the logger minted, so a batch written twice is one
-- row: the tail worker upserts, ignoring a row already there.
--
-- WHAT A ROW HOLDS. The outcome (delivered, refused, no_answer), Slack's error
-- code or the HTTP status, how a refusal is classed (destination pages at once,
-- transient after a run), the channel, and the alert's title: the header's
-- plain text with anything shaped like applicant data redacted by the logger,
-- never the body. No token and no organization: the check maps a channel to its
-- organization through the Slack connections.
--
-- VOLUME. The 2026-10-23 outage refused about 1,130 posts a day, and delivered
-- posts add to that, so a week is a few thousand to tens of thousands of rows.
--
-- RETENTION. The check reads the last 7 days (a run can last days, as that one
-- did), so rows are kept 7 days and then deleted daily by pg_cron.
--
-- SCOPE. Service role only; the browser roles are revoked outright (L124).
--
-- Expand/contract (ADR 0007): additive. A new table, three functions and a cron
-- job. Nothing reads or writes the table until the code in the same pull
-- request ships, and code that ships first finds the read missing and reports
-- itself unmeasured rather than as no refusals.
--
-- Guarded by supabase/tests/slack_post_outcomes.test.sql.

CREATE TABLE IF NOT EXISTS public.slack_post_outcomes (
  post_id      text PRIMARY KEY,
  occurred_at  timestamptz NOT NULL,
  channel      text NOT NULL,
  outcome      text NOT NULL,
  reason       text,
  kind         text,
  status       integer,
  title        text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_post_outcomes_post_id_check CHECK (length(post_id) BETWEEN 1 AND 100),
  CONSTRAINT slack_post_outcomes_channel_check CHECK (length(channel) BETWEEN 1 AND 200),
  CONSTRAINT slack_post_outcomes_outcome_check CHECK (outcome IN ('delivered', 'refused', 'no_answer')),
  CONSTRAINT slack_post_outcomes_reason_check CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 100),
  CONSTRAINT slack_post_outcomes_kind_check CHECK (kind IS NULL OR kind IN ('destination', 'transient')),
  CONSTRAINT slack_post_outcomes_kind_outcome_check CHECK ((outcome = 'delivered') = (kind IS NULL)),
  CONSTRAINT slack_post_outcomes_status_check CHECK (status IS NULL OR status BETWEEN 100 AND 599),
  CONSTRAINT slack_post_outcomes_title_check CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200)
);

COMMENT ON TABLE public.slack_post_outcomes IS
  'One row per Slack post of the bidding Worker and how it went, copied from its post outcome log line by the tail worker (#2364). The minute Slack refusal check reads it to page through Better Stack. Service role only; rows older than 7 days are purged daily.';
COMMENT ON COLUMN public.slack_post_outcomes.post_id IS
  'The id the Worker minted for the post, so a line copied twice is one row.';
COMMENT ON COLUMN public.slack_post_outcomes.occurred_at IS
  'When the Worker logged the outcome. Runs and the purge key on this.';
COMMENT ON COLUMN public.slack_post_outcomes.channel IS
  'The channel the Worker posted to, as it named it (an id or a #name).';
COMMENT ON COLUMN public.slack_post_outcomes.reason IS
  'Slack''s error code for an ok:false answer (not_in_channel, invalid_auth, ...); null for an HTTP failure or no answer.';
COMMENT ON COLUMN public.slack_post_outcomes.kind IS
  'How a refusal is classed (lib/slack-refusal.ts): destination pages on the first, transient after 5 spanning 5 minutes. Null exactly when the post was delivered.';
COMMENT ON COLUMN public.slack_post_outcomes.status IS
  'The HTTP status Slack answered with (200 for an ok:false answer); null when there was no answer.';
COMMENT ON COLUMN public.slack_post_outcomes.title IS
  'The alert''s header text, redacted of anything shaped like applicant data and cut to 120 characters, or Thread reply; never the body.';

CREATE INDEX IF NOT EXISTS slack_post_outcomes_channel_occurred_idx
  ON public.slack_post_outcomes (channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS slack_post_outcomes_occurred_idx
  ON public.slack_post_outcomes (occurred_at);

ALTER TABLE public.slack_post_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.slack_post_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.slack_post_outcomes TO service_role;

-- Per channel seen since p_since: its newest delivered post, and the RUN, the
-- refusals after that post (all of them for a channel with no delivered post
-- since p_since), counted by reason and by title. A channel with no run comes
-- back with refused 0, so the check can see a delivered post that ended one.
CREATE OR REPLACE FUNCTION public.slack_refusal_runs(p_since timestamptz)
RETURNS TABLE (
  channel            text,
  last_delivered_at  timestamptz,
  refused            integer,
  destination        integer,
  first_refused_at   timestamptz,
  last_refused_at    timestamptz,
  reasons            jsonb,
  titles             jsonb
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH recent AS (
    SELECT o.post_id, o.occurred_at, o.channel, o.outcome, o.reason, o.kind, o.status, o.title
    FROM slack_post_outcomes o
    WHERE o.occurred_at >= p_since
  ),
  newest AS (
    SELECT r.channel AS ch, max(r.occurred_at) FILTER (WHERE r.outcome = 'delivered') AS delivered_at
    FROM recent r
    GROUP BY r.channel
  ),
  run AS (
    SELECT r.*
    FROM recent r
    JOIN newest n ON n.ch = r.channel
    WHERE r.outcome <> 'delivered'
      AND (n.delivered_at IS NULL OR r.occurred_at > n.delivered_at)
  ),
  by_reason AS (
    SELECT run.channel AS ch, run.reason, run.status, run.kind, count(*)::int AS n
    FROM run
    GROUP BY run.channel, run.reason, run.status, run.kind
  ),
  by_title AS (
    SELECT run.channel AS ch, run.title, count(*)::int AS n
    FROM run
    GROUP BY run.channel, run.title
  )
  SELECT
    n.ch,
    n.delivered_at,
    count(run.post_id)::int,
    (count(run.post_id) FILTER (WHERE run.kind = 'destination'))::int,
    min(run.occurred_at),
    max(run.occurred_at),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('reason', b.reason, 'status', b.status, 'kind', b.kind, 'refused', b.n)
                       ORDER BY b.n DESC, b.reason NULLS LAST, b.status NULLS LAST)
      FROM by_reason b WHERE b.ch = n.ch
    ), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('title', t.title, 'refused', t.n) ORDER BY t.n DESC, t.title NULLS LAST)
      FROM by_title t WHERE t.ch = n.ch
    ), '[]'::jsonb)
  FROM newest n
  LEFT JOIN run ON run.channel = n.ch
  GROUP BY n.ch, n.delivered_at
  ORDER BY n.ch
$fn$;

COMMENT ON FUNCTION public.slack_refusal_runs(timestamptz) IS
  'Per channel posted to since p_since: the newest delivered post and the refusals after it, by reason and title (#2364). Read every minute by the Slack refusal check.';

-- Every refusal of the named channels in [p_from, p_to], a delivered post
-- between them or not, by reason and by title: what the all clear says was lost.
CREATE OR REPLACE FUNCTION public.slack_refusal_summary(p_channels text[], p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  refused           integer,
  first_refused_at  timestamptz,
  last_refused_at   timestamptz,
  reasons           jsonb,
  titles            jsonb
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH hit AS (
    SELECT o.post_id, o.occurred_at, o.reason, o.kind, o.status, o.title
    FROM slack_post_outcomes o
    WHERE o.channel = ANY (p_channels)
      AND o.occurred_at >= p_from
      AND o.occurred_at <= p_to
      AND o.outcome <> 'delivered'
  ),
  by_reason AS (
    SELECT h.reason, h.status, h.kind, count(*)::int AS n FROM hit h GROUP BY h.reason, h.status, h.kind
  ),
  by_title AS (
    SELECT h.title, count(*)::int AS n FROM hit h GROUP BY h.title
  )
  SELECT
    (SELECT count(*)::int FROM hit),
    (SELECT min(h.occurred_at) FROM hit h),
    (SELECT max(h.occurred_at) FROM hit h),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('reason', b.reason, 'status', b.status, 'kind', b.kind, 'refused', b.n)
                       ORDER BY b.n DESC, b.reason NULLS LAST, b.status NULLS LAST)
      FROM by_reason b
    ), '[]'::jsonb),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('title', t.title, 'refused', t.n) ORDER BY t.n DESC, t.title NULLS LAST)
      FROM by_title t
    ), '[]'::jsonb)
$fn$;

COMMENT ON FUNCTION public.slack_refusal_summary(text[], timestamptz, timestamptz) IS
  'Every refusal of the named channels in a window, by reason and title (#2364). Read by the Slack refusal check for its all clear.';

REVOKE ALL ON FUNCTION public.slack_refusal_runs(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.slack_refusal_runs(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.slack_refusal_summary(text[], timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.slack_refusal_summary(text[], timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_slack_post_outcomes()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM slack_post_outcomes
  WHERE occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_slack_post_outcomes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_slack_post_outcomes() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-slack-post-outcomes') THEN
    PERFORM cron.schedule(
      'purge-slack-post-outcomes',
      '54 6 * * *',
      $cmd$SET statement_timeout = '30s'; SET lock_timeout = '10s'; SELECT public.purge_slack_post_outcomes()$cmd$
    );
  END IF;
END
$$;
