-- ============================================================================
-- Snowflake Setup, Bidspoke Execution Archive (#870, Phase A2)
-- ============================================================================
-- Run this ONCE in a Snowsight worksheet under ACCOUNTADMIN, before the shadow
-- write in Phase A3 (#871) fires. Nothing in the Worker creates any of this.
--
-- Plan: https://github.com/Try-Pennie/bidspoke/discussions/867
-- ADR:  docs/adr/0009-never-delete-without-a-backup.md
--
-- WHY ITS OWN DATABASE. This does not live in BIDSPOKE.PUBLIC, where
-- LEAD_SIGHTINGS and the analytics role already are. The archive holds 13 months
-- of full fidelity execution payloads including SSNs, dates of birth, addresses
-- and credit reports, and the analytics role has no business being able to read
-- them. A separate database is what makes the grants say that rather than a
-- convention saying it.
--
-- WHAT IS DELIBERATELY ABSENT: a secure view filtered by a session parameter.
-- The plan originally specified one as the tenant boundary. Phase A0 settled
-- that this account serves a single tenant (ADR 0009, decisions taken
-- 2026-08-19), so a per-org predicate would filter on a column with one value,
-- and a row access policy would need Enterprise edition to buy nothing. Measured
-- on 2026-08-20: two organizations exist, and only one of them has ever produced
-- an execution (755,713 in the retained window against 0). The boundary is
-- therefore the route's own organization_id check, and the ADR says plainly that
-- this is weaker than the RLS behind the live path. If a second organization ever
-- starts producing executions, that justification has expired: the archiver
-- refuses rather than widening (see #871).
--
-- SECRETS. Each of the three users needs an RSA key pair. The PUBLIC half is not
-- a secret and is set with a one-off `ALTER USER` per identity, at the end of
-- this file, deliberately outside the re-runnable part. The PRIVATE half IS a
-- secret and must never be pasted into this file, a worksheet, or any terminal:
-- it goes straight into a Worker secret via `wrangler secret put`. Generate with:
--
--   openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out <name>.p8 -nocrypt
--   openssl rsa -in <name>.p8 -pubout -out <name>.pub
--
-- ============================================================================

-- ============================================================================
-- BEFORE YOU RUN ANYTHING: how Snowsight decides what to execute
-- ============================================================================
-- Pressing Run executes only the statement under the CURSOR, not the whole
-- worksheet. To run this file, select all of it and use Run All.
--
-- This is not a nicety. Measured on 2026-08-20: three ALTER statements pasted on
-- one line applied only the last of the three, and the worksheet reported
-- success. Two of the three identities kept the setting that was being removed,
-- and nothing said so. It was caught only by reading the state back afterwards.
--
-- It matters most for the KEY statements at the end of this file, where the same
-- mistake would set one identity's key, look like it worked, and leave the other
-- two unable to authenticate at all. Those are deliberately meant to be run ONE
-- AT A TIME, with the check read between each.
--
-- Whatever you run, read the state back rather than trusting that it applied.
-- ============================================================================

USE ROLE ACCOUNTADMIN;

-- ============================================================================
-- Warehouse: ONE, shared between ingest and reads
-- ============================================================================
-- Escalated decision 1 in the plan, answered: a single XS warehouse. A page load
-- queued behind the hourly ingest is a few seconds slower and that is accepted.
-- The two-warehouse split (ARCHIVE_INGEST_WH + ARCHIVE_READ_WH) is the paid
-- upgrade, and Phase A8 (#876) measures real read latency, so a split becomes a
-- decision made on evidence rather than on a guess made here.
--
-- AUTO_SUSPEND 60 because the load pattern is one burst an hour and otherwise
-- idle: anything longer bills for sitting still. INITIALLY_SUSPENDED so creating
-- this script's objects does not start a meter.
CREATE WAREHOUSE IF NOT EXISTS ARCHIVE_WH
  WAREHOUSE_SIZE       = 'XSMALL'
  AUTO_SUSPEND         = 60
  AUTO_RESUME          = TRUE
  INITIALLY_SUSPENDED  = TRUE
  COMMENT              = 'Bidspoke execution archive: hourly ingest plus sporadic point lookups (#870)';

-- ============================================================================
-- Database and schema
-- ============================================================================
CREATE DATABASE IF NOT EXISTS BIDSPOKE_ARCHIVE
  COMMENT = 'Execution archive. 13 month retention, full fidelity including identity data (#866)';

CREATE SCHEMA IF NOT EXISTS BIDSPOKE_ARCHIVE.EXECUTIONS
  COMMENT = 'One gzipped bundle per execution, plus the typed scalars the report header renders';

USE DATABASE BIDSPOKE_ARCHIVE;
USE SCHEMA EXECUTIONS;
USE WAREHOUSE ARCHIVE_WH;

-- ============================================================================
-- The table
-- ============================================================================
-- One row per execution, never one per step. The bundle is opaque on purpose:
-- the archive exists for operational debugging and explicitly not for analytics,
-- so queryability inside the payload buys nothing and a VARIANT would cost
-- storage and load time for it.
--
-- SNOWFLAKE ENFORCES NO UNIQUENESS. A PRIMARY KEY or UNIQUE here would be
-- accepted and then ignored, which is worse than not writing one, because it
-- reads as a guarantee.
--
-- AND NOTHING DEDUPLICATES ON THE WAY IN. This comment used to say idempotency
-- came from the loader using MERGE. It does not: the loader emits a plain
-- INSERT and says so in its own opening lines (#987). DUPLICATE ROWS ARE A
-- NORMAL STATE, not an anomaly, and they are designed in: an hour that fails to
-- reconcile does not advance the watermark, so it is read and sent again, and a
-- crash between the send and the local record leaves a bundle that is re-sent
-- next run.
--
-- What makes that safe is deduplication AT READ TIME. The deletion gate counts
-- COUNT(DISTINCT execution_id), and sums step_count over one row per execution
-- rather than over every row, so a re-sent hour changes neither number (#872).
-- A uniqueness constraint would not help even if Snowflake enforced one: it
-- would turn a harmless re-send into a send failure, and a failed send stalls
-- the watermark on an hour that could then never pass.
--
-- VARCHAR holds 16 MB, and the largest execution measured in A0 was 3.16 MB of
-- raw JSON before gzip, so there is real headroom. A bundle that would exceed it
-- must be REFUSED and recorded, never truncated: a truncated bundle still counts
-- as one archived row and would satisfy the gate while the debugging value it
-- exists for is gone (#871, #872).
CREATE TABLE IF NOT EXISTS execution_archive (
  execution_id              VARCHAR       NOT NULL,
  -- date_trunc('day', started_at AT TIME ZONE 'UTC') in Postgres. ONE definition
  -- of which day a row belongs to, shared by the Postgres count, the Snowflake
  -- count, the step selection, the partition mapping and the erasure delete.
  -- Deliberately NOT derived from the v7 execution id: the id's timestamp and
  -- started_at are taken one statement apart, so an execution born within a
  -- millisecond of UTC midnight would land in one day by id and the neighbouring
  -- day by started_at.
  archive_day               DATE          NOT NULL,
  organization_id           VARCHAR       NOT NULL,
  workflow_id               VARCHAR       NOT NULL,
  workflow_version_id       VARCHAR,
  parent_execution_id       VARCHAR,
  resumed_from_execution_id VARCHAR,
  trace_id                  VARCHAR,
  source                    VARCHAR,
  status                    VARCHAR,
  outcome                   VARCHAR,
  is_test                   BOOLEAN,
  started_at_utc            TIMESTAMP_NTZ NOT NULL,
  completed_at_utc          TIMESTAMP_NTZ,
  duration_ms               NUMBER,
  cost_usd                  NUMBER,
  -- Typed so the deletion gate can sum it without decompressing 105,000 bundles.
  -- It must be the length of the step array actually serialised into the bundle,
  -- never the intended count or a pre-pagination length, or the two sides of the
  -- gate agree perfectly while every bundle is short (#872).
  step_count                NUMBER        NOT NULL,
  -- Non-terminal when the archive deadline was reached. Kept as its own column
  -- rather than inferred from status, so "we archived it mid flight" is
  -- distinguishable from "it genuinely ended in this state".
  archived_incomplete       BOOLEAN       NOT NULL DEFAULT FALSE,
  -- Secondary erasure resolver, never the only one. A measured 3.5% of
  -- executions carry no SSN at all, so an erasure that resolved only through
  -- this column would silently miss them (#875).
  ssn_hash                  VARCHAR,
  bundle_gz_b64             VARCHAR       NOT NULL,
  bundle_bytes              NUMBER        NOT NULL,
  archived_at_utc           TIMESTAMP_NTZ NOT NULL,
  amended_at_utc            TIMESTAMP_NTZ
)
-- 30 days of Time Travel, decided on #909 (2026-08-22). Once A5 (#873) repoints
-- the purge this database is the ONLY place 13 months of execution history
-- exists, and at the 1 day default a bad archiver write or a wrong erasure is
-- unrecoverable after 24 hours. Available because this account is Enterprise or
-- above, established by probe and read-back on #911; Standard caps this at 1.
--
-- Near free in storage terms: Snowflake bills Time Travel on what CHANGES, and
-- this table is insert-only apart from erasures.
--
-- The cost is paid on the erasure side, deliberately and with eyes open: a
-- deleted row stays readable through AT/BEFORE for these 30 days, plus Fail-safe
-- beyond that. A7 (#875) must therefore state when the data actually becomes
-- unrecoverable rather than report a bare row count.
DATA_RETENTION_TIME_IN_DAYS = 30
COMMENT = 'One gzipped JSON bundle per execution. Loaded hourly in started_at order (#871)';

-- Re-runnable, and NOT redundant with the clause above. CREATE TABLE IF NOT
-- EXISTS does nothing to a table that already exists, so on every run after the
-- first the clause above is inert and this is the only line that puts the window
-- in force. Without it, running this script against the live table would report
-- success while leaving the retention at whatever it already was.
ALTER TABLE execution_archive SET DATA_RETENTION_TIME_IN_DAYS = 30;

-- NO CLUSTER BY, deliberately. Hourly loads arrive in started_at order, so the
-- micro-partitions are already naturally ordered by day. Declaring
-- CLUSTER BY (archive_day) would switch on Automatic Clustering, a continuous
-- background credit consumer, on a table that grows to roughly 450 GB, to buy
-- reclustering nobody needs. Phase A8 (#876) verifies pruning empirically with
-- SYSTEM$CLUSTERING_INFORMATION and a timed point lookup; if it proves
-- inadequate, CLUSTER BY (archive_day, execution_id) gets priced and then turned
-- on, not turned on and then discovered on the bill.

-- ============================================================================
-- Three roles, three identities
-- ============================================================================
-- Split by what each one may DESTROY, not by tidiness. The writer and the reader
-- have no DELETE at all, so a bug or a leaked credential on the hourly ingest or
-- on the read path cannot remove archived rows. The eraser exists because
-- without an identity holding DELETE, neither the erasure hook nor the 13 month
-- expiry job can run at all (#875).
CREATE ROLE IF NOT EXISTS bidspoke_archive_writer
  COMMENT = 'Hourly archive ingest. INSERT and SELECT only, never DELETE (#871)';
CREATE ROLE IF NOT EXISTS bidspoke_archive_reader
  COMMENT = 'Archived execution report reads. SELECT only (#874)';
CREATE ROLE IF NOT EXISTS bidspoke_archive_eraser
  COMMENT = 'Erasure requests and the 13 month expiry job. The only identity with DELETE (#875)';

GRANT USAGE ON WAREHOUSE ARCHIVE_WH  TO ROLE bidspoke_archive_writer;
GRANT USAGE ON WAREHOUSE ARCHIVE_WH  TO ROLE bidspoke_archive_reader;
GRANT USAGE ON WAREHOUSE ARCHIVE_WH  TO ROLE bidspoke_archive_eraser;

GRANT USAGE ON DATABASE BIDSPOKE_ARCHIVE TO ROLE bidspoke_archive_writer;
GRANT USAGE ON DATABASE BIDSPOKE_ARCHIVE TO ROLE bidspoke_archive_reader;
GRANT USAGE ON DATABASE BIDSPOKE_ARCHIVE TO ROLE bidspoke_archive_eraser;

GRANT USAGE ON SCHEMA BIDSPOKE_ARCHIVE.EXECUTIONS TO ROLE bidspoke_archive_writer;
GRANT USAGE ON SCHEMA BIDSPOKE_ARCHIVE.EXECUTIONS TO ROLE bidspoke_archive_reader;
GRANT USAGE ON SCHEMA BIDSPOKE_ARCHIVE.EXECUTIONS TO ROLE bidspoke_archive_eraser;

-- The writer needs SELECT as well as INSERT so it can read back what it wrote,
-- and UPDATE for the amend pass, which rewrites a row that has since finalised.
-- It deliberately holds no DELETE: a bug or a leaked credential on the hourly
-- ingest cannot remove an archived row.
GRANT SELECT, INSERT, UPDATE ON TABLE execution_archive TO ROLE bidspoke_archive_writer;
GRANT SELECT                 ON TABLE execution_archive TO ROLE bidspoke_archive_reader;
GRANT SELECT, DELETE         ON TABLE execution_archive TO ROLE bidspoke_archive_eraser;

-- The eraser also erases from the lead sightings mirror, which lives in the
-- OTHER database. An erasure that cleared the archive and left these behind
-- would report success while the subject's SSN stayed queryable (#875).
GRANT USAGE  ON DATABASE BIDSPOKE                      TO ROLE bidspoke_archive_eraser;
GRANT USAGE  ON SCHEMA   BIDSPOKE.PUBLIC               TO ROLE bidspoke_archive_eraser;
GRANT SELECT, DELETE ON TABLE BIDSPOKE.PUBLIC.LEAD_SIGHTINGS      TO ROLE bidspoke_archive_eraser;
GRANT SELECT, DELETE ON TABLE BIDSPOKE.PUBLIC.LEAD_SIGHTING_BIDS  TO ROLE bidspoke_archive_eraser;

-- ============================================================================
-- Three users
-- ============================================================================
-- Replace each <...PUBLIC_KEY> with the PUBLIC half of that user's key pair,
-- as one line with the BEGIN/END armour lines stripped. The private half never
-- appears here.
--
-- TYPE = SERVICE so none of these can log in to Snowsight interactively, and
-- DEFAULT_ROLE plus DEFAULT_WAREHOUSE so a statement that forgets to set them
-- fails closed on permissions rather than silently running as something wider.
--
-- DEFAULT_SECONDARY_ROLES = () is the one that is easy to miss. Snowflake's
-- default since the 2024_08 behaviour change is ALL, which makes a session's
-- privileges the UNION of every role granted to the user rather than just its
-- primary role. With one role each that is currently harmless, and that is the
-- problem: the whole safety story here is that the writer and the reader cannot
-- DELETE, and under ALL that holds by circumstance rather than by construction.
-- The day anyone grants a second role to one of these users for convenience, it
-- activates silently with no explicit switch and no error. Setting it empty makes
-- the split structural, and costs nothing, because the Worker names the role it
-- wants on every request.
-- Everything above this line is safe to re-run: `IF NOT EXISTS` and `GRANT` are
-- idempotent, so a second pass changes nothing.
--
-- Everything below is NOT. `CREATE USER IF NOT EXISTS` protects the user, but an
-- `ALTER USER ... SET RSA_PUBLIC_KEY` runs regardless and REPLACES whatever key
-- is already there. Re-running this file as a whole, after the identities are
-- live, would therefore overwrite three working keys with the placeholder text
-- below and break archive ingest, reads and erasure at once, with the only
-- symptom being authentication failures from a script that appeared to succeed
-- (LESSONS L5: never destroy good state before its replacement is verified).
--
-- So the users are created here, and the keys are set SEPARATELY and one at a
-- time. Check first, and only proceed for an identity that shows no fingerprint:

CREATE USER IF NOT EXISTS bidspoke_archive_writer_svc
  TYPE              = SERVICE
  DEFAULT_ROLE      = bidspoke_archive_writer
  DEFAULT_SECONDARY_ROLES = ()
  DEFAULT_WAREHOUSE = ARCHIVE_WH
  COMMENT           = 'Worker: hourly execution archive ingest (#871)';
GRANT ROLE bidspoke_archive_writer TO USER bidspoke_archive_writer_svc;

CREATE USER IF NOT EXISTS bidspoke_archive_reader_svc
  TYPE              = SERVICE
  DEFAULT_ROLE      = bidspoke_archive_reader
  DEFAULT_SECONDARY_ROLES = ()
  DEFAULT_WAREHOUSE = ARCHIVE_WH
  COMMENT           = 'Worker: archived execution report reads (#874)';
GRANT ROLE bidspoke_archive_reader TO USER bidspoke_archive_reader_svc;

CREATE USER IF NOT EXISTS bidspoke_archive_eraser_svc
  TYPE              = SERVICE
  DEFAULT_ROLE      = bidspoke_archive_eraser
  DEFAULT_SECONDARY_ROLES = ()
  DEFAULT_WAREHOUSE = ARCHIVE_WH
  COMMENT           = 'Worker: erasure requests and the 13 month expiry job (#875)';
GRANT ROLE bidspoke_archive_eraser TO USER bidspoke_archive_eraser_svc;

-- If the users already EXIST from an earlier run, `CREATE USER IF NOT EXISTS`
-- changes nothing about them, so the secondary-roles setting above will not have
-- been applied. Bring an existing set into line with:
--
--   ALTER USER bidspoke_archive_writer_svc SET DEFAULT_SECONDARY_ROLES = ();
--   ALTER USER bidspoke_archive_reader_svc SET DEFAULT_SECONDARY_ROLES = ();
--   ALTER USER bidspoke_archive_eraser_svc SET DEFAULT_SECONDARY_ROLES = ();
--
-- Safe to run whether or not they are already empty, and unlike the key
-- statements below it cannot destroy anything: it narrows a session, it does not
-- replace a credential. Run each on its own and read the state back, per the
-- note at the top of this file.
--
-- Done on the live account 2026-08-20: all three now report an empty
-- DEFAULT_SECONDARY_ROLES.

-- ============================================================================
-- Keys: run these ONE AT A TIME, and read the check before each
-- ============================================================================
-- `RSA_PUBLIC_KEY_FP` is empty for an identity that has no key yet, and holds a
-- fingerprint for one that does. A fingerprint present means the identity is
-- already in use: setting a key there is a ROTATION, which breaks the Worker
-- until the matching private half is put in the Worker secret, so do it
-- deliberately or not at all.
DESC USER bidspoke_archive_writer_svc;   -- read RSA_PUBLIC_KEY_FP
DESC USER bidspoke_archive_reader_svc;
DESC USER bidspoke_archive_eraser_svc;

-- Then, for each identity with NO fingerprint, substitute the PUBLIC half of its
-- key pair (one line, BEGIN/END armour stripped) and run its statement alone. The
-- placeholders are left deliberately invalid so a copy-paste of the whole file
-- fails loudly rather than setting a key nobody chose.
--
--   ALTER USER bidspoke_archive_writer_svc SET RSA_PUBLIC_KEY = '<WRITER_PUBLIC_KEY>';
--   ALTER USER bidspoke_archive_reader_svc SET RSA_PUBLIC_KEY = '<READER_PUBLIC_KEY>';
--   ALTER USER bidspoke_archive_eraser_svc SET RSA_PUBLIC_KEY = '<ERASER_PUBLIC_KEY>';
--
-- The PRIVATE half of each pair goes straight into a Worker secret and must never
-- be pasted into this file, a worksheet, or any terminal:
--
--   wrangler secret put ARCHIVE_WRITER_PRIVATE_KEY --name bidspoke-worker
--   wrangler secret put ARCHIVE_READER_PRIVATE_KEY --name bidspoke-worker
--   wrangler secret put ARCHIVE_ERASER_PRIVATE_KEY --name bidspoke-worker
--
-- plus the three matching `ARCHIVE_*_USER` values, which are just the user names
-- above and are not secret, though they are set the same way.

-- ============================================================================
-- Verify, rather than assume, before wiring the Worker
-- ============================================================================
-- Each of these answers a question this script's correctness depends on, and
-- each has a right answer worth reading rather than glancing at.

-- 1. Time Travel on the archive table. This is the whole reason an erasure can
--    claim less than it appears to: a DELETE leaves the prior version readable
--    through AT/BEFORE for DATA_RETENTION_TIME_IN_DAYS, and Fail-safe holds a
--    further seven days nobody can purge. Read the real number before the
--    erasure route claims a deletion (#875 depends on this).
SHOW PARAMETERS LIKE 'DATA_RETENTION_TIME_IN_DAYS' IN TABLE execution_archive;

-- 2. The grants actually landed, per role. A missing grant surfaces later as a
--    failing hourly job, which is a slow way to learn it.
SHOW GRANTS TO ROLE bidspoke_archive_writer;
SHOW GRANTS TO ROLE bidspoke_archive_reader;
SHOW GRANTS TO ROLE bidspoke_archive_eraser;

-- 3. The reader genuinely cannot delete, and the writer genuinely cannot either.
--    Least privilege that has never been tested is a claim, not a control. Run
--    each of these AS the role and confirm it is REFUSED:
--      USE ROLE bidspoke_archive_reader; DELETE FROM execution_archive WHERE FALSE;
--      USE ROLE bidspoke_archive_writer; DELETE FROM execution_archive WHERE FALSE;
--    `WHERE FALSE` matches nothing, so a permission failure is the only thing
--    either statement can report, and a SUCCESS here is the finding.

-- 4. The maximum statement size the REST API accepts. Phase A3's batch sizing
--    depends on it and A0 could not measure it. Batches are sized in BYTES, so
--    this number is an input to the design, not a detail.
SELECT CURRENT_ACCOUNT(), CURRENT_REGION(), CURRENT_VERSION();
