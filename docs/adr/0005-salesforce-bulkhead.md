# Salesforce gets a dependency-level bulkhead (inflight limit + fail-fast)

The execution engine runs on auto-scaling Cloudflare Workers (effectively unbounded request concurrency), but Salesforce has a hard ~25-slot concurrency governor. With no backpressure, a Salesforce slowdown becomes a system-wide cascade: slots saturate, abandoned calls keep running server-side, and the front end keeps piling on (the 2026-06-10 incident). We will add a **Salesforce bulkhead** — a fixed inflight-call budget set below the governor, with **fail-fast when exhausted** — so a Salesforce slowdown degrades into a bounded, fast, observable failure instead of a cascade. This is the same circuit-breaker pattern already used per-partner, applied to Salesforce as a whole dependency.

## Status

accepted (not yet implemented)

## Context

Per-partner circuit breakers protect against a *partner* failing, but nothing plays that role for shared non-scaling dependencies — chiefly Salesforce. The inline bid path must stay synchronous (ping-post must respond within the partner timeout), so the answer is not to queue the path but to bound concurrency on the dependency. The per-partner daily-cap and circuit-breaker Durable Objects are single-threaded actors and are the one place concurrency concentrates, but they are fast in-memory counters and judged a scaling watch-point, not a current problem. No *other* shared inline chokepoint was identified as needing this treatment now.

## Consequences

- Implement an inflight-concurrency limiter for Salesforce calls (e.g. a token-bucket/semaphore via a Durable Object or KV), capped below the 25-slot governor, that fails fast (or briefly queues then sheds) when exhausted, with metrics/alerting on shed events.
- Pairs with ADR 0003 (post-response SF writebacks move off the inline path to the durable queue) and the precomputed `Is_Eligible__c` flag (removes the governor-saturating pre-response table scan) — together these reduce both the volume and the blast radius of SF load.
- Not yet implemented as of 2026-06-22.
