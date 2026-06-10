# Build a bidding workflow

A step-by-step walkthrough for building an outbound bidding workflow: a lead arrives, you validate and enrich it, ask several partners for bids in parallel, pick the highest bidder, route the result to Salesforce, and return an HTTP response. By the end you will have a workflow you can test and turn on.

This guide assumes you have signed in and can open the canvas. If not, start with [getting started](./getting-started.md). For the big picture, read the [overview](../concepts/overview.md).

## The shape you are building

The finished workflow looks like this, left to right:

```
trigger -> validate (Filter) -> enrich (Code) -> Bid Group (highest bid)
                                                     |- winner   -> Salesforce -> Response
                                                     |- no_winner -> Response (no offer)
```

Each box is a node. Each arrow is an edge. The Bid Group node has two outgoing edges, `winner` and `no_winner`, and you wire each to a different next step.

## Step 1: Create the workflow and open the canvas

1. Go to the Workflows page and create a new workflow (give it a name like "Lead Routing").
2. Open it. You land on the canvas. The left rail is the node palette. The top of the canvas has Save, Undo/Redo, Test, Versions, and Import controls. The trigger node is already on the canvas.
3. Click the trigger node. The config panel on the right shows the webhook URL `https://hook.trypennie.dev/webhooks/<workflow_id>` and the auth method (API Key, sent as the `X-API-Key` header). The lead body you POST to that URL is available downstream as `trigger.payload.*`.

## Step 2: Validate the lead with a Filter node

Drop a [Filter node](../nodes/filter.md) and wire the trigger to it. The Filter is a two-output gate: leads that pass continue, leads that fail take the `exit` edge.

Configure it to continue only when the lead has the fields you need. For example, continue only when an email is present:

```json
{
  "operation": "continue_if",
  "condition": {
    "field": "trigger.payload.email",
    "operator": "exists"
  }
}
```

In the config panel, set Operation to "Continue if condition is met", field to `trigger.payload.email`, and operator to "exists". Leads with an email route to the `pass` handle; everything else routes to `exit`. Wire the `pass` handle to the next node. You can leave `exit` unwired (the run simply ends there) or wire it to a [Response node](../nodes/response.md) that returns a rejection.

For multiple checks, use [data references](../concepts/data-references.md) in the field, and add a [Branch node](../nodes/branch.md) when you need more than two labeled outcomes.

## Step 3: Enrich the lead with a Code node

Drop a [Code node](../nodes/code.md) and wire the Filter `pass` handle to it. The Code node runs sandboxed JavaScript in an isolated worker. Use it for a credit pull, an eligibility calculation, or any custom enrichment.

Inside a Code node, the available globals are `trigger.payload`, `steps`, `env`, `execution`, `props`, and `console` (no `$`, no imports, native `fetch`). Read upstream data with [data references](../concepts/data-references.md) and return an object; downstream nodes read it as `steps.<this_node>.output.*`.

```js
// Read the lead, call an enrichment API, return the enriched fields.
const res = await fetch('https://api.example.com/enrich', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': env.ENRICH_API_KEY },
  body: JSON.stringify({ email: trigger.payload.email })
})
const data = await res.json()
return { credit_score: data.score, monthly_debt: data.debt }
```

Credentials like `ENRICH_API_KEY` live on the [Environment Variables page](./environment-variables-and-secrets.md), not in the code. The node reads them as `env.ENRICH_API_KEY`.

## Step 4: Ask partners for bids with a Bid Group node

Drop a [Bid Group node](../nodes/bid-group.md) and wire the Code node to it. The Bid Group node sends the lead to N partners and picks a winner. It has three modes:

- `highest_bid` - fan out to all partners in parallel; the highest accepted bid wins.
- `cascade` - try partner 1, advance to partner 2 only if 1 does not win, and so on.
- `tiered` - ordered tiers, each cascade or highest-bid internally, advancing between tiers when no winner.

For a standard parallel auction, use `highest_bid`. In the config panel, select the partners to include (these are buyer partners you set up on the [Partners page](./configuring-a-partner.md)) and set a race deadline so slow partners do not hold up the run:

