# Buyer Click Send node

Sends one clicked prospect to a click sold buyer (Liberty1 first, EvaFi later), exactly once, and counts it exactly once. A click sold buyer is paid per click: a person saw the buyer's offer, clicked through, and the click workflow hands the prospect to the buyer. The node does the three things that must not come apart, in one step: it claims the prospect for the buyer, posts it, and adds it to the buyer's click count for the day.

## When to use it

In a click workflow, after a code node has built the request for the buyer (which URL, which body), and before the Salesforce updates that record the outcome. The node routes on what happened, so the Salesforce steps after it only write Completed on `sent` and Fail on `refused`, and write nothing when the outcome is unknown.

## What it does, in order

1. **Refuses a recovery run.** A resume or a replay of an earlier execution fails the step as `recovery_run_refused`, before anything else. Resume re-runs every node from the entry, so a resumed click would post to the buyer a second time. A new click starts a new execution.
2. **Checks its config** (see below). A problem fails the step by name before any claim.
3. **Looks up the partner** by its id, for its current slug. The slug names the buyer in the output, the logs, the pages and the post's error messages, and nothing else. The lookup is the organization's cached partner list, the same one the Constants node reads. A partner id this organization does not hold fails the step as `partner_not_found` (permanent); a lookup that cannot be read fails it as `partner_unreadable` (transient). Either way nothing is claimed or sent. A Test Runner run looks the partner up too, so a missing partner shows before launch.
4. **Claims the prospect** for this buyer, in a claim object named `sale:click:{partner_id}:{prospect_id}`. The claim answers one of:
   - taken: the node carries on.
   - `sold`: an earlier click sent this prospect. Routes `already_sent` with the earlier partner lead id. Nothing is posted.
   - `in_flight`: another execution is sending it right now. Routes `in_progress`. Nothing is posted.
   - `in_doubt`: an earlier send held the claim past its deadline and never recorded what happened. Routes `needs_review` and pages. Nothing is posted.
   - unreadable: the claim object did not answer. The step fails as `claim_unavailable` (transient). Nothing is posted.
5. **Posts** the body to the URL, with a 20 second timeout.
6. **Reads the answer** three ways:
   - **Confirmed**: a 2xx whose whole body (trimmed, and unquoted when the buyer returns it as a JSON string) matches the partner's success line. The claim is marked sold with the partner lead id and a payout of 0, then the prospect is added to today's count. Routes `sent`.
   - **Refused**: a 4xx carrying the buyer's own error, meaning not an HTML page, not empty, and not 408 or 429. The claim is freed, so a later click on the same prospect can try again. Routes `refused`.
   - **Unknown**: everything else. A timeout, a network error, a 5xx, an HTML page (something in front of the buyer answered), a 2xx that is not the success line, an empty 4xx, a 408 or 429. The claim is kept held, the node pages, and it routes `unknown`. Whether the buyer created the record is not known, so no later click on this prospect sends until a person has checked with the buyer and released the claim.

Every route carries a `reason`, and a `detail` where there is more to say.

## Routes

| Handle | `reason` | Meaning |
|--------|----------|---------|
| `sent` | `sent` | The buyer confirmed it created the record. |
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
| `request_url` | template | Yes | none | Resolves to the https URL the preceding code node picked. |
| `request_body` | template | Yes | none | Resolves to the body object the preceding code node built. Sent as JSON. |
| `success_pattern` | string | Yes | none | The buyer's success line as a regular expression with a named `id` group, matched against the WHOLE answer. There is no default, so a buyer's line can never confirm another buyer's answer. |
| `alert_over_percent` | number | No | `120` | The notice fires once the day's count reaches this percent of the cap (60 at a cap of 50). A whole number from 1 to 1000; anything else is refused when a live workflow saves, and fails the step as `alert_over_percent_invalid` if it reaches a run. One rule decides both (`alertOverPercentOf` in `@bidspoke/buyer-profile`). |

`retries` is ignored and reported as `retries_ignored`: the node runs once, because a retried click is a second send.

There is no cap on the node. The daily cap is the buyer profile's clicks per day, the one number [Buyer Click Check](buyer-click-check.md) stops offering at (#1543). A `daily_lead_cap` still stored on an older node is ignored and reported as `daily_lead_cap_ignored`.

For Liberty1 the success line is:

```
Records created successfully : (?<id>[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)
```

The id group captures the 15 or 18 character Salesforce id Liberty1 returns.

### Why the partner is stored by id

The claims a buyer holds and the day's click count are named by the partner id, never the slug. The Partners page does not edit a slug today, but the database does not forbid changing one; if the names carried the slug, a change would orphan every claim the buyer holds (a prospect clicked before it could be sent again after it) and restart the day's count at zero. With the id, a slug change alters only the words in the output and the pages, and those follow once the cached partner list is next rebuilt (at the latest 30 days, sooner on any partner edit through the app).

## The click count

One counter per buyer per **Pacific** day, named `clicks-{partner_id}-{YYYY-MM-DD}`, resetting at midnight Pacific. Clicks arrive after offers, so an Eastern day would push a late evening click into the next day's count. The counter holds the set of prospect ids sent that day, and the count is the number of distinct ids: adding the same prospect twice never counts it twice.

A count that fails after a confirmed send pages `count_failed`; the route is still `sent`.

## Pages and the over cap notice

The node posts to the org's Slack connection for two things:

- **A page** when a click needs a person: `outcome_unknown`, `claim_in_doubt`, `sold_mark_failed` (the buyer confirmed but the claim could not be marked sold), `count_failed`, `free_failed` (a refusal whose claim could not be released) and `cap_unreadable`. Buyer Click Check pages through the same path as `partner_not_click`. One page per buyer (by partner id) per reason per 15 minutes, so a burst of one fault is one page; the executions list holds every occurrence.
- **The over cap notice** when the count after an add reaches the profile's clicks per day times `alert_over_percent / 100`, once per buyer per Pacific day. The profile is read after the click is counted, through the same profile reader the offer side uses, within 5 seconds. A profile that cannot be read, an enabled one holding no clicks per day (or a cap that is not a whole number above zero), or one sold on the offer, whose cap counts leads rather than clicks, pages `cap_unreadable`. No enabled profile at all (the buyer was switched off while offers were still out) is recorded as `no_enabled_profile` and pages nothing, because no more offers are being made.

Both are decided by the alert claim object, so two clicks that page together post once. A Slack failure is logged and recorded on the step (`pages[].outcome`, `over_cap`), and never fails the node, because the click it reports on has already happened.

## Releasing a held click

A claim the node leaves held (`outcome_unknown`, `sold_mark_failed`, `free_failed`) or finds held (`claim_in_doubt`) is also recorded in `held_click_claims`, because a claim object cannot be listed and the step rows are kept only 7 days while the claim stays held. The buyer's partner page lists them under **Held clicks**, and the page for each of those reasons links there. A person checks the buyer's system and then either:

- **Mark sent**: the buyer has the lead. The claim is marked sent with the lead id the person enters, and the prospect is added to the click count of the Pacific day the click was held.
- **Free**: the buyer does not have it. The claim is freed, so the next click on the prospect sends it.

Each is a compare and set on the claim's generation, so a page read before the claim moved is refused, and each is audited. A record that cannot be written is logged and reported on the step as `hold_recorded: false`; the page still goes out. Routes: [Held clicks](../reference/api.md#held-clicks).

## Output

```json
{
  "_route": "sent",
  "reason": "sent",
  "detail": "the buyer created a0B5f00000XyZ12AAB",
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
