# Post-answer Salesforce write contract

Phase A of the Salesforce writeback recovery epic (#2015, #2021). This is the
contract of every Salesforce write the live workflows make after the HTTP
response is sent to the client. #1680 (port the Main Flow relay posts to native
Salesforce steps) and #2023 (the read-back and resend) build from it.

It is a read-only record, derived from the repo. Everything here is drawn from
the live workflow definitions, the node executors, and the committed reference
artifacts. Where the contract depends on something the repo cannot show (the
Pipedream relay's own internal config, Salesforce field-level security and
sharing, and the Salesforce automations each write fires), it is called out as
an open question rather than guessed. Those gaps are the ones #1680 and #2023
have to close with Pipedream UI access and Salesforce access.

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

A note on "v1 and v2": #2021 asks for Main Flow v1 and v2. The backup holds one
current Main Flow definition (above). Whether a second live Main Flow record or
an older version is still running is an **open question** (see the end). The
contract below is the current definition.

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
sends; it does **not** show the relay's own filter, method, Salesforce
connection, or field mapping. Those are open questions for #1680. The relay URLs
are deliberately NOT written here: they carry no auth header, so the URL itself
is a bearer capability that can write to production Salesforce, and this doc is
committed. The full URLs live in the live workflow definitions and the backup.

| Relay | Endpoint | Used by | Writes to |
|---|---|---|---|
| Submission update | id redacted (bearer URL) | the 9 Main Flow outcome posts | `Submission__c` (per the epic and the `submissionId` key) |
| Inquiries update | id redacted (bearer URL) | `send_salesforce_inquiry` | Salesforce, Equifax inquiry data |

Known from the epic plan (read off Salesforce, not the repo): the Submission
relay maps the request keys `UUID` and `leadUUID` to `Engine_UUID_SO__c` and
`Engine_Lead_UUID_SO__c`, and `SubmissionService.completeSubmissionWithUUID`
runs as the relay's write to complete the Submission and sync the Lead only when
both change. The request field `submissionId` is the Submission record id the
relay targets; `executionId` and `PDFlow_1__c` carry the Bidspoke run id and
deep link. All other request keys named below are Salesforce field API names the
relay is assumed to write straight through, which #1680 must confirm against the
relay's actual mapping.

## Main Flow post-answer writes, by state reached

Main Flow (`60e2e0bc`) is the inbound form-lead flow and the highest-volume
workflow. Its trigger declares these as the success (terminal) nodes. The nine
outcome posts are each wired directly after their branch's `response` node, so
each runs **after** the client has its answer:

`tripoint_sf_post`, `amone_sf_post`, `send_salesforce`,
`send_fallback_salesforce`, `send_fallback_salesforce_1`,
`engine_no_bids_sf_post`, `under_10000_sf_post`, `invalid_state_sf_post`,
`debt_missing_sf_post`.

The tenth, `send_salesforce_inquiry`, is not wired after a response node; it
runs inside a parallel branch, so its position relative to the answer is the
open question in its own section below.

All post to the Submission relay (id redacted) except the inquiry post.
The record is always the Submission, keyed by `submissionId` =
`{{trigger.payload.Submission__c}}`. Routing codes seen: 1 = Engine, 2 =
Tripoint, 3 = AmOne. Exchange status is written `Pending` by the live canvas
(the reference export wrote `Completed` for Engine paths). The likely reason,
inferred from the epic notes and not confirmed in the repo, is that the
Completed flip now happens Salesforce-side via `completeSubmissionWithUUID` when
`UUID` / `leadUUID` are present; open question below.

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
`leadUUID`: they are not an Engine sale, so they do not trip the relay's
Submission-completion path. The Engine posts do send them.

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

