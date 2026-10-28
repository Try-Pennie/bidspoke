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
the live definition at the moment of the apply, and in the tests on a frozen copy
of version 169, the last version before any stage was applied
(`__tests__/fixtures/main-flow-v169.json`, #2173). That copy is a test input,
not a kept workflow: nobody edits it, and the canvas stays the only place Main
Flow is changed. The tests read the money gate's fixture until the first canary,
when it became part ported.

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
as degraded and alerted. `ported-walk.test.ts` proves this through the real
engine walk over the ported definition's Tripoint win branch: the lead is
answered, the Submission is written, the Apex call is made once and fails, and
Achieve is not reached (and, as its control, is reached when the call succeeds).

For a day (#2833, 2026-10-26) the two steps sat in a parallel block after each
write, so the collections post could run beside them. The collections post now
runs before the answer instead (below), which left that block holding one slot,
so it was taken out (#2832): a one slot block only added a join and 500 ms of
block timeout to every branch. What #2833 changed in the engine stays: every step
in a parallel slot is watched as a step of the walk is, and a slot can be marked
`on_failure: 'continue'` ([parallel.md](./nodes/parallel.md)).

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
`calculate_internal_debt` runs after its answer, has a worst case of 11.45 s;
every other branch 9.5 s. A test walks every branch and fails when one no longer
fits.

**Achieve after the inquiry post ends inside the 12 s** (#2834). Achieve's step
starts after the inquiry post, which is up to 9.5 s after the answer on the six
branches that run it (the 4.5 s write, the 500 ms body step, the 4.5 s call). It
used to wait up to 9 s for Achieve's reply whatever time was left
(`ACHIEVE_FETCH_TIMEOUT_MS`; its step timeouts are 15 to 18 s), so in the worst
case it ended about 18.5 s after the answer and the run was reported as unfinished
work. It now waits only for what is left of the window less 500 ms
(`achieveWait`), so at worst it ends 11.5 s after the answer, and with less than
1.5 s left it sends nothing and records why (`answer_window_spent`). The window
test runs the node itself on every branch from that worst case. Typically the
write takes about 0.1 s, the inquiry post about 2 s (the median of the
`credit-trades` call, the closest one measured) and Achieve 4.7 s (9 in 10 within
5.8 s), so a typical run still waits the full 9 s. Today, on five of the six, the
outcome post still goes to the relay (three attempts of 3.5 to 4.5 s each), so
Achieve can start 12 to 15 s after the answer in the worst case; it now skips
there rather than run past the window. No limit was raised.

## Stages

Each stage is applied over the one before, and applying one twice changes
nothing. A post already ported is recognised and left alone. The table is in the
order the stages are applied.

| Stage | Plan phase | What it does |
|---|---|---|
| `canary_invalid_state` | 4 | ports `invalid_state_sf_post` |
| `canary_send_salesforce` | 5 | also ports `send_salesforce` |
| `collections` | #2832 | adds the collections post to `parallel_1`, before the answer (applied on 2026-10-28 as version 177) |
| `outcome_posts` | 6 | ports the other seven (gated on #2163 and #2023, D6) |
| `inquiry` | 7 | moves the inquiry post after the answer (gated on #2172) |

**The collections stage is independent of the rest of #1680.** It was applied on
2026-10-28 over live Main Flow (version 176, which holds `canary_send_salesforce`),
as version 177: it ports the same two posts that stage did, so over the live
definition it ported nothing and added the collections body and Apex call alone. `outcome_posts` and `inquiry`,
applied after it, keep its slot exactly as it is, and when `inquiry` takes the
inquiry relay out of `parallel_1` the collections slot stays there. Applied
before it, they never add the slot. It may equally be applied after either of
them, and builds the same definition. The transform's `collections` option says
"the slot is there afterwards": only the `collections` stage sets it; every other
stage keeps a slot it finds (or refuses one that is not exactly the port's) and
never adds one (the header of `transform.ts`).

## The collections post (#2832)

Equifax's `collections` array (collection agency placements, industry YC) goes to
`POST /services/apexrest/credit-collections` (`CollectionParserRest`, Geoff's
spec, being built by another team) before the answer, as a third slot of
`parallel_1`, the block on `equifax_debt`'s `trades_present` route that already
runs the trades chain (`trades_body`, `trades_request`,
`pennie_debt_calculation`, slot `child-0`) and, until the `inquiry` stage, the
inquiry relay (`child-1`). Dan decided this on 2026-10-27, because Geoff wants
the data soon and the post after the answer would have waited for the rest of
#1680 (#2174's readout on 3 November, then `outcome_posts`, #2834 and `inquiry`).
The slot is `child-2`, labelled `collections`:

- `collections_body`, a code node building `{ submissionId, collectionsJSON }`,
  spelt as Geoff's example (`EXAMPLE-post-credit-collections.json`) spells it,
  `collectionsJSON` the JSON text of `{ collections: [...] }`. Every item goes
  whole, `accountNumber` included, with only null valued keys dropped, exactly as
  `trades_body` builds the trades (Dan, 2026-10-27: send everything until Geoff
  answers the open question on #2832). When the report has no `collections` key,
  or it is null, an empty list is sent: Equifax leaves the key out of a file with
  no collection items (Geoff). A `collections` value that is not a list, or an
  item that is not an object, fails the step by name. It returns null, which
  skips the call, only when the lead has no `Submission__c`.
- `collections_apex`, the Apex call, one attempt of 4.5 s (`retries: 0`),
  skipped only for that null body. A repeat call is harmless (each call replaces
  the Lead's collection rows, and Geoff accepts the extra file a repeat attaches,
  as with trades), so the engine does not treat it as never resent and it has no
  read-back. It gets one attempt because a retry would only lengthen the wait for
  the answer on a slow call.

**It posts for every lead on the `trades_present` route**, since a file with no
collections still sends an empty list: about as many calls as `trades_request`
makes (9,771 attempts in the 3 days to 2026-10-15, about 3,250 a day), about 2%
of the 142,000 to 191,000 Salesforce steps a day.

**It has its own small share of the Salesforce bulkhead (#2847)**, so on a
Salesforce slowdown day it cannot take a slot the trades call beside it needs.
The main `salesforce` key (cap 20, wait 15 s) filled at least once in the week to
2026-10-27, during a slowdown (a shed at 20 of 20 after 15,042 ms in Workers Logs,
read on #2847; the counts there are the query engine's estimates), as it reached
20 of 20 on 2026-10-11 without shedding. The collections call takes a slot of
`salesforce-collections` first and a main slot second, as a post-answer call takes
its own share (#2170, ADR 0005), so it never holds a main slot while waiting on
its share. The trades call and every other call before the answer take the main
key alone, as before; a call after the answer, a collections post included, takes
the post-answer share. The engine recognises the call by the endpoint it posts to
(`isCreditCollectionsPost` in `engine/inquiry-post.ts`, beside the inquiry post's
own test), never by the step's name. Both numbers live in `lib/bulkhead-client.ts`
with their reasoning:

- **Cap 3** (`SALESFORCE_COLLECTIONS_BULKHEAD_LIMIT`). Even with the whole day's
  calls packed into 8 hours and every one running its full 4.5 s, about 0.5 are
  in flight on average (about 0.23 at the trades call's 2 s median), so a fourth
  at once is rare and an ordinary day sheds almost nothing, where a cap of 2 would
  make about 2% of calls wait. Three is at most 15% of the main cap; with the
  post-answer share (6) full too, 11 of the 20 stay out of both shares' reach.
  These are estimates: the endpoint has never been called. Like the post-answer
  share it is held below the main cap (a main cap of 4 gives a share of 3, of 2 a
  share of 1) and is never 0 (a main cap of 1 gives a share of 1).
- **Wait 400 ms** (`SALESFORCE_COLLECTIONS_BULKHEAD_WAIT_MS`, or the main wait if
  that is set lower). The wait is inside the call's one 4.5 s attempt, so a call
  granted at the end of it still has 4.1 s, above the trades call's p99 of
  4,001 ms, and never takes a main slot only to be cut off. A shed ends at about
  0.4 s, and the slot still ends within its 5 s, so the answer's worst case does
  not grow. On a full main bulkhead the trades call waits up to 15 s and the
  collections call gives up after 0.4 s: the money path sheds collections first.

A shed collections call fails its step like any shed (`Salesforce bulkhead: at
capacity (salesforce-collections, ...)`, logged as `salesforce_bulkhead_shed
key=salesforce-collections`), and the slot's mark below turns it into the run's
degraded alert, never a failed run or a lost lead.

**Its slot is marked `on_failure: 'continue'`.** A failed or timed out
collections call never fails `parallel_1`, so it never costs the lead its answer:
the walk goes on past the block as it does today. The failure is not silent. The
step's row says it failed, and once the walk is done the engine raises it as the
run's failure, as it does a failed write after the answer: the run is recorded as
degraded, the `sf_writeback` dead letter counts it, and the failed write capture
names it as an Apex call that cannot be replayed. A failed trades chain still
fails the block and the run before any answer, as today. Proved by
`ported-walk.test.ts` (the real walk over live Main Flow with the stage applied:
success, failure, timeout, a failed trades chain) and by the engine's own test of
a marked slot before the answer (`post-response-budget-engine.test.ts`), which
proves the run is degraded and dead lettered.

**Timing.** `parallel_1` waits for all its slots, at most its 20 s timeout. In the
worst case its trades chain alone already runs past that (its step settings allow
54.5 s, three attempts of `trades_request`'s 16.5 s among them), so the block's
worst case is its 20 s timeout with the collections slot or without it: the slot
adds nothing there. The slot itself ends within 5 s (500 ms body, 4.5 s call), on
its own deadline, before the block stops waiting. `ported-definition.test.ts`
computes all of this from the step settings and the engine's retry rules. The
typical case is not free, and is not measured: the block now waits for the slower
of the trades call (median about 2 s) and the collections call, which is built
like it but has never been called (if it is about as fast, the two side by side
take a little longer than either alone, not their sum). A collections call
slower than the trades chain holds the answer for the difference, up to the 5 s
the slot can take. The block already waits for the inquiry relay beside the
trades chain until the `inquiry` stage.

**Turning it on**, once `CollectionParserRest` is live in the PRODUCTION Pennie
org (not a sandbox). Done on 2026-10-28 (version 177, #2832); the steps stay as
the record of how:

1. Check it on a test lead first: a production test lead on the `trades_present`
   route (the Skyfall test lead procedure), with the endpoint called by hand with
   that lead's body as `collections_body` would build it, and the Lead's
   collection rows read back in Salesforce.
2. Apply the `collections` stage with the runbook below (steps 1 to 5). The
   preview over live Main Flow must answer that it ports nothing, adds
   `collections_body` and `collections_apex` and removes nothing, and leaves the
   inquiry where it is. Save the apply's answer as the rollback record.
3. In the fixture refresh pull request, add `collections` to `APPLIED_STAGES` in
   `gate-fixture.test.ts`. The money gate answers the call as
   `salesforce_credit_collections`; add a failure variant for it to the gate's
   fixtures in the same refresh.
4. Watch the first day's runs: a failed collections call shows as a degraded run
   and in the `sf_writeback` dead letter count, never as a lost lead. Count the
   `salesforce_bulkhead_shed key=salesforce-collections` lines per day: more than
   a handful on an ordinary day means the cap of 3 is too small for the real
   call times, which the estimate above could not measure.

Rolling it back is the runbook's rollback with that saved answer.

## When the transform refuses

It refuses, naming every problem at once, whenever a part it rewrites is not the
shape it was written against: a post missing or changed (another URL, a setting
it does not carry over, a body with no `submissionId`), a tenth post to either
relay, `parallel_1` or the inquiry relay changed, a step that reads what a relay
post answered or `parallel_1`'s output while a stage changes its slots, a
namespace it adds already taken. A slot of `parallel_1` is recognised only if it
is the trades chain, the inquiry relay, or exactly the collections slot: `child-2`
marked `on_failure: 'continue'`, `collections_body` then `collections_apex` (a
POST to credit-collections of what the body built) into `parallel_end_1`. Every
stage refuses a collections slot changed on the canvas (its mark removed, a step
added inside it, its call pointed elsewhere), so no later stage carries a changed
one forward; a canvas change to its timeouts or script is kept. Nothing is sent. Read the
reasons, look at the canvas edit behind them, and change the transform in a pull
request if the edit should stand.

## Previewing, applying and rolling back

Only a member of the production organization can save Main Flow, so this runs in
Dan's logged in Bidspoke tab, as the Liberty1 workflow was created. Each stage is
applied by its own phase issue. The stages live now are the ones `APPLIED_STAGES`
names in `gate-fixture.test.ts`: `collections`, applied on 2026-10-28 as version
177 (#2832), over version 176 (a canvas save of 2026-10-27 raising
`send_salesforce`'s timeout from 4,500 to 5,250 ms) and `canary_send_salesforce`,
applied on 2026-10-26 as version 175 (#2174), over `canary_invalid_state`, applied
on 2026-10-16 as version 172 (#2173) after an earlier apply (version 170) and its
rollback (version 171).

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
   moved, then PUTs and reads back. The PUT names what the save route requires
   of every definition save since #2599: `expected_version`, the workflow row's
   `version` from that re-read (not the snapshot's version number), and a fresh
   `save_id` UUID. A save landing after the re-read makes the route answer 409
   `stale_version`, which the apply reports as `refused_live_changed` with nothing
   written. A PUT naming neither is refused 428 `reload_required`, which is what
   the script sent before #2174. It answers `applied` with `before` and
   `after`, the versions either side. **Save that answer**: it is the rollback
   record. Any other outcome says what it found instead
   (`refused_live_changed`, `applied_with_deploy_errors`, `stored_differs`).
5. Refresh the money gate's fixtures (`npx tsx scripts/export-money-fixture-shapes.ts`
   from `apps/worker`) and require the refreshed Main Flow to be exactly the
   version the apply answered as `after`. Add the stage just applied to the end
   of `APPLIED_STAGES` in `src/lib/main-flow-port/__tests__/gate-fixture.test.ts`,
   in the same pull request. That test requires running each applied stage's
   transform over the gate's Main Flow to change nothing, with exactly the
   applied stages' posts native, and the inquiry and the collections slot where
   they left them. It lists every stage, not only the last, because the
   `collections` stage may come before or after `outcome_posts` and `inquiry`
   (#2832). A canvas save elsewhere in Main Flow passes (since
   2026-10-21, when version 173's edits made the old "equals the transform of
   version 169" check fail on an ordinary save). If it fails, a canvas save
   undid part of the port, and that save is looked at before anything here
   changes.

   The refresh pull request needs no `money-gate/expected-changes.json` entry.
   The gate replays the head's fixtures through both engines, the merge base's
   and the head's, so a definition that changed only in the fixtures is replayed
   identically on both sides and shows no difference. An entry would match
   nothing and fail the gate. (Measured on the #2173 canary refresh.) What the
   port changes in what Main Flow sends is proven by the port's own tests listed
   below, not by the gate's base and head comparison; from the refresh on, the
   gate replays the ported definition, so later engine changes are compared over it.

To roll back, save the apply's answer as a file and print
`npx tsx scripts/main-flow-port-tab.ts rollback <file> <worker url>`, then run it
in the tab. It re-PUTs the version read before the change under the same check,
naming the row version of its own re-read and a fresh `save_id`,
and refuses when the canvas has been saved since the port, because re-PUTting
then would discard that save too. Rehearse one rollback before the first canary.

## The canary's daily read-back (#2173)

From version 172 (2026-10-16), `invalid_state_sf_post` was the one native outcome
write, until version 175 (2026-10-26) made `send_salesforce` native as well
(below). Every morning at 9 AM ET (the `0 13 * * *` daily batch, so 8 AM ET once
clocks go back) the worker reads back from Salesforce every Main Flow run of the
24 hours ending at 12:50 UTC, ten minutes before the batch, whose invalid state step ran as a Salesforce step, and
posts one message to Main Flow's organization's alerts channel
([`apps/worker/src/lib/invalid-state-canary-watch.ts`](../apps/worker/src/lib/invalid-state-canary-watch.ts)).

A run landed when its Submission holds this run's write stamp, holds this run's
Bidspoke link in `PDFlow_1__c`, holds every other key the body sent with the
value sent (`PDFlow_4__c` among them), and its Lead's `EngineUUID__c` and
`EngineLeadUUID__c` equal the Submission's `Engine_UUID_SO__c` and
`Engine_Lead_UUID_SO__c`. A read Salesforce did not answer is "could not be
checked", never landed. A post that landed and was moved on since counts as
landed fully and is said apart (#2396), on the direct and the relay side alike:
"superseded by a later write" when its only differing fields are
`External_Exchange_Status__c` (still set) and `External_Timestamp__c` (moved
forward) on a Submission last modified after the post began, as the sale's own
completion left 11 of 100 sampled relay posts on 2026-10-18; "followed a newer Submission" when its Lead's
`Submission_Object_ID__c` names a Submission created after this one whose Engine
ids the Lead carries, the returning customer rule the lead status check uses.
Runs the step skipped are counted and said. The message
gives the count, how many landed, each run that did not with what was wrong (by
run, never a value), and the relay's figure over the same hours.

**The run link is `PDFlow_1__c`** (#2313). Every outcome post's body sends it as
the run's Bidspoke link, on the relay and the direct write alike, and #2173 names
it. `PDFlow_4__c` is the link the port adds (decision D4), but the inquiry relay,
still on Pipedream, writes the same field with a Pipedream link on every run:
on 2026-10-17 all six relay era invalid state Submissions held a pipedream.com
link there, and the four direct ones held the Bidspoke link only because the
direct write came after the inquiry relay's. So it cannot be read on the relay
side at all, and on the direct side it is one more key sent. Every field name
the check reads was confirmed against the live org that day with a read only
describe and Tooling `FieldDefinition` (the list is in the file's header).

**The inquiry relay sometimes writes `PDFlow_4__c` last** (2026-10-27). The
first `send_salesforce` report said 11 of 200 sampled direct writes did not
arrive complete. All 11 had: each Submission held the run's stamp, its run link
and every other field sent, and only `PDFlow_4__c` held a pipedream.com
inspector link. Pipedream answers the inquiry post in about 0.1 s and PATCHes
afterwards, and the `send_salesforce` direct write comes only 2 to 5 s after
that post, so Pipedream's PATCH arrives last about 1 time in 20. So a
pipedream.com link there, on a Submission modified after the write began, with
everything else matching, counts as arrived complete and moved on since, said
in its own sentence and counted as `inquiry_link_replaced` in the job run
record. Any other value there still reads as did not arrive complete. Those
leads keep the Bidspoke link in `PDFlow_1__c`; only the second link is
Pipedream's, as it was for every lead before the port. This ends when the
inquiry moves too (#2175).

**The relay's figure is what Salesforce saved** (#2313), not what Pipedream
answered. Each morning a sample of 100 of the day's relay posts of the outcome
steps no canary watches (seven since #2174 added `send_salesforce` as the second
subject; about 2,000 a day), spread evenly over it, is read back the same
way: the relay's own PATCH (the body with `executionId` and `submissionId`
dropped and `UUID` and `leadUUID` renamed) against the Submission, with the
link in `PDFlow_1__c`, and the Lead's Engine ids when the post sent them. A relay
post has no write stamp, so a Submission holding the link of a Main Flow run
whose write was sent later (#2806, below) was overwritten since and is left out,
one whose order against this post cannot be told is left out as order unknown,
and a post with no Submission, which the
relay's filter stops, is said apart. The relay reads share the direct reads'
circuit and stop after five minutes. A day with a run that did not
land or could not be checked is titled as an alert, and so is a day Main Flow
spent off the direct write: an invalid state post that went through the relay
after a direct one, or a day whose last post did (#2312). Relay posts from
before the first direct post are said as coming before the switch and alert on
nothing, as on the first report (2026-10-17), whose window began ten hours
before version 172. It has its own heartbeat
entry (`invalid-state-canary-watch`), so a missed morning pages, and its own
`job_runs` row with every run that did not land.

Two parts of #2173's acceptance are not in it and are read by hand: that fields
the body did not send are unchanged (which needs a snapshot from before the
write), and Regal's Lead fields.

**The window ends at 12:50 UTC whatever time the run starts** (#2806, its first
half): on 2026-10-22 the run started 31 minutes late and a window measured back
from its start left 8:52 to 9:23 AM ET unread.

**Two runs on one Submission are ordered by when each write was sent** (#2806,
its second half), not by when each run started: Salesforce keeps whichever write
arrived last, and on 2026-10-23 run 01a1689d-3f57 started 1.6 s before
01a1689d-45b2 but sent its post 3.4 s after it. A write reached Salesforce
between its posting step's start and end (`started_at`, `completed_at`), and one
write is later than another only when it was sent after the other was answered.
A run whose step rows are gone is bounded by its own start instead (it sends
nothing before it starts, and nothing more than ten minutes after; the longest
measured was 53.5 s). A pair those cannot order (overlapping sends, or a missing
send time the runs' starts do not settle) is "order unknown": never landed and
never lost, named in the message with its reason and counted in the `job_runs`
summary (`order_unknown`, `order_unknown_runs`, on both the direct writes and the
relay sample), and three or more in a day (and a tenth of the day's writes) page.
A relay post's span ends at Pipedream's answer; how long the relay then takes to
PATCH is not measured.

## The second canary: send_salesforce (#2174, phase 5)

`send_salesforce` is the busiest outcome post (about 1,271 a day) and a JSON
text body, the path the first canary could not exercise. The port, the stage
(`canary_send_salesforce`) and the engine options it needs were built in phases
1 and 2. Until the apply, `send-salesforce-canary.test.ts` ran the stage over
the money gate's Main Flow (the live version, 174 on 2026-10-26), so a canvas
edit that would make the apply refuse, or port more than this one post, failed
there first. Since the apply (version 175, 2026-10-26) it requires the gate's
Main Flow to hold the port, and holds "this one post and nothing else" on the
frozen version 169 with the first canary applied. It also walks the ported write
through the real engine for every Salesforce answer and requires each failure to
end the same way as the invalid state write the first canary passed on.
`save-route-contract.test.ts` now holds the save route contract on the next
stage still to apply, `outcome_posts`, and requires both canaries to answer
`nothing_to_do` over the live definition.

**Switching it on** (after the pull request that adds the watch is merged,
deployed, and the live commit confirmed): the runbook above, steps 2 to 5, with
the stage `canary_send_salesforce`. Preview first; it must answer that it ports
`send_salesforce` alone, adds and removes nothing, and leaves the inquiry where
it is. Save the apply's answer as the rollback record. Then refresh the money
gate fixtures and record `canary_send_salesforce` as applied in
`gate-fixture.test.ts` in the same pull request. Nothing needs turning on in the worker: the watch reads the live
definition every morning and starts reporting the first day Main Flow holds the
port.

**Rolling it back**: the rollback above, with the saved answer of this apply. It
restores the version before it, which still has `invalid_state_sf_post` native,
so the first canary is untouched.

**Its daily read-back** is the same check as the first canary's, run as its own
job (`send-salesforce-canary-watch`, its own heartbeat, `job_runs` row and
message, titled "Direct Send Salesforce writes"), by the same rule: write stamp,
`PDFlow_1__c`, every key sent, overwritten by a later run set aside (#2485),
landed then moved on said apart (#2396). Three things differ:

- It reads a sample of 200 of the day's direct writes, spread evenly over it,
  not every one: one Salesforce read took about half a second in the first
  canary's runs (230 reads in 57 to 229 s), so 1,271 would outrun the morning.
  The direct reads stop after five minutes and the rest are said as not checked.
  The message says how many were written and how many were checked.
- Its body sends no Engine ids, so no Lead is read and none is claimed.
- Until it is first switched on it records the day as `not_switched_on` and
  posts nothing: that is a day on which Main Flow does not hold its port, none
  of its posts went direct, and this check has never posted a day. Any one of
  the three makes it report. So a direct write in the window reports even when
  the live definition no longer holds the port, because a canvas save that undid
  it is a rollback (#2312), and once it has posted a day it never goes quiet
  again: a rollback is said every morning, as the first canary's always was.

The relay comparison is the same 100 relay posts of the seven unwatched outcome
posts, so the two messages compare against one figure.

**The low volume posts** (`send_fallback_salesforce_1` ran 0 times in the 7
days before the plan; `send_fallback_salesforce` is also rare) are not proved by
waiting for traffic. After phase 6 ports them, each is proved by a deliberate run:
a production test lead (the Skyfall test lead procedure), posted to Main Flow
shaped to take that post's branch (`debt_screening`'s `else` route for
`send_fallback_salesforce_1`, its `no_debt_but_adv` route for
`send_fallback_salesforce`), then its Submission read back by the same rule as
the daily check, with the run named in the phase 6 issue.

**Removing them.** Both end with the canaries, and the phase 6 pull request
(#2175) removes them, since once the other seven posts move there is no relay to
compare against. Delete `apps/worker/src/lib/invalid-state-canary-watch.ts` and
its tests in `apps/worker/src/lib/__tests__/` (`invalid-state-canary-watch*.test.ts`,
`send-salesforce-canary-watch.test.ts` and `canary-watch-send-order.test.ts`,
with the fixture `fixtures/invalid-state-repeat-visit-2026-10-18.ts`), the `invalid-state-canary-watch` and
`send-salesforce-canary-watch` entries in `CRON_JOBS`
(`apps/worker/src/lib/cron-heartbeat.ts`), the two blocks that run them in the
`0 13 * * *` batch of `apps/worker/src/index.ts`, and these sections. The
heartbeat's KV keys expire on their own and need nothing.

## Tests

In `apps/worker/src/lib/main-flow-port/__tests__/`:

- `transform.test.ts`: what the transform builds from the version 169 copy and
  from live Main Flow, each stage, idempotence, the collections stage applied
  before or after `outcome_posts` and `inquiry` to the same result, and every
  refusal.
- `gate-fixture.test.ts`: the money gate's Main Flow fixture is unchanged by
  the transform of every stage in `APPLIED_STAGES`, with exactly those stages'
  posts native and the inquiry and collections slot where they left them, and an
  unported definition fails the same check.
- `ported-definition.test.ts`: walks the ported graph. Every Submission write
  after the answer on the `trades_present` route is followed by the inquiry body
  and Apex call; the worst case from each answer through the call fits 12 s by
  the engine's own retry rules, and so does the Achieve step after it on the six
  branches that run one, measured by running the node itself from that worst
  case against a reply that never comes (#2834); the collections call is the one Apex call before
  the answer, in `parallel_1`, whose worst case it leaves at the block's 20 s
  timeout, ending within 5 s itself; the collections body's shape, its empty list
  for a missing key, and its refusals; every `success_node_namespaces` entry
  exists; neither relay is named; the save route's definition rules pass (no
  loop, no malformed Salesforce write option). The route itself is driven by
  `save-route-contract.test.ts`.
- `relay-parity.test.ts`: for each post, the native PATCH equals what the relay
  wrote from what the webhook posted, through the engine's real executors, over
  inputs whose key sets and value types were measured from production.
- `ported-walk.test.ts`: the real engine walk over one ported branch when the
  inquiry call fails (the walk ends before Achieve) and when it succeeds; and over
  live Main Flow's `parallel_1` with the collections stage applied, when the
  collections call succeeds, fails and times out (the lead is answered each time,
  the other slots run as today, a failure is left for finalize to raise), and
  when the trades call fails (the run fails before any answer, as today); and when
  the collections call is shed by a full `salesforce-collections` share (#2847:
  never sent, the trades call still gets its main slot, the lead answered).
- `engine/nodes/__tests__/salesforce-collections-bulkhead.test.ts` and
  `lib/__tests__/bulkhead-client.test.ts` (#2847): the collections call takes its
  share then a main slot and waits 400 ms, the trades call the main key alone and
  15 s, a full share sheds only the collections call, and the share's limits at
  main caps of 1 to 4; `post-response-budget-engine.test.ts` walks a shed
  collections call to a degraded, dead lettered run with the lead answered.
- `send-salesforce-canary.test.ts`: the phase 5 stage over the live Main Flow,
  and the ported `send_salesforce` walked by the real engine through every
  Salesforce answer, each failure ending as the invalid state write's does.
- `apply.test.ts` and `tab-bundle.test.ts`: the version checks, the read back,
  the rollback, and the built tab script run in a stand in tab whose fetch
  reaches the worker's real workflow routes.
- `save-route-contract.test.ts`: the apply and the rollback sent through the real
  `PUT /api/workflows/:id` (jwt auth and every check it makes of a live
  workflow), over a stand in database whose `write_workflow` refuses a stale
  version as the function does; each stage still to apply is accepted, and a
  save landing between the re-read and the PUT is `refused_live_changed`.

The money gate answers the native Submission PATCH (`salesforce_submission_update`)
and the Apex calls (`salesforce_credit_inquiries`, `salesforce_credit_collections`), each with a failing answer,
and its `salesforce_inquiry_post_fails` variant fails the inquiry post both
before the port and after it. Its `salesforce_collections_post_fails` variant
(#2832) fails the collections call alone, on a Tripoint win: the lead is still
answered and the walk goes on past `parallel_1`.
