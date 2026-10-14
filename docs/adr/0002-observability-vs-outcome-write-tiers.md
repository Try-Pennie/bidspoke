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

**Timed out is not lost (#1880, 2026-10-08).** `writeOutcome` takes a required `ReadBack` naming the record and the effect that prove the write landed. A write that returns an error is dead-lettered at once, as above. A write that only timed out at the post-response budget is recorded in KV as unconfirmed (`engine/unconfirmed-writes.ts`), and the minute sweep (`lib/unconfirmed-write-sweep.ts`) reads it back after 2 minutes: landed is dropped, missing is dead-lettered with the lost wording, and a database still silent after 15 minutes gets a "could not confirm" alert instead. The `execution_finalize` dead letter follows the same rule. A 90 second stall that day paged every timed out write as lost, and every one had landed.

## Build-now condition (the concrete trigger, #355)

"Watch dead-letter volume for a week" never said what volume means build-now, and a vague trigger never fires. The concrete bar is below, measured by a per-UTC-day dead-letter counter (`lib/deadletter-volume.ts`, incremented in `recordOutcomeDeadLetter`) and a daily check (`runDeadLetterBuildTriggerCheck`, in the daily alert batch) that announces to Slack when either half is met, re-surfacing on its own cooldown until the store is built. The numeric thresholds and the cadences are the constants in `lib/deadletter-volume.ts`, cited here by name rather than copied, so this ADR cannot drift from them.

Build the durable outcome store when EITHER holds:

1. **Any unrecoverable row loss.** A single `lead_sightings.insert` or `lead_sighting_bids.insert` dead-letter. These are the must-not-lose ROW inserts named in "the one limit": no persisted column lets a drain rebuild them, so one is a permanent loss of a billing / win-tracking row, which is exactly the risk this deferral accepted. The finalize losses are excluded, because the strand drains reconstruct them.
2. **Sustained volume.** Dead-letters of our own database writes at or above `BUILD_NOW_DAILY_VOLUME` per day for `BUILD_NOW_VOLUME_DAYS` consecutive completed UTC days. At that outage frequency a lost row is a matter of time rather than luck, even if half 1 has not fired yet. A failed Salesforce update (`sf_writeback`, and one the replay store could not capture) does not count (Dan, 2026-10-14, #2087): it has its own alerts and the replay tool, and this bar decides whether our database writes need a durable store, so counting it could raise the bar for a cause the store would not fix. Saving into the replay store itself is a database write and still counts.

The counter and the bar's constants live in `lib/deadletter-volume.ts`; change the bar there, not only here, so the sentence and the check cannot drift.

## Upgrade path (named, not built)

When dead-letter volume proves the loss is real, the durable upgrade goes behind the `writeOutcome` seam — one file. The preferred mechanism is **not a generic outbox**: it is to move `finalizeSighting` out of `waitUntil` into a per-execution Durable Object alarm or the existing 09:00 Snowflake export job (which already reads `lead_sightings`), finalizing from **already-persisted columns**. That sidesteps the `ctx.steps`-reconstruction problem and avoids standing up a new PII-at-rest store. The daily `reduce_finalize_stranded` cron is effectively a coarse, batch-grained prototype of this path.

## Tier 3 replay store, a scoped exception (#1993, 2026-10-13)

The upgrade path above prefers rebuilding from already-persisted columns and avoiding a new PII-at-rest store. That works for the tier-2 Supabase records. It cannot work for the tier-3 Salesforce writeback: the patch is resolved from a run's step outputs at the moment it is sent, and no column the run keeps holds it (`sighting_finalize` is a code node's output, and step logs are not a replay source). On 2026-10-13, 8 of 18 post-answer writes checked after a Salesforce slowdown had never landed (#2015) and had to be rebuilt by hand.

So the tier-3 tier gets the one store this ADR otherwise avoids, scoped as narrowly as it can be:

- **What:** `outcome_writeback_deadletters`, one row per failed post-answer Salesforce `update`, holding the resolved request the failed step carries (#1992). Only what a replay could resend is stored. A Salesforce failure without an object, a record id and a body is dead-lettered as `outcome_writeback_deadletters.uncapturable` instead, so a row always means "this can be resent".
- **PII handling:**
  - The body and the error text are encrypted with `SECRET_ENCRYPTION_KEY`, and the table is service role only.
  - It is an erasure target, by run id.
  - Its columns are re-locked by the key rotation route.
  - The restore drill restores it as structure only.
- **Retention:** a finished row is purged 30 days after it finishes. A pending row is never purged.
- **Write path:** through `writeOutcome`, so it is retried and read back like any tier-2 record. It is captured outside every alert gate, since a classified Salesforce outage is when these writes fail.

**Replay by hand (#471, 2026-10-13):** three admin actions, each scoped to the caller's organization and audited with no lead value in the audit row.

- `GET /api/admin/held-writes?status=pending` lists the rows without their encrypted columns.
- `POST /api/admin/held-writes/:id/replay` previews unless `dryRun` is `false`. The preview shows each field to be sent beside its current Salesforce value, and a person decides whether a changed field may be overwritten. A replay claims the row first (a compare and set on `attempts`), so two at once send once. It sends the stored body as literal JSON, never through template resolution, and through the node's own call path, so the bulkhead and timeout hold. The row ends `replayed`, `refused` (a business rejection), or stays `pending` with its last error. The logic is `lib/writeback-replay.ts`.
- `POST /api/admin/held-writes/:id/abandon` closes a row a person dealt with in Salesforce, with a required reason.

Not yet built: the automatic drain and the backlog alert (#468). Now that a pending row has an action that changes it, the alert has a remedy to name.

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

## Winners do not strand, and why (#377)

The recovery machinery above (the durable projection, the `reduce_finalize_stranded` drain, the winner flip, per-attempt bid recovery) exists for a strand that, in practice, only non-winners hit. Measured during #353 Phase 3: 0 of 5,450 winners stranded in a 48h sample. The strand drain's winner flip path has therefore never executed in production and is validated only synthetically (#366).

This is not luck, and it is not a property of the engine code. It is a property of the Engine **workflow definition**. The winning path does post-response work: after the Offer Response is sent, the walk continues to the Salesforce prospect writeback (the `patch_prospect` node), and that continuation is what keeps the Cloudflare isolate alive long enough for the block-2 finalize to land. A non-winner (a rejection) sends its response and has little or no post-response work, so its isolate can be evicted before the finalize, which is where strands come from.

The danger is that this is an invisible structural dependency. If the Engine flow is ever reordered so the Salesforce writeback runs **before** the response, or is removed, winners would begin stranding onto the winner flip and per-attempt bid recovery paths that carry no production traffic today. A note in prose is a hope (L27), so the invariant is guarded: `apps/worker/src/engine/__tests__/winner-no-strand-invariant.test.ts` asserts, against the in-repo money-gate snapshot of the live definition (`money-gate/fixtures/definitions/`, refreshed from production), three things: `offer_response` carries `continue_after_response` (it answers the caller and then continues the walk, rather than terminating at the response), EVERY path leaving `offer_response` reaches `patch_prospect` before it ends (not merely some path, so a branch that let a winner skip the writeback fails), and `offer_response` is not reachable downstream of `patch_prospect`. Together those say the writeback runs on every winner, and runs post-response. A reorder that broke any of them would trip the guard on the next fixture refresh and force a conscious decision. CI cannot read the live DB definition, so this is a snapshot check; a runtime monitor that reads the live definition (tracked as a #377 follow-up) would catch a live reorder at once. The live-finalize code in `engine/index.ts` carries the same note at the block-1 projection.

## Consequences

- Every per-lead outcome write declares its tier and gets retry + dead-letter; the external-HTTP (SF) tier gets a dead-letter without faking a `withDbRetry` op; observability writes have a named home with unchanged behavior.
- A Phase 3 CI guard (`apps/web/src/lib/__guards__/worker/durability-seam-guard.test.ts`) scans `apps/worker/src/engine/` and fails if any file other than the two seam-routed writers writes an outcome table directly: `lead-sightings.ts`, and `writeback-deadletter.ts` for the replay store (see "Tier 3 replay store, a scoped exception" above). Batch and admin writers (`lib/sightings-export.ts`, `routes/api/admin.ts`, and the erasure and key rotation writes to the replay store in `lib/archive-erasure.ts` and `lib/secret-reencrypt.ts`) are intentionally out of scope and documented in the guard.
- Any future log-sink/queue work must keep the tiers separable, not merge them.
- See ADR 0003 for how tier-3 writeback failure maps to the `degraded` execution status.
- For the end-to-end recovery pipeline (live finalize, the projection, the 30-min rich drain, the unrecoverable relabel, the export, and the drift guard), see [Lead outcome recovery](../concepts/lead-outcome-recovery.md).
