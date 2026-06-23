# Execution status reflects whether the lead was served, not post-response side-effects

Execution `status` should mean "was the lead served correctly." A lead that received a correct response but whose post-response writeback (e.g. the Salesforce patch after the Offer Response) later failed is **not** `failed` — it is served-with-a-degraded-writeback. Post-response Outcome-record writebacks are decoupled onto the durable Outcome-record queue (ADR 0002 / #309) and retried out-of-band; their failure is signalled by a separate "writeback dead-lettered after N retries" alert, never by promoting the execution to `failed` or paging during the live request.

## Status

accepted (supersedes the current behaviour; not yet implemented)

## Context

Today `apps/worker/src/engine/index.ts` (~L443-452) deliberately promotes a `completed` run to `failed` and pages when a `continue_after_response` step throws, to avoid silently recording a writeback loss as success. This wedges the team between two bad outcomes: page on a bookkeeping failure for a lead that got a correct `200` (noisy, erodes alert trust — the 2026-06-15 incident), or stop paging and silently lose the writeback (the Outcome-record loss ADR 0002 forbids). The root cause is that `status` overloads "was the lead served" with "did every post-response side-effect succeed."

## Considered options

- **Keep promoting post-response failures to `failed` + page** (current). Rejected: pages operators for bookkeeping failures on served leads; the lead-served signal and the side-effect signal are conflated.
- **Mark `completed`, no page.** Rejected: silently loses an Outcome record.
- **Decouple post-response writebacks to a durable queue; status reflects response delivery only.** Chosen: kills both the false page and the silent loss, and unifies with ADR 0002.

## Consequences

- The L443-452 promotion of post-response continuation failures to `failed` is removed once writebacks move to the queue; `status` then derives from response delivery (and the genuine pre-response/never-advanced/flush-error backstops remain).
- A new, separate alert path fires when a queued writeback is dead-lettered after its retries are exhausted.
- Pre-response Salesforce reads (eligibility lookups) are a different class: they must stay inline because routing depends on them, and are fixed by being made cheap/bounded (precomputed `Is_Eligible__c` flag), not by decoupling.
- Tracked alongside #309. Not yet implemented as of 2026-06-22.
