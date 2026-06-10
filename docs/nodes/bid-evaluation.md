# Bid Evaluation node

Picks a winner from partner bids that were already run in parallel. It reads the output of a [Parallel node](./parallel.md) whose children were [Partner Bid](./partner-bid.md) attempts, applies a minimum-bid threshold, selects the best candidate by your chosen strategy, and routes the workflow down a `winner` or `no_winner` edge.

This is the manual, two-node way to do bidding: a Parallel node fans out the partner bids, and this node evaluates them. For most workflows the [Bid Group node](./bid-group.md) is simpler. A Bid Group fans out to partners and picks the winner in one node, with the same partner-bid logic. Use Bid Evaluation when you specifically want to compose the fan-out yourself with a Parallel node (for example to mix partner bids with other parallel work, or to share one Parallel result across more than one consumer).

## How it selects a winner

1. Read the named Parallel step's output. Only fulfilled children with output are considered. Rejected or timed-out children are ignored.
2. Split candidates: a child counts as a candidate only if it was accepted, not skipped, and has a non-null bid. Everything else goes to `excluded`.
3. Apply `min_bid_threshold`: candidates below it move to `excluded`.
4. If no candidate qualifies, apply the no-qualifying-bids path (fallback partner, or `no_winner_behavior`).
5. Otherwise select the winner by `strategy`, breaking ties by `tiebreaker`.

## Config schema

