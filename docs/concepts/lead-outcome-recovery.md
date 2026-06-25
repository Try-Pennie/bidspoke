# Lead outcome recovery (the strand pipeline)

How a lead's final outcome (who won, what bid, why it was rejected, the enrichment) gets durably recorded, and how the system recovers the ~5% of leads per day whose outcome write is lost to a Worker eviction. This is the end-to-end map; the *why* of the durability tiering lives in ADR 0002 (`docs/adr/0002-observability-vs-outcome-write-tiers.md`, an internal decision record), and the term definitions are in the [glossary](./glossary.md).

## The problem: strands

When a lead finishes, the engine sends the HTTP response and then does the bookkeeping in the background (Cloudflare `waitUntil`). One of those background steps, `finalizeSighting`, flips the lead's `lead_sightings` row from `outcome_state='in_flight'` to `'finalized'` and fills in the outcome.

Cloudflare can evict the Worker isolate before that background step finishes. When it does, the lead was served correctly but its `lead_sightings` row is left stuck `in_flight` with no outcome. That stuck row is a **strand**. Measured rate: ~5% of finalized leads/day (4.67-5.64% over 2026-06-19..24). Left alone, the nightly export would record these as `abandoned` with a null winner/bid, which is a falsified money-outcome fact.

The whole pipeline below exists to make strands harmless: recover their real outcome promptly, and never falsify one.

## The three tables

1. `lead_sightings` -- one row per lead arrival. `outcome_state` is `in_flight` until finalized. Carries the outcome fields (winner, bid, reject_reason, enrichment, terminal node, outcome).
2. `lead_sighting_bids` -- one row per partner bid attempt for a sighting. `is_winner` marks the winning bid.
3. `workflow_executions.sighting_finalize` -- a JSONB **projection** of the full outcome, written in the *reliable* background block (see below). This is the key that makes rich recovery possible.

## Two background writes, one reliable

After the response, the engine registers two independent `waitUntil` blocks (both in `apps/worker/src/engine/index.ts`):

- **Block 1 -- the execution record.** Writes `workflow_executions` (status, outcome) AND the `sighting_finalize` projection. Empirically this block survives eviction (it is shorter and runs first). It is the backbone of recovery.
- **Block 2 -- the live finalize.** Runs `finalizeSighting` (the `lead_sightings` outcome) and the per-attempt `lead_sighting_bids` writes. This is the longer block that loses the eviction race ~5%/day -- the strand.

Both compute the outcome from the same pure function, `computeSightingFinalize` (`engine/lead-sightings.ts`), so the projection in block 1 and the live finalize in block 2 are byte-identical. Block 1 also projects the per-attempt bid rows under `sighting_finalize->'bid_attempts'` (shape `ProjectedBidAttempt`, `engine/bid-log.ts`).

## The lifecycle

```
                          lead served, response sent
                                     |
                        +------------+------------+
                        | block 1 (reliable)      | block 2 (strands ~5%)
                        | - workflow_executions   | - finalizeSighting
                        | - sighting_finalize     | - lead_sighting_bids
                        +------------+------------+
                                     |
              block 2 succeeded? ----+---- block 2 evicted (STRAND)
                     |                            |
              outcome_state='finalized'   outcome_state stays 'in_flight'
              recovered_by = NULL                 |
              (the live write)         +----------+-----------+
                                       | execution status?    |
                                       +----------+-----------+
                                       | completed / degraded / failed     -> recoverable
                                       | running / execution row purged    -> unrecoverable
                                       +----------+-----------+
                                                  |
                    +-----------------------------+------------------------+
                    | reduce_finalize_stranded (every 30 min)              | finalize_unrecoverable_stranded
                    | reads sighting_finalize projection                   | (daily 08:30 UTC)
                    |  - projection present -> recovered_by='rich'         | reject_reason='strand_unrecoverable'
                    |    real outcome + winner-flip + bid-row re-insert    | outcome left NULL = honestly unknown
                    |  - projection absent  -> recovered_by='reduced'      |
                    |    scalar fallback, reject_reason='reduced_finalize' |
                    +-----------------------------+------------------------+
                                                  |
                                    Snowflake export (daily 09:00 UTC)
```

