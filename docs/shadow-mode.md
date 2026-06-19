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
then runs the workflow in the background with `shadow_mode: 'dry_run'`. Add
`?mode=stand_in` to the URL to run the stand-in sub-mode instead (see below).

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
- Latency Gate → `mark` skips its KV write (a `check` only reads)

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

## Stand-in bid sub-mode

`shadow_mode: 'stand_in'` (triggered with `?mode=stand_in` on the shadow URL) is
dry run plus one difference: a Partner Bid resolves a deterministic bid instead
of returning a `shadow` skip, so downstream Bid Group, bid evaluation, and
routing are exercised too — not just the pre-bid path (filters, eligibility,
matrix lookups). Everything else is still fully stubbed; no partner submission,
dedup call, cap increment, circuit-breaker write, or bid-attempt write happens.

How the bid is resolved per partner:

- Formula partners → the real formula result (a pure local computation).
- Matrix partners → the real matrix lookup (a read-only DB query).
- API partners → a stand-in equal to the partner's floor (`min_bid`, or `0` when
  unset), tagged `bid_reason: 'shadow_standin'`, since their only real bid would
  come from the outbound call we must not make.

Use plain `dry_run` to prove volume and pre-bid decisions; use `stand_in` to also
rehearse winner selection and routing before sending a new partner live.

## Keeping nodes shadow-safe

A guard test (`apps/web/src/lib/__tests__/shadow-side-effect-guard.test.ts`)
enumerates every node executor in `apps/worker/src/engine/nodes/` and fails if one
performs an outbound side effect (HTTP / KV write / DB write / Durable Object)
without short-circuiting under `isShadowDryRun`, unless it is on an explicit
pure/read-only allowlist. A newly added node is forced to be classified either
way, so a side-effect leak like the original `latency-gate` `mark` miss can't
silently reappear.

## Inspecting shadow runs

Shadow runs are hidden from the default execution list (they are `is_test = true`).
The execution panel has a **Live / Shadow** toggle in its header: switch to
**Shadow** to list runs whose source ends in `__shadow`. The API powers this with
`GET /api/executions?shadow=1` (scopes to `is_test = true` AND
`source LIKE '%__shadow'`).

## After Phase A

The flag has three states, `'off'`, `'dry_run'`, and `'stand_in'`. At cutover the
engine is rerouted to Bidspoke and Pipedream is turned off in the same step, so
only one system ever has real side effects. The `shadow_mode` machinery stays —
it is reusable for every future partner migration.
