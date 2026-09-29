# Liberty1 click workflow

Replaces Brian's Pipedream flow `eoltut7tgps3yat` (issue #1545, milestone "Click sold buyers"). When a person clicks the Liberty1 offer in the portal, this workflow sends that person to Liberty1 once, counts the click, and records the outcome on their Salesforce records. The person is a Prospect, or, since 2026-09-29, a Submission with no Prospect (Brian's change to his flow that day).

[`definition.json`](./definition.json) is the whole workflow. Its four code node scripts are kept, tested files in [`apps/worker/src/engine/scripts/liberty1-click/`](../../../apps/worker/src/engine/scripts/liberty1-click/), and a test fails if the definition and those files ever differ.

## What it does

1. **Receives the click.** A custom endpoint, POST with a JSON body and an `X-API-Key`. The body is `{"Prospect__c": "<id>"}` or `{"Submission__c": "<id>"}`, whichever the portal has.
2. **Works out the query** (`resolve_input`). A `Prospect__c` that is a 15 or 18 character Salesforce id queries that prospect. Otherwise a `Submission__c` that is one queries the submission itself, with its Lead and, through `Prospect__r`, every field of the prospect it points at. A `Submission__c` sent beside a usable `Prospect__c` is ignored, because nothing ties it to that prospect. Anything else is refused before any query is built from it.
3. **Reads the record** from Salesforce (`query_record`): every field Brian's flow read, plus the routing code and exchange status.
4. **Picks what to send** (`pick_record`), then **checks the offer** (`check_offer`):
   - A prospect, or a submission whose prospect came back, is judged on the **prospect**: only routing code 4 with exchange status Bid is sent. This is what stops an arbitrary id posted to the public URL being sold or counted.
   - A submission with **no Prospect is trusted** (Dan, 2026-09-29): nothing writes a Liberty1 offer onto a Submission before the click, so there is no mark to check. It is sent from the submission's own `*_SO__c` fields, the phone taken from its Lead first (Brian's `submissionAsProspect`), unless the submission itself is already Completed for Liberty1. A submission completed for another buyer is still sent, as in Brian's flow.
   - A submission that names a prospect Salesforce does not return is refused as not found, never sent from the submission instead.
5. **Builds the request** (`build_request`): Brian's body, byte for byte, to the DV1 URL for DE, HI, IA, MN, OR, RI, VT, WA, WI and WY, and to DI4 for every other state.

   **The routes are the Liberty1 Salesforce site again** (`https://liberty1financial.my.salesforce-sites.com/L1F/services/apexrest/inbound/webhooks/DV1` and `/DI4`), where Brian's flow posts since 2026-09-29 "until later in the week". From 2026-09-25 they were LeadConnector webhook triggers (Brian's version 4); when Liberty1 moves back to LeadConnector, two things must be settled first: whether the doubled slash in those URLs is intended, and what LeadConnector answers on success, because `click_send` counts a click only on "Records created successfully" and every other answer routes `unknown`.
6. **Sends it** (`click_send`, a Buyer Click Send node). The node claims the click so two cannot both send it, keyed on the prospect, or on the submission when there is no prospect, posts, and counts it only when Liberty1 answers "Records created successfully". See [the node's page](../../nodes/buyer-click-send.md).
7. **Answers the portal**, then **writes Salesforce** (sent and refused only): the Prospect when there is one, then the Submission and its Lead when the click came with a Submission id.

## Every outcome

| What happened | Portal gets | Salesforce |
|---|---|---|
| Body has no id | 400 `{"success": false, "outcome": "invalid_request", "reason": "no_id"}` | nothing read, nothing written |
| An id that is not a Salesforce id | 400, reason `invalid_id` | nothing read, nothing written |
| No such prospect (or the submission names one Salesforce does not return) | 404 `prospect_not_found` | nothing written |
| No such submission | 404 `submission_not_found` | nothing written |
| Prospect without the Liberty1 offer (any routing code but 4, or a status other than Bid or Completed) | 409 `no_liberty1_offer` | nothing written |
| Liberty1 offer already Completed (on the prospect, or on a submission with no prospect) | 200 `{"success": true, "outcome": "already_sent"}` | nothing written, nothing sent |
| A submission with no prospect, not yet Completed for Liberty1 | sent with no offer check, then as the rows below | the Submission and its Lead only |
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
- A prospect without the Liberty1 offer is refused. Brian's flow sent any prospect it was given. A submission with no prospect is still sent without one, as his flow does, because nothing records an offer there.
- Failures page through Bidspoke, not the hard coded Slack webhook.
- The portal's answer says what happened. Brian's always said `{"success": true}`. Brian needs to confirm the portal does not act on a `false` or on the 400, 404 and 409 statuses.

**Kept from Brian's flow, worth knowing.** A click that arrives with only a `Prospect__c` updates the Prospect alone: the Lead is found only through a Submission, as in his flow. A submission with no prospect updates the Submission and its Lead, never a Prospect. And once a Fail is written, the offer check refuses the next click on that prospect, because its status is no longer Bid.

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

**The 2026-09-29 change on the canvas.** The live workflow (version 6) predates the Submission-only change, and the drift check reads that as a paste awaited, not a drift, through the baselines recorded that day. The canvas needs: `resolve_input` and `build_request` pasted again; `query_prospect` renamed `query_record`, its SOQL `{{steps.resolve_input.output.soql}}`; a new `pick_record` code node between it and `check_offer`; `check_offer`'s three branches reading `steps.pick_record.output.verdict`; the not found response's outcome `{{steps.pick_record.output.not_found_outcome}}`; `click_send`'s prospect id `{{steps.pick_record.output.sale_key}}`; a new `check_prospect` filter after `check_write` whose pass goes to `update_prospect` and whose exit goes to `check_submission`; the three update nodes' record ids and the two gates' fields reading `pick_record`; and `find_lead` deleted. After the paste, set the two baselines back to null and drop `pick_record`'s `newNodeSince`.

## What Brian changes

In the `liberty-1-proxy` worker (`libertyone.trypennie.app/cta-clicked`), point the forward at the Bidspoke custom endpoint instead of Pipedream, then turn the Pipedream flow off. How to wire a proxy to a custom endpoint: [partner-proxy-to-bidspoke.md](../../partner-proxy-to-bidspoke.md).

- **It must forward a POST, with the JSON body.** A custom endpoint answers any GET with `{"ok": true}` and runs nothing, so a GET forward looks healthy and sends no one.
- Send the endpoint's `X-API-Key`.
- Confirm what the portal does with the answer (see above).
