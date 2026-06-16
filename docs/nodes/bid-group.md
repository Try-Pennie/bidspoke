# Bid Group node

The primary bidding node. It sends one lead to several partners and picks a winner, all as a single node on the canvas. It runs each partner through the same logic as a [Partner Bid node](./partner-bid.md) (circuit breaker, daily cap, dedup, resolve, classify), then selects a winner according to its mode. It returns a `winner` and the full set of `all_bids`, and routes the workflow down a `winner` or `no_winner` edge.

Use a Bid Group whenever you want to bid a lead out to more than one partner and route on the result. It is the recommended way to do bidding: one node, internal fan-out, a winner, and a clear no-winner path.

## Bid Group vs. Partner Bid

A Bid Group does not replace partner-bid logic, it composes it. Internally, for each partner it tries, the engine synthesizes a `partner_bid` step that runs the same executor as a standalone [Partner Bid node](./partner-bid.md). Those synthesized attempts appear as their own step rows in the execution detail (one parent `bid_group` row plus one `partner_bid` row per partner tried), linked together so you can see every attempt and why each won, lost, declined, or was skipped.

- Use a **Bid Group** for the normal case: bid one lead to N partners and pick a winner.
- Use a standalone **Partner Bid** node only when you need a single, explicit partner attempt on the canvas.

## Modes

Set `mode` to one of:

| Mode | Behavior |
|------|----------|
| `highest_bid` (default) | Run all selected partners in parallel. The highest accepted bid wins. Ties break by input order (first listed wins). |
| `cascade` | Try partners in order. Stop at the first one that returns a winning bid. Partners that pass, decline, or error advance to the next. |
| `tiered` | A list of tiers, each run in `cascade` or `highest_bid` mode. Advance from one tier to the next only if the current tier produced no winner. Each tier can be gated by a rule. |

A bid counts as winning when the partner accepted it, the bid is non-null, and it is at or above the group's `min_bid_threshold` (if set). Skipped and declined attempts never win.

### Tiered mode and advance conditions

In `tiered` mode you provide `tiers`. Each tier has its own `mode` and `partner_ids`, and an optional `advance_condition`: a rule (the same rule-builder shape used by [Branch](./branch.md) and [Filter](./filter.md) nodes) evaluated before the tier runs. If the gate is false, the tier is skipped and its id is recorded in `tiers_skipped`. Tiers run top to bottom; the first tier that yields a winner ends the group.

Tiers do not have their own fallback partner. The group-level fallback (below) fires once, after all tiers are exhausted without a winner.

## Group-level fallback

`fallback_partner_id` is an optional last-resort partner (for example a catch-all buyer like Engine). After the primary partners (or all tiers) produce no winner, the fallback partner is tried once. If it returns a winning bid, it wins with `reason: 'fallback_won'`. The fallback runs the same partner-bid logic as any other partner.

## Config schema

