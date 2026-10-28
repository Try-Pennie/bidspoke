-- The alert kind on each Slack post record (#2948).
--
-- WHY. slack_post_outcomes (#2364) names an alert only by its title, which the
-- Worker reads from the message's header block. Since #2761 the HTTP money host
-- page has no header, at Dan's request, so its posts are recorded with no
-- title, and some other titles are built from a value (a partner, a job, a
-- workflow name), so a title does not tell one alert kind from another. A
-- refused or failing alert kind is told apart by this record (#2811), so each
-- post now also carries a fixed kind name from one list in the Worker
-- (SLACK_ALERT_KINDS in apps/worker/src/lib/slack-post-outcome.ts), whether or
-- not the alert shows a title. The tail worker copies it from the post outcome
-- line (apps/worker-tail/src/slack-posts.ts).
--
-- WHAT IT HOLDS. Lower case words joined by single hyphens, at most 60
-- characters (http-money-host), or null: a post that named no kind, and every
-- row written before this column existed. The title column is unchanged.
--
-- Expand/contract (ADR 0007): additive. One nullable column with no default
-- and a CHECK every existing row (all null) passes. Code deployed before this
-- migration never names the column; the tail worker that writes it deploys
-- only once the Deploy workflow finds this migration applied.
--
-- Guarded by supabase/tests/slack_post_outcomes.test.sql, case H.

ALTER TABLE public.slack_post_outcomes
  ADD COLUMN IF NOT EXISTS alert_kind text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'slack_post_outcomes_alert_kind_check'
      AND conrelid = 'public.slack_post_outcomes'::regclass
  ) THEN
    ALTER TABLE public.slack_post_outcomes
      ADD CONSTRAINT slack_post_outcomes_alert_kind_check
      CHECK (alert_kind IS NULL OR (length(alert_kind) <= 60 AND alert_kind ~ '^[a-z0-9]+(-[a-z0-9]+)*$'));
  END IF;
END
$$;

COMMENT ON COLUMN public.slack_post_outcomes.alert_kind IS
  'The fixed name of the alert posted (SLACK_ALERT_KINDS in the Worker), recorded whether or not the alert has a title; null when the post named none (#2948).';
