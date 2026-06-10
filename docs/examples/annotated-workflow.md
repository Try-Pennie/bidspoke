# Annotated workflow

A complete, realistic workflow definition, explained node by node. This is an inbound bidding (ping-post) flow: an external network pings the workflow with a lead, the workflow validates it, dedups against Salesforce, runs a parallel auction across partners, and responds with the winning offer or a rejection.

Use this as a template. For the formal shape of every field, see the [Workflow definition schema](../concepts/workflow-definition-schema.md). For the syntax of the `{{ }}` and dot-path references, see [Data references](../concepts/data-references.md).

## The full definition

```json
{
  "id": "22222222-2222-2222-2222-222222222222",
  "name": "Inbound bidding (example)",
  "trigger": {
    "type": "http_webhook",
    "config": { "method": "POST", "auth_method": "api_key" }
  },
  "nodes": [
    {
      "id": "n-constants",
      "namespace": "constants",
      "type": "constants",
      "config": {
        "data": { "MIN_LOAN": 1000, "MAX_LOAN": 50000 }
      }
    },
    {
      "id": "n-validate",
      "namespace": "validate",
      "type": "filter",
      "config": {
        "operation": "continue_if",
        "rules": {
          "logic": "AND",
          "groups": [
            {
              "logic": "AND",
              "conditions": [
                { "field": "trigger.payload.email", "operator": "exists" },
                { "field": "trigger.payload.loan_amount", "operator": "gte", "value": "{{ steps.constants.output.MIN_LOAN }}" },
                { "field": "trigger.payload.loan_amount", "operator": "lte", "value": "{{ steps.constants.output.MAX_LOAN }}" }
              ]
            }
          ]
        }
      }
    },
    {
      "id": "n-dedup",
      "namespace": "dedup",
      "type": "salesforce",
      "config": {
        "operation": "query",
        "soql": "SELECT Id FROM Lead WHERE Email = '{{ trigger.payload.email }}' LIMIT 1",
        "expected_errors": []
      }
    },
    {
      "id": "n-already-seen",
      "namespace": "seen_check",
      "type": "filter",
      "config": {
        "operation": "end_if",
        "condition": { "field": "steps.dedup.output.totalSize", "operator": "gt", "value": 0 }
      }
    },
    {
      "id": "n-auction",
      "namespace": "auction",
      "type": "bid_group",
      "config": {
        "mode": "highest_bid",
        "partner_ids": ["<partner-uuid-a>", "<partner-uuid-b>"],
        "timeout_ms": 10000,
        "no_winner_behavior": "route"
      }
    },
    {
      "id": "n-offer",
      "namespace": "offer",
      "type": "response",
      "config": {
        "status_code": 200,
        "headers": { "Content-Type": "application/json" },
        "body": {
          "accepted": true,
          "bid": "{{ steps.auction.output.winner.bid }}",
          "partner": "{{ steps.auction.output.winner.partner }}"
        }
      }
    },
    {
      "id": "n-reject",
      "namespace": "reject",
      "type": "response",
      "config": {
        "status_code": 200,
        "headers": { "Content-Type": "application/json" },
        "body": { "accepted": false, "reason": "no winning bid" }
      }
    },
    {
      "id": "n-duplicate",
      "namespace": "duplicate",
      "type": "exit",
      "config": { "response": { "accepted": false, "reason": "duplicate lead" } }
    },
    {
      "id": "n-invalid",
      "namespace": "invalid",
      "type": "exit",
      "config": { "response": { "accepted": false, "reason": "failed validation" } }
    }
  ],
  "edges": [
    { "id": "e1", "source": "trigger", "target": "n-constants" },
    { "id": "e2", "source": "n-constants", "target": "n-validate" },
    { "id": "e3", "source": "n-validate", "source_handle": "pass", "target": "n-dedup" },
    { "id": "e4", "source": "n-validate", "source_handle": "exit", "target": "n-invalid" },
    { "id": "e5", "source": "n-dedup", "target": "n-already-seen" },
    { "id": "e6", "source": "n-already-seen", "source_handle": "exit", "target": "n-duplicate" },
    { "id": "e7", "source": "n-already-seen", "source_handle": "pass", "target": "n-auction" },
    { "id": "e8", "source": "n-auction", "source_handle": "winner", "target": "n-offer" },
    { "id": "e9", "source": "n-auction", "source_handle": "no_winner", "target": "n-reject" }
  ]
}
```

## Node by node

**`n-constants` (Constants).** Runs first so every later node can reference shared values. Here it defines `MIN_LOAN` and `MAX_LOAN`, read downstream as `steps.constants.output.MIN_LOAN`. A real flow also pulls partner data (UUID map, sell-off copy) from the database through this node. See [Constants node](../nodes/constants.md).

**`n-validate` (Filter).** Gates the lead. With `operation: "continue_if"`, it passes (`pass`) only when all conditions hold: an email is present and the loan amount is within the configured band. Failing leads route from the `exit` handle to `n-invalid`. See [Filter node](../nodes/filter.md).

**`n-dedup` (Salesforce).** Queries Salesforce for an existing lead with the same email. The result is available as `steps.dedup.output` (here `totalSize` is the count of matching records). See [Salesforce node](../nodes/salesforce.md).

**`n-already-seen` (Filter).** With `operation: "end_if"`, this filter routes to `exit` when the condition is true, that is when the dedup query found a match (`totalSize > 0`). A matched lead routes to `n-duplicate`; a fresh lead passes to the auction. This is the ping-post dedup gate.

**`n-auction` (Bid Group).** The core of the flow. It fans out to the listed partners in parallel, collects their bids, and in `highest_bid` mode selects the top bid. Its output exposes `steps.auction.output.winner` (with `bid` and `partner`, the partner slug) and `steps.auction.output.all_bids`. It routes from the `winner` handle when someone bid and from `no_winner` when no partner did. See [Bid Group node](../nodes/bid-group.md) and the [Bidding model](../concepts/bidding-model.md).

**`n-offer` (Response).** Terminates the run with the winning offer, reading the winner's bid and partner from the auction output. See [Response node](../nodes/response.md).

**`n-reject` (Response).** Terminates the run with a clean rejection when no partner bid.

**`n-duplicate` and `n-invalid` (Exit).** Terminate early for duplicate and invalid leads, each returning a small body explaining why. See [Exit node](../nodes/exit.md).

## How an AI should adapt this

- Replace `<partner-uuid-a>` and `<partner-uuid-b>` with real partner ids from partner settings, or use a [Bid Group](../nodes/bid-group.md) `cascade` or `tiered` mode if you want ordered or tiered bidding.
- Every node's `id` should be a UUID in a real definition; the `namespace` is the short name you reference in `steps.<namespace>.output`.
- Keep one terminating node (`response` or `exit`) on every path, so every lead gets a reply.
- For an outbound routing flow, add credit-pull and enrichment [Webhook](../nodes/webhook.md) or [Code](../nodes/code.md) nodes before the auction. See [Building a bidding workflow](../guides/building-a-bidding-workflow.md).

## See also

- [Workflow definition schema](../concepts/workflow-definition-schema.md)
- [Bidding model](../concepts/bidding-model.md)
- [Building a bidding workflow](../guides/building-a-bidding-workflow.md)
