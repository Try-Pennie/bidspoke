-- ============================================================
-- The execution archive's Postgres side: a clock and two ledgers (#871)
-- ============================================================
-- Three small standalone tables. NONE of them is a column added to
-- workflow_executions, and that is the whole point of the shape: ALTER TABLE on
-- that partitioned parent takes ACCESS EXCLUSIVE across every partition and
-- fires extensions.pgrst_ddl_watch, which 503s all PostgREST traffic while the
-- schema cache rebuilds. That is the failure 20260619000001 exists to avoid, and
-- its header names it as the cause of dropped lead-sightings rows (#237) and the
-- Hyperdrive-fallback alert (#235). A supporting partial index on that parent
-- would be a second such event.
--
-- SECURITY. Every table here is Worker-only. The Worker connects as service_role
-- and bypasses RLS, so these need no policy to work; what they need is for
-- nobody ELSE to read them. Postgres and PostgREST both default towards
-- exposure, which is #762 (six security definer functions reachable by anon), so
-- RLS is enabled with NO policy, which denies every non-bypassing role, and the
-- grants are revoked explicitly as well. The REVOKEs are the load-bearing lines.

-- ------------------------------------------------------------
-- 1. The clock
-- ------------------------------------------------------------
-- One row per stream, holding the last UTC hour archived. Progress is a
-- watermark rather than an archived_at flag on each execution, for the ALTER
-- TABLE reason above. Keyed by stream rather than being a single unkeyed row so
-- a second stream (a backfill, a replay) cannot silently share one watermark.
CREATE TABLE IF NOT EXISTS public.execution_archive_progress (
  stream          TEXT PRIMARY KEY,
  -- The last hour fully archived. The next run takes the hour AFTER this one,
  -- and only once that hour has closed and its settle window has passed.
  watermark_hour  TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.execution_archive_progress IS
  'Last UTC hour archived, per stream. The archive advances strictly forward (#871)';

-- ------------------------------------------------------------
-- 2. Refusals: executions the archiver could not archive
-- ------------------------------------------------------------
-- A per-execution failure that is permanent for that execution (a payload past
-- the statement ceiling will be past it on every retry; a bundle that will not
-- compress will not compress next hour) must not hold the watermark, or one row
-- stops all archiving forever with no mechanism that can clear it. So the
-- watermark advances and the refusal is recorded HERE instead.
--
-- Without this row the failed execution is indistinguishable from one never
-- attempted, and the A4 gate would see only a count shortfall it could never
-- explain or clear by re-running (L47). The gate reads unresolved refusals as
-- their own column with their own message, separate from a plain shortfall, and
-- still refuses to authorise deletion for any day carrying one, because those
-- executions genuinely have no backup.
--
-- Volume: expected to be ZERO on a healthy day. It is a defect ledger, not a
-- queue, so no partitioning and no pruning.
CREATE TABLE IF NOT EXISTS public.execution_archive_refusals (
  execution_id  TEXT PRIMARY KEY,
  archive_day   DATE NOT NULL,
  reason        TEXT NOT NULL,
  refused_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when the execution is later archived successfully. The row is KEPT
  -- rather than deleted, so the attempt stays visible after it is resolved: a
  -- deleted refusal reads exactly like one that never happened.
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS execution_archive_refusals_open_day_idx
  ON public.execution_archive_refusals (archive_day)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.execution_archive_refusals IS
  'Executions the archiver refused, by id and reason. A day with an unresolved row cannot be deleted (#871, #872)';

-- ------------------------------------------------------------
-- 3. Archived ids, so the gate can count orphans without leaving Postgres
-- ------------------------------------------------------------
-- The A4 gate has to count step rows whose execution was never archived. The
-- archived set lives in Snowflake and the step rows live in Postgres, so written
-- literally that is a cross-store anti-join of roughly 1,050,000 step rows
-- against roughly 105,000 ids, which cannot be run: 105,000 ids exceed both the
-- PostgREST URL length and its 1,000 row cap, and paging 1.05M distinct step
-- execution_ids into the Worker does not fit the budget. A check nobody can run
-- becomes a NULL that refuses safely but unexplained, or gets quietly replaced
-- by something cheaper that measures a different thing (L24).
--
-- Writing the id here as each hour is sent makes it one partition-pruned
-- Postgres anti-join, and leaves the Snowflake count the genuinely independent
-- side it has to be.
--
-- VOLUME, stated rather than discovered: ~105,000 rows/day. Deliberately NOT
-- partitioned, because this repo's monthly partitions have twice run out of
-- seeded ranges with nothing extending them (see 20260610000001). Instead the
-- rows are pruned once their day has been verified and its execution partition
-- dropped, so steady state is the retention window, not thirteen months: about
-- 3.2M rows at 30 days, roughly 300 MB. The prune ships with A5, which is the
-- change that first deletes anything.
CREATE TABLE IF NOT EXISTS public.execution_archive_ids (
  execution_id  TEXT PRIMARY KEY,
  archive_day   DATE NOT NULL,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS execution_archive_ids_day_idx
  ON public.execution_archive_ids (archive_day);

COMMENT ON TABLE public.execution_archive_ids IS
  'Ids sent to the Snowflake archive, so the deletion gate can count orphan steps inside Postgres (#871, #872)';

-- ------------------------------------------------------------
-- Lock them down
-- ------------------------------------------------------------
ALTER TABLE public.execution_archive_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_archive_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_archive_ids      ENABLE ROW LEVEL SECURITY;

-- No policies are created, so every role that does not bypass RLS sees nothing.
-- The Worker's service_role bypasses it; anon and authenticated do not.
REVOKE ALL ON public.execution_archive_progress FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.execution_archive_refusals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.execution_archive_ids      FROM PUBLIC, anon, authenticated;
