# Execution status reflects whether the lead was served, not post-response side-effects

Execution `status` should mean "was the lead served correctly." A lead that received a correct response but whose post-response writeback (e.g. the Salesforce patch after the Offer Response) later failed is **not** `failed` — it is served-with-a-degraded-writeback. Post-response Outcome-record writebacks are decoupled onto the durable Outcome-record queue (ADR 0002 / #309) and retried out-of-band; their failure is signalled by a separate "writeback dead-lettered after N retries" alert, never by promoting the execution to `failed` or paging during the live request.

## Status

accepted; **implemented 2026-06-24** (#309 Phase 5 / #310). The post-response writeback failure is NOT moved onto a durable queue: it stays a tier-3 external HTTP call retried by the Salesforce node's own `withRetry`, and on exhaustion it dead-letters via the rate-aggregated `recordOutcomeDeadLetter('sf_writeback', …)` alert — not promoted to `failed`, not per-run paged.

**Refinement on the team's decision:** a served lead whose post-response writeback fails is recorded as **`degraded`** (a distinct, visible status), not silently `completed`. This was an explicit override of the original "never gates status" framing: the lead-served signal is preserved (no hard `failed`, no page), but the degradation is surfaced in `status` rather than hidden.

## Context

Previously `apps/worker/src/engine/index.ts` (the post-walk finalize handler, L443-481, `resolveContinuationStatus` at L464) deliberately promoted a `completed` run to `failed` and paged when a `continue_after_response` step threw, to avoid silently recording a writeback loss as success. This wedges the team between two bad outcomes: page on a bookkeeping failure for a lead that got a correct `200` (noisy, erodes alert trust — the 2026-06-15 incident), or stop paging and silently lose the writeback (the Outcome-record loss ADR 0002 forbids). The root cause is that `status` overloads "was the lead served" with "did every post-response side-effect succeed."

## Considered options

- **Keep promoting post-response failures to `failed` + page** (current). Rejected: pages operators for bookkeeping failures on served leads; the lead-served signal and the side-effect signal are conflated.
- **Mark `completed`, no page.** Rejected: silently loses an Outcome record.
- **Decouple post-response writebacks to a durable queue; status reflects response delivery only.** Chosen: kills both the false page and the silent loss, and unifies with ADR 0002.

## Consequences

- The L443-481 promotion of post-response continuation failures to `failed` is replaced (commit on 2026-06-24) by a `degraded` status via `resolveContinuationStatus` (engine/finalize-status.ts); `status` now derives from response delivery. The genuine pre-response / never-advanced / flush-error backstops still resolve to `failed`.
- A flush that only TIMED OUT at the post-response budget (nothing came back either way) is not a flush error (#1881, 2026-10-08, part of #688). The lead was answered, so the run is `degraded` with "Step records were not confirmed saved", sends no per run failure alert, and the minute sweep reads the step rows back for the slowdown summary. A flush that returned an error stays `failed`.
- A genuine writeback failure dead-letters via `recordOutcomeDeadLetter('sf_writeback', …)` (engine/durability.ts, #309 Phase 2) — rate-aggregated, gated like the failure alert (skips business rejections / suppressed / muted / shared-outage signals). The writeback is idempotent: `executeSalesforceNode` PATCHes by Salesforce record id, so a retry is not a create.
- Pre-response Salesforce reads (eligibility lookups) are a different class: they must stay inline because routing depends on them, and are fixed by being made cheap/bounded (precomputed `Is_Eligible__c` flag), not by decoupling.
- Follow-up: dashboard/list rendering of the new `degraded` status (so it reads as served-with-a-degraded-writeback, distinct from `failed`). The status value is recorded now; UI polish is separate.
