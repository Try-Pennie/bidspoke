# Main Flow relay port

How Main Flow's Salesforce writes move off the two Pipedream relays onto native
Salesforce steps (#1680, built in #2171). The plan, its decisions and its phase
0 measurements are on #1680; the contract every write follows is
[salesforce-post-answer-write-contract.md](./salesforce-post-answer-write-contract.md).

## No copy of Main Flow is kept

Brian and Dan edit Main Flow on the canvas, and nobody carries those edits back
into the repo, so Main Flow is not one of the drift check's kept workflows and
the repo holds no copy of it (Dan, 2026-10-15). Every save on the canvas is still
mirrored to the `Try-Pennie/bidspoke-workflows` backup, and the money gate's
fixture of it is refreshed from that backup by the export script.

The port is therefore a transform, not a file: `portMainFlow` in
[`apps/worker/src/lib/main-flow-port/transform.ts`](../apps/worker/src/lib/main-flow-port/transform.ts)
takes whatever the canvas holds and returns the ported definition. It is run on
the live definition at the moment of the apply, and on the money gate's
production fixture in the tests.

## What the transform changes

**Each of the nine outcome posts** (`tripoint_sf_post`, `amone_sf_post`,
`send_salesforce`, `send_fallback_salesforce`, `send_fallback_salesforce_1`,
`engine_no_bids_sf_post`, `under_10000_sf_post`, `invalid_state_sf_post`,
`debt_missing_sf_post`) becomes a native `update` of `Submission__c`, keeping:

- its namespace, id, label and position, so `success_node_namespaces` still
  counts it and the canvas looks the same;
- its body template exactly. A JSON text body stays text, so `""` and the
  string `"null"` are sent as the relay received them; a code node's `sfBody`
  is sent as the object it is.

and adding what the relay did on its side:

- `omit_fields: ["executionId", "submissionId"]`, the keys it never sent;
- `rename_fields: {"UUID": "Engine_UUID_SO__c", "leadUUID": "Engine_Lead_UUID_SO__c"}`;
- `record_id` from the body's own `submissionId`, where the relay read it;
- `skip_when_empty: true`, its filter: a null body (an Engine failure path) or
  one with no record id writes nothing, with the reason recorded on the step;
- `injected_fields: {"PDFlow_4__c": "{{execution.bidspoke_link}}"}`, the
  Bidspoke run link (decision D4), which the inquiry relay wrote before.

**The inquiry post** (`send_salesforce_inquiry`) leaves `parallel_1`, and after
every outcome write come two steps, before what followed the write (the branch's
Achieve step, or `exit_1` to `exit_3`):

- `inquiry_body_<post>`, a code node that builds the relay's Apex body,
  `{ submissionId, inquiriesJson }`, or returns null, which skips the call,
  unless the lead took `equifax_debt`'s `trades_present` route (where the
  inquiry post ran before) and its credit report carries inquiries (#2169: the
  endpoint writes nothing for an empty list and answers 500 for a missing one);
