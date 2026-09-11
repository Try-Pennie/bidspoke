-- Round two. The first run answered #1314 and half of #886, and turned #1323
-- from a formality into a real finding.
--
-- WHAT THE FIRST RUN SHOWED. 21,308 of 2,688,112 archived rows carry no person
-- resolver. 21,301 of them are on ONE DAY, 2026-08-22, spread across four money
-- path workflows at about 15 percent of that day's rows each. The other 7 are
-- single runs of an internal Gmail offboarding workflow, which carries no SSN
-- and correctly has none.
--
-- THE LIKELY CAUSE, and it is checkable rather than assumed: the writer that
-- fills ssn_hash shipped on 2026-08-22 (#927, PR #975). A writer that only
-- fills records going forward never reaches what already existed when it
-- shipped, so the hours of that day archived before the deploy have nulls and
-- everything after has values. Section 2 below tests that directly.
--
-- THE QUESTION THAT DECIDES THE REMEDY is section 1, not the cause. The archive
-- INSERTs and never MERGEs, so a re-archived day leaves more than one row per
-- execution. If those executions ALSO have a later copy carrying a resolver,
-- they are erasable and these rows are stale duplicates, which is a different
-- issue (#1023). If they do not, then about 21,000 real leads cannot be erased
-- on request and that needs its own remedy.
--
-- Pure reads. Counts only, never a value.

-- ---------------------------------------------------------------------------
-- 1. Are those rows stale duplicates, or the only copy?  (decides #1323)
-- ---------------------------------------------------------------------------
-- never_resolvable is the number that matters. Zero means every affected
-- execution is covered by a newer copy and there is no erasure gap.
WITH per_execution AS (
  SELECT execution_id,
         COUNT(*)        AS copies,
         COUNT(ssn_hash) AS copies_with_resolver
  FROM BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE
  GROUP BY execution_id
)
SELECT COUNT(*)                                                              AS executions,
       COUNT_IF(copies_with_resolver = 0)                                    AS never_resolvable,
       COUNT_IF(copies_with_resolver > 0 AND copies_with_resolver < copies)  AS has_a_stale_null_copy,
       COUNT_IF(copies > 1)                                                  AS has_more_than_one_copy
FROM per_execution;

-- Only if never_resolvable above is non-zero: which days and workflows they
-- are, which is the population that would need a remedy.
WITH per_execution AS (
  SELECT execution_id,
         MIN(archive_day)  AS day,
         MIN(workflow_id)  AS workflow_id,
         COUNT(ssn_hash)   AS copies_with_resolver
  FROM BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE
  GROUP BY execution_id
)
SELECT day, workflow_id, COUNT(*) AS executions_never_resolvable
FROM per_execution
WHERE copies_with_resolver = 0
GROUP BY day, workflow_id
ORDER BY day, workflow_id;

-- ---------------------------------------------------------------------------
-- 2. Was it the deploy?  (confirms the cause rather than inferring it)
-- ---------------------------------------------------------------------------
-- Keyed on archived_at_utc, when WE WROTE the row, not on when the lead ran.
-- If the writer shipping is the cause, the nulls all sit before one instant and
-- the values all sit after it, with no overlap. An overlap means something else
-- is going on and the fix would be aimed at the wrong thing.
SELECT CASE WHEN ssn_hash IS NULL THEN 'no resolver' ELSE 'has resolver' END AS bucket,
       COUNT(*)               AS rows_archived,
       MIN(archived_at_utc)   AS first_written,
       MAX(archived_at_utc)   AS last_written
FROM BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE
WHERE archive_day = '2026-08-22'
GROUP BY bucket;

-- ---------------------------------------------------------------------------
-- 3. Storage, corrected.  (#886)
-- ---------------------------------------------------------------------------
-- The first version named a row_count column this view does not have, which is
-- why it failed. Same query without it.
SELECT table_name,
       ROUND(active_bytes / POWER(1024, 3), 2)      AS active_gb,
       ROUND(time_travel_bytes / POWER(1024, 3), 2) AS time_travel_gb,
       ROUND(failsafe_bytes / POWER(1024, 3), 2)    AS failsafe_gb
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE table_catalog = 'BIDSPOKE_ARCHIVE'
  AND deleted = FALSE
ORDER BY active_bytes DESC;
