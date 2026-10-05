# Buyer Click Send node

Sends one clicked prospect to a click sold buyer (Liberty1 first, EvaFi later), exactly once, and counts it exactly once. A click sold buyer is paid per click: a person saw the buyer's offer, clicked through, and the click workflow hands the prospect to the buyer. The node does the three things that must not come apart, in one step: it claims the prospect for the buyer, posts it, and adds it to the buyer's click count for the day.

## When to use it

In a click workflow, after a code node has built the request body for the buyer and the lead's state, and before the Salesforce updates that record the outcome. The node routes on what happened, so the Salesforce steps after it only write Completed on `sent` and Fail on `refused`, and write nothing when the outcome is unknown.

## What it does, in order

1. **Refuses a recovery run.** A resume or a replay of an earlier execution fails the step as `recovery_run_refused`, before anything else. Resume re-runs every node from the entry, so a resumed click would post to the buyer a second time. A new click starts a new execution.
2. **Checks its config** (see below). A problem fails the step by name before any claim.
3. **Looks up the partner** by its id, for its current slug. The slug names the buyer in the output, the logs, the pages and the post's error messages, and nothing else. The lookup is the organization's cached partner list, the same one the Constants node reads. A partner id this organization does not hold fails the step as `partner_not_found` (permanent); a lookup that cannot be read fails it as `partner_unreadable` (transient). Either way nothing is claimed or sent. A Test Runner run looks the partner up too, so a missing partner shows before launch.
4. **Reads the buyer profile** once, through the one profile reader, within 5 seconds (#1639). Its click delivery says where the click goes and which reply counts as sold (see below), and its clicks per day judges the over cap notice later. The profile is the only place the address and the success line come from (#1671), so every way of not having them fails the step by name before anything is claimed or sent, and the node never guesses:
   - `profile_unreadable` (transient): the profile could not be read at all.
   - `no_profile` (permanent): the buyer has no buyer profile at all.
   - `not_sold_on_click` (permanent): the enabled profile is sold on the offer, and an offer buyer holds no click delivery.
   - `click_delivery_unset` (permanent): the click profile's **Click delivery** is empty. The fix is to fill it on the partner page.

   **A profile switched off is still sent to** (Dan, 2026-09-30). Switching a click buyer's profile off stops new offers only; a click on an offer already shown goes out through that profile's Click delivery and is claimed and counted as usual. The enabled profiles come from the one cached snapshot buyer_select and Buyer Click Check read; only for a buyer that snapshot does not hold does the node read the buyer's own profile row (`readBuyerClickDelivery` in `buyer-profile-loader.ts`, shaped by the same `clickDeliveryFromDocument`). A failure of either read is `profile_unreadable`.
   - `click_delivery_invalid` or `state_template_unset` (permanent): the delivery does not pass the shared rules, or it routes by state and the node has no `state` template.
5. **Claims the prospect** for this buyer, in a claim object named `sale:click:{partner_id}:{prospect_id}`. The claim answers one of:
   - taken: the node carries on.
   - `sold`: an earlier click sent this prospect. Routes `already_sent` with the earlier partner lead id. Nothing is posted.
   - `in_flight`: another execution is sending it right now. Routes `in_progress`. Nothing is posted.
   - `in_doubt`: an earlier send held the claim past its deadline and never recorded what happened. Routes `needs_review` and pages. Nothing is posted.
   - unreadable: the claim object did not answer. The step fails as `claim_unavailable` (transient). Nothing is posted.
6. **Posts** the body to the profile route's address, with a 20 second timeout.
7. **Reads the answer** three ways:
   - **Confirmed**: a 2xx whose whole body (trimmed, and unquoted when the buyer returns it as a JSON string) matches the buyer profile's success reply. The claim is marked sold with the partner lead id and a payout of 0, then the prospect is added to today's count. Routes `sent`.
   - **Refused**: a 4xx carrying the buyer's own error, meaning not an HTML page, not empty, and not 408 or 429. The claim is freed, so a later click on the same prospect can try again. Routes `refused`.
   - **Unknown**: everything else. A timeout, a network error, a 5xx, an HTML page (something in front of the buyer answered), a 2xx that is not the success line, an empty 4xx, a 408 or 429. The claim is kept held, the node pages, and it routes `unknown`. Whether the buyer received the lead is not known, so no later click on this prospect sends until a person has checked with the buyer and released the claim.

Every route carries a `reason`, and a `detail` where there is more to say.

## Routes

| Handle | `reason` | Meaning |
|--------|----------|---------|
| `sent` | `sent` | The buyer confirmed receipt with an id. The success line proves no more than that: what the id names, and whether a record was created, depends on the buyer. |
| `refused` | `refused_by_buyer` | The buyer refused the prospect; the claim is free again. |
| `unknown` | `outcome_unknown` | No readable answer; the claim is held and a person was paged. |
| `already_sent` | `already_sent` | An earlier click sent this prospect to this buyer. |
| `in_progress` | `claim_in_progress` | Another execution is sending it now. |
| `needs_review` | `claim_in_doubt` | An earlier send never recorded its outcome; paged. |
| `not_sent` | `report_only` | A Test Runner run, a shadow run or local dev: the config was checked and nothing was claimed, sent, counted or paged. |

All seven handles must be wired before a live workflow saves, because the node can take any of them and an unwired handle is a named step failure (`buyer_click_send_handle_unwired`).

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `partner_id` | string | Yes | none | The buyer's partner id, picked from the buyer partners by name. Names the claim, the counter and the page cooldowns. A value that is not a partner id (a slug, for instance) is refused when a live workflow saves, and fails the step as `partner_id_invalid` if it reaches a run. One rule decides both (`partnerIdOf` in `@bidspoke/buyer-profile`). |
| `prospect_id` | template | Yes | none | Resolves to the prospect id: the key that stops one prospect being sent twice and counted twice. |
| `request_body` | template | Yes | none | Resolves to the body object the preceding code node built. Sent as JSON. |
| `state` | template | When the profile routes by state | none | Resolves to the lead's state (for Liberty1, `{{steps.build_request.output.state}}`). Picks the route from the buyer profile's click delivery. With a delivery that routes by state and no `state` set, the step fails as `state_template_unset` before any claim, rather than send every state to the catch-all. |
| `alert_over_percent` | number | No | `120` | The notice fires once the day's count reaches this percent of the cap (60 at a cap of 50). A whole number from 1 to 1000; anything else is refused when a live workflow saves, and fails the step as `alert_over_percent_invalid` if it reaches a run. One rule decides both (`alertOverPercentOf` in `@bidspoke/buyer-profile`). |

`retries` is ignored and reported as `retries_ignored`: the node runs once, because a retried click is a second send.

There is no address and no success line on the node (#1671): both are the buyer profile's click delivery. A node saved before #1671 may still hold a `request_url` and a `success_pattern`; the node never reads them, save validation does not check them, and the config panel offers **Remove the old address and success line** to clear both.

There is no cap on the node. The daily cap is the buyer profile's clicks per day, the one number [Buyer Click Check](buyer-click-check.md) stops offering at (#1543). A `daily_lead_cap` still stored on an older node is ignored and reported as `daily_lead_cap_ignored`.

For Liberty1, whose clicks go to its LeadConnector webhook triggers since 2026-09-30, the success reply on its profile is:

```
^\s*\{(?=[\s\S]*"status"\s*:\s*"Success)[\s\S]*?"id"\s*:\s*"(?<id>[A-Za-z0-9]{15,20})"[\s\S]*\}\s*$
```

LeadConnector answers HTTP 200 with `{"status":"Success: request sent to trigger execution server","id":"w5Rjej9mohRyKpeG3la6"}`. That means the lead was queued to Liberty1's LeadConnector workflow, not that a record was created, and the id group captures LeadConnector's run id, not a Salesforce id. (Before that, on the Liberty1 Salesforce site, the line was `Records created successfully : (?<id>[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)`.)

## Click delivery on the buyer profile (#1639)

A click buyer's addresses and success reply live on its buyer profile, under **Click delivery** on the partner page, so a buyer that moves its endpoint is a profile edit with version history rather than a script edit and a workflow save:

- **Routes**: each a name, an https address and the states it takes. Exactly one route has no states; it takes every state no other route lists. A state is in at most one route.
- **Success reply**: the success line as a regular expression with a named `id` group, matched against the WHOLE answer. There is no default, so a buyer's line can never confirm another buyer's answer. One rule judges it wherever it is checked (`successPatternOf` in `@bidspoke/buyer-profile`).

The node posts to the route listing the lead's state, else the catch-all. A lead with no readable state goes to the catch-all. The output records `route_name`, `route_matched` (`state`, `catch_all` or `no_state`), `route_state`, and `url_source` and `pattern_source`, which are `profile` (step rows written before #1671 can read `node`). A profile with no delivery is refused by name, as step 4 lists. A delivery that does not pass the shared rules fails the step as `click_delivery_invalid` before any claim.

The profile form refuses a delivery the node would refuse (the shared validator in `@bidspoke/buyer-profile`, run by the form and the profile API), `save_buyer_profile` refuses its structure again as `click_delivery_invalid` and refuses one on a buyer sold on the offer as `click_delivery_on_offer_buyer`, and a save that sends no `click_delivery` keeps the stored one. Before saving a change, the form says where clicks from each state will go instead of where they went, and the profile history shows each route and the success reply old to new.

### Why the partner is stored by id

The claims a buyer holds and the day's click count are named by the partner id, never the slug. The Partners page does not edit a slug today, but the database does not forbid changing one; if the names carried the slug, a change would orphan every claim the buyer holds (a prospect clicked before it could be sent again after it) and restart the day's count at zero. With the id, a slug change alters only the words in the output and the pages, and those follow once the cached partner list is next rebuilt (at the latest 30 days, sooner on any partner edit through the app).

## The click count

One counter per buyer per **Pacific** day, named `clicks-{partner_id}-{YYYY-MM-DD}`, resetting at midnight Pacific. Clicks arrive after offers, so an Eastern day would push a late evening click into the next day's count. The counter holds the set of prospect ids sent that day, and the count is the number of distinct ids: adding the same prospect twice never counts it twice.

An add that gives no answer, because it timed out or failed in transit, may still have landed: on 2026-10-05 one landed 48 ms after the node gave up on it (#1766). Because the count takes each prospect once, the node asks it once more, and a retry that answers is the count, with nothing paged. The step then carries `count_retried`, why the first ask gave no answer. The retry is asked only while the run still has room for it: the node's whole run, from just before the claim, is the claim deadline less its 10 second margin (`CLICK_RUN_BUDGET_MS`, 30 seconds), and the retry is asked only when the add at its full 5 second deadline and the page after it both fit in what is left. It is never given a shorter deadline.

A count that still fails pages, saying only what the counter answered, and the route is still `sent`:

- `count_failed`: the counter refused the add, so the click is known not to be counted and the count reads low by it.
- `count_unknown`: nothing the counter answered says whether it took the click. That is no answer even after the retry, a retry the run had no room for, an error status, an answer that cannot be read, or an error the node does not classify. The page says the click may not have been counted.

Only a deadline that expired or a call lost in transit is asked again. Once the counter has answered, whatever it answered, it is not asked again, and neither is an error the node does not classify. The step carries the page's detail as `count_error`. The click path reconcile after the Pacific day lists a `count_unknown` prospect as Completed but never counted only when its add never landed.

## Pages and the over cap notice

The node posts to the org's Slack connection for two things:

- **A page** when a click needs a person: `outcome_unknown`, `claim_in_doubt`, `sold_mark_failed` (the buyer confirmed but the claim could not be marked sold), `count_failed` and `count_unknown` (above), `free_failed` (a refusal whose claim could not be released) and `cap_unreadable`. Buyer Click Check pages through the same path as `partner_not_click`. One page per buyer (by partner id) per reason per 15 minutes, so a burst of one fault is one page; the executions list holds every occurrence.
- **The over cap notice** when the count after an add reaches the profile's clicks per day times `alert_over_percent / 100`, once per buyer per Pacific day. The profile is the one read made before the claim (step 4), so the address and the cap come from the same snapshot. An enabled click profile holding no clicks per day (or a cap that is not a whole number above zero) pages `cap_unreadable`. A profile switched off while offers were still out is recorded as `no_enabled_profile` and pages nothing, because no more offers are being made. A buyer with no profile, or one sold on the offer, never reaches the count: step 4 refused the click.

Both are decided by the alert claim object, so two clicks that page together post once. A Slack failure is logged and recorded on the step (`pages[].outcome`, `over_cap`), and never fails the node, because the click it reports on has already happened.

## Releasing a held click

A claim the node leaves held (`outcome_unknown`, `sold_mark_failed`, `free_failed`) or finds held (`claim_in_doubt`) is also recorded in `held_click_claims`, because a claim object cannot be listed and the step rows are kept only 7 days while the claim stays held. The buyer's partner page lists them under **Held clicks**, and the page for each of those reasons links there when the record landed. A person checks the buyer's system and then either:

- **Mark sent**: the buyer has the lead. The claim is marked sent with the lead id the person enters, the prospect is added to the click count of the Pacific day the click was held, and Salesforce is updated as a live `sent` click would have updated it (below).
- **Free**: the buyer does not have it. The claim is freed, so the next click on the prospect sends it. Nothing is written to Salesforce.

**The Salesforce updates on Mark sent (#1659).** A held click's workflow wrote nothing to Salesforce, so Mark sent writes the Prospect, Submission and Lead bodies the click workflow's `click_patch` writes on `sent`: Completed, the lead id the person entered, the time the click was held (when the buyer received it) as the timestamp, and `PDFlow_3__c` as the held run's Bidspoke link. They are built by one builder, `apps/worker/src/lib/click-sale-updates.ts`, which a test holds byte for byte to the kept `click_patch` script. The partner name and routing code come from the buyer's partner record, so the next click buyer needs no code for them. The consent text and lead sale type belong to the buyer's own click flow, so they are read out of that workflow's kept `click_patch` script rather than copied: a second copy of a legal text would drift from what the live click writes. A click from a workflow Bidspoke keeps no `click_patch` script for is refused by name and writes nothing.

The records are the ones the held run's own record step named (`pick_record`: the step whose output carries this claim's `sale_key` with `prospect_id`, `submission_id` and `lead_id`), and a record the click did not name is not written, as in the live flow. Step rows are kept 7 days, so past that the same step is read from the execution archive (13 months). Salesforce is never searched for "the Submission of this Prospect", because a prospect can have several and a guess would mark the wrong one sold. When neither source answers, nothing is written and every record says why.

The mark stands whatever Salesforce answers. Each record's outcome (updated, refused with Salesforce's reason, not part of this click, or not attempted with the reason) is returned, audited on the `held_click` entry as `salesforce_writes`, and shown on the row. An entry whose updates did not all land stays on the list with **Retry the Salesforce updates**, which writes the same bodies again with the lead id the claim was sold with; the entry leaves the list once every record lands. A sold entry with no updates recorded at all (a mark that stopped between the sale and its audit) is offered the same retry. Removing such an entry from the list removes its retry too, so the page says so and asks first. The updates are the same every time, so a retry, or two at once, is safe.

Each is a compare and set on the claim's generation, so a page read before the claim moved is refused, and each is audited. A record that cannot be written is logged and reported on the step as `hold_recorded: false` with the error in `hold_record_error`, and the page still goes out, but it does not point at Held clicks, which lacks the click: it says the click could not be added to that list, names the prospect and the claim, and says the next click on the prospect after the claim's send window records it there. Routes: [Held clicks](../reference/api.md#held-clicks).

## Output

```json
{
  "_route": "sent",
  "reason": "sent",
  "detail": "the buyer confirmed receipt with id a0B5f00000XyZ12AAB",
  "mode_effective": "live",
  "partner_id": "3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70",
  "partner_slug": "liberty1",
  "prospect_id": "a0B000000000001AAA",
  "status": 200,
  "partner_lead_id": "a0B5f00000XyZ12AAB",
  "count": 12,
  "counted": true,
  "count_date": "2026-09-29",
  "over_cap": "not_due",
  "daily_lead_cap": 50,
  "pages": [],
  "duration_ms": 842
}
```

`partner_slug` is the slug the partner had when the node ran (null when the partner could not be looked up). `status` is the buyer's HTTP status (null when no answer arrived). `counted` is false when the prospect was already in today's count or the add failed. `over_cap` is `not_due`, `posted`, `claimed_elsewhere` (already posted today), `no_slack`, `post_failed`, `cap_unreadable`, `no_enabled_profile` or `not_counted`. `daily_lead_cap` is the profile cap the notice was judged against (null when it was not read). The request body is never written to the step row.

## Timing

The claim deadline is 40 seconds: the 20 second post, then two object calls of up to 5 seconds each (mark sold, add to the count), plus 10 seconds of margin. It is a structural bound rather than a measured one, because no send to the buyer has run through Bidspoke yet; replace it with the measured worst case once live clicks have run.

## See also

- [Buyer Click Check](buyer-click-check.md), the offer side's check that decides whether this buyer may be offered a lead.
- [Buyer Select](buyer-select.md), the offer side's sale node for a lead sold on the ping.
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
