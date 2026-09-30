# Liberty1 click workflow

Replaces Brian's Pipedream flow `eoltut7tgps3yat` (issue #1545, milestone "Click sold buyers"). When a person clicks the Liberty1 offer in the portal, this workflow sends that person to Liberty1 once, counts the click, and records the outcome on their Salesforce records. The person is a Prospect, or, since 2026-09-29, a Submission with no Prospect (Brian's change to his flow that day).

[`definition.json`](./definition.json) is the whole workflow. Its four code node scripts are kept, tested files in [`apps/worker/src/engine/scripts/liberty1-click/`](../../../apps/worker/src/engine/scripts/liberty1-click/), and a test fails if the definition and those files ever differ.

## What it does

1. **Receives the click.** A custom endpoint, POST with a JSON body and an `X-API-Key`. The portal's body carries both ids, `{"Prospect__c": "<id>", "Submission__c": "<id>"}`; either alone is still accepted.
2. **Works out the query** (`resolve_input`). A valid `Submission__c` (a 15 or 18 character Salesforce id) queries the submission itself, with its Lead and, through `Prospect__r`, every field of the prospect it points at. The portal sends both ids, and then the submission must belong to the posted `Prospect__c` or the click is refused as `submission_not_for_prospect` with nothing sent. A valid `Prospect__c` with no usable `Submission__c` queries that prospect directly. A `Prospect__c` that is present but not an id is refused. Anything else is refused before any query is built from it.
3. **Reads the record** from Salesforce (`query_record`): every field Brian's flow read, plus the routing code and exchange status.
4. **Picks what to send** (`pick_record`), then **checks the offer** (`check_offer`):
   - A prospect, or a submission whose prospect came back, is judged on the **prospect**: only routing code 4 with exchange status Bid is sent. This is what stops an arbitrary id posted to the public URL being sold or counted.
   - A submission with **no Prospect is trusted** (Dan, 2026-09-29): nothing writes a Liberty1 offer onto a Submission before the click, so there is no mark to check. It is sent from the submission's own `*_SO__c` fields, the phone taken from its Lead first (Brian's `submissionAsProspect`), unless the submission is already Completed: for Liberty1 it is answered already sent, and for any other buyer refused as no Liberty1 offer (Dan, 2026-09-29), so one person is not sold twice. Brian's flow sends those.
   - A submission that names a prospect Salesforce does not return is refused as not found, never sent from the submission instead.