The executor reads `node.config` as:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | `'highest_bid'` \| `'cascade'` \| `'tiered'` | No | `'highest_bid'` | Selection mode. |
| `partner_ids` | string[] (UUIDs) | For `cascade` / `highest_bid` | `[]` | Partners to query. In cascade mode the order is the try-order. Empty list yields no winner with `reason: 'no_partners_configured'`. |
| `tiers` | `Tier[]` | For `tiered` | `[]` | Ordered tiers. See [Tier shape](#tier-shape). Empty yields `reason: 'no_tiers_configured'`. |
| `min_bid_threshold` | number \| null | No | `null` (no minimum) | Bids below this amount do not win (treated as not winning). |
| `fallback_partner_id` | string (UUID) \| null | No | `null` | Last-resort partner, tried once after no winner. |
| `no_winner_behavior` | `'route'` \| `'exit'` \| `'fail'` | No | `'route'` | What to do on no winner. See [No-winner behavior](#no-winner-behavior). |
| `timeout_ms` | number | No | unset (wait for all) | `highest_bid` only (and tiers in highest-bid mode). Race deadline in ms. Partners that do not settle in time are recorded as failed. The underlying fetch keeps running. Each partner still has its own 15s API timeout. The main flow uses `5000` for parity with the legacy Pipedream flow. |
| `cascade_total_timeout_ms` | number | No | `30000` | `cascade` only. Max wall-clock time to spend trying partners in order. On exceed, returns no winner with `reason: 'cascade_timeout'`. |
| `context` | object (name to template string) | No | none | Name-to-template pairs resolved once at group entry against the current execution context, then exposed to partner formulas as `context.<name>`. Keeps partner configs workflow-agnostic. See [Context](#context). |

### Tier shape

Each entry in `tiers`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | none | Unique tier id. Appears in `tiers_skipped` / `tier_winner`. |
| `label` | string | No | none | Display label. |
| `mode` | `'cascade'` \| `'highest_bid'` | Yes | none | How partners inside this tier are run. |
| `partner_ids` | string[] (UUIDs) | Yes | none | Partners in this tier. |
| `advance_condition` | `{ groups: ConditionGroup[]; logic: 'AND' \| 'OR' }` | No | always run | Rule gate. If false, the tier is skipped. Same shape as [Branch](./branch.md) / [Filter](./filter.md) rules. See [Workflow definition schema](../concepts/workflow-definition-schema.md). |

### Context

`context` is a map of name to template string, resolved once when the group starts. Each value may reference `steps.*`, `trigger.*`, or `env.*`. Partner formulas then reference the names as `context.<name>`, so the same partner formula works across workflows with different step names. Example: `{ "finalDebt": "{{steps.eligibility.output.final}}" }`, and a partner formula uses `context.finalDebt`. See [data references](../concepts/data-references.md).

## No-winner behavior

When the group produces no winner (`_route` is `no_winner`), `no_winner_behavior` controls what happens:

| Value | Behavior |
|-------|----------|
| `'route'` (default) | Take the `no_winner` outgoing edge and continue normal execution. Does not fail the step. |
| `'fail'` | Legacy alias for `'route'`. It has always meant "fall through to the no_winner edge", never "throw". Treated identically to `'route'`. |
| `'exit'` | Short-circuit the workflow and return the group output as the HTTP response with status 200. No edge routing. |

## Output shape

`steps.<id>.output` contains a `BidGroupOutput`:

```json
{
  "winner": {
    "partner": "tripoint",
    "bid": 19.82,
    "raw_response": { "bid": 19.82 },
    "extra": { "leadId": "abc-123" }
  },
  "all_bids": [
    {
      "partner": "tripoint",
      "bid": 19.82,
      "accepted": true,
      "skipped": false,
      "resolver_type": "api",
      "outcome": "won",
      "outcome_reason": "Highest bid in race"
    },
    {
      "partner": "m1",
      "bid": 12.0,
      "accepted": true,
      "skipped": false,
      "resolver_type": "api",
      "outcome": "outbid",
      "outcome_reason": "Outbid by tripoint ($19.82 vs $12)"
    }
  ],
  "excluded": [],
  "mode": "highest_bid",
  "reason": "winner",
  "_route": "winner"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `winner` | object \| null | The winning partner: `partner` (slug), `bid` (number), `raw_response`, and `extra` (partner-specific values like `clickUrl`/`leadId`). `null` when no winner. |
| `all_bids` | array | Every attempt, each a [PartnerBidOutput](./partner-bid.md#output-shape) plus an `outcome` and `outcome_reason`. |
| `excluded` | array | The non-winning attempts (same entries as `all_bids` minus the winner). On a no-winner result, this equals `all_bids`. |
| `mode` | `'highest_bid'` \| `'cascade'` \| `'tiered'` | The mode that ran. |
| `reason` | string | Why the group ended. Winner cases: `winner`, `fallback_won`, `tier_winner`. No-winner cases: `no_partners_configured`, `no_accepted_bids`, `all_partners_passed`, `cascade_timeout`, `no_tiers_configured`, `all_tiers_skipped`, `all_tiers_exhausted`. |
| `_route` | `'winner'` \| `'no_winner'` | The edge handle the engine follows. |
| `tiers_skipped` | string[] \| absent | Tiered mode only. Ids of tiers whose `advance_condition` was false. |
| `tier_winner` | string \| absent | Tiered mode only. Id of the tier that produced the winner. |

### Per-attempt outcomes

Each entry in `all_bids` / `excluded` carries an `outcome` and a human-readable `outcome_reason`:

| `outcome` | Meaning |
|-----------|---------|
| `won` | Picked as the group's winner. |
| `outbid` | Returned a usable bid but lost on amount. |
| `declined` | Declined the lead (skip reason `rejected` or `bid_below_min`), or returned a null bid. |
| `skipped` | Not contacted (skip reason `partner_inactive`, `circuit_open`, `cap_exceeded`, or `duplicate`). |
| `error` | The attempt failed or timed out (the row is synthesized so the partner stays visible). |

## Edges and handles

The group routes by `_route`. Wire the outgoing edges by `source_handle`:

- `source_handle: 'winner'` to the step that handles a won bid (route the lead, write to Salesforce, respond with the offer).
- `source_handle: 'no_winner'` to the step that handles no winner (fall back, exit, respond with a decline).

If no `_route`-matching edge is wired (older configs), the engine falls back to the first outgoing edge whose condition matches. With `no_winner_behavior: 'exit'`, a no-winner result returns the group output as the HTTP response instead of routing.

## Examples

### Highest bid across two partners

```json
{
  "id": "bg_main",
  "namespace": "bid_race",
  "type": "bid_group",
  "config": {
    "mode": "highest_bid",
    "partner_ids": [
      "8f3c1a90-2b4d-4e77-9a1c-7e21b0c5d6aa",
      "1d2e3f40-5a6b-7c8d-9e0f-1a2b3c4d5e6f"
    ],
    "min_bid_threshold": 5,
    "timeout_ms": 5000,
    "fallback_partner_id": "aa11bb22-cc33-dd44-ee55-ff6677889900",
    "no_winner_behavior": "route"
  }
}
```

Both partners are queried in parallel with a 5s race deadline. The highest accepted bid of at least $5 wins. If neither qualifies, the fallback partner is tried; if it still produces no winner, the workflow takes the `no_winner` edge.

### Cascade with a fallback

```json
{
  "id": "bg_cascade",
  "namespace": "bid_cascade",
  "type": "bid_group",
  "config": {
    "mode": "cascade",
    "partner_ids": [
      "8f3c1a90-2b4d-4e77-9a1c-7e21b0c5d6aa",
      "1d2e3f40-5a6b-7c8d-9e0f-1a2b3c4d5e6f"
    ],
    "cascade_total_timeout_ms": 30000,
    "fallback_partner_id": "aa11bb22-cc33-dd44-ee55-ff6677889900",
    "no_winner_behavior": "exit"
  }
}
```

Tries the first partner; only if it does not win does it try the second; then the fallback. If none win, the workflow exits with the group output as the 200 response.

### Tiered with a gated second tier

```json
{
  "id": "bg_tiered",
  "namespace": "tiered_bid",
  "type": "bid_group",
  "config": {
    "mode": "tiered",
    "min_bid_threshold": 5,
    "fallback_partner_id": "aa11bb22-cc33-dd44-ee55-ff6677889900",
    "no_winner_behavior": "route",
    "context": {
      "finalDebt": "{{steps.eligibility.output.final}}"
    },
    "tiers": [
      {
        "id": "tier_premium",
        "label": "Premium buyers",
        "mode": "highest_bid",
        "partner_ids": ["8f3c1a90-2b4d-4e77-9a1c-7e21b0c5d6aa"]
      },
      {
        "id": "tier_overflow",
        "label": "Overflow",
        "mode": "cascade",
        "partner_ids": ["1d2e3f40-5a6b-7c8d-9e0f-1a2b3c4d5e6f"],
        "advance_condition": {
          "logic": "AND",
          "groups": [
            {
              "logic": "AND",
              "conditions": [
                { "field": "context.finalDebt", "operator": "gte", "value": 10000 }
              ]
            }
          ]
        }
      }
    ]
  }
}
```

Tier 1 runs first. If it produces no winner, tier 2 runs only when `finalDebt` is at least 10000; otherwise tier 2 is skipped (recorded in `tiers_skipped`). If no tier wins, the fallback partner is tried, then the `no_winner` edge is taken.

## See also

- [Partner Bid node](./partner-bid.md) for the single-partner attempt this node fans out to internally.
- [Partners reference](../reference/partners.md) for resolver types, the bid matrix, formulas, daily caps, circuit breakers, and outbound field mapping.
- [Bidding model](../concepts/bidding-model.md) for how bids, partners, and winners fit together.
- [Data references](../concepts/data-references.md) for the `context.*`, `steps.*`, `trigger.*`, `env.*` syntax.
