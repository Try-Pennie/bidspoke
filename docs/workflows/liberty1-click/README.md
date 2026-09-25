# Liberty1 click workflow

Replaces Brian's Pipedream flow `eoltut7tgps3yat` (issue #1545, milestone "Click sold buyers"). When a person clicks the Liberty1 offer in the portal, this workflow sends that prospect to Liberty1 once, counts the click, and records the outcome on the prospect's Salesforce records.

[`definition.json`](./definition.json) is the whole workflow. Its three code node scripts are kept, tested files in [`apps/worker/src/engine/scripts/liberty1-click/`](../../../apps/worker/src/engine/scripts/liberty1-click/), and a test fails if the definition and those files ever differ.

## What it does

1. **Receives the click.** A custom endpoint, POST with a JSON body and an `X-API-Key`. The body is `{"Prospect__c": "<id>"}` or `{"Submission__c": "<id>"}`, whichever the portal has.
2. **Works out the prospect** (`resolve_input`). A `Prospect__c` that is a 15 or 18 character Salesforce id is used directly. Otherwise a `Submission__c` that is one is used, and the prospect is read through that submission. A `Submission__c` sent beside a usable `Prospect__c` is ignored, because nothing ties it to that prospect. Anything else is refused before any query is built from it.
3. **Reads the prospect** from Salesforce (`query_prospect`): every field Brian's flow read, plus `ExternalRoutingCode__c` and `ExternalExchangeStatus__c`.
4. **Checks the Liberty1 offer is on record** (`check_offer`). Only a prospect with routing code 4 and exchange status Bid is sent. This is what stops an arbitrary id posted to the public URL being sold or counted.
5. **Builds the request** (`build_request`): Brian's body, byte for byte, to the DV1 URL for DE, HI, IA, MN, OR, RI, VT, WA, WI and WY, and to DI4 for every other state.

   **Since Brian's version 4 (2026-09-25) the two routes are LeadConnector webhook triggers**, not the Liberty1 Salesforce site his Pipedream flow posts to (`https://services.leadconnectorhq.com/hooks/1TkhxxyKTddL2rZ7wHI2/webhook-trigger//<route id>`, the doubled slash as saved). Two things are unconfirmed and must be settled before the workflow is switched on: whether the doubled slash is intended, and what LeadConnector answers on success. `click_send` still counts a click only on "Records created successfully", so until its success pattern matches LeadConnector's answer every click routes `unknown`: nothing is written, nothing is counted, and it pages.
6. **Sends it** (`click_send`, a Buyer Click Send node). The node claims the prospect so two clicks cannot both send it, posts, and counts it only when Liberty1 answers "Records created successfully". See [the node's page](../../nodes/buyer-click-send.md).
7. **Answers the portal**, then **writes Salesforce** (sent and refused only): the Prospect, then the Submission and its Lead when the click came with a Submission id.

## Every outcome

| What happened | Portal gets | Salesforce |
|---|---|---|
| Body has no id | 400 `{"success": false, "outcome": "invalid_request", "reason": "no_id"}` | nothing read, nothing written |
| An id that is not a Salesforce id | 400, reason `invalid_id` | nothing read, nothing written |
| No such prospect (or the submission points at none) | 404 `prospect_not_found` | nothing written |
| Prospect without the Liberty1 offer (any routing code but 4, or a status other than Bid or Completed) | 409 `no_liberty1_offer` | nothing written |
| Liberty1 offer already Completed | 200 `{"success": true, "outcome": "already_sent"}` | nothing written, nothing sent |
| `sent`: Liberty1 created the record | 200 `{"success": true, "outcome": "sent"}` | Completed, with Liberty1's lead id |
| `refused`: Liberty1 turned it down with its own error | 200 `{"success": false, "outcome": "refused"}` | Fail, no partner lead id |
| `already_sent`: an earlier click already sent this prospect | 200 `{"success": true, "outcome": "already_sent"}` | nothing written |
| `unknown`: no readable answer (timeout, 5xx, an HTML page) | 200 `{"success": false, "outcome": "unknown"}` | nothing written; the node pages and holds the claim until a person checks with Liberty1 |
| `needs_review`: an earlier send never recorded its outcome | 200, outcome `needs_review` | nothing written; paged |
| `in_progress`: another click is sending it right now | 200, outcome `in_progress` | nothing written |
| `not_sent`: a Test Runner or shadow run | 200, outcome `not_sent` | nothing written, nothing sent |

The Salesforce writes are Brian's three bodies, field for field: exchange status, Liberty1's lead id (sent only), partner name `Liberty1`, routing code 4 (a Number on the Prospect, text on the Submission and Lead), the Liberty1 TCPA text, the time of the write, lead sale type `Form`, and on the Prospect and Submission `PDFlow_3__c`, which now holds this run's Bidspoke execution link where Brian's held the Pipedream inspect URL. Nothing is written as blank.

**When the portal is answered.** As soon as the send's outcome is known: after Liberty1 answers (up to the node's 20 second timeout), before the Salesforce writes. Brian's flow answered at the same point. Whether the portal waits on the answer at all is not known; if it does not, nothing is lost.