Open question: this post sits inside a parallel branch rather than strictly
after a response node, so whether it always runs after the answer (and therefore
whether #2023's read-back should cover it) needs the branch timing confirmed.

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
are already the shape #1680 is moving the Main Flow toward. #2023's read-back
covers Submission writes first (B of the epic); the others wait on a dedicated
marker field (#2020).

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
  `patch_prospect_body` code node.
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
| Main Flow | `Submission__c` (via relay) | `trigger.payload.Submission__c` | 9 relay posts, plus `send_salesforce_inquiry` (parallel branch, post-answer timing is open question 3) |
| Engine Bidding | `Prospect__c` | `generate_trades_body.output.prospectId` | `patch_prospect`, `patch_prospect_reject` |
| Lead Economy | `Prospect__c` | `create_prospect.output.body.id` (and `generate_trades_body...` for `patch_prospect`) | `patch_prospect`, `patch_prospect_success` / `_duplicate` / `_error` / `_missing_credit` |
| Liberty1 Click | `Prospect__c`, `Submission__c`, `Lead` | `pick_record.output.{prospect,submission,lead}_id` | `update_prospect`, `update_submission`, `update_lead` |
| RML LendSwift / GigFi | `Applicant__c` | `create_applicant.output.body.id` | `patch_applicant_bid`, `patch_applicant_no_bid` |

## Field-level access and sharing

Open, because the repo cannot show a Salesforce user's field-level security or
sharing. What the repo does establish:

- The native node writes as the **Bidspoke integration user** (client-credentials
  OAuth, `SALESFORCE_CLIENT_ID`). The relay almost certainly writes as a
  **different, non-integration user** (whoever owns the Pipedream Salesforce
  connection), but the repo cannot show that connection, so the relay's writing
  identity is inferred, not established here (open question 1). If it holds,
  porting a relay post to a native step (#1680) changes the writing user, and the
  integration user needs field-level write access and record access to every
  field and record the relay writes today.

Open questions for #1680 / #2023 (require Salesforce access):

- Does the Bidspoke integration user have field-level write access to every
  mapped field on `Submission__c` (and on `Lead` for the Submission-relay's Lead
  sync, and on `Prospect__c` / `Applicant__c`)?
- What is the integration user's sharing and record access to the Submission,
  Lead, Prospect and Applicant records it will update? The epic notes
  `SubmissionService` is `with sharing`, and the relay currently writes as a
  different user, so parity is not guaranteed.
- Which fields are formula / read-only / managed, so a native write would be
  rejected where the relay's user or path was allowed?

## Salesforce automation side-effects

Open, because the automations live in Salesforce metadata the repo does not
hold. What the repo shows that implies side-effects:

- **Submission completion and Lead sync.** The epic records (read off Salesforce)
  that the Submission relay's `UUID` / `leadUUID` keys drive
  `SubmissionService.completeSubmissionWithUUID` (completes the Submission and
  stamps `Engine_Offers_Date_SO__c` when both change) and
  `updateRelatedLeadForSubmission` (syncs the Lead on the Completed flip). The
  2026-10-13 hand repair omitting those keys left Leads synced with blank Engine
  fields, which is the concrete proof these side-effects matter.
- **Revenue formulas keyed on fields Bidspoke writes.** ADR 0010 records that
  Main Flow leads book revenue through `Lead.ExternalRevenue__c` and external
  partner leads through `Prospect__c.ExternalExchangeRevenue__c`, both derived
  from debt fields. A write that changes a debt or partner field feeds those.

Open questions (require Salesforce access), as listed on #2021:

- The `Submission__c` trigger and `Custom_Event_30_Helper`.
- The 16 Lead after-save flows (which fire on the Lead sync).
- The Prospect before-save flows.
- Whether any automation keys on the **writing user** (the relay's user), which
  would change behaviour when the write moves to the Bidspoke integration user.

Knowing these matters for #2023 because a resend re-fires whatever the write
triggers, so a resend is only safe once the side-effects of a second identical
write are known.

## Volume

Exact per-write daily counts are an open question (they come from execution and
Snowflake data, not the repo). What is known:

- Main Flow is the highest-volume inbound flow and the dominant source of these
  writes.
- The #2015 revised plan estimates roughly 100,000 post-answer writes a day
  across all flows (the figure behind the decision to record at risk only after
  a 2 s delay). Treat this as an estimate to be measured, not a repo fact.
- ADR 0002 measures that about 5% of finalized leads a day lose their
  post-response database finalize to Worker eviction; the Salesforce writeback
  sits in the same post-response window and the 2026-10-13 incident measured 8
  of 18 flagged writes (44%) not landing under an upstream slowdown.

#1680 should pull the real per-node daily counts (for the API-quota sizing it
calls for) and record them here.

## Open questions (consolidated)

For #1680 and #2023 to resolve with Pipedream UI and Salesforce access:

1. **Relay internal config.** Both relays' filter rules, HTTP method, Salesforce
   connection, and the full key-to-field mapping. The role of five keys is
   understood (`submissionId` is the target record id, `UUID` / `leadUUID` map
   to `Engine_UUID_SO__c` / `Engine_Lead_UUID_SO__c`, and `PDFlow_1__c` /
   `executionId` carry the run deep link and id); every other key is assumed to
   write straight through to a like-named field, which this item must confirm.
   Also confirm the relay does nothing beyond the Salesforce write.
2. **Main Flow v1 / v2.** Whether a second live Main Flow record or an older
   version is running beyond the one definition in the backup.
3. **Inquiry post timing.** Whether `send_salesforce_inquiry` always runs after
   the response (it sits inside a parallel branch), hence whether #2023 covers
   it.
4. **Field-level access and sharing** for the Bidspoke integration user on every
   mapped field and record (Submission, Lead, Prospect, Applicant).
5. **Salesforce automations** each write fires (Submission trigger,
   `Custom_Event_30_Helper`, the 16 Lead after-save flows, Prospect before-save
   flows) and whether any keys on the writing user.
6. **Per-write daily volume**, from execution or Snowflake data.
