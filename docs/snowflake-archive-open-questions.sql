-- The three questions ADR 0009 left open, as queries somebody can re-run.
--
-- Each one is a PURE READ. Nothing here creates, writes, drops or locks
-- anything, so it is safe against production, and production is where it
-- belongs: these are questions about production's own archive.
--
-- Run the whole file (Snowsight: Run All). Section 1 needs to reach
-- BIDSPOKE_ARCHIVE; sections 2 and 3 read SNOWFLAKE.ACCOUNT_USAGE, which
-- ACCOUNTADMIN has by default. ACCOUNT_USAGE lags real time by up to 45
-- minutes and that does not matter for any of these.
--
-- Section 1 returns COUNTS ONLY and never a value, because the table it reads
-- holds unredacted applicant identity data.

-- ---------------------------------------------------------------------------
-- 1. Are there archived rows nothing can erase by SSN?  (#1323)
-- ---------------------------------------------------------------------------
-- An erasure request resolves an execution either through LEAD_SIGHTINGS or
-- through this table's own ssn_hash. A row with a null ssn_hash whose sighting
-- has been purged is reachable by neither, so it could not be erased on
-- request. Measured in Postgres on 2026-09-11, the unresolvable population is
-- ONE execution in seven days (an internal Gmail offboarding run). Postgres
-- keeps only seven days, so that reading says nothing about the eleven months
-- of archive behind it, which is exactly what this asks.
--
-- Expected answer: one row, no_resolver = 0. Anything else is a real finding
-- and the dates it names are the population that needs its own remedy.
SELECT COUNT(*)                        AS rows_archived,
       COUNT(*) - COUNT(ssn_hash)      AS no_resolver,
       MIN(archive_day)                AS oldest_day,
       MAX(archive_day)                AS newest_day
FROM BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE;

-- Only if the count above is non-zero: where they are. Grouped by day and
-- workflow id rather than name, because this table holds the id; the names are
-- looked up afterwards in Postgres.
SELECT archive_day,
       workflow_id,
       COUNT(*)                   AS rows_archived,
       COUNT(*) - COUNT(ssn_hash) AS no_resolver
FROM BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE
GROUP BY archive_day, workflow_id
HAVING COUNT(*) - COUNT(ssn_hash) > 0
ORDER BY archive_day, workflow_id;

-- ---------------------------------------------------------------------------
-- 2. How long does a cold archive take to answer?  (#1314)
-- ---------------------------------------------------------------------------
-- Every archived read races a 20 second deadline and reports the archive as
-- unreachable if the deadline wins. That 20 seconds was chosen, not measured,
-- and ADR 0009 records cold warehouse read latency as unmeasured.
--
-- It matters because ARCHIVE_WH suspends when idle and archived reads are rare
-- by construction, so the FIRST read of a day is nearly always a cold one. If
-- resume plus query exceeds the deadline, that read tells somebody chasing a
-- dispute that the archive is down, and the deadline has manufactured the
-- outage it reports.
--
-- Taken from history rather than by forcing a suspend, so it measures cold
-- starts that really happened. QUEUED_PROVISIONING_TIME is the wait for the
-- warehouse to come up, which is the part a warm test can never see.
SELECT COUNT(*)                                                              AS queries,
       COUNT_IF(queued_provisioning_time > 0)                                AS cold_starts,
       ROUND(MAX(queued_provisioning_time) / 1000, 1)                        AS worst_resume_s,
       ROUND(AVG(NULLIF(queued_provisioning_time, 0)) / 1000, 1)             AS mean_resume_s,
       ROUND(MAX(total_elapsed_time) / 1000, 1)                              AS worst_total_s,
       ROUND(APPROX_PERCENTILE(total_elapsed_time, 0.95) / 1000, 1)          AS p95_total_s
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE warehouse_name = 'ARCHIVE_WH'
  AND query_type = 'SELECT'
  AND start_time > DATEADD(day, -30, CURRENT_TIMESTAMP());

-- The worst ten on their own, because a p95 hides the case the deadline has to
-- survive and the worst case is the one a person actually meets.
SELECT start_time,
       role_name,
       ROUND(queued_provisioning_time / 1000, 1) AS resume_s,
       ROUND(total_elapsed_time / 1000, 1)       AS total_s
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE warehouse_name = 'ARCHIVE_WH'
  AND query_type = 'SELECT'
  AND start_time > DATEADD(day, -30, CURRENT_TIMESTAMP())
ORDER BY total_elapsed_time DESC
LIMIT 10;

-- ---------------------------------------------------------------------------
-- 3. What does the archive actually cost?  (#886)
-- ---------------------------------------------------------------------------
-- The 13 month retention was priced on roughly 1.1 TB, which was an
-- UNCOMPRESSED figure. The realised compression measured on 2026-08-19 was 4x
-- at p50, which puts 13 months nearer 435 GB, about 40 percent of what was
-- priced. The retention may still be right on consumer data grounds, which is
-- the stronger argument, but it should be held for that reason rather than
-- inherited from a number we now know is wrong.
--
-- Storage first. ACTIVE is the data; TIME_TRAVEL and FAILSAFE are billed too
-- and are the reason an erasure is not final for 30 days plus 7.
SELECT table_name,
       ROUND(active_bytes / POWER(1024, 3), 2)      AS active_gb,
       ROUND(time_travel_bytes / POWER(1024, 3), 2) AS time_travel_gb,
       ROUND(failsafe_bytes / POWER(1024, 3), 2)    AS failsafe_gb,
       row_count
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE table_catalog = 'BIDSPOKE_ARCHIVE'
  AND deleted = FALSE
ORDER BY active_bytes DESC;

-- Then compute. Every warehouse, so the archive's share is visible rather than
-- assumed: this account is shared with other Pennie projects.
SELECT warehouse_name,
       ROUND(SUM(credits_used), 2)      AS credits_30d,
       ROUND(SUM(credits_used) / 30, 3) AS credits_per_day
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time > DATEADD(day, -30, CURRENT_TIMESTAMP())
GROUP BY warehouse_name
ORDER BY credits_30d DESC;