The executor reads `node.config` as:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `parallel_source` | string | Yes | none | Namespace (step id) of the Parallel node whose partner-bid children to evaluate. The step must have completed. In the editor this is the "Bids from" dropdown. If missing, the node throws. |
| `strategy` | `'highest_bid'` \| `'weighted_score'` | No | `'highest_bid'` | How to rank candidates. See [Strategies](#strategies). |
| `min_bid_threshold` | number \| null | No | `null` (no minimum) | Bids below this amount are excluded before selection. In the editor: "Minimum bid threshold ($)". |
| `tiebreaker` | `'partner_priority'` \| `'fastest_response'` | No | `'partner_priority'` | How to break ties. Both currently preserve the Parallel child order (child order reflects priority). |
| `fallback_partner` | string (slug) \| null | No | `null` | If no candidate qualifies, route to this partner slug as a last resort. In the editor: "Fallback partner". |
| `no_winner_behavior` | `'exit'` \| `'fail'` | No | `'exit'` | What to do when no candidate qualifies and no fallback is set. See [No-winner behavior](#no-winner-behavior). |
| `weight_bid` | number | No | `1.0` | Weighted-score only. Multiplier on the bid amount. |
| `weight_acceptance` | number | No | `0.5` | Weighted-score only. Multiplier on the partner's recent acceptance rate. |
| `weight_speed` | number | No | `0.1` | Weighted-score only. Multiplier subtracted per ms of average response time (lower is better). |

`fallback_partner` is a partner slug string, unlike the Bid Group's `fallback_partner_id` which is a partner UUID. The fallback here is named as a winner with `bid: null` and `is_fallback: true`; this node does not run the fallback partner's bid logic, it just routes to it.

## Strategies

### Highest bid

`strategy: 'highest_bid'` (default) picks the candidate with the largest bid. Ties preserve Parallel child order (first listed wins). `reason` is `highest_bid`, or `highest_bid_fastest_response` when `tiebreaker` is `fastest_response`.

### Weighted score

`strategy: 'weighted_score'` ranks each candidate by:

```
score = bid * weight_bid
      + acceptance_rate * weight_acceptance
      - avg_response_ms * weight_speed
```

`acceptance_rate` and `avg_response_ms` come from the partner's last 30 days of `partner_bid` steps. A partner needs at least 10 bids in that window for real metrics; below that, defaults are used (`acceptance_rate` 0.5, `avg_response_ms` 5000). If the metrics query fails, scoring falls back to defaults for all partners and the output includes a `metrics_warning`. The weights do not need to sum to 1. `reason` is `weighted_score` (or `weighted_score_fastest_response`).

## No-winner behavior

When no candidate qualifies (all rejected, all below threshold, or no candidates at all):

| Value | Behavior |
|-------|----------|
| `'exit'` (default) | Return a `no_winner` result and take the `no_winner` outgoing edge. Does not fail the step. |
| `'fail'` | Throw, marking the step (and run) failed. |

A configured `fallback_partner` takes precedence: if set, the node always routes `winner` to the fallback instead of applying `no_winner_behavior`.

Note: this vocabulary differs from the [Bid Group node](./bid-group.md), where `'fail'` is a legacy alias for routing and never throws. Here, `'fail'` does throw.

## Output shape

`steps.<id>.output` contains a `BidEvaluationOutput`:

```json
{
  "winner": {
    "partner": "tripoint",
    "bid": 19.82,
    "namespace": "bids.tripoint",
    "raw": { "bid": 19.82 }
  },
  "all_bids": [
    { "partner": "tripoint", "bid": 19.82, "namespace": "bids.tripoint", "raw": { "bid": 19.82 } },
    { "partner": "m1", "bid": 12.0, "namespace": "bids.m1", "raw": { "bid": 12.0 } }
  ],
  "excluded": [],
  "reason": "highest_bid",
  "_route": "winner"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `winner` | object \| null | The chosen candidate: `partner`, `bid`, `namespace`, `raw`, and optional `score` (weighted) and `is_fallback` (true when the fallback partner was selected; its `bid` is `null`). `null` on a no-winner exit. |
| `all_bids` | array | Qualifying candidates considered (accepted, non-null bid, at or above threshold). Each has `partner`, `bid`, `namespace`, `raw`, and optional `score`. |
| `excluded` | array | Candidates that were skipped, declined, null-bid, or below threshold. |
| `reason` | string | `highest_bid`, `highest_bid_fastest_response`, `weighted_score`, `weighted_score_fastest_response`, `fallback`, `all_rejected`, or `all_below_threshold`. |
| `_route` | `'winner'` \| `'no_winner'` | The edge handle the engine follows. |
| `metrics_warning` | string \| absent | Present only when weighted scoring fell back to defaults because the metrics fetch failed. |

## Edges and handles

The node routes by `_route`. Wire the outgoing edges by `source_handle`:

- `source_handle: 'winner'` to the won-bid path (route, write to Salesforce, respond with the offer). This handle also fires when the fallback partner is selected.
- `source_handle: 'no_winner'` to the no-winner path (only reachable when `no_winner_behavior` is `'exit'` and no fallback is set; with `'fail'` the step throws instead).

## Examples

### Highest qualifying bid from a Parallel fan-out

```json
{
  "id": "eval_bids",
  "namespace": "pick_winner",
  "type": "bid_evaluation",
  "config": {
    "parallel_source": "bid_fanout",
    "strategy": "highest_bid",
    "min_bid_threshold": 5,
    "tiebreaker": "partner_priority",
    "no_winner_behavior": "exit"
  }
}
```

Reads the `bid_fanout` Parallel step, drops any bid below $5, and routes the highest remaining bid down the `winner` edge. With no qualifying bid it takes the `no_winner` edge.

### Weighted score with a fallback partner

```json
{
  "id": "eval_weighted",
  "namespace": "pick_winner",
  "type": "bid_evaluation",
  "config": {
    "parallel_source": "bid_fanout",
    "strategy": "weighted_score",
    "weight_bid": 1.0,
    "weight_acceptance": 0.75,
    "weight_speed": 0.05,
    "fallback_partner": "engine",
    "no_winner_behavior": "fail"
  }
}
```

Ranks partners by bid, acceptance rate, and speed. If none qualify, routes `winner` to the `engine` fallback (because a fallback is set, `no_winner_behavior: 'fail'` is not reached).

## See also

- [Bid Group node](./bid-group.md) for the one-node bid-to-N-partners-and-pick-a-winner alternative.
- [Partner Bid node](./partner-bid.md) for the per-partner attempts this node evaluates.
- [Parallel node](./parallel.md) for the fan-out that feeds `parallel_source`.
- [Partners reference](../reference/partners.md) for partner configuration.
- [Bidding model](../concepts/bidding-model.md) for how bids, partners, and winners fit together.
- [Data references](../concepts/data-references.md) for the `steps.*` syntax used to reference the Parallel source.