```json
{
  "mode": "highest_bid",
  "partner_ids": ["tripoint", "m1", "engine"],
  "timeout_ms": 5000,
  "min_bid_threshold": null,
  "no_winner_behavior": "route"
}
```

The Bid Group node internally handles each partner's circuit breaker, daily cap, dedup, bid resolution (API, formula, or matrix), and response classification. You do not wire individual partner nodes; the fan-out happens inside the one Bid Group node.

### The two output edges

The Bid Group node emits `_route` of `'winner'` or `'no_winner'` and follows the matching outgoing edge. Wire both:

- `winner` - to the route/Salesforce step.
- `no_winner` - to a Response that returns "no offer" (or wherever you want failed auctions to go).

The `no_winner_behavior` field controls what happens on no winner: `route` (default) follows the `no_winner` edge; `exit` short-circuits the workflow and returns the group output as the response. You can also set a `fallback_partner_id` so a fallback partner is tried when no one bids.

### Output shape

`steps.<bid_group>.output` contains:

```json
{
  "winner": { "partner_slug": "tripoint", "bid": 42.5, "...": "..." },
  "all_bids": [ { "partner_slug": "m1", "bid": 38, "outcome": "outbid" } ],
  "mode": "highest_bid",
  "reason": "highest_bid",
  "_route": "winner"
}
```

Downstream nodes read the winning partner and amount as `steps.<bid_group>.output.winner.partner_slug` and `steps.<bid_group>.output.winner.bid`.

## Step 5: Route the winner to Salesforce

Wire the Bid Group `winner` handle to a [Salesforce node](../nodes/salesforce.md). Use it to create or update the prospect record with the winning partner and bid. Reference the winner with data references, for example `steps.bid_group.output.winner.partner_slug`. Salesforce credentials come from the [Environment Variables page](./environment-variables-and-secrets.md).

## Step 6: Return a response

Wire the Salesforce node to a [Response node](../nodes/response.md). The Response node sets the HTTP status, headers, and body returned to the original caller. Build the body from the winner:

```json
{
  "status_code": 200,
  "body": {
    "matched": true,
    "partner": "{{steps.bid_group.output.winner.partner_slug}}",
    "offer": "{{steps.bid_group.output.winner.bid}}"
  }
}
```

Wire the Bid Group `no_winner` handle to a second Response node that returns `{ "matched": false }` with whatever status you want.

## Step 7: Save, test, and turn it on

1. Click Save. Every save creates a [version snapshot](./versioning-and-backup.md) and pushes a backup to GitHub. If a node is attached but unconfigured, you will see an amber ring and the save is blocked for live workflows.
2. Open the Test panel and run a sample payload through it. Watch the steps light up on the canvas overlay and read each node's resolved input and output. See [Testing and debugging](./testing-and-debugging.md).
3. When the test looks right, enable the workflow. From then on, POSTing a lead to the webhook URL with the `X-API-Key` header runs it for real.

## Inbound bidding variant

If instead a partner is pinging you for a bid (inbound), the shape is simpler: trigger to validate (Filter) to decision logic (Code) to Response, where the Response body carries your bid. Inbound endpoints are usually [custom endpoints](./environment-variables-and-secrets.md) on `hook.trypennie.dev`. There is no Bid Group node, because you are the bidder, not the buyer. See the [overview](../concepts/overview.md) for the distinction.

## See also

- [Bid Group node](../nodes/bid-group.md) for cascade, highest-bid, and tiered modes and the full config.
- [Configure a partner](./configuring-a-partner.md) for setting up the buyers a Bid Group references.
- [Testing and debugging](./testing-and-debugging.md) for running and inspecting the workflow.
- [Data references](../concepts/data-references.md) for the `trigger.*`, `steps.*`, `env.*` syntax.
- [Filter node](../nodes/filter.md), [Code node](../nodes/code.md), [Salesforce node](../nodes/salesforce.md), [Response node](../nodes/response.md).
