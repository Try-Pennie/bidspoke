# Two durability tiers for engine writes: observability vs outcome records

The engine writes to Supabase via best-effort `waitUntil()`. We recognise distinct tiers with different durability requirements rather than treating all writes the same: **observability writes** (`execution_steps`, audit detail) are loss-tolerant and batchable, while **outcome records** (`lead_sightings`, `lead_sighting_bids`, planned `opportunities`) capture real money/business results and must not be silently lost. The boundary is named at the call site through a seam (`engine/durability.ts`) so it is greppable and CI-enforceable, not implicit in which file a write happens to live in.

## Status

**Seam enforced; durable store deferred** (#309, 2026-06-24). The three-tier seam, the static CI guard, the dead-letter alert, and the strand-and-falsify fix all shipped. The durable store behind the must-not-lose tier is deliberately deferred pending dead-letter alert volume (see "the one limit" and "upgrade path" below). Supersedes the 2026-06-22 "not yet fully implemented" status.

## Context

In a system where real money moves, silently dropping an outcome record on a Supabase hiccup is a materially worse failure than dropping a debug log, but originally both rode the same fire-and-forget path. Issue #237 added retry to the lead-sightings writes as a one-off patch; #309 generalises that into a uniform, reviewable boundary. The "unified log sink" idea (TODO.md, Platform/Ops) would batch everything onto one queue, which would worsen the conflation by putting outcome records behind the same lag as debug logs — hence the explicit boundary here.

## The three tiers, in failure-mode terms

- **Tier 1 — observability** (`execution_steps`, audit). At-most-once, best-effort, batchable, droppable under pressure. An occasional lost debug row is tolerable. Routed through `writeObservability` (engine/durability.ts), which is the named home for the at-most-once tier — behavior unchanged (no retry, no alert) so the boundary is symmetric and greppable. step-logger and audit are the tier-1 reference callers.

- **Tier 2 — Supabase outcome records** (`lead_sightings`, `lead_sighting_bids`, planned `opportunities`). At-least-once via `writeOutcome`: `withDbRetry` ladder, then `recordOutcomeDeadLetter` on a returned error (retries exhausted or permanent). A duplicate-key (`23505`) is treated as success — the row already landed — so a replay is a no-op rather than a loss or a wasted ladder; this pairs with the `lead_sighting_bids_attempt_uniq` constraint (#340, migration `20260624000003`) that makes the bid write idempotent under replay. Retried in-process within `waitUntil`, off the request path.

- **Tier 3 — external Salesforce writeback** (the post-Offer-Response prospect PATCH). At-least-once via the node executor's own `withRetry` (per-attempt `AbortSignal`/timeout, `classifyTransportError`), idempotent because `executeSalesforceNode` PATCHes by Salesforce record id (a retry is not a create). On exhaustion it calls `recordOutcomeDeadLetter('sf_writeback', …)` **directly** — it does NOT flow through the `withDbRetry` seam, because an HTTP PATCH is not a PostgREST op. The seam contributes the dead-letter alert and the no-promote rule here, not the retry. Per ADR 0003 / #310 this tier never hard-fails the execution: a served lead whose writeback fails is recorded `degraded` (visible), not `failed` and not paged on the live request (`resolveContinuationStatus`, engine/index.ts:443-481, `resolveContinuationStatus` at L464).

## The loss mode this narrows, and its measured rate

`finalizeSighting` runs in a post-response `waitUntil`. The Worker isolate can be evicted before that continuation completes, leaving the `lead_sightings` row `outcome_state='in_flight'` on an execution that actually **completed** (the lead was served). The nightly Snowflake export sweep then falsified these to `outcome='abandoned'` with a null winner/bid/enrichment — real money-outcome facts recorded wrong.

**Measured (Phase 0, #339, 2026-06-24):** ~5% of finalized leads/day are strands rescued by the drain (4.67–5.64% over 2026-06-19…24, ~3,500–4,900 leads/day). This is materially non-zero day-over-day, so the dead-letter alert is load-bearing immediately, not decorative.

Two daily pg_cron jobs (DB-side, ahead of the 09:00 UTC export) close this without a queue:
- `reduce_finalize_stranded` (every 30 minutes, plus a deeper daily pass at 07:45 UTC; migration `20260624000004`): finalizes `in_flight` rows whose execution still exists and completed, writing a **reduced finalize** derived purely from already-persisted `workflow_executions` columns (`outcome`, `final_node_namespace`, `response_status`, `duration_ms`) (no `ctx.steps` needed). Marked `reject_reason='reduced_finalize'` so they stay auditable vs a full live finalize.
- `finalize_unrecoverable_stranded` (08:30 UTC, migration `20260624000005`, #351): honestly relabels the genuinely-unrecoverable remainder (execution row purged at ~7 days, or never completed) as `reject_reason='strand_unrecoverable'` with `outcome` left NULL = unknown , replacing the old falsifying `abandoned` marker. Moving this DB-side fixed the prior silent failure where the multi-partition UPDATE ran past the Worker's `statement_timeout`. That ceiling is **30s**, not the 8s this ADR used to cite (#614): the Worker authenticates with `SUPABASE_SECRET_KEY` and so runs as `service_role`. Verified live 2026-08-14 in `pg_db_role_setting`: `anon` 3s, `authenticated` 8s, `authenticator` 8s, `service_role` 30s. The conclusion is unchanged and in fact stronger: a ~72K-row multi-partition UPDATE that cannot finish in thirty seconds was never going to be rescued by trimming the batch at the margin, and the pg_cron jobs run as `postgres`, which carries no role-level override and so gets the 120s cluster default, four times the Worker's ceiling. It also means a 57014 reaching us from the Worker is a much louder signal than the old wording implied. With the recoverable drain running, near-zero rows reach this state (0 to 87/day).

## The one limit (the explicit deferred follow-up)

The tier-2 in-process `withDbRetry` ladder does **not** survive Worker isolate eviction or a deploy mid-retry: a sustained multi-minute Supabase outage can still drop a tier-2 row with only the dead-letter alert as the trace. The daily drain backstops the specific `finalizeSighting` strand (because it reconstructs from already-persisted columns), but an `insertSighting`/`recordBidAttempt` write lost to a long outage is not recoverable from existing columns. This is the deliberately deferred risk: the seam is the enforceable boundary and the falsification fix, not a durable queue.

## Upgrade path (named, not built)

When dead-letter volume proves the loss is real, the durable upgrade goes behind the `writeOutcome` seam — one file. The preferred mechanism is **not a generic outbox**: it is to move `finalizeSighting` out of `waitUntil` into a per-execution Durable Object alarm or the existing 09:00 Snowflake export job (which already reads `lead_sightings`), finalizing from **already-persisted columns**. That sidesteps the `ctx.steps`-reconstruction problem and avoids standing up a new PII-at-rest store. The daily `reduce_finalize_stranded` cron is effectively a coarse, batch-grained prototype of this path.

## Post-response `waitUntil` write audit (#362)

The strand loss above is one instance of a general shape: the engine registers several independent `executionCtx.waitUntil(...)` writes after the early response, any of which the isolate can drop on eviction. #362 enumerated them and classified each so the must-not-lose ones are knowingly protected and the rest are knowingly accepted:

| Write (engine/index.ts) | Tier | Loss on eviction | Protection |
| --- | --- | --- | --- |
| Execution record + step-log flush (`updateExecutionRecord`, ~L437) | 2 (drives the drain + observability) | Empirically survives — shortest block, runs first | Backbone of the #353 recovery; the `sighting_finalize` projection rides here |
| Lead-sighting finalize + bid attempts (~L590) | 2 (money/outcome) | Was the ~5%/day strand | Durable projection (#353 Ph1) + `reduce_finalize_stranded` drain (#360/#366) |
| Achieve evaluation log (`insertAchieveEvaluations`, ~L644) | **1 (analytical volume)** | A dropped row under-counts trend analysis | **Routed through `writeObservability` (#362).** Loss-tolerant by decision: analytical, nightly-exported-then-purged, not money. Upgradeable to `writeOutcome` behind the same seam if it ever needs at-least-once. |
| Slack failure alert (~L560/L667) | 1 (alert) | One missed page | Acceptable — the aggregated crons (failure-rate #248, upstream-outage #331) page on spikes regardless |
| Idempotency cache PUT/clear (~L699/L706) | 1 (cache) | A miss just re-runs the lead | Acceptable by design |

Conclusion: after #353, the only must-not-lose post-response write without recovery was the Achieve log, and it was not yet live (zero `achieve_evaluations` rows in prod). It is classified tier-1 and named at the seam rather than given the full projection+drain, because losing ~5% of analytical volume rows is tolerable noise where losing a money outcome is not. The seam guard's `OUTCOME_TABLES` deliberately does not include `achieve_evaluations` — it is tier-1, so a direct-or-seam write is both allowed.

## Consequences

- Every per-lead outcome write declares its tier and gets retry + dead-letter; the external-HTTP (SF) tier gets a dead-letter without faking a `withDbRetry` op; observability writes have a named home with unchanged behavior.
- A Phase 3 CI guard (`apps/web/src/lib/__tests__/durability-seam-guard.test.ts`) scans `apps/worker/src/engine/` and fails if any file other than the seam-routed `lead-sightings.ts` writes an outcome table directly. Batch/admin writers (`lib/sightings-export.ts`, `routes/api/admin.ts`) are intentionally out of scope and documented in the guard.
- Any future log-sink/queue work must keep the tiers separable, not merge them.
- See ADR 0003 for how tier-3 writeback failure maps to the `degraded` execution status.
- For the end-to-end recovery pipeline (live finalize, the projection, the 30-min rich drain, the unrecoverable relabel, the export, and the drift guard), see [Lead outcome recovery](../concepts/lead-outcome-recovery.md).
