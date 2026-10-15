# Post-answer Salesforce write contract

Phase A of the Salesforce writeback recovery epic (#2015, #2021). This is the
contract of every Salesforce write the live workflows make after the HTTP
response is sent to the client. #1680 (port the Main Flow relay posts to native
Salesforce steps) and #2023 (the read-back and resend) build from it.

It is a read-only record. The first pass (2026-10-14) was derived from the repo:
the live workflow definitions, the node executors, and the committed reference
artifacts. Where the contract depended on something the repo cannot show (the
Pipedream relays' own config, Salesforce field-level security and sharing, the
Salesforce automations each write fires, which Main Flow records run, and the
daily volume), it was listed as an open question rather than guessed.

All six open questions were answered on 2026-10-15, read only, from the
Pipedream UI (question 1), the production database, and the Salesforce org
(questions 2 to 6), with two residual items that could not be measured and stay
open for #1680: whether Pipedream omits an absent body key or sends it as null
(question 1), and the body of the managed `regal_voice.LeadTrigger`, which
Salesforce hides (question 5). Each answer sits in the section it belongs to and carries
the query or source it came from; the consolidated list at the end points to
them. Nothing was written to Salesforce, Supabase, Pipedream or Cloudflare.

## What the answers change in the #1680 plan

Read this before building #1680 or #2023. Each item is measured on 2026-10-15
and detailed in its section below.

1. **There is one Main Flow to port, not two.** `Main Flow (v2)`
   (`0630d714-5917-4221-9bcc-ca1fb2d9eba2`) is active and not deleted, but it
   has never run: zero runs, test or live, in the daily stats table since it was
   created on 2026-07-29, no custom endpoint and no source assignment. It is
   still reachable through the generic webhook route with any valid key, so
   whether to deactivate it (and drop "v1 and v2" from #1680's scope) is a
   decision for Dan, not a port. See question 2.
2. **`send_salesforce_inquiry` is not a post-answer write.** It runs inside a
   parallel node that waits for all its children before the walk reaches any
   response, and a failed child fails the run. 0 of 22,078 completed inquiry
   posts in 7 days finished after the response; the 2 that failed ended their
   leads with HTTP 500 and no answer. So #2023's read-back does not cover it,
   and porting it (#1680) puts two Salesforce calls (a Submission PATCH and the
   `/services/apexrest/credit-inquiries` Apex REST call) on the pre-answer path
   inside that parallel's 20 s window, where a failure costs the lead. The
   native node treats `apex` as not safe to repeat, and the Apex endpoint
   attaches a new file to the Lead on every call that carries inquiries, so its
   retry needs deciding on purpose. See question 3.
3. **The Update Submission relay sends exactly 28 named fields and drops
   everything else**, `executionId` included. Every one of the nine Main Flow
   posts to this relay sends `executionId`; nothing else in their bodies falls
   outside the 28 (checked against the live definition). The inquiry post goes
   to the other relay and carries no `executionId`. A native PATCH must leave `executionId` out:
   it is not a Salesforce field name. See question 1.
4. **The Inquiries relay makes two Salesforce calls per post with no filter**:
   a Submission PATCH of `PDFlow_4__c` and `VantageScore__c`, then the Apex REST
   POST. `VantageScore__c` is therefore written twice per lead on the trades
   present path, by the inquiry
   relay before the answer and by the outcome relay after it, from different
   sources. `PDFlow_4__c` is a link to a Pipedream workflow, not to Bidspoke.
   See question 1.
5. **No access work is needed for the integration user.** The Bidspoke
   integration user (`Bidspoke Integration`, `bidspoke@trypennie.com`) holds
   the same System Administrator profile as the relays' writing user (Brian
   Nelms), with Modify All Data, and has edit on all 70 fields the post-answer
   writes touch. See question 4.
6. **No readable Salesforce automation keys on the writing user.** No Apex trigger,
   trigger handler, record-triggered flow or validation rule on Submission,
   Lead, Prospect, Applicant or Inquiry reads the running or last modifying
   user. One managed package trigger (`regal_voice.LeadTrigger`) hides its
   body and could not be read. See question 5.
7. **A relay 2xx probably proves nothing about Salesforce today.** Both relays
   use Pipedream's default HTTP response, and the inquiry post's median
   duration is 63 ms for a relay that makes two Salesforce calls. Read
   together, the relay acknowledges on receipt, before its Salesforce steps
   run. This is an inference, not a measurement of Pipedream. If it holds, the
   relay steps' configured timeouts (`timeout_ms` 2,250 to 122,750 in the
   live Main Flow definition read on 2026-10-15, `send_salesforce` the
   largest, plus the 15,000 ms default on `send_fallback_salesforce_1`; #1680
   quotes 950 to 122,750) and their measured durations describe
   Pipedream's intake, not a Salesforce write, so neither is a guide for the
   native step timeouts. See question 3.
8. **Volume is about 54,300 post-answer writes a day, not about 100,000**
   (57,400 counting the pre-answer inquiry post). The Main Flow relay outcome
   posts are about 3,290 of them. Porting them plus the inquiry
   relay adds about 9,500 calls a day to the Bidspoke user, about 0.6% of the
   org's 1,680,000 daily API allocation, and that allocation is org wide, so
   Pipedream's calls already count against it today. See question 6.
