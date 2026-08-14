-- ============================================================
-- Count leads whose email was dropped before reaching Salesforce (#744)
-- ============================================================
-- When Salesforce rejects a lead's email, the Salesforce node blanks the field
-- and retries, so the run SUCCEEDS. That is the right outcome for the lead (#723:
-- a cosmetically broken address must not cost us someone we can still phone), but
-- it means there is no failed execution, no Slack alert and no dashboard signal.
-- Making the failure self-recovering deleted the only thing that counted it.
--
-- An error deliberately classified as expected still needs a RATE behind it
-- (LESSONS L77): one damaged address a week and a partner encoding change
-- producing hundreds a day arrive on exactly the same path and are otherwise
-- indistinguishable.
--
-- WHY THE COUNTER LIVES ON workflow_executions, measured rather than assumed.
-- The obvious design reads the marker straight off execution_steps. That was
-- built first and does not work: there is no index on `step_type`, and on
-- production even a THIRTY MINUTE window timed out at 25 seconds, let alone the
-- 24 hour window an alert needs. workflow_executions has one row per lead, is
-- partition pruned on `started_at`, and already carries `source`, so the same
-- question becomes a single-table aggregate.
--
-- The engine derives the boolean at finalize from the step outputs, gated on node
-- TYPE rather than on the marker alone, and writes it beside `field_presence`,
-- which is the established shape for a per-execution derived value.

-- Nullable with NO DEFAULT, so this is a metadata-only change: adding a defaulted
-- column would rewrite every one of the 139 partitions. Null means "not dropped"
-- and also "this run predates the column", which is the same thing for a rate
-- measured over a recent window.
ALTER TABLE public.workflow_executions
  ADD COLUMN IF NOT EXISTS email_dropped BOOLEAN;

COMMENT ON COLUMN public.workflow_executions.email_dropped IS
  'True when a Salesforce step dropped this lead''s email address and retried, so the record was created without it (#744). Null otherwise, including for runs predating the column.';

-- Aggregated per source. `count(*) FILTER` keeps the total and the dropped count
-- behind ONE predicate and one scan, so the two can never disagree (LESSONS L16).
CREATE OR REPLACE FUNCTION public.email_drop_counts_by_source(
  p_org_id UUID,
  p_since  TIMESTAMPTZ
)
RETURNS TABLE (
  source_name TEXT,
  total       BIGINT,
  dropped     BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(e.source, '(no source)')::TEXT              AS source_name,
    count(*)::BIGINT                                     AS total,
    count(*) FILTER (WHERE e.email_dropped)::BIGINT      AS dropped
  FROM public.workflow_executions e
  JOIN public.workflows w ON w.id = e.workflow_id
  WHERE w.organization_id = p_org_id
    -- `started_at` is the partition key, so this bound prunes rather than scans.
    AND e.started_at >= p_since
    AND e.is_test = false
  GROUP BY 1
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, so the REVOKE is the
-- line that does the protecting: without it this security-definer function, which
-- takes the organization as a parameter, would be callable by `anon` over the REST
-- API (LESSONS L124, and the sweep in 20260814000002 that found 19 of these).
REVOKE ALL ON ROUTINE public.email_drop_counts_by_source(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON ROUTINE public.email_drop_counts_by_source(UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON ROUTINE public.email_drop_counts_by_source(UUID, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON ROUTINE public.email_drop_counts_by_source(UUID, TIMESTAMPTZ) TO service_role;

-- NO INDEX is created here on purpose. `started_at` is the partition key, so the
-- time bound is already served by pruning, and CREATE INDEX on a partitioned
-- parent cascades to all 139 partitions under ACCESS EXCLUSIVE, which is not a
-- lock worth taking on the table the live bidding engine writes to.
--
-- Column names verified against the live schema before writing this, not guessed:
-- workflow_executions carries id, started_at, source, is_test and workflow_id.
