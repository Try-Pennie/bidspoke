# Money gate

A differential replay of the bidding Worker (#1704, design on #1687). Every pull
request that touches an input of the gate runs synthetic leads through the engine
at the merge base and at the head, and fails on any difference in what the two
send and decide. It does not know the right answer for a lead; it knows the pull
request did not change behaviour it did not mean to change.

## What runs for real, and what is a double

| Real | Double |
|---|---|
| `executeWorkflow` and every node executor of the engine under test | Supabase: `lib/supabase-double.ts` serves `fixtures/config-snapshot.json`, records every write and applies it to a private copy |
| Durable Objects and KV, in workerd through `@cloudflare/vitest-plugin` | Every outbound request: answered by `lib/stub-rules.ts`, the same rules on both sides |
| Code nodes: each workflow's bundle is built by the engine's own `buildBundledWorkerScript` and hosted in a nested workerd (`harness/gate-io.ts`), so the production chain path runs | `DYNAMIC_WORKER_LOADER`: a fake that records the script name and namespaces each dispatch resolves to |

Network is off: the replay's global `fetch` is replaced, the runner's own
outbound service refuses anything that slips past it, and each code bundle's
outbound service answers from the stub rules. Clock, randomness, timezone and
locale are pinned, in the engine and inside every code bundle.

## What is compared, per fixture

`golden_trigger`, `route` at every node that routes by handle, `nodes_executed`,
`final_node`, `response`, `outbound_request` (method, host, path, headers with
credentials redacted, body), `code_namespace`, `supabase_write`, `do_state` and
`kv_state`. Requests and the rows inside one write compare as sets, because a
bid group calls its partners at once. The verdict prints the count per check,
the first difference of each, then the list.

Coverage is printed on every run: per workflow, the arms reached and not reached
by name and the nodes never executed. A workflow that executed no node fails.

## Fixtures carry no real person

* `fixtures/shapes.json`: field paths, value classes, string formats and small
  enumerated domains of recent real trigger payloads, never a value. Written by
  `scripts/export-money-fixture-shapes.ts`, which reads production through a client
  whose writes and rpc throw; its output guard is `lib/__tests__/export-script.test.ts`.
* `fixtures/config-snapshot.json`: the config tables the engine reads, real
  structure, synthetic numbers (order of magnitude and position only), env var
  names with placeholders, URL tokens removed. Result codes, routing codes and
  priority are kept: they decide which arm a lead takes, not what it is worth.
* `fixtures/definitions/*.json`: the live definitions, from the
  `Try-Pennie/bidspoke-workflows` backup, refused unless equal to production.
* `fixtures/variants/*.json`: per workflow, the arms to steer towards: payload
  overrides by path, stub scenarios, env overrides, prior runs.
* `lib/fixture-scan.ts` fails on an issuable SSN, a date of birth other than the
  first of January, a Luhn valid card number and a non zero account number, over
  everything committed and every payload generated (`lib/__tests__/committed-fixtures.test.ts`).

## Running it

```
.github/scripts/money-gate.sh origin/main
```

from the repository root after `pnpm install`. The shapes go stale; from day 23
the verdict warns and from day 30 it asks for a reminder issue. Neither blocks.
Refresh them with `npx tsx scripts/export-money-fixture-shapes.ts` from
`apps/worker`, which needs `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the
environment or `.dev.vars`, and the `gh` CLI for the definitions backup.

## The base on a dispatched Deploy

A Deploy that was DISPATCHED rather than pushed (the Dependabot auto-merge starts
one, and so does a person repairing a stranded target from the Actions tab,
#1761) has no commit before. Its base is the `money_gate_base` input when one is
given (the auto-merge passes the commit main was at before its merge), and
otherwise the commit the live worker reports, so the gate compares exactly the
engine production runs. A dispatched run that can find neither refuses by name:
start it again with `money_gate_base` set. That rule lives in
`.github/scripts/money-gate-base.sh`.

Against the live worker's commit, every `expected-changes.json` entry added since
that commit counts as new, so an entry whose difference was later reverted can
fail as matching nothing. Passing `money_gate_base` set to a nearer commit avoids
that.

## Reading a red

The first difference of each check is the place to start. A route difference
names the node; an outbound difference names the node that sent the request (the
code chain, or the engine step running at the time) and the body field.

If the change is meant, the gate does NOT go green on its own: the pull request
compares the merge base with the head, and the push to main compares the commit
before with the one after, so the same difference fails both. Acknowledge it in
`expected-changes.json`, in the same pull request:

```json
{ "entries": [
  { "workflow": "Main Flow", "check": "outbound_request", "node": "bid_race",
    "field": "* body.unsecuredDebt", "reason": "Tripoint no longer takes the debt field, agreed on the call of 2026-10-01" }
] }
```

`workflow` is the name the fixtures carry, `check` one of the checks above,
`node` and `field` are patterns where `*` matches anything (the node may be left
out), and `reason` says in words why. The rules (`lib/expected-changes.ts`):

* An entry excuses a difference only when it is new in this change: present at
  the head and absent, in exactly that form, at the merge base. So it counts on
  the pull request and again on the push to main, and never after.
  The script hands the verdict the merge base's copy, or git's word that the file
  does not exist there; a copy that was not handed over, cannot be read or does
  not parse fails the gate by name rather than counting as empty.
* Every excused difference still prints, marked excused with its reason.
* A new entry that matches no difference fails the gate by name: an excuse for a
  change that did not happen is a defect.
* Once merged, an entry is carried over: it excuses nothing, the verdict lists it
  as inert, and it can be deleted in any later pull request.

The gate also fails, by name, when it checked nothing: a transcript with no
workflow or no fixture, or a committed definition the head did not replay.

## Known limits

* The HTTP route (auth, body parsing, custom endpoints) is not exercised: the
  replay calls `executeWorkflow` directly, with the trigger the route would build.
* Responses are canned. A change that only matters against a real partner answer
  the stubs do not model is invisible here.
* Arms no fixture reaches are listed by name in the coverage report rather than
  hidden. Some are unreachable by construction, such as Main Flow's
  `debt_screening` else, behind a screen that already required what it lacks.
* Workflows with no live runs when the shapes were exported (Main Flow (v2),
  Bidding - LendSwift, Offer Wall by Submission ID, Forms <> Engine <> Data Store)
  have no fixtures.
