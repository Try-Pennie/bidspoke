-- One row per cron delivery of the bidding Worker (#2284).
--
-- The hourly cron guard check (apps/worker/src/lib/cron-guard-watch.ts) used to
-- page whenever the guard failed open 3 times in a day. A fail-open does no
-- harm by itself: harm needs that same tick to be run by a second delivery as
-- well. Measured 2026-10-15 to 2026-10-17, fail-opens run at about 4 a day from
-- ordinary platform delays and no tick ran twice, so the page fired most days
-- with nothing to do. The check now pages when a tick may really have run
-- twice, and that needs a durable record of every delivery: the guard's skip
-- count cannot show it (a second delivery that ran leaves no skip), and a
-- Workers Logs search missed known lines.
--
-- HOW ROWS ARRIVE. The guard (cron-once.ts) logs one `[cron-once] delivery`
-- line per scheduled invocation saying what it decided (ran, took_over,
-- failed_open, skipped). The tail worker (apps/worker-tail/src/deliveries.ts)
-- copies each into this table with how the invocation ended, and records a
-- scheduled invocation with no such line as `no_decision`. Written by a
-- different worker, later, into a different store from the guard's own, so it
-- does not share the guard's failure (L561).
--
-- THE KEY is the delivery id the guard minted (its claim holder id), so a batch
-- written twice is one row: the tail worker upserts, ignoring a row already
-- there. A `no_decision` row is named from the invocation's own times.
--
-- VOLUME. About 1,900 scheduled deliveries a day across the nine crons (2,000
-- of the minute tick alone while Cloudflare doubles every tick), so a week of
-- rows is about 13,000 to 27,000.
--
-- RETENTION. The check reads the last 24 hours. Rows are kept 7 days so a
-- doubled tick can be looked at after the page, then deleted daily by pg_cron.
--
-- SCOPE. Platform rows, no organization: the guard runs the worker's own
-- crons. Service role only; the browser roles are revoked outright (L124).
--
-- Expand/contract (ADR 0007): additive. A new table, one function and a cron
-- job. Nothing reads or writes the table until the code in the same pull
-- request ships.
--
-- Guarded by supabase/tests/cron_tick_deliveries.test.sql.

CREATE TABLE IF NOT EXISTS public.cron_tick_deliveries (
  delivery_id         text PRIMARY KEY,
  occurred_at         timestamptz NOT NULL,
  cron                text NOT NULL,
  scheduled_at        timestamptz NOT NULL,
  outcome             text NOT NULL,
  invocation_outcome  text,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cron_tick_deliveries_delivery_id_check CHECK (length(delivery_id) BETWEEN 1 AND 200),
  CONSTRAINT cron_tick_deliveries_cron_check CHECK (length(cron) BETWEEN 1 AND 100),
  CONSTRAINT cron_tick_deliveries_outcome_check CHECK (outcome IN ('ran', 'took_over', 'failed_open', 'skipped', 'no_decision')),
  CONSTRAINT cron_tick_deliveries_invocation_outcome_check CHECK (invocation_outcome IS NULL OR length(invocation_outcome) <= 50)
);

COMMENT ON TABLE public.cron_tick_deliveries IS
  'One row per scheduled delivery of the bidding Worker and what its cron guard decided, copied from the guard''s delivery log line by the tail worker (#2284). The hourly cron guard check reads it for a tick two deliveries both ran. Service role only; rows older than 7 days are purged daily.';
COMMENT ON COLUMN public.cron_tick_deliveries.delivery_id IS
  'The id the guard minted for the delivery (its claim holder id), or trace:<scheduled ms>:<started ms>:<cron> for a delivery the guard said nothing about.';
COMMENT ON COLUMN public.cron_tick_deliveries.occurred_at IS
  'When the guard logged its decision, or when the invocation started for a no_decision row. The check''s 24 hour window keys on this.';
COMMENT ON COLUMN public.cron_tick_deliveries.scheduled_at IS
  'The scheduled time Cloudflare gave the delivery. With cron it names the tick: the check groups deliveries by cron and scheduled minute, the same key the guard claims.';
COMMENT ON COLUMN public.cron_tick_deliveries.outcome IS
  'What the guard decided: ran (claimed and ran), took_over (ran as the retry of a holder whose lease went stale), failed_open (ran without the claim), skipped (a duplicate), or no_decision (no delivery line in the invocation''s logs).';
COMMENT ON COLUMN public.cron_tick_deliveries.invocation_outcome IS
  'How Cloudflare says the invocation ended (ok, canceled, exception, exceededCpu, ...). A run that did not end ok was cut short, so a later delivery running its tick is the intended retry.';

CREATE INDEX IF NOT EXISTS cron_tick_deliveries_occurred_idx
  ON public.cron_tick_deliveries (occurred_at DESC);

ALTER TABLE public.cron_tick_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_tick_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cron_tick_deliveries TO service_role;

CREATE OR REPLACE FUNCTION public.purge_cron_tick_deliveries()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM cron_tick_deliveries
  WHERE occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_cron_tick_deliveries() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_cron_tick_deliveries() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-cron-tick-deliveries') THEN
    PERFORM cron.schedule(
      'purge-cron-tick-deliveries',
      '52 6 * * *',
      $cmd$SET statement_timeout = '30s'; SET lock_timeout = '10s'; SELECT public.purge_cron_tick_deliveries()$cmd$
    );
  END IF;
END
$$;
