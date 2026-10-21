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
| Code nodes: each workflow's bundle is built by the engine's own `buildBundledWorkerScript` and hosted in a nested workerd (`harness/gate-io.ts`), so the production chain path runs | Every dispatch namespace binding the engine's `wrangler.toml` declares (today `DYNAMIC_WORKER_LOADER`, read with wrangler's own config reader): a fake that records the binding, its dispatch namespace, the script name and the code nodes each dispatch resolves to |

Network is off: the replay's global `fetch` is replaced, the runner's own
outbound service refuses anything that slips past it, and each code bundle's
outbound service answers from the stub rules. Clock, randomness, timezone and
locale are pinned, in the engine and inside every code bundle.

Durable Object alarms are held, never scheduled (#1789). An object arms its alarm
from the pinned clock, a time long past in real time, and workerd fires such an
alarm at once on the real clock, so a pending buyer reservation used to turn
`unresolved` before or after the capture by chance, and base and head disagreed
with nothing changed. The replay replaces storage's `setAlarm`, `getAlarm` and
`deleteAlarm`: the time an object asks for is recorded and reported in
`do_state`, and nothing fires. An alarm is a later event, not part of the run. The
replay checks the stand in works before the first fixture, and every capture
refuses an object holding an alarm with the platform scheduler.

Step timeouts are lifted, never raced (#1796). A node's `timeout_ms` (and a bid
group's `cascade_total_timeout_ms`) is a wall clock timer, and live definitions give
code nodes 150 to 250 ms, which a dispatch into the nested workerd can exceed on a
busy runner. The step then retried on one side only and the gate went red with
nothing changed. The replay raises every timer a definition already sets to
`GATE_STEP_DEADLINE_MS` (`lib/step-deadlines.ts`), on both sides alike, and never
adds one a node lacks, since a custom timeout keeps a code node out of a chain. To
check a replay does not depend on how fast it runs, set
`MONEY_GATE_DISPATCH_DELAY_MS` to hold every code dispatch that long, and compare
the transcript with one replayed without it: they must have no difference.

The engine's own timers are lifted too (#1872). Budgets written in code, not in a
definition, are wall clock timers as well: `buyer_click_check` gives its profile
read and click count 800 ms, `buyer_select` bounds its whole path, the lead read
budget aborts a slow read. On 2026-10-07 the head replay ran first and cold, the
click check's budget ran out on that side only, and the lead was refused instead
of offered, with nothing changed. During each replay run `lib/engine-timers.ts`
raises every `setTimeout` and `AbortSignal.timeout` the engine sets to
`GATE_STEP_DEADLINE_MS`, on both sides alike. Measured over every fixture, no
engine timer fires during a run, so this changes no outcome. One that fires anyway
fails the replay by name, with the fixture, the length the engine asked for and
where it was set. The outage drill keeps real timers (`engineTimers: 'real'`),
because its hung database ends only when the caller's own deadline fires. Code
node scripts run in the nested workerd, out of reach of the lift, and keep real
timers: their retry waits are meant to fire.

The replay also runs one lead twice, once as usual and once with every table
read (rpc calls are not held) held past the click check's budget (`dbReadDelayMs`), and fails on any
difference between the two records. It is the fixture that flipped on 2026-10-07,
and it costs a few seconds per side.

## Three kinds of run

Every lead is replayed as a live run. The variants marked `"also_run_as": ["test",
"shadow_dry_run"]` are replayed twice more, as the same lead (same payload, same
randomness) started another way (#1730):

* **test run**: the canvas Test Runner, `POST /api/workflows/:id/test`. It stays
  live in everything it sends: real outbound calls, into the money namespace (Dan,
  2026-10-02, on #1708). Before the run the gate calls the engine's own
  `deployTestCodeBundle`, as the route does, answers its upload to Cloudflare
  locally and hosts the script under the name it chose, so the test run dispatches
  to its test bundle.
* **shadow dry_run**: the shadow mirror, `POST /shadow/:workflow_id`, with every
  outbound submission stubbed and its code on a compare bundle (#1708 part B).
  The gate calls the engine's own `deployCompareCodeBundle`, as the route does,
  and hosts the script in the namespace its upload names, so the shadow run
  dispatches there. An engine from before part B has no such deploy, and its
  shadow runs of code are refused by name instead.

Each kind's options are what its route hands `executeWorkflow`, built in
`lib/run-kinds.ts`; `lib/__tests__/run-kinds.test.ts` drives both routes and fails
when either passes something else. Prior runs are always live, since they stand
for traffic that came before. A workflow with no variant file replays its shape
default as all three. Every workflow must be replayed as each kind: the verdict
fails, by name, on a workflow with no fixture of a kind or whose fixtures of a
kind executed no node, and `committed-fixtures.test.ts` fails on a variant file
that marks no variant for one.

A test or shadow fixture is compared base against head exactly as a live one is,
with every check below. Its id names the kind (`Main Flow/bid_race_tripoint_wins
as test run`), and the coverage report prints one line per test and shadow
fixture: the nodes it executed, the requests it sent, and the binding, namespace
and script its code dispatched to.

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
* `fixtures/variants/*.json`: per workflow, the arms to steer towards (and, by
  `also_run_as`, which variants also run as a test run and a shadow run): payload
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

A refresh changes no verdict by itself, and needs no `expected-changes.json`
entry. The fixtures, harness and stub rules come from the head on both sides,
so a definition changed in production (a canvas save, a Main Flow port stage) is
replayed through the merge base's engine and the head's alike. An entry for it
would match nothing and fail the gate.

## Definition A/B mode: proving a lead validation swap

```
.github/scripts/money-gate-swap.sh <candidate> [<check>:<lenient|strict>]
```

Instrument 2 of a lead validation swap (#2591, part of #934). It replays one
workflow's fixtures twice through the HEAD engine, once with the committed
definition and once with the candidate in `swap/candidates/<candidate>.json`
swapped in, and compares the two with this gate's comparator. Same engine on both
sides, so no `expected-changes.json` entry is read or needed.

What differs by construction is set aside and listed rather than compared: the
replaced step's own step row, the code bundle names, the run's estimated cost (a
code step is priced, a lead validation step is not) and the cached definition in
KV. Every other difference fails unless the candidate's `gate_accepted` names it
(same shape as an `expected-changes.json` entry), and an accepted entry that
matches nothing fails too. Each differing fixture is printed with what the
validation step decided on each side and the check behind it.

The optional second argument seeds a defect in one check, to see the mode name
it. The mode reaches the replay as text bindings (`MONEY_GATE_CANDIDATE`,
`MONEY_GATE_CANDIDATE_SIDE`, `MONEY_GATE_CANDIDATE_SEED`) set in
`vitest.money-gate.config.mts`; unset, the gate replays as always. The logic is
`swap/ab.ts`; the grid (instrument 1) and the real traffic replay (instrument 3)
are described in `docs/nodes/lead-validation.md`.

## The base on a dispatched Deploy

A Deploy that was DISPATCHED rather than pushed (the Dependabot auto-merge starts
one, and so does a person repairing a stranded target from the Actions tab,
#1761) has no commit before. Its base is the `money_gate_base` input when one is
given (the auto-merge passes the commit main was at before its merge), and
otherwise the commit the live worker reports, so the gate compares exactly the
engine production runs. A dispatched run that can find neither refuses by name:
start it again with `money_gate_base` set to a full 40 character commit hash
(a short hash is refused, because the run's shallow checkout cannot fetch one).
That rule lives in
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
* Once merged, an entry is carried over: it excuses nothing, and the verdict
  counts the carried over entries in one note line, naming their workflows.
* Once the live worker runs the commit that added it, it has shipped and can
  never excuse a difference again, so a pull request fails on it by name until it
  is deleted (#1836). Only the pull request job asks the live worker
  (`MONEY_GATE_LIVE_WORKER_URL`); a Deploy never fails on this, and a worker that
  cannot be read is a note, not a failure.

The gate also fails, by name, when it checked nothing: a transcript with no
workflow or no fixture, a committed definition the head did not replay, or a
workflow not replayed as a test run or as a shadow run.

## The outage drill

`money-gate/harness/outage.workers.test.ts` (#1305, plan on #1675) proves each
money flow keeps answering its caller, deciding and sending exactly what it would
with the database up, while every database call fails. It reuses this harness
(`harness/replay-core.ts`) and runs the head only: on every pull request whose
files are money gate inputs (`.github/workflows/outage-drill.yml`), and once a week
on main (`outage-drill-weekly.yml`, Mondays 09:00 UTC, also driven by the worker's
schedule watch when GitHub drops the cron). Not after every merge: each run is
several paid runner minutes, and the pull request run already drilled what merged
(Dan, 2026-10-07). `.github/scripts/outage-drill.sh` is how both run it.

For each live fixture of each money flow it:

1. warms the stored copies the way production does, with the Worker's own
   per minute prewarm plus one lead on a different prospect;
2. keeps only the stored copies (every KV key named `lastgood`), as an outage
   that outlived every short cache would find them;
3. runs the lead with the database up, from that state (the twin);
4. runs it again from the same state once per outage shape (`lib/outage.ts`): a
   refused connection, a PostgREST 503, a Cloudflare HTML 522, and a database
   that hangs, whose requests end only when the caller's own deadline aborts them
   (#1851), with the engine handed the Worker's own lead client over that network;
5. requires each down run to match its twin on the response, every request sent,
   every code dispatch, every route taken, the nodes run and the Durable Object
   state, except the alert claims (`DO_STATE_NOT_COMPARED` in `lib/outage.ts`):
   an outage is expected to raise alerts its twin does not, and since #1881 the
   outcome dead letter's cooldown is an alert claim. Writes to the database are not compared: losing the logging of a run
   in an outage is allowed (Dan, 2026-09-10); losing the lead is not. In the
   hung shape the lead must also be answered within `HUNG_ANSWER_ALLOWANCE_MS`
   (2 s) of its twin, since Engine's own timeout is recorded nowhere, and a run
   still unanswered after 30 s stops the drill by name, as a wait with no
   deadline.

A down run that never asked the database fails the drill, because it drilled
nothing. Decisions come from the engine's step observer, since a down run never
writes its step rows, and every post-response retry waits on an injected clock.

```
cd apps/worker && pnpm exec vitest run --config vitest.outage-drill.config.mts
```

The hung shape waits out each bounded deadline for real, which makes it the slow
one: the whole drill took 608 s on a laptop on 2026-10-07, so vitest gives it
`OUTAGE_DRILL_TIMEOUT_MS` (20 minutes) inside the jobs' 25.

`OUTAGE_DRILL_ONLY="<workflow name>"` drills one flow; the report then says it was
narrowed. `MONEY_GATE_OUT=<file>` writes the report: each fixture's differences,
each one naming the first position where the down run parted from its twin, and
the time spent by phase.

**Exemptions.** A flow that does not pass yet is listed in
`money-gate/outage-exemptions.json` with its workflow, the outage shape (or `*`),
its expected first difference (`field: pattern`, `*` as a wildcard), the issue
that removes it and an expiry date. Any other difference still fails, an expired
entry fails, and an entry that matched nothing fails, so a fixed flow cannot stay
exempt.

**Not drilled**, each for its reason:

* Test and shadow runs: they carry no lead.
* The custom endpoint route: the replay calls the engine directly. Its stored
  record has its own tests (`routes/__tests__/custom-endpoint.test.ts`).
* The bid matrix and the latency gate: no live money flow uses them, so no
  fixture reaches them. Their stored copies have their own tests
  (`lib/__tests__/bid-matrix-last-good.test.ts`,
  `engine/nodes/__tests__/latency-gate-outage.test.ts`).
* `Delegate Gmail Access for Offboarded Agents`: it moves no lead.
* A Cloudflare outage: the Worker itself is down, so nothing here runs.

**Known quirk.** workerd reports a rejected fetch as unhandled even when
supabase-js catches it and the caller awaits the answer (reproduced with one
awaited read and nothing of ours around it), so the drill's config ignores
exactly the refused shape's own rejection (`isOutageNetworkRejection`); any other
unhandled error still fails the run.

## Known limits

* The HTTP route (auth, body parsing, custom endpoints) is not exercised: the
  replay calls `executeWorkflow` directly, with the trigger the route would build.
  For a test run and a shadow run the options come from `lib/run-kinds.ts`, which
  a Node test holds to what the two routes pass; a route that changes them fails
  that test, and the replay then drives both sides with the new options, so the
  route change itself is never a base and head difference.
* Bundles are hosted per dispatch namespace, as on the platform: a name in one
  namespace is not reachable through another's binding. A bundle in a namespace
  whose binding names an outbound Worker has its requests answered by that
  Worker's own code (`apps/compare-outbound` for the compare namespace), and they
  are not recorded as sent, because none is; a namespace naming an outbound Worker
  the gate has no handler for stops the replay by name.
* Responses are canned. A change that only matters against a real partner answer
  the stubs do not model is invisible here.
* Arms no fixture reaches are listed by name in the coverage report rather than
  hidden. Some are unreachable by construction, such as Main Flow's
  `debt_screening` else, behind a screen that already required what it lacks.
* Workflows that have never had live runs at an export (Main Flow (v2),
  Bidding - LendSwift, Offer Wall by Submission ID, Forms <> Engine <> Data Store)
  have no fixtures. A workflow that already has a fixture and is merely quiet at an
  export keeps it (#2173): its definition and config are exported as usual and its
  shape is carried over, marked `carried_over` with when it was really sampled.
  The stale shapes warning counts from the oldest such sample.
