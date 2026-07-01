-- Purge-predicate indexes for the export cleanup (purgeOldExported in
-- apps/worker/src/lib/sightings-export.ts).
--
-- The export runs every 2h and purges rows 24h after export via
--   SELECT id ... WHERE exported_at IS NOT NULL AND exported_at < cutoff LIMIT n
-- but the only exported_at indexes on these tables were PARTIAL on
-- `exported_at IS NULL` (built for the export's find-unexported query), which
-- deliberately excludes exactly the rows the purge wants. So every purge batch
-- sequentially scanned all partitions. Under the heap bloat left by a large
-- one-time drain this scan exceeded the 2-minute statement_timeout (57014) and
-- purged nothing (2026-07-01 incident). A partial btree matching the purge
-- predicate turns each batch's row-finding SELECT into an index range scan.
--
-- Additive-only (expand): new indexes, no rename/drop. Applied by hand in prod
-- via the dashboard SQL editor (fast builds at current table sizes); this file
-- keeps the repo in sync so a rebuild recreates them.

CREATE INDEX IF NOT EXISTS lead_sightings_purge_idx
  ON public.lead_sightings (exported_at) WHERE exported_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS lead_sighting_bids_purge_idx
  ON public.lead_sighting_bids (exported_at) WHERE exported_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS achieve_evaluations_purge_idx
  ON public.achieve_evaluations (exported_at) WHERE exported_at IS NOT NULL;
