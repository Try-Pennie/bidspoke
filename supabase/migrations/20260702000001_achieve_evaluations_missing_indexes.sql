-- achieve_evaluations never actually got the exported_at indexes that
-- lead_sightings/lead_sighting_bids have.
--
-- The purge index (achieve_evaluations_purge_idx) WAS in
-- 20260701000001_export_purge_indexes.sql, but a live pg_indexes check on
-- 2026-07-02 found it was never applied to this table in prod (only the
-- other two tables in that migration landed). It is CREATE INDEX IF NOT
-- EXISTS here too, so this file is a safe no-op if it turns out to already
-- exist.
--
-- The export-find index (achieve_evaluations_export_idx) never existed at
-- all, in this migration or any earlier one -- runAchieveExport's exportTable
-- call filters `is_test = false AND exported_at IS NULL`
-- (apps/worker/src/lib/achieve-export.ts:166), the same shape as
-- lead_sightings_export_idx, but no matching index was ever added when the
-- exported_at column landed (20260610000001_achieve_evaluations.sql marks it
-- "future"). backfillTrades (achieve-export.ts:94-100) filters the same
-- exported_at IS NULL set plus `trades IS NULL`; that additional predicate is
-- left as a post-filter rather than folded into the index, matching how
-- lead_sightings_export_idx already leaves `NOT is_test` as a post-filter.
--
-- Currently harmless: achieve_evaluations has 0 rows (Achieve/FDR node not
-- fully live yet, see TODO.md Platform/Ops "Achieve (FDR) offer-collection
-- node"). Without this, the table will hit the identical 57014
-- statement-timeout / alert-spam incident as lead_sightings the moment it
-- gets real volume.
--
-- Additive-only (expand): new indexes, no rename/drop. Applied by hand in
-- prod via the dashboard SQL editor (fast builds at current table sizes,
-- table is empty); this file keeps the repo in sync so a rebuild recreates
-- them.

CREATE INDEX IF NOT EXISTS achieve_evaluations_purge_idx
  ON public.achieve_evaluations (exported_at) WHERE exported_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS achieve_evaluations_export_idx
  ON public.achieve_evaluations (requested_at_utc) WHERE exported_at IS NULL;