5. **Builds the request** (`build_request`): Brian's body, byte for byte except `consentsToTcpa`, which is always true because the button the person pressed sits under Liberty1's own TCPA disclosure (Dan, 2026-09-29; his flow copied the earlier form's flag, which reads false for most leads). It returns the body and the lead's state, and nothing about where the lead goes (#1671).

   **The routes are on Liberty1's buyer profile** (Click delivery on the partner page, #1639, filled 2026-09-30 19:00 UTC), and `click_send` picks one by the state: DV1 for DE, HI, IA, MN, OR, RI, VT, WA, WI and WY, DI4 for every other state. They are Liberty1's LeadConnector webhook triggers (Dan, 2026-09-30): `https://services.leadconnectorhq.com/hooks/1TkhxxyKTddL2rZ7wHI2/webhook-trigger/CTTs3WKFFvjTUTQOlrHF` for DV1 and `.../webhook-trigger/AYAF77n9lUw8WbZ4kaRM` for DI4. From 2026-09-29 to 2026-09-30 the canvas posted to the Liberty1 Salesforce site instead. An endpoint Liberty1 moves is now a profile edit, with version history, not a script paste.
6. **Sends it** (`click_send`, a Buyer Click Send node). The node claims the click so two cannot both send it, keyed on the prospect, or on the submission when there is no prospect, posts to the profile route for the lead's state (the node's `state` template, `{{steps.build_request.output.state}}`), and counts it only when LeadConnector answers its success reply, HTTP 200 with `{"status":"Success: request sent to trigger execution server","id":"w5Rjej9mohRyKpeG3la6"}`. The success reply, on the buyer profile since #1671 (the node holds no address or success line of its own), is

   ```
   ^\s*\{(?=[\s\S]*"status"\s*:\s*"Success)[\s\S]*?"id"\s*:\s*"(?<id>[A-Za-z0-9]{15,20})"[\s\S]*\}\s*$
   ```

   **What that reply means.** It says LeadConnector queued the lead to Liberty1's LeadConnector workflow, not that a Liberty1 record was created: whatever that workflow does afterwards, a refusal included, is not reported back. The `id` is LeadConnector's run id for the trigger, not a Liberty1 or Salesforce record id, and it is what `click_patch` writes as the partner lead id on Completed. The step's detail reads "the buyer confirmed receipt with id" followed by that run id, and the pages for a failed sold mark or count say the same, because receipt is all the success line proves. Every other answer (an error body, an empty body, an HTML page, the Salesforce site's "Records created successfully") routes `unknown`. See [the node's page](../../nodes/buyer-click-send.md).
7. **Answers the portal**, then **writes Salesforce** (sent and refused only): the Prospect when there is one, then the Submission and its Lead when the click came with a Submission id (the portal always sends one).

## Every outcome

| What happened | Portal gets | Salesforce |
|---|---|---|
| Body has no id | 200 `{"success": false, "outcome": "invalid_request", "reason": "no_id"}` | nothing read, nothing written |
| An id that is not a Salesforce id | 200, outcome `invalid_request`, reason `invalid_id` | nothing read, nothing written |
| No such prospect (or the submission names one Salesforce does not return) | 200, outcome `prospect_not_found` | nothing written |
| No such submission | 200, outcome `submission_not_found` | nothing written |
| A submission posted with a prospect it does not belong to | 200, outcome `submission_not_for_prospect` | nothing written, nothing sent |
| Prospect without the Liberty1 offer (any routing code but 4, or a status other than Bid or Completed), or a submission with no prospect already Completed for another buyer | 200, outcome `no_liberty1_offer` | nothing written |
| Liberty1 offer already Completed (on the prospect, or on a submission with no prospect) | 200 `{"success": true, "outcome": "already_sent"}` | nothing written, nothing sent |
| A submission with no prospect, not yet Completed for Liberty1 | sent with no offer check, then as the rows below | the Submission and its Lead only |
| `sent`: LeadConnector queued the lead to Liberty1's workflow | 200 `{"success": true, "outcome": "sent"}` | Completed, with LeadConnector's run id as the partner lead id |
| `refused`: Liberty1 turned it down with its own error | 200 `{"success": false, "outcome": "refused"}` | Fail, no partner lead id |
| `already_sent`: an earlier click already sent this prospect | 200 `{"success": true, "outcome": "already_sent"}` | nothing written |
| `unknown`: no readable answer (timeout, 5xx, an HTML page) | 200 `{"success": false, "outcome": "unknown"}` | nothing written; the node pages and holds the claim until a person checks with Liberty1 |
| `needs_review`: an earlier send never recorded its outcome | 200, outcome `needs_review` | nothing written; paged |
| `in_progress`: another click is sending it right now | 200, outcome `in_progress` | nothing written |
| `not_sent`: a Test Runner or shadow run | 200, outcome `not_sent` | nothing written, nothing sent |

The Salesforce writes are Brian's three bodies, field for field: exchange status, the partner lead id (sent only; LeadConnector's run id since 2026-09-30), partner name `Liberty1`, routing code 4 (a Number on the Prospect, text on the Submission and Lead), the Liberty1 TCPA text, the time of the write, lead sale type `Form`, and on the Prospect and Submission `PDFlow_3__c`, which now holds this run's Bidspoke execution link where Brian's held the Pipedream inspect URL. Nothing is written as blank.

**When the portal is answered.** As soon as the send's outcome is known: after Liberty1 answers (up to the node's 20 second timeout), before the Salesforce writes. Brian's flow answered at the same point. Whether the portal waits on the answer at all is not known; if it does not, nothing is lost.

**Changes from Brian's flow, on purpose.**
- A 2xx that is not the success reply was written as Fail. It is now `unknown`: nothing is written and a person is paged, because Liberty1 may have received it.
- A prospect without the Liberty1 offer is refused. Brian's flow sent any prospect it was given. A submission with no prospect is still sent without one, as his flow does, because nothing records an offer there.
- Failures page through Bidspoke, not the hard coded Slack webhook.
- `consentsToTcpa` is always true. Brian's flow copied the earlier form's `TCPAConsentFlag__c`, which reads false for most leads; the person reaches this workflow only by pressing the button under Liberty1's own TCPA disclosure, so the press is the consent (Dan, 2026-09-29). The flag is still queried and mapped, now unused by the send.
- The portal's answer says what happened in its body. Brian's always said `{"success": true}`. Every answer is a 200, because the portal moves to the Liberty1 lander only on a 200 (Brian, 2026-09-29); `success` and `outcome` in the body carry the result.

**Kept from Brian's flow, worth knowing.** A click that arrives with only a `Prospect__c` updates the Prospect alone: the Lead is found only through a Submission, as in his flow. A submission with no prospect updates the Submission and its Lead, never a Prospect. And once a Fail is written, the offer check refuses the next click on that prospect, because its status is no longer Bid.