**Changes from Brian's flow, on purpose.**
- A 2xx from Liberty1 that is not the success line was written as Fail. It is now `unknown`: nothing is written and a person is paged, because Liberty1 may have created the record.
- A prospect without the Liberty1 offer is refused. Brian's flow sent any prospect it was given.
- Failures page through Bidspoke, not the hard coded Slack webhook.
- The portal's answer says what happened. Brian's always said `{"success": true}`. Brian needs to confirm the portal does not act on a `false` or on the 400, 404 and 409 statuses.

**Kept from Brian's flow, worth knowing.** A click that arrives with only a `Prospect__c` updates the Prospect alone: the Lead is found only through a Submission, as in his flow. And once a Fail is written, the offer check refuses the next click on that prospect, because its status is no longer Bid.

## What Dan builds

The Liberty1 partner must exist first: a partner of type Buyer on the Partners page, which is what the send node's partner picker lists. It was created on 2026-09-25 (#1547), slug `liberty1`. That partner record names the click claim and the daily click count, so create it once and keep it. The 50 clicks a day is set on its buyer profile (Clicks per day), not on this workflow: the offer side stops offering at it and the send node judges its over cap notice against the same number (#1543).

Then, either:

- **Create it from the file** (quickest): a session POSTs `definition.json` to `/api/workflows` (the file is exactly that request's body), which creates the workflow switched ON: the create route always does, whatever the body says. Switch it off straight after (`PATCH /api/workflows/:id` with `{"is_active": false}`, the Workflows list toggle). The session must call as a user of the production organization, so from Dan's logged in browser tab, not with the E2E user. Dan opens it, sets the partner (below), and saves. This is how it was built on 2026-09-25: workflow `8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08`, renamed on the canvas to "Liberty1 Click Handler".
- **Or build it on the canvas** by hand, node by node, using `definition.json` as the list: each node's namespace, type and config are there, and every code node's script box gets the matching file pasted in full.

**The partner field.** In `definition.json` it is the one line `"partner_id": ""` on the `click_send` node: Liberty1's partner id (#1553), deliberately left empty because the partner does not exist yet. Empty, the canvas marks the node "No partner selected" and refuses to save the workflow live, so it cannot go live without a buyer. Pick Liberty1 in the node's partner picker, which fills it in.

**Before switching it on:**
1. Create an API key on the API Sources page, then a custom endpoint for the workflow on the Endpoints page (partner slug `liberty1`, path `/click`). The endpoint form has no key field: any key on API Sources opens it. Give partners the `https://hook.trypennie.dev/liberty1/click` form of the address; `liberty1.trypennie.dev` answers Cloudflare error 1014 and never reaches Bidspoke.
2. Run it from the Test Runner with `{"Prospect__c": "<a real Liberty1 Bid prospect>"}`. A test run checks everything and routes `not_sent`: nothing is claimed, sent, counted or written.
3. The workflow's id is in `LIBERTY1_CLICK_WORKFLOW_ID` (`apps/worker/src/lib/engine-script-drift.ts`, #1547), so the hourly drift check compares the canvas with the kept scripts.

## What Brian changes

In the `liberty-1-proxy` worker (`libertyone.trypennie.app/cta-clicked`), point the forward at the Bidspoke custom endpoint instead of Pipedream, then turn the Pipedream flow off. How to wire a proxy to a custom endpoint: [partner-proxy-to-bidspoke.md](../../partner-proxy-to-bidspoke.md).

- **It must forward a POST, with the JSON body.** A custom endpoint answers any GET with `{"ok": true}` and runs nothing, so a GET forward looks healthy and sends no one.
- Send the endpoint's `X-API-Key`.
- Confirm what the portal does with the answer (see above).
