# Buyer Select node

Sells a sell off lead to the highest ranked eligible buyer, and says precisely why not when it does not. The buyers, their prices, their states, hours, caps and the rules that read their answers all come from **buyer profiles** on the Partners page, so a pricing or eligibility change is a form edit rather than a script rewrite. The node replaces the hand written Tripoint script in the Engine workflow and is built to take further buyers and further lead populations without new code.

It routes down one of four edges: `sold`, `no_sale`, `not_applicable` and `deferred`.

## When the node applies

The node decides applicability first, before it reads anything from the database or touches a Durable Object, so the nine in ten leads that are not for sale pay nothing:

- `sell_off_when` must resolve to exactly `true`. A value that is not a boolean is treated as `false` and logged as `sell_off_flag_not_boolean`, because a broken template must not look like a quiet day.
- `bid_when_positive`, when set, must resolve to a number above zero. This is the second condition the replaced script checked (it bailed on a zero bid), kept so the two agree lead for lead.

A lead that fails either routes `not_applicable`. A `sell_off_when` that cannot be resolved at all routes `deferred`, so the rest of the workflow decides for itself.

## Modes

| Mode | What happens |
|------|--------------|
| `decide_only` | Everything except the buyer call: eligibility, ranking, the claim, the reservation and the commit, all under the `rehearsal` ledger kind, with caps from the `BUYER_SELECT_REHEARSAL_CAPS` environment variable. The lead routes `deferred` and the output records what would have been sent. This mode never fails the step and gives up after 800 ms with `rehearsal_deadline`; the 800 ms bounds the whole node, so a slow object call ends the rehearsal at the deadline rather than running its own full time (#1491). |
| `live` | Sells. Only this mode calls a buyer and only this mode can fail the step. The steps before the buyer call (the profile read, the breaker check, the claim, the reservation, any wait on another execution holding the lead) share a 2 second budget from the node's start; when it runs out the lead routes `no_sale` with `object_deadline`, holding nothing. The buyer call keeps its own 20 second budget, and the calls after it (commit, mark sold) keep their own deadlines, because an accepted answer must be recorded whatever the clock says (#1508). |

There is no default: a missing or unknown mode fails the step as `mode_invalid`.

Test Runner runs, shadow runs and local development runs evaluate and report only, in every mode. They claim nothing, reserve nothing, call nobody and write nothing, and the output says so with `mode_effective: "report_only"`.

## The live share

`live_percent_env` names an environment variable holding a whole number from 0 to 100. In live mode a lead is sold only when its stable bucket, derived from the lead key, falls inside that share; otherwise it routes `deferred`. If the variable is unset or not a number, every lead routes `deferred` with `live_percent_unset`. Nothing ever defaults to 100.

## Config

| Field | Required | Description |
|-------|----------|-------------|
| `population` | Yes | Which lead population this node sells, chosen from the wired populations. Buyers are priced per population. |
| `mode` | Yes | `decide_only` or `live`. |
| `live_percent_env` | No | The environment variable holding the live share. |
| `sell_off_when` | Yes | Template that must resolve to `true`. |
| `bid_when_positive` | No | Template that must resolve to a positive number. |
| `lead_key` | Yes | Template for the stable key one lead is known by across executions. An empty key fails a live step and defers otherwise. |
| `state`, `debt`, `loan_amount` | As profiles need them | Templates the eligibility rules read. |
| `collections` | When a profile caps collections | The lead's collections balance, judged as a share of `debt` against a profile's collections cap (#2111). Without it, a buyer whose profile sets a cap is out as `collections_not_wired`. |
| `sale_payload` | Yes | `{ base, set, normalise }`. `base` is a whole object template such as `{{trigger.payload}}`. `set` is a list of target path and source template pairs. `normalise` is a list of path and normaliser pairs, for example `ssn_digits_9`. Resolved only after the lead is known to be for sale. |

The node has no `retries` setting and ignores one if a definition carries it (reported as `retries_ignored`). A retried sale is a duplicate send.

A rule a live step cannot read is refused at both saves (#2149). The state and the debt are always read; the loan amount only when a buyer it judges sets a minimum; collections only when one caps them (`leadFieldsNeeded` in `@bidspoke/buyer-profile`, the list the box refuses by). Saving an enabled buyer profile whose rule a live workflow's `buyer_select` or `buyer_click_check` step has no template for is refused on that profile field, naming the workflow and the step; saving, switching on or restoring a live workflow whose step cannot read an enabled profile it judges is refused, naming the buyer and the rule. A template that is set but reads a path the lead does not carry cannot be seen at save time: the hourly live share refusal check (`lib/live-share-refusals.ts`) pages after 20 refused live share leads in a row with none sent to a buyer.

## What one attempt does

For each eligible buyer in rank order (priority 1 first, then the higher payout, then a stable hash of the lead key so ties spread evenly):

1. Check the buyer's circuit breaker, the same one the Partner Bid node uses for that partner.
2. Claim the lead in the lead sale object, so two executions cannot sell it twice.
3. Reserve a slot and the payout against the buyer's hourly and daily caps in the buyer ledger object.
4. Call the buyer with the resolved payload, through the partner's outbound field mapping, with a 20 second budget.
5. Read the answer through the partner's accept rules and decline rules.
6. On an accept, commit the reservation, mark the lead sold and mirror the sale to `buyer_sales`.

A definite decline releases the reservation and moves on to the next buyer. An answer nobody can classify (a timeout, a bare 504, a 200 matching no rule) stops the cascade and **holds** the reservation and the claim, because the buyer may have taken the lead; a person settles it from the unresolved queue. A rehearsal reservation nothing settles inside the ledger's grace period is released by the ledger itself (resolution source `expired`), since no buyer was called, and never waits on a person; the buyer sales checks count those releases per buyer as a leak measure. A timeout or a 5xx of that kind fails the step; an unmatched 200 routes `no_sale` without failing it.

A cap refusal, an open breaker or a ledger that cannot be read skips the buyer by name and is never an allow. Each cause has its own reason: a cap names the cap, an open breaker is `circuit_open`, a breaker that did not answer is `breaker_unreadable`, an object call (claim, reserve) that ran out of time before the buyer was called is `object_deadline`, and an object that answered with an error is `cap_check_error`.

## Output

```json
{
  "_route": "sold",
  "reason": "sold",
  "mode_effective": "live",
  "population": "engine",
  "lead_key": "…",
  "sale": {
    "skipped": false, "accepted": true, "buyer_reference": "L-1", "result_code": "1000", "partner_slug": "tripoint",
    "partner_name": "Tripoint", "click_url": "https://trypennie.com/portal/tpl", "routing_code": 2, "response_class": "Success"
  },
  "considered": [
    { "partner": "tripoint", "priority": 1, "payout_cents": 2190, "outcome": "sold" },
    { "partner": "liberty", "priority": 2, "payout_cents": 1800, "outcome": "not_reached" }
  ],
  "live_percent_in_force": 100,
  "caps_in_force": [{ "partner": "tripoint", "hourly_lead_cap": null, "daily_lead_cap": 500, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null }],
  "rehearsal_expired_in_flight": 0,
  "rehearsal_in_doubt_heals": 0,
  "buyer_call_ms": 3104,
  "duration_ms": 3518
}
```

`buyer_call_ms` is the time spent inside buyer calls, summed over every buyer called, so the node's own cost on a lead is `duration_ms` minus `buyer_call_ms` (#1804). It is absent when no request left (decide only, report only, no eligible buyer, every buyer skipped), so a lead that measured nothing never reads as zero.

The hourly parity refresh writes a Stage B report for each Eastern day into `buyer_select_parity_days.stage_b` (#1809), beside the Stage A counts and outside their hash, so a sign off is never cleared by it. It holds, for the canary arm (this node selling live) and the legacy arm (`tripoint_ping`): attempts, accepts and Tripoint's answer codes, the p50 and p95 step time, for the canary the buyer call and the node's own time split out, the added time against the legacy step at each percentile, every live percent seen that day, and whether each attempted execution has exactly one Tripoint bid row. Bid rows drain about a day after export, so that check reads `unmeasured` with the reason once they are gone, and a measured check is kept rather than overwritten by a later run that could not measure. Each Stage B step is reviewed from these rows: `GET /api/admin/buyer-select/parity` returns them.

`rehearsal_expired_in_flight` counts the lead sale claims this execution made that found an earlier holder past its deadline and moved the claim to in doubt; `rehearsal_in_doubt_heals` counts the in doubt claims its attempts settled as sold from the buyer ledger (#1643). Both are present, as 0 when nothing happened, whenever at least one claim answered, and absent when none did (a lead not for sale, no eligible buyer, a claim call that never answered), so the daily parity row reads a lead that never claimed as unmeasured rather than as zero. The names are the parity row's; a live node records the same facts under them. The Phase 3 drill runs once a day in the 13:00 UTC batch under a `buyer-objects-drill` row in `job_runs`, whose summary carries its own expiries and heals separately from these organic counts.

`sale` carries the winner's own facts so the Engine response and the Salesforce patch derive everything buyer specific from it and a second buyer needs no script change: the partner's name, the click URL a sold lead lands on, the Salesforce routing code the prospect patch carries, and the class Salesforce records (`Success` on an accept, `Duplicate` when a decline matches one of the partner's duplicate rules, `Fail` on any other decline, none when the buyer gave no answer to classify). A decline names the declining buyer, its code and its class and carries no click URL or routing code; a skipped sale carries nothing. `considered` carries every buyer with an enabled profile sold on the offer and why it was in or out (a buyer sold on the click is offered by [buyer_click_check](./buyer-click-check.md), never by this node, so it is not listed), in plain vocabulary the execution view labels. `reason` names why the node routed where it did. The output is deliberately not shaped like a Tripoint response, so nothing downstream mistakes it for the replaced script's output.

## Step rows

The execution detail shows one `buyer_select` row for the node plus one `partner_bid` row per buyer that was actually contacted, linked to the parent. Buyers that were filtered out before a call appear only in `considered`. The rows never carry the sale payload.

A row whose buyer was called carries `timing`, the attempt split at the call (#1804): `before_call_ms` (the claim and the reservation), `call_ms` (the buyer call alone, up to its answer or its throw) and `after_call_ms` (the breaker record, commit, mark sold and the mirror, or after a decline the release and the mirror). Inside those, each object call has its own figure: `claim_ms` (including any wait on another holder), `reserve_ms`, `breaker_ms` (recording the buyer's answer), `commit_ms`, `mark_sold_ms`, `release_ms` (giving back the reservation and freeing the claim after a decline) and `mirror_ms` (the `buyer_sales` copy, timed even when it fails). A figure is present only when the attempt reached that call, so a decline has no `commit_ms` and a call that threw has no `mirror_ms`, rather than a zero. All of these are logged per attempt as `buyer_select_attempt_timing`. The row's own start and end, and the bid row in `lead_sighting_bids`, span the whole attempt, so the buyer's share of the time is read from `call_ms`.

## Save time rules

A live workflow cannot be saved unless `population`, `mode`, `lead_key`, `sell_off_when` and `sale_payload.base` are set, and unless `sold`, `no_sale` and `not_applicable` are wired, plus `deferred` whenever the mode is `decide_only` or a live share variable is named. The engine fails the step as `buyer_select_handle_unwired` if it ever routes to an unwired handle, in every mode.
