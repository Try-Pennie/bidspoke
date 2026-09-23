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
| `live` | Sells. Only this mode calls a buyer and only this mode can fail the step. |

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
| `sale_payload` | Yes | `{ base, set, normalise }`. `base` is a whole object template such as `{{trigger.payload}}`. `set` is a list of target path and source template pairs. `normalise` is a list of path and normaliser pairs, for example `ssn_digits_9`. Resolved only after the lead is known to be for sale. |

The node has no `retries` setting and ignores one if a definition carries it (reported as `retries_ignored`). A retried sale is a duplicate send.

## What one attempt does

For each eligible buyer in rank order (priority 1 first, then the higher payout, then a stable hash of the lead key so ties spread evenly):

1. Check the buyer's circuit breaker, the same one the Partner Bid node uses for that partner.
2. Claim the lead in the lead sale object, so two executions cannot sell it twice.
3. Reserve a slot and the payout against the buyer's hourly and daily caps in the buyer ledger object.
4. Call the buyer with the resolved payload, through the partner's outbound field mapping, with a 20 second budget.
5. Read the answer through the partner's accept rules and decline rules.
6. On an accept, commit the reservation, mark the lead sold and mirror the sale to `buyer_sales`.

A definite decline releases the reservation and moves on to the next buyer. An answer nobody can classify (a timeout, a bare 504, a 200 matching no rule) stops the cascade and **holds** the reservation and the claim, because the buyer may have taken the lead; a person settles it from the unresolved queue. A rehearsal reservation nothing settles inside the ledger's grace period is released by the ledger itself (resolution source `expired`), since no buyer was called, and never waits on a person; the buyer sales checks count those releases per buyer as a leak measure. A timeout or a 5xx of that kind fails the step; an unmatched 200 routes `no_sale` without failing it.

A cap refusal, an open breaker or a ledger that cannot be read skips the buyer by name and is never an allow.

## Output

```json
{
  "_route": "sold",
  "reason": "sold",
  "mode_effective": "live",
  "population": "engine",
  "lead_key": "…",
  "sale": { "skipped": false, "accepted": true, "buyer_reference": "L-1", "result_code": "1000", "partner_slug": "tripoint" },
  "considered": [
    { "partner": "tripoint", "priority": 1, "payout_cents": 2190, "outcome": "sold" },
    { "partner": "liberty", "priority": 2, "payout_cents": 1800, "outcome": "not_reached" }
  ],
  "live_percent_in_force": 100,
  "caps_in_force": [{ "partner": "tripoint", "hourly_lead_cap": null, "daily_lead_cap": 500, "hourly_spend_cap_cents": null, "daily_spend_cap_cents": null }],
  "duration_ms": 412
}
```

`considered` carries every buyer with an enabled profile and why it was in or out, in plain vocabulary the execution view labels. `reason` names why the node routed where it did. The output is deliberately not shaped like a Tripoint response, so nothing downstream mistakes it for the replaced script's output.

## Step rows

The execution detail shows one `buyer_select` row for the node plus one `partner_bid` row per buyer that was actually contacted, linked to the parent. Buyers that were filtered out before a call appear only in `considered`. The rows never carry the sale payload.

## Save time rules

A live workflow cannot be saved unless `population`, `mode`, `lead_key`, `sell_off_when` and `sale_payload.base` are set, and unless `sold`, `no_sale` and `not_applicable` are wired, plus `deferred` whenever the mode is `decide_only` or a live share variable is named. The engine fails the step as `buyer_select_handle_unwired` if it ever routes to an unwired handle, in every mode.