## What Dan builds

The Liberty1 partner must exist first: a partner of type Buyer on the Partners page, which is what the send node's partner picker lists. It was created on 2026-09-25 (#1547), slug `liberty1`. That partner record names the click claim and the daily click count, so create it once and keep it. The 50 clicks a day is set on its buyer profile (Clicks per day), not on this workflow: the offer side stops offering at it and the send node judges its over cap notice against the same number (#1543).

Then, either:

- **Create it from the file** (quickest): a session POSTs `definition.json` to `/api/workflows` (the file is exactly that request's body), which creates the workflow switched ON: the create route always does, whatever the body says. Switch it off straight after (`PATCH /api/workflows/:id` with `{"is_active": false}`, the Workflows list toggle). The session must call as a user of the production organization, so from Dan's logged in browser tab, not with the E2E user. Dan opens it, sets the partner (below), and saves. This is how it was built on 2026-09-25: workflow `8a0f65aa-49a9-441c-a47e-b2a9a5fb2b08`, renamed on the canvas to "Liberty1 Click Handler".
- **Or build it on the canvas** by hand, node by node, using `definition.json` as the list: each node's namespace, type and config are there, and every code node's script box gets the matching file pasted in full.

**The partner field.** In `definition.json` it is the one line `"partner_id"` on the `click_send` node: Liberty1's partner id (#1553). It was left empty while the partner did not exist, so a copy could not go live without a buyer; since #1662 it holds the id the canvas picked (`4ed89cc6-b25b-4537-8b3d-5bf1fc237cc3`, slug `liberty1`), because the hourly drift check compares this file's settings with the canvas. Building the workflow in another organization means picking that organization's Liberty1 in the node's partner picker.

**Before switching it on:**
1. Create an API key on the API Sources page, then a custom endpoint for the workflow on the Endpoints page (partner slug `liberty1`, path `/click`). The endpoint form has no key field: any key on API Sources opens it. Give partners the `https://hook.trypennie.dev/liberty1/click` form of the address; `liberty1.trypennie.dev` answers Cloudflare error 1014 and never reaches Bidspoke.
2. Run it from the Test Runner with `{"Prospect__c": "<a real Liberty1 Bid prospect>"}`. A test run checks everything and routes `not_sent`: nothing is claimed, sent, counted or written.
3. The workflow's id is in `LIBERTY1_CLICK_WORKFLOW_ID` (`apps/worker/src/lib/engine-script-drift.ts`, #1547), so the hourly drift check compares the canvas with the kept scripts, and (#1662) every node's outcome deciding settings with this file: the send node's partner, prospect and body templates and state template, the Salesforce queries and writes, the branch and filter conditions and the responses. The field list, with the reason for each setting watched or not, is `WATCHED_CONFIG_FIELDS` and `UNWATCHED_CONFIG_FIELDS` in `apps/worker/src/lib/kept-node-config.ts`. A canvas edit to one of them pages until it is copied here.

**The 2026-09-29 change on the canvas** was saved as version 7 the same day through the workflow API, applied onto version 6 so the picked partner and the layout stayed.

**The 2026-09-30 change** was made on the canvas: version 11 (15:46:50 UTC) moved `build_request` back to the LeadConnector routes and version 12 (15:57:59 UTC) set `click_send`'s success line to LeadConnector's reply. The kept files and `definition.json` were brought to version 12 afterwards. Version 14 (19:00 UTC) added `click_send`'s `state` template, the same hour Liberty1's profile gained its Click delivery.

**#1671** then took the routes out of `build_request` and the address and success line off `click_send`, here first, and Dan applied both on the canvas as version 15 (2026-09-30 19:54 UTC). The drift check holds no baseline for any of the four scripts, and a `request_url` or `success_pattern` reappearing on `click_send` pages as a retired setting (`RETIRED_CONFIG_FIELDS` in `kept-node-config.ts`), because the node no longer reads either.

## What Brian changes

In the `liberty-1-proxy` worker (`libertyone.trypennie.app/cta-clicked`), point the forward at the Bidspoke custom endpoint instead of Pipedream, then turn the Pipedream flow off. How to wire a proxy to a custom endpoint: [partner-proxy-to-bidspoke.md](../../partner-proxy-to-bidspoke.md).

- **It must forward a POST, with the JSON body.** A custom endpoint answers any GET with `{"ok": true}` and runs nothing, so a GET forward looks healthy and sends no one.
- Send the endpoint's `X-API-Key`.
- Every answer is a 200, so the portal can move to the lander on any answer; `success` and `outcome` in the body say what happened (settled 2026-09-29).
