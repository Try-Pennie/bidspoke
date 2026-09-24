# Node catalog

Every node type Bidspoke supports, grouped by purpose. A node is one step in a workflow. You add nodes to the canvas, configure each one, and connect them with edges. Each node reads data from upstream steps (see [data references](../concepts/data-references.md)), does its work, and produces an output that later nodes can read as `steps.<namespace>.output.<path>`.

For the JSON shape of a node and how edges route between them, see the [workflow definition schema](../concepts/workflow-definition-schema.md).

## Control flow

| Node | `type` | What it does | Routing |
|------|--------|--------------|---------|
| [Filter](filter.md) | `filter` | Pass/exit gate on a condition. | `pass` / `exit` |
| [Branch](branch.md) | `branch` | N conditional outputs plus an else path. | one handle per branch |
| [Parallel](parallel.md) | `parallel` | Fan out to child nodes concurrently. | child handles, then join |
| [Exit](exit.md) | `exit` | End the execution early, with an optional response. | terminates |
| [Response](response.md) | `response` | Send a structured HTTP response to the caller. | terminates or continues |

## Data and integrations

| Node | `type` | What it does | Routing |
|------|--------|--------------|---------|
| [Code](code.md) | `code` | Run a sandboxed JavaScript script. Can respond or exit early. | single next |
| [Webhook](webhook.md) | `webhook` | Outbound HTTP request to an external service (also called the Integration node). | single next |
| [Salesforce](salesforce.md) | `salesforce` | Create, update, or query Salesforce records, with dedup support. | single next |
| [Transform](transform.md) | `transform` | Map and reshape data into a new object. | single next |
| [Constants](constants.md) | `constants` | Emit workflow constants merged with partner data from the database. | single next |
| [Data Store](data-store.md) | `data_store` | Read and write a key-value store (KV-backed). | single next |

## Bidding

| Node | `type` | What it does | Routing |
|------|--------|--------------|---------|
| [Bid Group](bid-group.md) | `bid_group` | Fan out to N partners and pick a winner (cascade / highest bid / tiered). | `winner` / `no_winner` |
| [Partner Bid](partner-bid.md) | `partner_bid` | Request a bid from a single partner. | single next |
| [Latency Gate](latency-gate.md) | `latency_gate` | Mark and check a partner match-latency window. | `within` / `exceeded` |
| [Achieve Offers](achieve-offers.md) | `achieve_offers` | Send the lead to Achieve (FDR) and log the offers returned; collect-only. | single next |
| [Buyer Select](buyer-select.md) | `buyer_select` | Sell a sell off lead to the highest ranked eligible buyer, from buyer profiles rather than a script. | `sold` / `no_sale` / `not_applicable` / `deferred` |
| [Buyer Click Check](buyer-click-check.md) | `buyer_click_check` | Decide on Engine's response path whether a click sold buyer may be offered this lead, against its profile and today's clicks. | `eligible` / `not_eligible` |
| [Buyer Click Send](buyer-click-send.md) | `buyer_click_send` | Send a clicked prospect to a click sold buyer once, and count it once, in one step. | `sent` / `refused` / `unknown` / `already_sent` / `in_progress` / `needs_review` / `not_sent` |

The [Bid Group](bid-group.md) node is the primary, first-class way to run a parallel auction across partners: it is one canvas node that fans out to the partners internally. [Partner Bid](partner-bid.md) is the lower-level building block (a single partner attempt) used in hand-built or imported flows. The default node palette surfaces Bid Group; Partner Bid is available as a node type in definitions even though it is not a separate palette entry.

## Which nodes are in the canvas palette

The drag-and-drop palette offers: Filter, Branch, Code, Response, Exit, Transform, Webhook, Parallel, Bid Group, Constants, Salesforce, Data Store, Latency Gate, Achieve Offers, Buyer Select, and Buyer Click Send. The engine additionally understands `partner_bid` and the passive join nodes `branch_end` and `parallel_end`, which appear automatically when you use Branch and Parallel.

## See also

- [Workflow definition schema](../concepts/workflow-definition-schema.md)
- [Data references](../concepts/data-references.md)
- [Bidding model](../concepts/bidding-model.md)
