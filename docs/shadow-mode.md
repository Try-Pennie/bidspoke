# Shadow mirror mode (dry run)

Shadow mode lets Bidspoke process real engine traffic without doing anything for
real. It is the dress rehearsal we run before the engine cutover, to prove
Bidspoke handles production volume and to spot-check its decisions against the
live Pipedream flow. See [engine-cutover-scope.md](./engine-cutover-scope.md)
section 3.3 for the full plan.

## How it runs

Pipedream (still the live system) fires a fire-and-forget copy of each request
at `POST https://<worker-host>/shadow/<workflow_id>` with the same `X-API-Key`.
Bidspoke checks the workflow first, then returns `204` immediately so the
mirror step never blocks Pipedream, and runs the workflow in the background with
`shadow_mode: 'dry_run'`. Add `?mode=stand_in` to the URL to run the stand-in
sub-mode instead (see below).

For a workflow carrying a Code node, the route first deploys its compare bundle
(see Code nodes below). A deploy that fails, or a compare namespace the Worker
does not bind, answers a named `503` and nothing runs. A workflow that does not
exist answers `404`, and one that cannot be read answers `503`, since whether
the run would send anything is then unknown.

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

## Code nodes: run in the compare namespace

A Code node's scripts make their real outbound calls; the sandbox request carries
`shadow_mode`, but no script reads it, and nothing inside a script could be
trusted to stub itself anyway. So a shadow run's code runs somewhere every call
is refused (#1708 part B):

- `POST /shadow` deploys the workflow's code to a compare bundle
  (`bs-cmp-<workflow>-<hash>`) in the `bidspoke-code-nodes-compare` dispatch
  namespace, by content hash, so the same code is uploaded once. Never on save.
- The platform routes every request a script in that namespace makes to its
  outbound Worker, `bidspoke-compare-outbound` (`apps/compare-outbound`), which
  answers `403 egress_denied` naming the host, and sends nothing. A code step that
  calls Equifax on a shadow run sees that refusal, and its step records it.
- The engine dispatches a shadow run's code, single steps and chains alike, only
  to that bundle in that namespace (`codeDispatchTarget`, from the one switch
  `codeNamespaceOf` in `engine/run-reality.ts`), and never falls back to the money
  namespace. A shadow run carrying code with no compare bundle is refused before
  anything runs (#1780).

Live runs and canvas test runs still dispatch to `bidspoke-code-nodes` and make
their real calls (Dan, 2026-10-02). Every node type declares what a shadow run
does with it, the `shadowRun` trait in `packages/node-types` (`sends_nothing`,
`stubbed`, or `sandboxed`), so a new node type has to decide. Deploy Worker
creates the compare namespace if it is missing
(`.github/scripts/ensure-compare-namespace.sh`).

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