9. **Resend safety (#2023).** An identical second write that lands on an
   unchanged record re-fires nothing that keys on a change (Submission
   completion, the Lead sync's completion branch, Cometly event 30, the six
   Lead flows keyed on `PD_Completed_Timestamp__c`). A resend over a record
   another writer has since moved would regress it: for example
   `External_Exchange_Status__c` from Completed back to Pending, after which the
   next Completed flip fires Cometly event 30 a second time. #2023's rule never
   to overwrite a different non-blank value is what prevents that. On Prospect,
   a backward `BidStatus__c` is silently reverted by a flow, so it neither
   errors nor lands. See question 5.

## Provenance

- **Live definitions**: `apps/worker/money-gate/fixtures/definitions/*.json`.
  The money gate README states these are the live definitions from the
  `Try-Pennie/bidspoke-workflows` backup, refused by the gate unless equal to
  production. They are the authoritative shape of what runs today.
  - Main Flow: `60e2e0bc-5aa2-47db-b333-3a8fe1c62e09.json`
  - Engine Bidding Workflow: `da82a183-1a4a-417e-b0b8-5f3fe5e14840.json`
  - Lead Economy Bidding Workflow: `89b1a6af-7e0f-43de-bc66-1e888184551f.json`
  - Liberty1 Click Handler: `8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08.json`
  - RML Bidding (LendSwift): `e1b810da-16c0-49eb-bf12-ba1c9b67c914.json`
  - RML Bidding (GigFi): `6624acd0-bf61-4d21-85fc-4371ca7ed77d.json`
- **Node executors**: `apps/worker/src/engine/nodes/salesforce.ts` (native
  Salesforce node) and `apps/worker/src/engine/nodes/integration.ts` (the
  webhook node the relay posts use).
- **Committed code-node scripts** that build the write bodies:
  `apps/worker/src/engine/scripts/engine-bidding/patch_prospect_body.js`,
  `.../engine-bidding/build_response_body.js`,
  `.../liberty1-click/liberty1_click_patch.js`.
- **Reference parity source**: `docs/reference/main-flow-pipedream.ts`, the
  Main Flow as it ran on Pipedream on 2026-05-14 (a single custom action; the
  live canvas now fans the same outcomes out to separate per-branch posts).
- **Related records**: ADR 0002 (observability vs outcome write tiers),
  ADR 0010 (Engine and Main Flow price Tripoint differently),
  `docs/concepts/lead-outcome-recovery.md`.

### Main Flow v1 and v2 (open question 2, answered 2026-10-15)

#2021 asks for Main Flow v1 and v2. Measured in the production database:

- `workflows` holds two Main Flow records, both `is_active = true`,
  `deleted_at is null`, lane `money`, 88 nodes each, with different
  definitions:
  - `Main Flow`, `60e2e0bc-5aa2-47db-b333-3a8fe1c62e09`: 169 versions, the last
    saved 2026-10-07 16:39 UTC. This is the definition in the backup and the
    money gate fixture, and the one this contract describes.
  - `Main Flow (v2)`, `0630d714-5917-4221-9bcc-ca1fb2d9eba2`: created
    2026-07-29, 2 versions, the last saved 2026-09-17. It carries 10 webhook
    nodes (the same relay post shape).
- **Only `60e2e0bc` runs.** `workflow_executions` (non-test, the whole
  retention window, which held runs from 2026-10-08 00:00 UTC to the query at
  2026-10-15 15:13 UTC) holds 25,155 Main Flow runs,
  every one on `60e2e0bc` version 169; no run used an older version, and none
  had a null `workflow_version_id`. `0630d714` has no execution at all in that
  window, test or live.
- `workflow_stats_daily`, which goes back to 2026-04-06, has **no row for
  `0630d714` ever**, test or live, while `60e2e0bc` has 97,188 live runs since
  2026-09-17 (the positive control that the table counts this workflow family).
- The only custom endpoint (subdomain `mainflow`, path `/webhook`) and the only source
  assignment (`main_flow`) both point at `60e2e0bc`. `0630d714` has neither, but
  being active it would still run if something posted to
  `/webhooks/0630d714-...` with any valid API key.

Queries: `select id, name, is_active, deleted_at ... from workflows where name
ilike '%main%'`; executions grouped by `workflow_id` and the version number
joined from `workflow_versions`, filtered on `started_at` (the partition key);
`workflow_stats_daily` grouped by `workflow_id, is_test`; `webhook_endpoints` and
`source_workflow_assignments` filtered on both ids.

So the "v2" in #2015 and #1680 is a dormant copy. Porting `60e2e0bc` covers every
relay post that has run. Whether `0630d714` is deactivated is Dan's decision.

## Two write mechanisms

Every Salesforce write today is one of two kinds. The port in #1680 turns the
first into the second.

### 1. Pipedream relay post (webhook node)

The Main Flow outcome writes are `webhook` nodes that POST a JSON body to a
Pipedream-hosted HTTP endpoint (a relay), which then writes to Salesforce as a
Pipedream Salesforce connection. The engine side is `executeIntegrationNode`:

- Method POST, `Content-Type: application/json`, plus `X-Trace-Id` set from the
  execution trace id. No auth header is configured on these nodes (the relay URL
  is the capability).
- Default timeout 15000 ms unless the node sets `timeout_ms`.
- On a non-2xx the node throws the `Response` so the engine classifies the HTTP
  error. An HTML error page is treated as transient at any status (#756).
- The engine does **not** see what Salesforce did. The relay answers; the fields
  the relay writes, the user it writes as, and the automations it triggers are
  all invisible to Bidspoke. This is why a slow or failed relay post is an
  unknown outcome, which is the whole reason #2015 exists.

### 2. Native Salesforce node

The sibling workflows (Engine Bidding, Lead Economy, Liberty1, RML) and three
Main Flow steps use the `salesforce` node, `executeSalesforceNode`:

- Auth: client-credentials OAuth as the Bidspoke integration user
  (`SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` /
  `SALESFORCE_INSTANCE_URL`), token cached in KV for 3500 s. A 401 evicts the
  token and retries the same request once with a fresh token.
- Operation maps to REST on `v60.0`: `create` POST to
  `/sobjects/<Object>`, `update` PATCH to `/sobjects/<Object>/<record_id>`,
  `upsert` PATCH on an external id, `query` GET `/query`, `apex` to an
  `/services/apexrest/...` path.
- A successful `update` returns 204 No Content. A PATCH is all or nothing per
  record.
- Retry and double-send: `create` / `update` / `upsert` are treated as safe to
  repeat; `apex` is not (its side effects may already have fired). A Salesforce
  bulkhead caps in-flight calls (ADR 0005) and sheds as a transient (retryable)
  error. `429` and `5xx` and configured `transient_errors` retry; other 4xx are
  permanent. A field-level `INVALID_EMAIL_ADDRESS` blanks the named field and
  retries once (#723).
- Idempotency: there is no idempotency key. A retried `update` resends the same
  PATCH, which is why #2023's resend relies on `update` being all-or-nothing and
  on a per-write landed marker rather than resending blindly.

## The two Pipedream relays

Two relay endpoints receive Main Flow posts. The repo shows the request Bidspoke
sends; the relay's own filter, method, Salesforce connection and field mapping
were read off the Pipedream UI on 2026-10-15 (open question 1, below). The relay
URLs are deliberately NOT written here: they carry no auth header, so the URL
itself is a bearer capability that can write to production Salesforce, and this
doc is committed. The full URLs live in the live workflow definitions and the
backup.

| Relay | Endpoint | Used by | Writes to |
|---|---|---|---|
| Submission update | id redacted (bearer URL) | the 9 Main Flow outcome posts | one `Submission__c` PATCH of 28 named fields (question 1) |
| Inquiries update | id redacted (bearer URL) | `send_salesforce_inquiry` | a `Submission__c` PATCH of `PDFlow_4__c` and `VantageScore__c`, then the `/credit-inquiries` Apex REST POST that replaces the Lead's `Inquiry__c` rows (question 1) |

### The relays' internal config (open question 1, answered 2026-10-15)

Read off the Pipedream UI on 2026-10-15, read only (no edits, test runs or
deploys), with the 2026-09-30 Pipedream project export as a cross check. The
export blanks every step prop as redacted, so the filter and mapping exist only
in the UI.

**Salesforce: Update Submission** (the Submission relay)

- Settings: auto retry on, error notifications on. Trigger: HTTP, ergonomic
  event shape, **default response** (no custom response step), automated
  requests discarded. The build view had no undeployed draft.
- Step 1, filter: "End if condition is met" when `body.submissionId` does not
  exist. That is the whole filter: any request carrying a `submissionId`
  continues. A post whose body is `null` (the Engine failure paths return
  `sfBody: null`) carries no `submissionId`, so the relay stops there and
  writes nothing; a native port reproduces that by skipping the write.
- Step 2, one HTTP request: `PATCH
  /services/data/v60.0/sobjects/Submission__c/Id/{submissionId}` on the
  production instance, authenticated as Pipedream's connected Salesforce
  account (no token is written into the workflow). Salesforce's success answer
  is `{id, success: true, errors: [], created: false}`.
- Body: **28 keys, and only these.** Two are renamed:
  `Engine_Lead_UUID_SO__c` from `body.leadUUID` and `Engine_UUID_SO__c` from
  `body.UUID`. The other 26 pass straight through from the same named body key:
  `ADV_SO__c`, `XBC_SO__c`, `Monthly_Creditor_Payment_ES__c`,
  `Unsecured_Debt_Verified_ES__c`, `Credit_Pull_Result_ES__c`, `PDFlow_1__c`,
  `PDFlow_2__c`, `External_Exchange_Status__c`, `External_Partner_Name__c`,
  `External_Routing_Code__c`, `External_Timestamp__c`, `EQXCreditPullStatus__c`,
  `InternalDebtRouting__c`, `LeadSaleType__c`, `PD_Completed_Timestamp__c`,
  `VantageScore__c`, `TripointLeadID__c`, `Tripoint_Response__c`, `AmOneBid__c`,
  `AmOneClickURL__c`, `EnrolledPennieDebt__c`, `ExternalDebtAmount__c`,
  `Prescreen_Completed__c`, `CreditFreeze__c`, `Tripoint_Create_Timestamp__c`,
  `Tripoint_Create_Result_Code__c`.
- `submissionId` is used only in the URL. **`executionId`, and any key not in
  the 28, is never sent to Salesforce.** Checked against the live Main Flow
  definition on 2026-10-15: the nine post bodies send no key outside the 28
  plus `submissionId`, `UUID` and `leadUUID` except `executionId`. Three posts
  have literal bodies; the other six post a code node's `sfBody`, built by seven
  code nodes (`engine_no_bids_sf_post` falls back between two). The eighth code
  node checked, `fallback_engine_debt_not_present`, only feeds the UUIDs into
  the literal body of `send_fallback_salesforce_1`.
- It does nothing beyond the one PATCH.
- **Still open for #1680:** a body key that is absent resolves to undefined in
  Pipedream's key and value body, and whether Pipedream then omits the key or
  sends it as null is not established. It matters: a null in a PATCH clears the
  field, an omitted key leaves it. The port must decide which it reproduces,
  ideally by reading what a past relay run actually sent.

**Salesforce: Inquiries update** (the Inquiries relay)

- Live version active; the build view carries an undeployed draft, but the
  live run at 11:17 ET on 2026-10-15 executed the same four steps with the same
  effect as the draft. Settings and trigger as above, including the default
  response.
- Step 1, code: builds `{ PDFlow_4__c, VantageScore__c }`. `PDFlow_4__c` is a
  link to a Pipedream workflow's inspector (a test Equifax workflow) keyed on
  `body.traceId`, not a Bidspoke link. `VantageScore__c` is the score of the
  Equifax model whose `modelNumber` is `05402` in `body.equifax.models`, else
  null.
- Step 2: `PATCH .../sobjects/Submission__c/Id/{submissionId}` with that
  object, so it writes `PDFlow_4__c` and `VantageScore__c`.
- Step 3, code: builds `{ submissionId, inquiriesJson }`, where `inquiriesJson`
  is the JSON string of `{ inquiries: [...] }` with null valued keys dropped.
- Step 4: `POST /services/apexrest/credit-inquiries` with that body. Live
  answer: `{ message: "Inquiries inserted successfully", statusCode: 200,
  leadId }`. The endpoint is the Apex class `InquiryParserRest` (described
  under question 5).
- **No filter step**: a request with no `submissionId` would PATCH
  `.../Submission__c/Id/undefined` and fail.
- Two Salesforce calls per request, so a port that keeps both is two API calls
  per inquiry post.

Both relays authenticate as a Pipedream connected Salesforce account. Measured
from the records each one writes (question 4), both write as **Brian Nelms's** Salesforce user (a staff System Administrator
account; its id and username are left out of this committed doc and can be
read from any relay-written record's `LastModifiedById`).

## Main Flow post-answer writes, by state reached

Main Flow (`60e2e0bc`) is the inbound form-lead flow and the highest-volume
workflow. Its trigger declares these as the success (terminal) nodes. The nine
outcome posts are each wired directly after their branch's `response` node, so
each runs **after** the client has its answer:

`tripoint_sf_post`, `amone_sf_post`, `send_salesforce`,
`send_fallback_salesforce`, `send_fallback_salesforce_1`,
`engine_no_bids_sf_post`, `under_10000_sf_post`, `invalid_state_sf_post`,
`debt_missing_sf_post`.

The tenth Main Flow relay post, `send_salesforce_inquiry`, is not wired after a
response node. It runs inside a parallel branch, and question 3 (its own section
below) measured that it always finishes **before** the answer, so it is not a
post-answer write.

All post to the Submission relay (id redacted) except the inquiry post.
The record is always the Submission, keyed by `submissionId` =
`{{trigger.payload.Submission__c}}`. Routing codes seen: 1 = Engine, 2 =
Tripoint, 3 = AmOne. Exchange status is written `Pending` by the live canvas
(the reference export wrote `Completed` for Engine paths). Read off the Apex on
2026-10-15 (question 5): the Submission's completion
(`Completed_Submission_SO__c` = Yes) is set Salesforce side by
`completeSubmissionWithUUID` on any of four changes in the write, and Pending
is not one of them; a later writer flips the exchange status to Completed.

### The nine outcome posts

| Node | State reached | Partner / routing | Body source | Distinctive fields |
|---|---|---|---|---|
| `tripoint_sf_post` | debt >= $10,000, state allowed, Tripoint wins the bid race | Tripoint, routing 2, exchange Pending | `tripoint_win_body.output.sfBody` (code) | `TripointLeadID__c`, `Tripoint_Response__c`, `Tripoint_Create_Result_Code__c`, `Tripoint_Create_Timestamp__c`, `EnrolledPennieDebt__c`, `ExternalDebtAmount__c` |
| `amone_sf_post` | debt >= $10,000, state allowed, AmOne wins | AmOne, routing 3, exchange Pending | `amone_win_body.output.sfBody` (code) | `AmOneBid__c`, `AmOneClickURL__c`, `Tripoint_Response__c`, `EnrolledPennieDebt__c`, `ExternalDebtAmount__c` |
| `engine_no_bids_sf_post` | debt >= $10,000, state allowed, no partner bid, Engine fallback | Engine, routing 1, exchange Pending | `engine_no_bids_call.output.sfBody ?? engine_no_bids_call_1.output.sfBody` (code) | `UUID`, `leadUUID`, `Tripoint_Response__c`, `TripointLeadID__c`, `LeadSaleType__c` = Offer Wall |
| `under_10000_sf_post` | debt < $10,000, Engine fallback | Engine, routing 1, exchange Pending | `fallback_engine_under_10000.output.sfBody` (code) | `UUID`, `leadUUID`, `EnrolledPennieDebt__c`, `ExternalDebtAmount__c`, `LeadSaleType__c` = Offer Wall |
| `invalid_state_sf_post` | state not allowed, Engine fallback | Engine, routing 1, exchange Pending | `fallback_invalid_state.output.sfBody` (code) | `UUID`, `leadUUID`, credit fields conditional on eligibility |
| `debt_missing_sf_post` | no debt computed (credit pull failed / no debt), Engine fallback | Engine, routing 1, exchange Pending | `fallback_engine_debt_missing.output.sfBody` (code) | `UUID`, `leadUUID`, `Credit_Pull_Result_ES__c` = Fail, `EQXCreditPullStatus__c` = Fail, no ADV/XBC/debt fields |
| `send_salesforce` | over-threshold, internal debt routing (after `return_response_20k`) | none (not sold externally) | literal JSON | `InternalDebtRouting__c` = `calculate_internal_debt.output`, `CreditFreeze__c`, no partner / routing / exchange fields |
| `send_fallback_salesforce` | internal routing fallback (after `return_fallback_adv`) | none | literal JSON | `InternalDebtRouting__c` = `20000` (literal), `CreditFreeze__c`, ADV/XBC from `return_fallback_adv` |
| `send_fallback_salesforce_1` | debt-not-present fallback (after `debt_not_present_response`) | Engine, routing 1, exchange Pending | literal JSON | `UUID`, `leadUUID` from `fallback_engine_debt_not_present`, `LeadSaleType__c` = Offer Wall, `CreditFreeze__c` |

Common fields across the outcome posts (present unless noted otherwise above):
`submissionId`, `PDFlow_1__c` = `{{execution.bidspoke_link}}`, `executionId`
(the run id or trace id), `External_Timestamp__c`, `PD_Completed_Timestamp__c`,
`ADV_SO__c`, `XBC_SO__c` (= `adv` + `bes` + `LEG`), `VantageScore__c`,
`EQXCreditPullStatus__c` (Success / Fail), `Credit_Pull_Result_ES__c`
(conditional on eligibility data), `Monthly_Creditor_Payment_ES__c`,
`Unsecured_Debt_Verified_ES__c`, `External_Partner_Name__c`,
`External_Routing_Code__c`, `External_Exchange_Status__c`, `LeadSaleType__c`.

The winner posts (`tripoint_sf_post`, `amone_sf_post`) do not send `UUID` /
`leadUUID`: they are not an Engine sale, so they never set
`Engine_Offers_Date_SO__c`. The Engine posts do send them. Correction from the
Apex (question 5): the UUID pair is only one of four completion conditions, so a
winner post can still complete the Submission through a change to
`Credit_Pull_Result_ES__c` or `EQXCreditPullStatus__c`.

### The inquiry post

`send_salesforce_inquiry` posts to the Inquiries relay (id redacted) inside
a parallel node on the trades-present branch. Body:

```json
{
  "equifax": {
    "models":    "{{steps.equifax_credit_report.output.data.consumers.equifaxUSConsumerCreditReport[0].models}}",
    "inquiries": "{{steps.equifax_credit_report.output.data.consumers.equifaxUSConsumerCreditReport[0].inquiries}}"
  },
  "traceId":      "{{execution.trace_id}}",
  "submissionId": "{{trigger.payload.Submission__c}}"
}
```

#### Inquiry post timing (open question 3, answered 2026-10-15)

**It always runs before the answer, and it blocks the answer.**

From the live definition (`60e2e0bc`, money gate fixture):

- `equifax_debt` routes `trades_present` into `parallel_1`, whose two children
  are `trades_body` (slot `child-0`, the start of the `pennie_debt_calc` chain)
  and `send_salesforce_inquiry` (slot `child-1`). Its config is `wait_for:
  all`, `on_child_error: fail`, `timeout_ms: 20000`, `on_timeout: partial`.
- The parallel's only onward edge is to `parallel_end_1`. A walk of the graph
  from there (skipping the child slots) reaches all fourteen `response` nodes
  through `parallel_end_1 -> equifax_debt_end -> ...`, so every response on the
  trades-present path is downstream of the parallel.
- `executeParallelNode` (`apps/worker/src/engine/nodes/parallel.ts`), mode
  `all`: awaits `Promise.allSettled` of every child, raced against the
  timeout. `on_timeout: partial` does not let the walk carry on past a slow
  child: it only returns the unsettled child marked `timeout`, and the
  `on_child_error: fail` check that follows treats a `timeout` exactly like a
  rejection and throws (lines 130 to 140). So the walk cannot pass the parallel
  until the inquiry post has settled, and if it failed (or was still running at
  20 s) the run fails.
- The inquiry node is `timeout_ms: 5500`, `retries: 2`, exponential backoff
  (500 ms, 1 s), so its worst case is about 18 s, inside the 20 s window.

Confirmed in `execution_steps` (non-test, Main Flow, filtered on `started_at`,
the partition key; run in four windows because one 7 day join timed out),
comparing each inquiry step's `completed_at` with the earliest `started_at` of
any `response` step in the same execution:

| Window (relative to 2026-10-15 ~15:30 UTC) | Inquiry steps completed | Finished before the response | Finished after the response | Completed, no response step | Failed |
|---|---|---|---|---|---|
| last 1 day | 3,704 | 3,704 | 0 | 0 | 0 |
| 1 to 3 days ago | 6,033 | 6,024 | 0 | 9 | 2 |
| 3 to 5 days ago | 6,204 | 6,204 | 0 | 0 | 0 |
| 5 to 7 days ago | 6,146 | 6,146 | 0 | 0 | 0 |

- **0 of 22,078** inquiry posts that ran alongside a response finished after
  it. Durations: median 63 ms over the last day, the longest completed in the
  7 days 15,841 ms.
- The 9 completed without a response belong to runs that failed elsewhere and
  answered HTTP 500 (7 failed at `parallel_1` because the other child,
  the trades chain, failed; 2 at a `data_store` step).
- The 2 failures (2026-10-13 03:34 and 04:34 UTC) were transient timeouts
  ("Step timed out after 5500ms", all 2 retries used, 18,000 ms in total). Both
  runs failed at `parallel_1` and answered **HTTP 500, with no offer**. A slow
  Inquiries relay therefore costs the lead today.

Consequences:

- #2023's read-back does not cover this post: it is never unfinished after the
  answer. Its failure is already loud (the run fails and alerts).
- Porting it (#1680) moves two Salesforce calls onto the pre-answer critical
  path, inside the 20 s parallel. The native node treats `apex` as not safe to
  repeat, and `InquiryParserRest` attaches a new file to the Lead on every
  successful call that carries inquiries (question 5; a call without them
  writes nothing, see "Port measurements"), so how that step retries is a decision, not a
  copy of the relay's settings.
- A 63 ms median for a relay that makes two Salesforce calls, one of them an
  Apex insert, fits Pipedream's default HTTP response acknowledging on receipt,
  before the Salesforce steps run (both relays use the default response,
  question 1). That is an inference, not a measurement of Pipedream. If it
  holds, a relay 2xx today says only that Pipedream received the request, and
  the relay steps' durations measure Pipedream's intake rather than Salesforce.

### Main Flow native Salesforce steps (for completeness, not post-answer)

Three Main Flow steps use the native node and run **before** the answer, so they
are out of the post-answer scope but recorded here so the port does not confuse
them with the outcome writes (one of the three, `prescreen_query`, is a read,
not a write):

- `set_completed_submission`: fed directly by the trigger (first node). `update
  Submission__c`, `record_id` = `{{trigger.payload.Submission__c}}`, body
  `{ "Completed_Submission_Flag__c": true }`, `retries: 2`, `transient_errors`
  REQUEST_LIMIT_EXCEEDED / Concurrent. A native write that already exists on the
  Submission, useful as the model for the port.
- `prescreen_query`: read, not a write. SOQL
  `select Prescreen_Completed__c from submission__c where id = '...'`.
- `trades_request`: apex POST `/services/apexrest/credit-trades`, body from
  `trades_body`. Pre-answer credit trades step.

## Sibling workflow post-answer writes

These workflows already use native Salesforce nodes, so their post-answer writes
are already the shape #1680 is moving the Main Flow toward. Since #2020 and
#2023 their updates on `Applicant__c`, `Prospect__c` and `Lead` carry a write
marker and are read back and resent; their `Submission__c` updates are not (see
"The write marker and the read-back" below).

### Engine Bidding Workflow (`da82a183`)

Pre-answer: `create_prospect` (create `Prospect__c`), `prospect_trades` (apex
`/services/apexrest/prospect-trades`).

Post-answer writes, both `update Prospect__c`:

- `patch_prospect` (winner writeback), `record_id` =
  `{{steps.generate_trades_body.output.prospectId}}`, body from
  `patch_prospect_body.js`:
  `BidAmount__c` = offer rate, `BidStatus__c` = Bid, `OfferLandingPage__c` =
  click url, `Base_Bid__c`; and when sold, `ExternalPartnerName__c` =
  sale partner name, `ExternalDebtAmount__c` = enrollable debt,
  `ExternalRoutingCode__c` = sale routing code, `ExternalExchangeStatus__c` =
  Bid; Tripoint-only, written only when Tripoint is the buyer:
  `TripointLeadID__c`, `Tripoint_Response__c`; `Collections_Bid_Discount__c`
  when a collections discount applied. ADR 0002 notes this winner writeback is
  the post-response work that keeps the isolate alive.
- `patch_prospect_reject` (rejection), body from `build_response_body.js`
  `reject_patch`: `BidStatus__c` = Rejected, `RejectionReason__c` = the reason,
  plus `Tripoint_Response__c` only when Tripoint was the decliner.

### Lead Economy Bidding Workflow (`89b1a6af`)

Pre-answer: `custom_request` (apex `/services/apexrest/custommdt/bid?name=Lead_Economy`,
reads bid config), `create_prospect` (create `Prospect__c`), `prospect_trades`.

Post-answer writes, all `update Prospect__c` (record id =
`{{steps.create_prospect.output.body.id}}` except `patch_prospect`, which uses
`{{steps.generate_trades_body.output.prospectId}}`):

- `patch_prospect`: winner writeback, body from the Lead Economy
  `patch_prospect_body` code node, which writes `Base_Bid__c`, `BidAmount__c`,
  `BidStatus__c`, `Bid_Response_Timestamp__c`, `Collections_Bid_Discount__c`,
  `ExternalDebtAmount__c`, `ExternalExchangeStatus__c`,
  `ExternalPartnerName__c`, `ExternalRoutingCode__c`, `OfferLandingPage__c` and
  `RejectionReason__c` (read from the live definition's code, 2026-10-15).
- `patch_prospect_success` / `patch_prospect_duplicate` / `patch_prospect_error`:
  `{ "TripointLeadID__c": <createLead.id>, "Tripoint_Response__c": "Success" |
  "Duplicate" | "Fail" }`.
- `patch_prospect_missing_credit`: `{ "BidStatus__c": "Rejected",
  "RejectionReason__c": "No equifax match" }`.

### Liberty1 Click Handler (`8a0f65aa`)

A separate handler for the Liberty1 click delivery. Pre-answer: `query_record`
(query to find the records). Post-answer writes, bodies all from
`liberty1_click_patch.js`, which writes only on route `sent` (exchange status
Completed) or `refused` (exchange status Fail), and writes nothing on any other
route (`write: false` skips all three updates):

- `update_prospect`: `update Prospect__c`, record id =
  `{{steps.pick_record.output.prospect_id}}`. Fields:
  `ExternalExchangeStatus__c`, `ExternalPartnerLeadId__c` (only when sent),
  `ExternalPartnerName__c` = Liberty1, `ExternalRoutingCode__c` = 4 (number),
  `TCPA_Consent__c` (the Liberty1 verbatim TCPA text), `ExternalTimestamp__c`,
  `PDFlow_3__c` = Bidspoke link, `LeadSaleType__c` = Form.
- `update_submission`: `update Submission__c`, record id =
  `{{steps.pick_record.output.submission_id}}`. Same facts under the
  Submission field names: `External_Exchange_Status__c`,
  `External_Partner_Lead_Id__c`, `External_Partner_Name__c`,
  `External_Routing_Code__c` = "4" (text), `External_TCPA_Consent__c`,
  `External_Timestamp__c`, `PDFlow_3__c`, `LeadSaleType__c`.
- `update_lead`: `update Lead` (the standard Lead object), record id =
  `{{steps.pick_record.output.lead_id}}`. Fields: `External_Exchange_Status__c`,
  `ExternalPartnerLeadId__c`, `ExternalPartnerName__c`,
  `External_Routing_Code__c` = "4" (text), `TCPAConsent__c`,
  `External_Timestamp__c`, `LeadSaleType__c`.

Undefined fields are dropped so nothing is blanked. The same routing code is a
number on Prospect and text on Submission and Lead, and the TCPA field has a
different API name on each object.

### RML Bidding: LendSwift (`e1b810da`) and GigFi (`6624acd0`)

Two sub-workflows of the same shape (GigFi tracked by `docs/gigfi-port-plan.md`).
Pre-answer: `create_applicant` (create `Applicant__c`). Post-answer writes, both
`update Applicant__c`, record id = `{{steps.create_applicant.output.body.id}}`:

- `patch_applicant_bid` (Bid branch): `BidAmount__c`, `BidStatus__c` = Bid,
  `LeadSaleType__c` = Form, `Redirect_URL__c`, `Minimum_Bid_Amt__c`,
  `OfferLandingPage__c`, `ExternalTimestamp__c`, `ExternalPartnerName__c` =
  LendSwift (or GigFi), `ExternalRoutingCode__c` = 4, `External_Partner_Bid__c`.
- `patch_applicant_no_bid` (No Bid branch): `BidStatus__c` = Rejected,
  `Minimum_Bid_Amt__c`, `RejectionReason__c`, `ExternalPartnerName__c`,
  `ExternalRoutingCode__c` = 4, `LS_Rejection_Reason__c`, `External_Partner_Bid__c`.

The 2026-10-13 incident (#2015) flagged `patch_applicant_no_bid` writes that
never landed, so this write is squarely in scope even though it is already
native.

## Objects and record id sources (summary)

| Workflow | Object | Record id source | Post-answer write nodes |
|---|---|---|---|
| Main Flow | `Submission__c` (via relay) | `trigger.payload.Submission__c` | 9 relay posts (`send_salesforce_inquiry` also posts per lead, but before the answer: question 3) |
| Engine Bidding | `Prospect__c` | `generate_trades_body.output.prospectId` | `patch_prospect`, `patch_prospect_reject` |
| Lead Economy | `Prospect__c` | `create_prospect.output.body.id` (and `generate_trades_body...` for `patch_prospect`) | `patch_prospect`, `patch_prospect_success` / `_duplicate` / `_error` / `_missing_credit` |
| Liberty1 Click | `Prospect__c`, `Submission__c`, `Lead` | `pick_record.output.{prospect,submission,lead}_id` | `update_prospect`, `update_submission`, `update_lead` |
| RML LendSwift / GigFi | `Applicant__c` | `create_applicant.output.body.id` | `patch_applicant_bid`, `patch_applicant_no_bid` |

## Field-level access and sharing (open question 4, answered 2026-10-15)

**Result: no gap.** The Bidspoke integration user can already write every field
and record the post-answer writes touch, with the same profile the relays'
user holds. Measured read only in the production org with `sf data query`
(standard and Tooling API) on 2026-10-15.

### Who writes

| User | Id | Username | Profile (license) | How identified |
|---|---|---|---|---|
| Bidspoke Integration | `005Ui00000EnivtIAB` | `bidspoke@trypennie.com` | System Administrator (Salesforce) | `LoginHistory`, last 2 days: 236 successful "Remote Access 2.0" logins through the connected app "Bidspoke API". It created 4,643 of today's `Applicant__c` records (LendSwift `create_applicant`) and 13,861 of today's `Prospect__c` records, and is the last modifier of 4,519 of those Applicants. |
| Brian Nelms (the relays' writer) | staff account, id omitted | omitted | System Administrator (Salesforce) | Inquiries relay: all 7,598 `Inquiry__c` rows and all 1,243 `Inquiries_...` files created today were created by this user (only `InquiryParserRest` writes them). Update Submission relay: of today's 1,423 Submissions carrying a Main Flow run link (`PDFlow_1__c`), this user is the last modifier of 1,108, and 883 of those were last modified within 60 s of `PD_Completed_Timestamp__c`, the stamp Bidspoke puts in the post body just before posting. |

Two other writers seen on the same Submissions, for context: Geoff Harris (a
staff account) is the last modifier of 419 internal routing Submissions,
all but 5 of them more than 60 s after the relay's stamp, so a separate later
writer and not the relay; and a user named `integration pipedream`
(`005Ul00000HY0a5IAD`, Salesforce Integration license, logs in through a
connected app named "Pipedream Integration") wrote no Submission or Inquiry
today, so it is not the relays' account.

Queries: `SELECT CreatedById, LastModifiedById, COUNT(Id) FROM Applicant__c /
Prospect__c / Submission__c WHERE CreatedDate = TODAY GROUP BY ...`;
`SELECT CreatedById, COUNT(Id) FROM Inquiry__c WHERE CreatedDate = TODAY GROUP BY
CreatedById` (and the same on `ContentVersion` with `Title LIKE 'Inquiries_%'`);
`LoginHistory` grouped by user, login type and application; today's Submissions
with `PDFlow_1__c != null`, comparing `LastModifiedDate` with
`PD_Completed_Timestamp__c` locally.

### Access

- **Same profile, Modify All Data.** Both users hold the System Administrator
  profile's permission set (`0PSDp000001WqexOAC`): `PermissionsModifyAllData`,
  `PermissionsViewAllData`, `PermissionsAuthorApex` and `PermissionsApiEnabled`
  all true. The Bidspoke user also holds `Bidspoke_API_Access`, which only adds.
- **Object access.** The profile grants read, edit, View All and Modify All on
  `Submission__c`, `Lead`, `Prospect__c`, `Applicant__c` and `Inquiry__c`
  (`ObjectPermissions`).
- **Sharing.** Org wide defaults (`EntityDefinition`): Submission, Prospect,
  Applicant and Inquiry are internal Read/Write; Lead is Private. Modify All
  Data overrides sharing, so the Private Lead model and `SubmissionService`
  being `with sharing` do not restrict either user. Spot check with
  `UserRecordAccess` for the Bidspoke user: 5 of today's Submissions and the 3
  Leads linked to three of them all answer `HasEditAccess = true`,
  `MaxAccessLevel = All`.
- **Field-level security.** `FieldPermissions` on the profile permission set
  grants **edit on all 70 fields** the post-answer writes name: the relay's 28
  Submission fields plus `PDFlow_4__c`, `Completed_Submission_Flag__c`,
  `External_Partner_Lead_Id__c`, `External_TCPA_Consent__c` and `PDFlow_3__c` on
  Submission; the 7 Liberty1 Lead fields; the 18 Prospect fields of the Engine,
  Lead Economy and Liberty1 patches (including `Bid_Response_Timestamp__c`); the
  12 Applicant fields of the LendSwift and GigFi patches. Every one of the 70
  returned a row, so none is misspelled, and an edit grant cannot exist on a
  formula field, so none is a formula. 0 rows had edit false on the profile.
- **Apex REST.** `SetupEntityAccess` gives the profile access to
  `InquiryParserRest` (`/credit-inquiries`), `TradeParserRest`
  (`/credit-trades`) and `ProspectTradeParserRest` (`/prospect-trades`).
- **Validation rules.** None active on the five objects (Tooling
  `ValidationRule`, all 15 in the org listed; the only one on these objects is
  Prospect's `Bid_Status_Pipeline`, inactive).
- **Positive control.** The Bidspoke user already writes `Submission__c`
  natively on every Main Flow run (`set_completed_submission`, pre-answer) and
  on Liberty1 clicks (`update_submission`), and already calls `/credit-trades`
  (`trades_request`).

What changes when a relay post moves to a native step is only the writing user
recorded on the record (`LastModifiedById` becomes Bidspoke Integration instead
of Brian Nelms). Question 5 found nothing readable that reads it; the managed `regal_voice.LeadTrigger` could not be read.

## Salesforce automation side-effects (open question 5, answered 2026-10-15)

Read from the org's metadata on 2026-10-15: the bodies of every active
unmanaged Apex class (202) and every active trigger on the five objects (Tooling
`ApexClass` and `ApexTrigger` `Body`), and the active version of every
record-triggered flow that fires on update on those objects (Tooling `Flow`
`Metadata`, one record per query, 24 flows). Already known and still true: ADR
0010's revenue formulas (`Lead.ExternalRevenue__c`,
`Prospect__c.ExternalExchangeRevenue__c`) are fed by the debt and partner
fields these writes set.

### Does anything key on the writing user? Nothing readable does; one managed trigger cannot be read.

- **Apex.** All 202 active unmanaged classes and the 6 active unmanaged triggers (`LeadTrigger`, `LeadLinkTokenTrigger`, `ProspectTrigger`, `ProspectLinkTokenTrigger`, `SubmissionTrigger`, `SubmissionLinkTokenTrigger`; the managed `regal_voice.LeadTrigger` is the one active trigger on these objects that could not be read) were
  scanned for `UserInfo.`, `LastModifiedById`, `CreatedById`, `$User`,
  `Profile.Name`, `Username`, permission checks and hard coded user ids. The
  only hits are off every write path: `TradeController.isSalesUser` (an
  `@AuraEnabled` method for a Lightning component, `Profile.Name == 'Sales'`),
  `AchieveApiController` (stamps the clicking agent's email in a UI action),
  `FreezeCheckJob` (a scheduled job that checks a list of usernames),
  `Constants` (a named credential username) and comments in
  `DraftInfoStampBatch`. The two bypass checks in the triggers
  (`LeadScoreBackfillBatch.isBypassActive()`,
  `LeadScoreSubmissionBackfillBatch.isBypassActive()`) read a static flag that
  only those batches set, not the user.
- **Flows.** The 24 flows' metadata contains no reference to `$User`,
  `$Profile`, `$Permission`, `$UserRole`, `$Setup`, `$Api`, `LastModifiedBy`,
  `LastModifiedById`, `CreatedBy`, `CreatedById`, `OwnerId`, `Username` or a
  user id: 0 hits. Control: the same scan finds `$Record` in all 24. The Apex
  actions they call (`CometlyEvent`, `EmailSha2HashInvocable`) are in the class
  scan above.
- **Validation rules.** None active on the five objects (question 4).
- **Process Builder and workflow rules.** No active flow of process type
  Workflow (Process Builder); Tooling `WorkflowRule` returned 0 rows org wide.
- **Not readable:** `regal_voice.LeadTrigger` (`01qDp000000He2OIAS`, before
  and after insert and update on Lead) is a managed package trigger whose body
  Salesforce hides. Whether it keys on the user cannot be measured from the org.
  It is subscribed to every Lead insert and update whoever makes it, but what it
  does inside may still differ by user, so a port moving writes from the
  relay's user to the Bidspoke user carries that one unmeasured risk; the
  canary in #1680 is where a difference in Regal's behaviour would first show.

### What each write sets off

**Submission (`SubmissionTrigger`, unmanaged).**

- Before update, `completeSubmissionWithUUID` (once per transaction, a static
  flag) sets `Completed_Submission_SO__c = 'Yes'` and
  `Submission_Timestamp_SO__c` when the write changes **any** of:
  - both `Engine_UUID_SO__c` and `Engine_Lead_UUID_SO__c` (both non-null and
    both different from before), which also stamps `Engine_Offers_Date_SO__c`;
  - `Credit_Pull_Result_ES__c` to Success or Fail;
  - `External_Exchange_Status__c` to the Tripoint Completed or Fail value;
  - `EQXCreditPullStatus__c` to Success or Fail (with a Prospect, only if
    `Email_SO__c` is not blank).

  The first condition, quoted whole from `SubmissionService`:

  ```
  if (newSub.Engine_UUID_SO__c != null
      && newSub.Engine_Lead_UUID_SO__c != null) {
    if (oldSub.Engine_Lead_UUID_SO__c != newSub.Engine_Lead_UUID_SO__c
        && oldSub.Engine_UUID_SO__c != newSub.Engine_UUID_SO__c) {
      newSub.Engine_Offers_Date_SO__c = Datetime.now();
      completionTriggered = true;
    }
  }
  ```
- After update, `updateRelatedLeadForSubmission`. On the completion flip with a
  Lead: updates the Lead with the completion fields, the Engine UUIDs and offer
  date (or **nulls them** when the Submission has no `Engine_Offers_Date_SO__c`,
  which is the 2026-10-13 repair's blank Engine fields), `Submission_Object_ID__c`,
  the Prospect link, and many copied fields including `PDFlow_1__c` to
  `PDFlow_8__c` (each when not null), `PD_Completed_Timestamp__c`, `External_Exchange_Status__c`,
  `InternalDebtRouting__c`, `CreditFreeze__c`; then, with a Prospect, clones its
  files to the Lead and starts `TradeParserBatch` (async Apex). **Without** a
  completion flip, if the Submission has a Lead, it still updates the Lead with
  `CreditFreeze__c`: so every Submission update with a Lead is also a Lead
  update, and runs the Lead automations below.
- `SubmissionLinkTokenTrigger` runs after insert only.
- Flow `Custom_Event_30_Helper` (after save, create and update): only when
  `External_Exchange_Status__c` changes to Completed and `ExternalRevenue__c >
  0`; asynchronously after commit it sends Cometly event 30 and logs a
  `CometlyEventLog__c`. The relay posts write Pending, so they do not fire it;
  Liberty1's `update_submission` writes Completed on a sent click and can.
- Create only, not fired by these updates: `Debt_Amount_Set_for_Engine`,
  `Set_Resubmit_Sell_Off`.

**Lead (on the Lead sync, Liberty1's `update_lead`, and `InquiryParserRest`'s
count update).**

- Triggers: `LeadLinkTokenTrigger` (before insert and update,
  `LinkToken.stampLeads`); unmanaged `LeadTrigger` (before update:
  `wipeRegalFields`, `enrollmentFieldsSync`, `syncAssignedAgentManager`,
  `recalculateLeadScoreOnUpdate`; after update: `handleUpdate`, whose PDF step
  is commented out, and `syncSubmissionsFromLead`, which writes Lead fields
  back to the active Submissions); the managed `regal_voice.LeadTrigger`.
- After save flows that fire on update (15, against the "16" #2021 expected),
  each with its entry condition. Six fire on a **change to
  `PD_Completed_Timestamp__c`**, which the completion branch of the Lead sync
  copies from the Submission, and send marketing conversion events
  asynchronously:
  - `V_Lead_All`, `Event_28_V_Lead_All_Sales` (`EngineDebt__c >= 0`);
  - `Event_29_V_MQL_Sales`, `Lead_Debt_Category_Events`,
    `Pennie_V_MQL_Cometly_Event`, `VMQL_NewForm` (`EngineDebt__c >= 20000`);
  - their actions call Cometly (v2, v3, v4), LiveIntent, Rokt, AppLovin, Groovy,
    Moment Science and DigitalEcho external services and log
    `CometlyEventLog__c`.

  The other nine: `Live_Intent_Sync`, `Live_Intent_Sync_RML`
  (`ActiveCompletedSubmission__c` changes to Yes, sub source Live Intent, by
  record type); `Cometly_Event_13_Helper` (`ActiveBookingEvent__c`);
  `Custom_Event_14_Helper` (`Active_Completed_Call_R__c`);
  `Custom_Event_15_Helper` and `Cometly_Event_27_Helper` (`Estimated_Revenue__c`
  changes and is above 0); `Cometly_Events_TEST` (new, `Active_Submission__c`
  to Yes, or a change to `InternalDebtRouting__c` or `Tags__c`, among others);
  `Prospect_Estimated_Revenue` (`DS_Enrollment_Date_M__c`);
  `Set_Call_Scheduled_Status` (`Call_Scheduled_R__c`).
- Before save flows on update: `New_Range_Based_On_Unsecured_Debt`
  (`InternalDebtRouting__c`, `EnrolledPennieDebt__c` or
  `Unsecured_Debt_Verified_ES__c` changes), `Track_Expired_SO`,
  `Update_Lead_Fields`, `Update_Lead_Tags`.

**Inquiries relay's Apex REST (`InquiryParserRest`, `/credit-inquiries`).**
Finds the Submission's Lead (404 if none) and, only when the parsed inquiry
list is non-empty, **deletes** the Lead's existing `Inquiry__c` rows and
inserts the parsed ones, updates the Lead's four inquiry counts, and attaches
the raw JSON to the Lead as a **new file** (`ContentVersion` and
`ContentDocumentLink`). An empty or missing list writes nothing (corrected by
#2169, see "Port measurements"). The class declares no
sharing keyword. No trigger exists on `Inquiry__c`, `ContentVersion` or
`ContentDocumentLink`.

**Prospect (Engine Bidding, Lead Economy, Liberty1).** `ProspectTrigger` (before
insert and update) sets the sub account name only when `SubaccountUUID__c`
changes, which these patches do not write. Flows on update:
`ProspectBidStatusValidation` (before save, on a `BidStatus__c` change) **silently
puts `BidStatus__c` back to its prior value** when the change would move
backward through Bid, Won Bid, Clicked, Converted, with no error;
`Bid_Status_Change` (`ConvertedToLead__c` or `OfferClicked__c` changes) and
`ProspectTags` (`PennieDebt__c` changes) key on fields these patches do not
write. `ProspectLinkTokenTrigger` is after insert only.

**Applicant (LendSwift, GigFi).** No trigger. One after save flow,
`Applicant_SSN_Testing`, enters only when `SocialSecurityNumber__c` is
`000000000`, a field the patches do not write. So `patch_applicant_*` sets off
nothing.

### What a resend sets off (#2023)

- An identical PATCH that lands on an unchanged record re-fires nothing that
  keys on a change: no completion (the values match), no Engine offer date, no
  completion branch of the Lead sync, no Cometly event 30, none of the six
  `PD_Completed_Timestamp__c` flows. It does repeat the `CreditFreeze__c`-only
  Lead update, which runs the Lead triggers and fires nothing above.
- A resend over a record another writer has since moved would regress it. For
  example, Main Flow writes `External_Exchange_Status__c` Pending and a later
  writer moves it to Completed (firing event 30); resending the Pending write
  undoes that, and the next Completed flip fires Cometly event 30 again. #2023's
  rule not to overwrite a different non-blank value is what stops this.
- A first write that never landed fires everything once when the resend lands,
  as the original would have.
- An Inquiries resend that carries inquiries replaces the inquiry rows (safe)
  but attaches one more file to the Lead each time (not idempotent); one
  without inquiries writes nothing. It is pre-answer, so #2023 does
  not resend it.
- On Prospect, a resent `BidStatus__c` that would move backward is reverted
  without error, so the PATCH answers 204 and the field does not hold the
  resent value.

## Volume (open question 6, answered 2026-10-15)

Expected before querying (L24): Main Flow about 3,300 runs a day (the daily
stats table), one outcome post per run plus one inquiry post on most runs;
Engine Bidding about 60,000 runs a day with one patch on most; the #2015
estimate of about 100,000 post-answer writes a day across all flows.

Measured from `execution_steps` (non-test, filtered on `started_at`, its
partition key, one UTC day per query because a three day query timed out),
counting rows by workflow and `step_namespace`. Every row counted had status
`completed` except where noted.

| Workflow | Write step | 10-08 | 10-09 | 10-10 | 10-11 | 10-12 | 10-13 | 10-14 | Daily mean |
|---|---|---|---|---|---|---|---|---|---|
| Main Flow | `send_salesforce` | 1,354 | 1,269 | 1,218 | 1,230 | 1,246 | 1,175 | 1,408 | 1,271 |
| Main Flow | `under_10000_sf_post` | 1,285 | 1,195 | 1,226 | 1,185 | 1,226 | 1,121 | 1,327 | 1,224 |
| Main Flow | `tripoint_sf_post` | 395 | 411 | 454 | 374 | 368 | 330 | 370 | 386 |
| Main Flow | `engine_no_bids_sf_post` | 153 | 170 | 158 | 176 | 158 | 152 | 236 | 172 |
| Main Flow | `debt_missing_sf_post` | 110 | 94 | 99 | 104 | 83 | 96 | 102 | 98 |
| Main Flow | `send_fallback_salesforce` | 62 | 72 | 57 | 66 | 60 | 69 | 69 | 65 |
| Main Flow | `amone_sf_post` | 56 | 52 | 52 | 45 | 52 | 38 | 61 | 51 |
| Main Flow | `invalid_state_sf_post` | 14 | 26 | 22 | 24 | 17 | 15 | 17 | 19 |
| Main Flow | `send_fallback_salesforce_1` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Main Flow | **9 outcome posts** | 3,429 | 3,289 | 3,286 | 3,204 | 3,210 | 2,996 | 3,590 | 3,286 |
| Main Flow | `send_salesforce_inquiry` (pre-answer) | 3,260 | 3,118 | 3,125 | 3,031 | 3,066 | 2,842 | 3,406 | 3,121 |
| Engine Bidding | `patch_prospect_reject` | 31,753 | 32,810 | 30,078 | 24,942 | 29,830 | 31,174 | 31,287 | 30,268 |
| Engine Bidding | `patch_prospect` | 4,456 | 4,247 | 3,976 | 3,007 | 3,825 | 4,320 | 3,528 | 3,908 |
| Lead Economy | `patch_prospect` | 2,201 | 2,279 | 955 | 902 | 2,206 | 2,288 | 2,386 | 1,888 |
| Lead Economy | `patch_prospect_duplicate` | 295 | 344 | 116 | 128 | 257 | 319 | 329 | 255 |
| Lead Economy | `patch_prospect_success` | 235 | 250 | 89 | 85 | 223 | 240 | 168 | 184 |
| Lead Economy | `patch_prospect_missing_credit` | 153 | 151 | 68 | 74 | 121 | 169 | 159 | 128 |
| Lead Economy | `patch_prospect_error` | 45 | 33 | 16 | 14 | 46 | 47 | 89 | 41 |
| Liberty1 Click | `update_prospect`, `update_submission`, `update_lead` (each) | 51 | 46 | 4 | 0 | 41 | 44 | 21 | 30 |
| RML LendSwift | `patch_applicant_no_bid` | 10,754 | 11,476 | 11,090 | 9,107 | 10,836 | 11,039 | 10,711 | 10,716 |
| RML LendSwift | `patch_applicant_bid` | 1,400 | 1,600 | 1,351 | 1,166 | 1,282 | 1,414 | 1,392 | 1,372 |
| RML GigFi | `patch_applicant_no_bid` | 1,251 | 1,209 | 1,340 | 1,006 | 1,358 | 1,322 | 1,293 | 1,254 |
| RML GigFi | `patch_applicant_bid` | 967 | 965 | 832 | 804 | 1,007 | 987 | 940 | 929 |
| **All post-answer writes** (excluding the inquiry post) | | 57,092 | 58,791 | 53,209 | 44,439 | 54,324 | 56,447 | 55,935 | 54,320 |

(Liberty1 counted once per step, so its row is three writes a day each.)

- **About 54,300 post-answer writes a day** (57,400 including the pre-answer
  inquiry post), not the estimated 100,000. Engine Bidding's rejection patch is
  over half of them.
- Not completed in the window: Engine Bidding `patch_prospect` 3 on 10-13, 1 on
  10-12, 1 on 10-10; `patch_prospect_reject` 36 on 10-13, 4 on 10-12, 1 on
  10-10; Main Flow inquiry 2 on 10-13. Every other count above is all completed.
- `send_fallback_salesforce_1` (the debt not present Engine fallback) did not
  run once in 7 days.
- Main Flow (v2) wrote nothing (question 2).
- Control: the Main Flow outcome post total matches its runs in
  `workflow_stats_daily` (10-14: 3,590 posts for 3,589 runs; 10-08: 3,429 for
  3,435), so the step table is not missing writes for this flow.

**API quota.** `sf limits api display` on 2026-10-15 about 15:40 UTC:
`DailyApiRequests` max 1,680,000, remaining 1,202,467 (477,533 used in the
rolling 24 hours); `DailyAsyncApexExecutions` max 421,800, remaining 248,415.
Porting the Main Flow relays adds about 3,290 outcome PATCHes plus about 6,240
inquiry calls (two per post) a day, about 9,500, which is 0.6% of the daily
allocation. `DailyApiRequests` is reported for the org as a whole, so the
relays' calls already count against it today when Pipedream makes them; moving
them to the Bidspoke user changes which user makes them, not the org total. The
concurrent long running request limit is not reported by `/limits` and was not
measured.

ADR 0002's figures still stand: about 5% of finalized leads a day lose their
post-response database finalize to Worker eviction, and the 2026-10-13 incident
measured 8 of 18 flagged writes (44%) not landing under an upstream slowdown.

## Port measurements (#2169)

Phase 0 of the #1680 plan (approved 2026-10-15): read only measurements the
port rests on, all taken on 2026-10-15 from the production database
(`execution_steps`, filtered on `started_at`, its partition key), the Salesforce
org (`sf data query`, standard and Tooling API) and Workers Logs. Nothing was
written anywhere. The Pipedream auto retry count is measured separately and is
not in this section. Times are UTC. The port built on them (#2171), its stages
and how each is applied and rolled back: [main-flow-relay-port.md](./main-flow-relay-port.md).

### What these change in the #1680 plan

"Plan point N", "R1", "R2" and "D5" below are the numbered items of the
approved #1680 plan comment, not this document's own numbered lists.

1. **R1 does not happen: a `"null"` VantageScore lands.** `VantageScore__c` is
   a `Text(255)` field on both Submission and Lead, so the string `"null"` is
   stored as text, not refused. All 210 Submissions posted with it in 3 days
   show the write landed (209 carry that run's link, the 210th a later run's
   link from the same post). Keeping the text body keeps today's behaviour
   exactly (the literal text `null` on about 70 Submissions a day); it breaks
   nothing in the write.
2. **Plan point 15 is wrong about the empty case: the Apex call writes nothing at
   all when there are no inquiries.** `InquiryParserRest` only deletes, inserts,
   updates the Lead's counts and attaches the file when the parsed list is
   non-empty. Live posts never carry an empty list: 11.7% carry no `inquiries`
   key at all (2,562 of 21,848 in 7 days), and for those no marker of any kind
   appears in Salesforce. The marker for every successful call that carries
   inquiries is the `Inquiries_<leadId>` file on the Lead (150 of 150). So the
   port should skip the Apex call, with a recorded reason, when the inquiry
   list is absent or empty (it cannot do anything), and the D5 read-back
   covers only posts that carry inquiries. The Lead's old `Inquiry__c` rows
   are not deleted in that case (12 of 150 sampled Leads keep rows from an
   earlier pull).
3. **The bulkhead reached its cap once in 7 days and never shed, but it failed
   open 50 times.** Peak in flight 20 of 20 on 2026-10-11 at about 17:14,
   with waits up to 21.5 s (the runs that logged waits started between
   17:14:31 and 17:14:56; the slowdown's own length was not measured). 46 of the 50 fail-opens
   came on the evening of 2026-10-12 and during the 2026-10-13 incident: the
   bulkhead Durable Object itself errored and calls went ahead without a slot,
   so the cap did not hold when it mattered most. Plan point 7's separate
   post-answer bulkhead key stands; its test should also cover the fail-open
   path.
4. **The timeout budget is tight.** Work after the answer gets 12 s: a run
   waits at most 12 s after its response for the rest of its walk
   (`apps/worker/src/lib/post-response-budget.ts`, #1882; plan point 5).
   `set_completed_submission` (a Submission PATCH that does not complete the
   Submission) has p99.9 4,474 ms and max 14,540 ms per attempt. The
   completing outcome PATCH runs more Salesforce automation synchronously
   (the completion flip, the Lead sync, the Lead flows), so it is probably at
   least as slow (inferred, not measured). Two attempts at the p99.9 already
   take about 9 s before the Apex call starts, and one attempt at the
   measured maximum takes more than the whole 12 s. Plan point 5's budget test
   will have to choose between one attempt and a shorter per-attempt timeout.
5. **R2: moving the Apex call after the completion flip changes no final field
   value**, and sends the inquiry counts to the right Submission in the one case
   where today they go to an older one.

### 1. `VantageScore__c` as the string `"null"` (risk R1)

**Which posts.** In the live Main Flow definition (money gate fixture), three
outcome posts are JSON text bodies with `"VantageScore__c":
"{{steps.gen_vantage_score.output}}"`: `send_salesforce`,
`send_fallback_salesforce` and `send_fallback_salesforce_1`. The other six send
a code node's `sfBody`, where `VantageScore__c` is a real JSON value.

**What it renders to.** `gen_vantage_score` returns `null` when the Equifax
report or its `models` is missing. Inline interpolation in `resolveTemplate`
(`engine/context.ts`) turns `null` into the text `null` and `undefined` into
an empty string, so inside the quotes the body carries `"VantageScore__c":
"null"` (a string), or `""` when the step did not run. In the code node bodies
the same case is a JSON `null`, which clears the field.

**How often.** Last day before about 16:20: `gen_vantage_score` completed 3,901
times, 164 with a null output. Those 164 runs posted through
`debt_missing_sf_post` 85 (code body, JSON null), `send_fallback_salesforce` 71
(text, `"null"`), `under_10000_sf_post` 6 (code body) and `send_salesforce` 2
(text, `"null"`). Query: `execution_steps` where `step_namespace =
'gen_vantage_score'` and `output is null`, joined on `execution_id` to the
outcome post steps, reading `input->'resolved'->'body'`.

**Whether such writes land.** All 213 text-body posts carrying
`"VantageScore__c": "null"` in the 3 days before about 16:20 (209
`send_fallback_salesforce`, 4 `send_salesforce`, all answered 200 by the relay)
cover 210 Submissions. Read back from `Submission__c` by id:

- 209 of 210 hold `PDFlow_1__c` equal to that run's Bidspoke link, so the relay
  PATCH landed. The 210th holds the link of a later Main Flow run on the same
  Submission (13:02 the same day, also `send_fallback_salesforce`), so it landed
  and was then superseded. None failed.
- 186 still hold `VantageScore__c = 'null'`; 21 hold a score written later by
  another writer, 3 are blank (210 in all).
- Field type (Tooling `FieldDefinition`): `VantageScore__c` is `Text(255)` on
  Submission and on Lead, so Salesforce accepts the string. The completion
  flip copies a non-null `VantageScore__c` to the Lead, so the text reaches the
  Lead too: 391 Submissions and 319 Leads created in the 7 days to 2026-10-15
  hold `VantageScore__c = 'null'`.

### 2. The inquiry call's always-present marker

**What `InquiryParserRest` writes** (Tooling `ApexClass` body of the class with
`@RestResource(urlMapping='/credit-inquiries')`, and its `InquiryParser` and
`InquiryQuery`): it looks up the Submission's Lead (404 when there is none),
parses the inquiries, and **only if the parsed list is non-empty** deletes the
Lead's `Inquiry__c` rows, inserts the new ones, updates the Lead's
`InquiriesAmount__c`, `Num_of_Inquiries_12M__c`, `Num_of_Inquiries_24M__c` and
`Num_of_Inquires_2Y__c`, and last inserts a `ContentVersion` titled
`Inquiries_<leadId>` linked to the Lead. An empty list writes nothing and still
answers 200. A body whose `inquiries` key is missing makes `wrapper.inquiries`
null, and iterating it throws, which the class catches and answers 500, again
before any write. The catch does not roll back, so a failure inside the file
insert would leave the rows and counts written and the file missing.

**What live posts carry.** Over 7 days (2026-10-08 to 2026-10-14), of 21,848
`send_salesforce_inquiry` posts, 19,286 carried a non-empty `inquiries` array,
2,562 (11.7%) carried no `inquiries` key at all, and **0** carried an empty
array. The relay builds the Apex body from that key; whether it sends `{}` or
`{"inquiries":[]}` when the key is missing is not visible, and either way the
Apex writes nothing.

**Read back.** The 150 most recent posts of each kind between 2 and 24 hours
before the query (the 2 hour gap lets the relay finish), compared with each
Lead, timestamps truncated to the second as Salesforce stores them:

| Marker on the Lead, created after the post started | Non-empty list (150) | No `inquiries` key (150) |
|---|---|---|
| `Inquiries_<leadId>` file (`ContentDocumentLink`) | 150 | 0 |
| `Inquiry__c` rows | 150 | 0 |
| `InquiriesAmount__c` equal to the posted count | 149 | not written |
| Submission `PDFlow_4__c` set (the relay's own PATCH, not the Apex) | 150 | 150 |
| Lead created after the post started | 0 | 0 |

**The marker:** the `Inquiries_<leadId>` file linked to the Lead with a
`CreatedDate` at or after the call, present on every successful call that
carries inquiries. It is the last write in the method, so its presence means the
rows and counts were written too. **No marker exists for a post with no
inquiries**, because the call writes nothing; `PDFlow_4__c` is written by the
relay's separate Submission PATCH, which the plan folds into the outcome write.
12 of the 150 Leads in that group keep `Inquiry__c` rows and counts from an
earlier pull, which the call does not clear.

### 3. Bulkhead peak in flight

**What is recorded.** `BulkheadObject` stores only the current leases, no
history or counters. The Salesforce node logs `salesforce_bulkhead_shed` (with
`inflight`) on a shed and `salesforce_bulkhead_waited` (with `inflight` at the
moment of the grant) only when getting a slot took over 1 s. A grant without a
wait is not logged, so the logs give the peak only when it coincided with a
wait. When the call to the Durable Object itself throws, the client fails open
(`allowed: true`, no lease) and the waited line reads `inflight=undefined`.

**Workers Logs**, `bidspoke-worker`, queried in windows of 24 hours or less
grouped by message (7 day searches miss lines), covering 2026-10-08 16:00 to
2026-10-15 16:00:

| Window | Shed lines | Waited lines | Highest `inflight` on a waited line | Fail-open lines |
|---|---|---|---|---|
| 10-08 16:00 to 10-09 16:00 | 0 | 28 | 11 | 0 |
| 10-09 16:00 to 10-10 16:00 | 0 | 13 | 11 | 0 |
| 10-10 16:00 to 10-11 16:00 | 0 | 23 | 11 | 4 |
| 10-11 16:00 to 10-12 16:00 | 0 | 27 | **20** (10-11 about 17:14) | 0 |
| 10-12 16:00 to 10-13 00:00 | 0 | 35 | 13 | 26 |
| 10-13 00:00 to 10-14 00:00 | 0 | 130 | 11 | 20 |
| 10-14 00:00 to 10-15 00:00 | 0 | 8 | 6 | 0 |
| 10-15 00:00 to 10-15 16:00 | 0 | 4 | 4 | 0 |

- **Sheds: 0 in 7 days.** Control: the same filter mechanism returned the
  waited lines in every window, and `execution_steps` holds no step whose
  error starts `Salesforce bulkhead` in the same days.
- **Peak: 20 of 20, once**, on 2026-10-11 at about 17:14 (the sampled traces
  are Engine Bidding and LendSwift runs started between 17:14:31 and
  17:14:56), with waits up to 21,507 ms. Nothing shed because slots freed within the wait.
- Most waited lines show a low `inflight` (1 to 4) with a multi second wait: the
  wait was the Durable Object round trip itself, not a full bulkhead.
- **Fail open 50 times**, with waits up to 29,341 ms: 4 in the 10-10 to 10-11
  window and 46 during the 10-12 evening and the 10-13 incident. Those calls
  went to Salesforce with no slot, so the true in flight then is unknown and
  the cap did not apply.

**Step overlap, as a cross check.** Counting every native Salesforce step's
whole duration (`step_type = 'salesforce'`, non-test, all workflows) as one
slot, the running maximum per UTC day: 10-08 13, 10-09 16, 10-10 16, 10-11 23
(at 17:14:56, the same spike), 10-12 15, 10-13 21 (at 03:16), 10-14 15, over
142,559 to 190,777 steps a day. A step spans retries, backoff and the
bulkhead wait, so this overstates the slots held, and it misses steps whose
log row was lost, so it is a cross check rather than a bound. Porting the Main
Flow relays adds about 9,500 calls a day, about 5% of these steps.

### 4. Timeout samples

7 days, 2026-10-08 16:00 to 2026-10-15 16:00, non-test, from
`execution_steps.duration_ms`. A step with `retries_used = 0` is one attempt,
and its duration includes the bulkhead acquire and any token fetch.

**Main Flow `set_completed_submission`** (update `Submission__c`
`Completed_Submission_Flag__c`, `retries: 2`, no `timeout_ms`, so each attempt
is bounded by the node's 15 s call abort):

| | Count | p50 | p99 | p99.9 | Max |
|---|---|---|---|---|---|
| One attempt, completed | 23,318 | 696 ms | 1,685 ms | 4,474 ms | 14,540 ms |
| Completed after a retry | 1 | | | | 16,341 ms in total |
| Failed | 0 | | | | |

This PATCH changes none of the four completion conditions, so it runs the
Submission trigger and the else branch Lead update (`CreditFreeze__c`) but not
the completion flip, the Lead copy or the Lead flows that the completing outcome
PATCH fires synchronously. It is the right object and user but a lighter write.
The relay's own Salesforce step durations for the completing PATCH live only in
Pipedream's inspector and were not read (no browser in this pass).

**Engine Bidding `patch_prospect_reject`** (update `Prospect__c`, `retries: 2`,
`timeout_ms: 1500`):

| | Count | p50 | p99 | p99.9 | Max |
|---|---|---|---|---|---|
| All steps | 212,197 | 245 ms | 818 ms | 1,357 ms | 8,300 ms |
| One attempt, completed | 212,021 | 245 ms | 757 ms | 1,185 ms | 1,498 ms |
| Completed after a retry | 134 | 2,579 ms | 5,660 ms | 5,827 ms | 5,848 ms |
| Failed | 42 | 6,000 ms | 7,357 ms | 8,206 ms | 8,300 ms |

The one attempt maximum sits just under the 1,500 ms limit, so that
distribution is cut off by the timeout: 1,231 single attempts took over
1,000 ms and 182 over 1,200 ms. 176 steps (0.08%) had at least one attempt
fail (134 then succeeded on a retry, 42 failed). The failures read in the busiest day (40 of the 42, 2026-10-12 16:00
to 2026-10-13 16:00) were all `Step timed out after 1500ms`, 33 of them between
03:00 and 05:00 on 10-13. A timed out PATCH may still have landed. Durations
were pulled per day as raw values and the percentiles computed over the whole
week, because one 7 day percentile query timed out.

### 5. What `syncSubmissionsFromLead` writes (risk R2)

Read from the Tooling `ApexClass` and `ApexTrigger` bodies.

**`SubmissionService.updateRelatedLeadForSubmission`** (Submission after
update). On the completion flip (`Completed_Submission_SO__c` changing to Yes,
with a Lead) it updates the Lead with `Completed_Submission__c`,
`ActiveCompletedSubmission__c`, the Engine UUIDs and offer date (or nulls),
**`Submission_Object_ID__c` = this Submission**, `Submission_Timestamp__c`,
`Prospect__c`, and `populateLeadBySub`: identity and contact fields, debt and
loan fields, ADV, BES, LEG, XBC, RLA, attribution and click ids,
`Credit_Pull_Result_ES__c`, `PDFlow_1__c` to `PDFlow_8__c`, the external
exchange fields, `EQXCreditPullStatus__c`, `CreditFreeze__c`,
`VantageScore__c` (when not null), `InternalDebtRouting__c`, `LeadSaleType__c`,
`PD_Completed_Timestamp__c`, `AmOneBid__c`, `AmOneClickURL__c`,
`Minimum_EQX_Unsecured_Pmt__c` and others; then with a Prospect it clones files
and starts `TradeParserBatch`. Without a completion flip it updates only the
Lead's `CreditFreeze__c`. **It writes none of the four inquiry count fields.**

**`LeadTriggerHandler.syncSubmissionsFromLead`** (Lead after update) collects,
for the Lead's active Submission (`Lead.Submission_Object_ID__c`), the fields
that changed in this Lead update from these lists in `LeadConstants`: lead
score (9 fields), call booking (15), credit (`Credit_Status__c`,
`Estimated_Credit_Score__c`, `Verified_Debt_Range__c`), general
(`EngineDebt__c`, `ExternalPartnerName__c`), sales activity tracker (33) and
calculator (about 80, **including `Num_of_Inquiries_12M__c`,
`Num_of_Inquiries_24M__c` and `Num_of_Inquires_2Y__c`**, not
`InquiriesAmount__c`); the 27 Regal fields when any changed; the debt
resolution fields (26) to the enrollment Submission when the enrollment or
first draft date changed; and `Active_Submission_Date__c` and
`ReplacementDate__c` when the active Submission changed. It writes them in a
`LeadSubmissionSyncQueueable`, so after commit and asynchronously, not in the
caller's transaction.

**Where the active Submission points before the flip.** `populateSubmissionLead`
(Submission after insert) already sets `Lead.Submission_Object_ID__c` to the new
Submission unless the Lead has an active submission (`Active_Submission__c =
Yes`), in which case it stays on the older one until the completion flip moves
it.

**What changes if the Apex call runs after the completion flip.**

- No field is written by both: the flip's Lead update and the Apex's Lead update
  touch disjoint fields, so the final Lead values are the same in either order.
- The three inquiry counts are synced to whichever Submission the Lead points
  at when the Apex runs. Today that is this Submission in most cases, but the
  older active one for a returning Lead with an active submission. After the
  move it is always this Submission. Measured on the 150 non-empty posts above:
  142 Leads now point at the posting Submission, 8 at another; 130 of the 150
  Submissions carry `Num_of_Inquiries_12M__c` and 124 match their Lead. The
  move corrects the minority case rather than breaking the common one. (The
  remaining nulls are probably counts unchanged since the Lead's earlier pull,
  which the sync skips; that part is inferred, not measured.)
- Nothing else keyed on these four fields was found: they are not lead score
  inputs (`LEAD_SCORE_INPUT_FIELDS`), and none of the Lead flow entry
  conditions recorded under question 5 names them.
- New, unmeasured: the Apex call's Lead update will now run while the flip's own
  async work (`TradeParserBatch`, the sync queueable) may be updating the same
  Lead, so a row lock error (`UNABLE_TO_LOCK_ROW`) becomes possible where today
  the Apex call finishes first. The class answers any exception with a 500, so
  the canary should count Apex 500s by message.

The canary in #1680 should therefore check, per Submission, that the three
inquiry counts equal the Lead's (and expect them on this Submission, not the
older one).

## The write marker and the read-back (#2023)

**The marker.** Every post-answer `update` on `Applicant__c`, `Prospect__c` and
`Lead` carries `Bidspoke_Write__c = <execution id>:<step namespace>:<attempt>`
(Text 255, #2020). The engine adds it, not the canvas, so no workflow is edited
for it: the walk decides "post-answer" by a response already pending when the
step starts, the same fact that starts the at-risk watch (#2022), and hands the
marker to the Salesforce node for that step only. A write before the answer is
never stamped. Attempt 0 is the run's own step, every retry inside it included
(they send the identical PATCH); 1 and 2 are the read-back's resends. A marker
that would not fit 255 characters is not stamped at all, and that write keeps the
held alert. Code: `apps/worker/src/engine/write-marker.ts`.

**The read-back** (`apps/worker/src/lib/salesforce-read-back.ts`, every minute)
reads each held write's record once it is 3 minutes old (30 s for the last
attempt to be sent, plus 91.5 s, the longest Salesforce answer measured, rounded
up to minutes), judges "landed" by the write's own marker, merges several writes
to one record in attempt order (newer wins, and a later stamp never stands for an
earlier write), and resends what did not land, at most twice, under a claim that
fails closed. A field another writer set since the write began is never
overwritten and is named in a conflict alert. Its header has the rest.

**Submission is not covered.** `Submission__c` has no marker field. The only
native post-answer Submission write live today is Liberty1's `update_submission`
(about 30 a day), and it carries this run's link in `PDFlow_3__c`, not
`PDFlow_1__c`. The Main Flow's Submission writes are still relay posts (webhook
nodes, which the at-risk watch does not record) until #1680 ports them. Using
`PDFlow_3__c` as Liberty1's marker, or adding `Bidspoke_Write__c` to
`Submission__c`, is a decision recorded on #2023; until it is made, a held
Submission update keeps the held alert (#2163), as does any update held from
before the marker shipped.

## Open questions (consolidated)

All answered on 2026-10-15, read only; each answer is in its section. Two
residual items stay open for #1680, marked **Still open** below.

1. **Relay internal config.** Answered from the Pipedream UI: see "The relays'
   internal config". The Update Submission relay filters only on the presence
   of `submissionId`, PATCHes 28 named fields (two renamed from `UUID` and
   `leadUUID`) and drops every other key, `executionId` included. The Inquiries
   relay has no filter and makes two calls: a Submission PATCH of `PDFlow_4__c`
   and `VantageScore__c`, then the `/credit-inquiries` Apex REST POST. **Still
   open:** whether Pipedream omits an absent body key or sends it as null.
2. **Main Flow v1 / v2.** Two active records; only `60e2e0bc` (version 169) has
   run. `Main Flow (v2)` has never run. See "Main Flow v1 and v2".
3. **Inquiry post timing.** Always before the answer, inside a blocking
   parallel; 0 of 22,078 after it; its failure fails the lead. Not a #2023 case.
   See "Inquiry post timing".
4. **Field-level access and sharing.** No gap: the Bidspoke integration user has
   the relays' user's System Administrator profile, Modify All Data, and edit on
   all 70 fields. See "Field-level access and sharing".
5. **Salesforce automations.** Listed per object in "Salesforce automation
   side-effects"; none that could be read keys on the writing user. **Still open:** the managed
   `regal_voice.LeadTrigger` hides its body, so it could not be checked.
6. **Per-write daily volume.** About 54,300 post-answer writes a day; Main Flow
   relay posts about 3,290. See "Volume".
