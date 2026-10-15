# Salesforce gets a dependency-level bulkhead (inflight limit + fail-fast)

The execution engine runs on auto-scaling Cloudflare Workers (effectively unbounded request concurrency), but Salesforce has a hard ~25-slot concurrency governor. With no backpressure, a Salesforce slowdown becomes a system-wide cascade: slots saturate, abandoned calls keep running server-side, and the front end keeps piling on (the 2026-06-10 incident). We will add a **Salesforce bulkhead** — a fixed inflight-call budget set below the governor, with **fail-fast when exhausted** — so a Salesforce slowdown degrades into a bounded, fast, observable failure instead of a cascade. This is the same circuit-breaker pattern already used per-partner, applied to Salesforce as a whole dependency.

## Status

accepted — implemented 2026-06-25 (#312). `BulkheadObject` Durable Object
(`durable-objects/bulkhead.ts`) + `BulkheadClient`, wired into the inline
Salesforce call in `engine/nodes/salesforce.ts`. Cap via `SALESFORCE_BULKHEAD_LIMIT`
(default 20); shed = a permanent error that routes to the step's on_error/fallback
(no SF retry). Background cron SF callers and the cached token fetch are out of scope.

Amended 2026-10-15 (#2170, phase 1 of #1680): a Salesforce call made after the
run's answer (`ctx.afterAnswer`, set by the walk when it answers, the same fact
the at-risk watch reads) also takes a slot of a second key,
`salesforce-post-answer`, capped at `SALESFORCE_POST_ANSWER_BULKHEAD_LIMIT` (6)
in `lib/bulkhead-client.ts`. It takes that share first and a main `salesforce`
slot second, so post-answer work holds at most 6 of the 20 and a pre-answer call
always finds the other 14, while the two keys together never let more calls reach
Salesforce than the main cap alone. A post-answer call waits at most 3 s for both
(`SALESFORCE_POST_ANSWER_BULKHEAD_WAIT_MS`), so a shed post-answer write fails
inside the 12 s post-answer window as an unknown outcome, kept by its at-risk
record, rather than being cut off still waiting. A Durable Object error fails
open for either key alike and logs `salesforce_bulkhead_failed_open` with the key.
The write replay (#1993) runs outside any run and keeps the main key only.

## Context

Per-partner circuit breakers protect against a *partner* failing, but nothing plays that role for shared non-scaling dependencies — chiefly Salesforce. The inline bid path must stay synchronous (ping-post must respond within the partner timeout), so the answer is not to queue the path but to bound concurrency on the dependency. The per-partner daily-cap and circuit-breaker Durable Objects are single-threaded actors and are the one place concurrency concentrates, but they are fast in-memory counters and judged a scaling watch-point, not a current problem. No *other* shared inline chokepoint was identified as needing this treatment now.

## Consequences

- Implement an inflight-concurrency limiter for Salesforce calls (e.g. a token-bucket/semaphore via a Durable Object or KV), capped below the 25-slot governor, that fails fast (or briefly queues then sheds) when exhausted, with metrics/alerting on shed events.
- Pairs with ADR 0003 (post-response SF writebacks move off the inline path to the durable queue) and the precomputed `Is_Eligible__c` flag (removes the governor-saturating pre-response table scan) — together these reduce both the volume and the blast radius of SF load.
- Implemented 2026-06-25 (#312). Observability: a structured `salesforce_bulkhead_shed`
  log line, and because the shed error message is distinctive ("Salesforce bulkhead:
  at capacity") an unhandled shed flows through the existing failure + failure-rate
  Slack alerts without new alert infrastructure.
