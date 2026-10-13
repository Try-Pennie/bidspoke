-- A durable store for a failed post-answer Salesforce write, so it can be replayed (#1993).
--
-- When a Salesforce write after the answer failed, the dead letter only counted
-- the loss in KV and alerted: nothing recorded what should have been written, and
-- the exact patch cannot be rebuilt from anything else the run keeps (the sighting
-- projection is a code node's output, and step logs are not a replay source). The
-- failed step now carries its resolved request (#1992); this is where it is kept.
--
-- ONE ROW PER FAILED WRITE, keyed (execution_id, step_namespace, sf_object,
-- sf_record_id, sf_operation), so a second failed write in one run is kept
-- rather than dropped, even to the same record from another step, and the same
-- write recorded twice is refused. A run stops at its first post-answer failure
-- today, so it holds one row at most; the key does not lean on that.
--
-- PERSONAL DATA. The body is the patch, which can carry lead fields, and a
-- Salesforce 4xx echoes field values back in its error text, so both are stored
-- ENCRYPTED with SECRET_ENCRYPTION_KEY by the worker (secret-crypto), never in
-- the clear. The table is service role only: RLS on with no policy, and the
-- browser roles revoked outright (L124). It is an erasure target (by execution
-- id, which the erasure resolves from the subject's SSN hash), its encrypted
-- columns are in the key rotation re-encrypt route, and the restore drill
-- restores it as structure only.
--
-- STATUS, every value the code writes: pending (awaiting replay), replayed (the
-- replay landed), refused (Salesforce refused the write for good: a failure the
-- engine classed permanent is stored refused and finished at capture, and a
-- replay Salesforce refuses ends here too), abandoned (a person or the replay
-- gave up on it). `replayable` is false for a permanent failure, so the replay
-- leaves it rather than resend a write Salesforce will refuse again, while a
-- person can still read it until retention removes it.
--
-- RETENTION. Only finished rows (replayed, refused, abandoned) are purged, 30
-- days after they finished, by a daily pg_cron job. A pending row is never
-- purged however old: it is a write somebody still owes. Each failure is
-- alerted once, as it is captured, by the dead letter that already pages a
-- lost post-answer write. NOTHING YET alerts on an old pending row, and nothing
-- yet moves one out of pending: the replay tool (#471) and the drain with its
-- backlog alert (#468) are separate work, and until they ship every row here
-- stays pending.
--
-- Expand/contract (ADR 0007): additive. A new table, a function and a cron job;
-- nothing the deployed worker reads changes.
--
-- Guarded by supabase/tests/outcome_writeback_deadletters.test.sql.

CREATE TABLE IF NOT EXISTS public.outcome_writeback_deadletters (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id),
  workflow_id           uuid NOT NULL,
  execution_id          uuid NOT NULL,
  step_namespace        text NOT NULL,
  sf_object             text NOT NULL,
  sf_record_id          text NOT NULL,
  sf_operation          text NOT NULL,
  body_encrypted        text NOT NULL,
  error_encrypted       text NOT NULL,
  error_type            text,
  replayable            boolean NOT NULL,
  status                text NOT NULL DEFAULT 'pending',
  attempts              integer NOT NULL DEFAULT 0,
  last_error_encrypted  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  CONSTRAINT outcome_writeback_deadletters_status_check CHECK (status IN ('pending', 'replayed', 'refused', 'abandoned')),
  CONSTRAINT outcome_writeback_deadletters_operation_check CHECK (sf_operation IN ('update', 'upsert', 'create')),
  CONSTRAINT outcome_writeback_deadletters_finished_check CHECK ((status = 'pending') = (finished_at IS NULL)),
  CONSTRAINT outcome_writeback_deadletters_write_key UNIQUE (execution_id, step_namespace, sf_object, sf_record_id, sf_operation)
);

COMMENT ON TABLE public.outcome_writeback_deadletters IS
  'One row per post-answer Salesforce write that failed, holding its encrypted request for replay (#1993, #471). Service role only; an erasure target; purged 30 days after it finishes, never while pending.';
COMMENT ON COLUMN public.outcome_writeback_deadletters.body_encrypted IS
  'The resolved request body, encrypted with SECRET_ENCRYPTION_KEY (secret-crypto). Can carry lead fields.';
COMMENT ON COLUMN public.outcome_writeback_deadletters.error_encrypted IS
  'The failure text, encrypted: a Salesforce 4xx echoes field values back.';
COMMENT ON COLUMN public.outcome_writeback_deadletters.replayable IS
  'False when the engine classed the failure permanent, so the replay refuses it rather than resend a write Salesforce will refuse again.';

CREATE INDEX IF NOT EXISTS outcome_writeback_deadletters_pending_idx
  ON public.outcome_writeback_deadletters (organization_id, created_at)
  WHERE status = 'pending';

ALTER TABLE public.outcome_writeback_deadletters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outcome_writeback_deadletters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outcome_writeback_deadletters TO service_role;

-- ------------------------------------------------------------------
-- Retention: finished rows only, 30 days after they finished
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_outcome_writeback_deadletters()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM outcome_writeback_deadletters
  WHERE status <> 'pending'
    AND finished_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_outcome_writeback_deadletters() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_outcome_writeback_deadletters() TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-outcome-writeback-deadletters') THEN
    PERFORM cron.schedule(
      'purge-outcome-writeback-deadletters',
      '17 6 * * *',
      $cmd$SET statement_timeout = '60s'; SET lock_timeout = '10s'; SELECT public.purge_outcome_writeback_deadletters()$cmd$
    );
  END IF;
END
$$;