- `inquiry_apex_<post>`, the `POST /services/apexrest/credit-inquiries` call,
  `retries: 0` because each call attaches a new file to the Lead. The engine
  also never retries this post whatever its config says, records it before it is
  sent, and the Salesforce read-back checks the Lead's Inquiries file before
  resending it at most once (#2172; the contract doc's "The credit inquiry post's
  read-back").

A failed Apex call ends the walk after the answer, as a failed outcome post does
today: the branch's Achieve step does not run after it, and the run is recorded
as failed. `ported-walk.test.ts` proves this through the real engine walk over the
ported definition's Tripoint win branch: the lead is answered, the Submission is
written, the Apex call is made once and fails, and Achieve is not reached (and,
as its control, is reached when the call succeeds).

The inquiry relay's `VantageScore__c` patch is not kept: the outcome write
already sets it last today, so its value stands (plan point 2).

**Timeouts.** Work after the answer gets 12 s (`CONTINUATION_WINDOW_MS`). The
outcome write gets one attempt of 4.5 s, near the p99.9 of
`set_completed_submission` (4,474 ms over 7 days; 7,077 ms over the 3 days to
2026-10-15). Counted against 4.5 s, 25 of its 23,364 single attempts in 7 days
took longer, 22 of them in the last 3 days, so expect one or two writes in 1,000
to time out (more if the completing write is slower, which is inferred, not
measured); each is held by the at-risk record for #2023's read-back rather than
resent. The Apex call gets one
attempt of 4.5 s, sized on the same org's `credit-trades` call (p99 4,001 ms).
The body step gets 500 ms. The longest branch, `send_salesforce`, whose
`calculate_internal_debt` runs after its answer, has a worst case of 11.45 s; a
test walks every branch and fails when one no longer fits.

## Stages

Each stage is applied over the one before, and applying one twice changes
nothing. A post already ported is recognised and left alone.

| Stage | Plan phase | What it does |
|---|---|---|
| `canary_invalid_state` | 4 | ports `invalid_state_sf_post` |
| `canary_send_salesforce` | 5 | also ports `send_salesforce` |
| `outcome_posts` | 6 | ports the other seven (gated on #2163 and #2023, D6) |
| `inquiry` | 7 | moves the inquiry post after the answer (gated on #2172) |

## When the transform refuses

It refuses, naming every problem at once, whenever a part it rewrites is not the
shape it was written against: a post missing or changed (another URL, a setting
it does not carry over, a body with no `submissionId`), a tenth post to either
relay, `parallel_1` or the inquiry relay changed, a step that reads what a relay
post answered, a namespace it adds already taken. Nothing is sent. Read the
reasons, look at the canvas edit behind them, and change the transform in a pull
request if the edit should stand.

## Previewing, applying and rolling back

Only a member of the production organization can save Main Flow, so this runs in
Dan's logged in Bidspoke tab, as the Liberty1 workflow was created. Nothing has
been applied yet; each stage is applied by its own phase issue.

1. Before any apply, the engine pull request that the stage needs is merged and
   deployed, and the live commit confirmed (plan point 12).
2. Print the tab script, from `apps/worker`, with the worker URL from the
   `NEXT_PUBLIC_WORKER_URL` repo variable:
   `npx tsx scripts/main-flow-port-tab.ts preview <stage> <worker url>`.
3. Reload a Bidspoke app tab signed in as Dan (so its session is fresh), and run
   the printed text in its console (it reads the session from the tab's cookies
   and never prints the token). It answers what the stage would port,
   add and remove, and the live version it read, and changes nothing.
4. Print and run `apply` the same way. It reads the live definition, runs the
   transform on it, re-reads immediately before the PUT and refuses if anything
   moved, then PUTs and reads back. It answers `applied` with `before` and
   `after`, the versions either side. **Save that answer**: it is the rollback
   record. Any other outcome says what it found instead
   (`refused_live_changed`, `applied_with_deploy_errors`, `stored_differs`).
5. Refresh the money gate's fixture (`npx tsx scripts/export-money-fixture-shapes.ts`)
   and require no difference from the PUT definition; then the fixture pull
   request acknowledges each changed node and field in
   `money-gate/expected-changes.json`, never `*`, and deletes each entry after
   the deploy that ships it.

To roll back, save the apply's answer as a file and print
`npx tsx scripts/main-flow-port-tab.ts rollback <file> <worker url>`, then run it
in the tab. It re-PUTs the version read before the change under the same check,
and refuses when the canvas has been saved since the port, because re-PUTting
then would discard that save too. Rehearse one rollback before the first canary.

## The canary's daily read-back (#2173)

From version 172 (2026-10-16), `invalid_state_sf_post` is the one native outcome
write. Every morning at 9 AM ET (the `0 13 * * *` daily batch, so 8 AM ET once
clocks go back) the worker reads back from Salesforce every Main Flow run of the
24 hours ending ten minutes before the run (12:50 UTC) whose invalid state step ran as a Salesforce step, and
posts one message to Main Flow's organization's alerts channel
([`apps/worker/src/lib/invalid-state-canary-watch.ts`](../apps/worker/src/lib/invalid-state-canary-watch.ts)).

A run landed when its Submission holds this run's write stamp, holds this run's
Bidspoke link in `PDFlow_4__c`, holds every other key the body sent with the
value sent (`PDFlow_1__c` among them), and its Lead's `EngineUUID__c` and
`EngineLeadUUID__c` equal the Submission's `Engine_UUID_SO__c` and
`Engine_Lead_UUID_SO__c`. A read Salesforce did not answer is "could not be
checked", never landed. Runs the step skipped are counted and said. The message
gives the count, how many landed, each run that did not with what was wrong (by
run, never a value), and the relay's figure over the same hours, which is what
Pipedream accepted, not what reached Salesforce. A day with a run that did not
land or could not be checked is titled as an alert. It has its own heartbeat
entry (`invalid-state-canary-watch`), so a missed morning pages, and its own
`job_runs` row with every run that did not land.

Two parts of #2173's acceptance are not in it and are read by hand: that fields
the body did not send are unchanged (which needs a snapshot from before the
write), and Regal's Lead fields.

**Removing it.** It ends with the canary, and the phase 6 pull request (#2175)
removes it, since once the other seven posts move there is no relay to compare
against. Delete `apps/worker/src/lib/invalid-state-canary-watch.ts` and its test
in `apps/worker/src/lib/__tests__/`, the `invalid-state-canary-watch` entry in
`CRON_JOBS` (`apps/worker/src/lib/cron-heartbeat.ts`), the block that runs it in
the `0 13 * * *` batch of `apps/worker/src/index.ts`, and this section. The
heartbeat's KV keys expire on their own and need nothing.

## Tests

In `apps/worker/src/lib/main-flow-port/__tests__/`:

- `transform.test.ts`: what the transform builds from the production fixture,
  each stage, idempotence, and every refusal.
- `ported-definition.test.ts`: walks the ported graph. Every Submission write
  after the answer on the `trades_present` route is followed by the Apex call;
  the worst case from each answer to its Apex call fits 12 s by the engine's own
  retry rules; every `success_node_namespaces` entry exists; neither relay is
  named; the save route's checks pass.
- `relay-parity.test.ts`: for each post, the native PATCH equals what the relay
  wrote from what the webhook posted, through the engine's real executors, over
  inputs whose key sets and value types were measured from production.
- `ported-walk.test.ts`: the real engine walk over one ported branch when the
  Apex call fails, and when it succeeds.
- `apply.test.ts` and `tab-bundle.test.ts`: the version checks, the read back,
  the rollback, and the built tab script run against a stand in tab.

The money gate answers the native Submission PATCH (`salesforce_submission_update`)
and the Apex call (`salesforce_credit_inquiries`), each with a failing answer,
and its `salesforce_inquiry_post_fails` variant fails the inquiry post both
before the port and after it.
