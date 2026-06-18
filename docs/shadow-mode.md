# Shadow mirror mode (dry run)

Shadow mode lets Bidspoke process real engine traffic without doing anything for
real. It is the dress rehearsal we run before the engine cutover, to prove
Bidspoke handles production volume and to spot-check its decisions against the
live Pipedream flow. See [engine-cutover-scope.md](./engine-cutover-scope.md)
section 3.3 for the full plan.

## How it runs

Pipedream (still the live system) fires a fire-and-forget copy of each request
at `POST https://<worker-host>/shadow/<workflow_id>` with the same `X-API-Key`.
Bidspoke returns `204` immediately so the mirror step never blocks Pipedream,
then runs the workflow in the background with `shadow_mode: 'dry_run'`.

The run is marked `is_test = true`, so it does not emit Slack alerts, does not
write lead sightings, and is excluded from prod dashboards. Shadow runs carry a
`__shadow` suffix on their source (e.g. `website_form__shadow`) so they stay
filterable apart from manual test runs.

## What dry run skips

These node types return a tagged `_shadow` stub instead of making their call:

- Integration (HTTP) → `{ status: 200, body: { _shadow: true }, headers: {} }`
- Salesforce → `{ status: 200, body: { _shadow: true } }`
- Partner Bid → a canonical skip with `skip_reason: 'shadow'` (no submission, no
  dedup call, no bid-attempt write; the partner config DB read still happens)
- Achieve Offers → a non-accept stub with no `_achieve_evaluation` marker, so the
  achieve-log hook writes nothing
- Data Store → `set` and `delete` skip the KV write (a `get` still reads)

Everything else — filters, branches, transforms, matrix lookups, bid evaluation
— runs for real. That is the point: the decision logic executes, the side
effects do not.

## Code nodes: author responsibility

The engine cannot see inside a Code node's sandbox, so an outbound Code script
must stub itself. Every code script receives a `shadow_mode` value (`'off'` or
`'dry_run'`) alongside `payload`, `steps`, `env`, and `execution`. Any script
that makes an outbound call (e.g. the Equifax credit pull, a partner submission)
must short-circuit:

    if (shadow_mode === 'dry_run') {
      return { /* a realistic stubbed success shape for this step */ }
    }

Pure-transform code nodes (no outbound call) need no change.

## After Phase A

The flag has two states, `'off'` and `'dry_run'`. At cutover the engine is
rerouted to Bidspoke and Pipedream is turned off in the same step, so only one
system ever has real side effects. The `shadow_mode` machinery stays — it is
reusable for every future partner migration.