## Who recovers what

| Path | When | Covers | `recovered_by` | `reject_reason` |
|------|------|--------|----------------|-----------------|
| Live finalize (block 2) | real time | the 95% that don't strand | `NULL` | real reason (or null for a winner) |
| `reduce_finalize_stranded` -- rich | every 30 min (`*/30`) | strands whose execution has a `sighting_finalize` projection | `rich` | real reason from the projection |
| `reduce_finalize_stranded` -- reduced | every 30 min | strands from before the projection existed (pre-#353-Phase-1) | `reduced` | `reduced_finalize` placeholder |
| `finalize_unrecoverable_stranded` | daily 08:30 UTC | strands with no recoverable execution (status `running`, or the execution row purged at ~7-day retention) | stays `NULL` | `strand_unrecoverable`, `outcome` left NULL |

Execution status decides recoverability. `completed`, `degraded` (lead served, post-response Salesforce writeback failed), and `failed` (lead got an error response) all reached the reliable block-1 write, so their outcome is recoverable from the projection. `running` means block 1 itself never finished -- there is no outcome to recover, so those fall to the honest `strand_unrecoverable` relabel (the deferred per-execution durable store, [#309](https://github.com/Try-Pennie/bidspoke/issues/309), is the only thing that would close that last gap).

The 30-minute drain runs well ahead of the 08:30 relabel, so a recoverable strand is rescued within minutes and never reaches the unrecoverable path.

## Where each field comes from

The drain reconstructs the `lead_sightings` outcome columns by reading keys back out of `sighting_finalize` (e.g. `winning_partner_slug`, `winning_bid_cents`, `reject_reason`, `outcome`, the `equifax_*` enrichment), falling back to the scalar `workflow_executions` columns (`outcome`, `final_node_namespace`, `response_status`, `duration_ms`) when the projection is absent. For a recovered winner it also flips `lead_sighting_bids.is_winner` and re-inserts the per-attempt bid rows from `sighting_finalize->'bid_attempts'` (those rows were lost with block 2). The bid re-insert is idempotent via the `(execution_id, partner_slug, attempted_at_utc)` unique key.

## Keeping the two implementations in sync

The live finalize is TypeScript (`computeSightingFinalize`, `bidAttemptsForProjection`) and the drain is SQL (`reduce_finalize_stranded`). They are coupled only by the JSONB key names. A build-time guard, `apps/web/src/lib/__tests__/worker-strand-drain-contract.test.ts` ([#367](https://github.com/Try-Pennie/bidspoke/issues/367)), fails CI if the SQL stops reading any field the TS shape projects, so the two cannot silently diverge. It follows the drain forward by checking whichever migration most recently redefines the function.

## Source map

| Piece | Location |
|-------|----------|
| Live finalize + projection (both blocks) | `apps/worker/src/engine/index.ts` |
| Pure outcome computation | `apps/worker/src/engine/lead-sightings.ts` (`computeSightingFinalize`, `buildSightingFinalizeProjection`) |
| Per-attempt bid projection | `apps/worker/src/engine/bid-log.ts` (`bidAttemptsForProjection`, `ProjectedBidAttempt`) |
| Rich drain + winner-flip + bid re-insert | `supabase/migrations/20260625000003_recover_degraded_failed_stranded.sql` (latest redefinition; lineage: `20260624000004` reduced -> `20260625000001` rich -> `000002` bid rows -> `000003` degraded/failed) |
| Unrecoverable relabel | `supabase/migrations/20260624000005_finalize_unrecoverable_stranded.sql` |
| Projection column | `supabase/migrations/20260624000007_workflow_executions_sighting_finalize.sql` |
| Drift guard | `apps/web/src/lib/__tests__/worker-strand-drain-contract.test.ts` |
| Snowflake export (09:00 UTC) | `apps/worker/src/lib/sightings-export.ts`, scheduled in `apps/worker/src/index.ts` |
| Durability tiering decision | ADR 0002 (`docs/adr/0002-observability-vs-outcome-write-tiers.md`) |
