# Two durability tiers for engine writes: observability vs outcome records

The engine writes to Supabase via best-effort `waitUntil()`. We recognise two tiers with different durability requirements rather than treating all writes the same: **Observability writes** (`execution_steps`, audit detail) are loss-tolerant and batchable, while **Outcome records** (`lead_sightings`, `lead_sighting_bids`, planned `opportunities`) capture real money/business results and must not be silently lost. Outcome records get durability guarantees (retry, ideally a durable queue with a dead-letter); observability writes stay best-effort.

## Status

accepted

## Context

In a system where real money moves, silently dropping an outcome record on a Supabase hiccup is a materially worse failure than dropping a debug log, but today both ride the same fire-and-forget path. Issue #237 already added retry to the lead-sightings writes, acknowledging the gap as a one-off patch. The "unified log sink" idea (TODO.md, Platform/Ops) would batch everything onto one queue, which would worsen the conflation by putting outcome records behind the same lag as debug logs — hence the explicit boundary here.

## Consequences

- Outcome-record writes need retry and, ideally, a durable queue (CF Queue) with a dead-letter; observability writes can be batched and dropped under pressure.
- Any future log-sink/queue work must keep the two tiers separable, not merge them.
- Tracked in #309. Not yet fully implemented as of 2026-06-22 (only the #237 lead-sightings retry exists).
