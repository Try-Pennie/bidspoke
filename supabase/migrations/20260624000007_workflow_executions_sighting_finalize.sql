-- ============================================================
-- Durable projection of the rich sighting-finalize fields (#353 / #359 Phase 1)
-- ============================================================
-- ~5% of served leads/day "strand": their lead_sightings row stays
-- outcome_state='in_flight' because the post-response finalizeSighting waitUntil
-- is lost to Worker-isolate eviction, while the workflow_executions row (a shorter
-- waitUntil that runs first) DOES get written (status='completed'). The reduced
-- drain (20260624000004) then recovers only scalar columns, dropping the rich
-- fields (winner/bid/enrichment/reject_reason) because they were computed from the
-- dying isolate's in-memory step outputs.
--
-- Fix: the engine now ALSO writes those rich fields onto workflow_executions (the
-- write that survives) as this JSONB column, at the same moment it writes the
-- execution record. Phase 2 upgrades the drain to copy these onto lead_sightings
-- (+ flip the winning bid), so residual strands recover with FULL fidelity instead
-- of a reduced finalize. Shape mirrors SightingFinalizeFields in
-- apps/worker/src/engine/lead-sightings.ts (winning_partner_slug, winning_bid_cents,
-- partners_attempted/responded, prospect_id, equifax_*, reject_reason, outcome,
-- terminal_node_id/label, response_status_code).
--
-- Nullable: only capture-on, non-test runs populate it; everything else stays NULL.
-- workflow_executions is partitioned, so ADD COLUMN propagates to all partitions.

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS sighting_finalize jsonb;
