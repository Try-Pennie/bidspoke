# Bidspoke overview

Bidspoke is a visual workflow builder for lead routing and partner bidding. You build a workflow on a canvas by dragging nodes and connecting them with edges, then point a webhook at it. When a lead arrives, Bidspoke walks the graph step by step: validates and enriches the lead, asks partners for bids, picks a winner, routes the result to a system like Salesforce, and returns an HTTP response.

This page is the starting map. If you are brand new, read this first, then follow the [getting started](../guides/getting-started.md) guide.

## What Bidspoke is for

Pennie routes consumer lead traffic to lending partners. Each lead needs to be checked, enriched (credit pull, eligibility), offered to one or more partners, and sold to the partner that bids highest (or accepted by the first partner in a cascade). Bidspoke replaces a tangle of Pipedream workflows with one place to build, test, version, and observe that logic. Real money moves through these workflows, so the platform is built around testing, versioning, and observability rather than just "run and hope".

## The two modes

Most workflows fall into one of two shapes. They use the same canvas and the same nodes; the difference is who initiates the call and which way the bid flows.

### Outbound routing

A lead lands on Pennie (for example, from a website form). The workflow validates it, enriches it, then asks several buyer partners for bids in parallel and routes the lead to the highest bidder. This is the classic "we have a lead, who wants it" flow.

Typical shape: trigger to validate to enrich to [Bid Group](../nodes/bid-group.md) (highest bid) to route to [Salesforce](../nodes/salesforce.md) to [Response](../nodes/response.md). See [Build a bidding workflow](../guides/building-a-bidding-workflow.md).

### Inbound bidding

A partner (or upstream platform like Engine) pings Pennie with a lead and asks for a bid. The workflow validates the lead, runs a decision engine, and returns a bid in the HTTP response. Here Pennie is the bidder, not the buyer.

Typical shape: trigger to validate to decision logic to [Response](../nodes/response.md) carrying the bid. Inbound endpoints are usually [custom endpoints](../guides/environment-variables-and-secrets.md) on `hook.trypennie.dev`.

## The core pieces

### Canvas and nodes

The canvas is where you build. The left rail is the node palette; you drag a node onto the canvas and connect it to others with edges. Each node does one job. The node types are:

- [Filter](../nodes/filter.md) - two-output pass/exit gate. Drop unqualified leads.
- [Branch](../nodes/branch.md) - N labeled conditional paths plus an `else` edge.
- [Code](../nodes/code.md) - sandboxed JavaScript in an isolated worker. Use for custom logic, API calls, and credit pulls.
- [Transform](../nodes/transform.md) - reshape and rename fields with dot-path mapping.
- [Response](../nodes/response.md) - the HTTP response sent back to the caller.
- [Exit](../nodes/exit.md) - early termination, with an optional response.
- [Parallel](../nodes/parallel.md) - run several branches concurrently.
- [Bid Group](../nodes/bid-group.md) - send a lead to N partners and pick a winner (cascade, highest bid, or tiered).
- [Constants](../nodes/constants.md) - workflow-level constants plus partner data (UUIDs, sell-off copy) from the database.
- [Salesforce](../nodes/salesforce.md) - create, update, or query Salesforce records.
- [Data Store](../nodes/data-store.md) - KV read/write with TTL.
- [Latency Gate](../nodes/latency-gate.md) - stamp a time, then gate on elapsed time (for match-charging partners).
- [Webhook](../nodes/webhook.md) - outgoing HTTP request.

Nodes read each other's results through [data references](./data-references.md) like `trigger.payload.email`, `steps.validate.output.score`, and `env.MY_KEY`.

### Triggers

A workflow runs when its trigger fires. The default trigger is an HTTP webhook at `https://hook.trypennie.dev/webhooks/<workflow_id>` authenticated with an `X-API-Key` header. You can also map a branded [custom endpoint](../guides/environment-variables-and-secrets.md) like `hook.trypennie.dev/partner-name/bidding` to a workflow. The trigger payload is available downstream as `trigger.payload.*`.

### Partners

A partner is a buyer or a source, configured on the Partners page, not on the canvas. A buyer partner receives bids (an API call, a formula, or a bid matrix decides the bid amount). A source partner sends leads to Pennie. Bid Group and Partner Bid nodes reference partners by their configuration. See [Configure a partner](../guides/configuring-a-partner.md) and the [partners reference](../reference/partners.md).

### Executions

Every run of a workflow is an execution. Each node that runs becomes a step with recorded input and output. You can watch executions live on the canvas overlay, replay them from the start, or resume them from a failed step. See [Testing and debugging](../guides/testing-and-debugging.md) and the [observability reference](../reference/observability.md).

### Versions and backup

Every save creates a version snapshot. You can browse, preview, and restore any version. Saves are also pushed to a GitHub backup repo with a commit SHA recorded on the version. See [Versioning and backup](../guides/versioning-and-backup.md).

## Start here

1. [Getting started](../guides/getting-started.md) - sign in, find the canvas, run your first test.
2. [Build a bidding workflow](../guides/building-a-bidding-workflow.md) - the end-to-end outbound flow.
3. [Configure a partner](../guides/configuring-a-partner.md) - add a buyer or source on the Partners page.
4. [Test and debug](../guides/testing-and-debugging.md) - saved payloads, step-by-step replay, why a lead got no bid.
5. [Import from Pipedream](../guides/importing-from-pipedream.md) - bring an existing Pipedream workflow in.
6. [Environment variables and secrets](../guides/environment-variables-and-secrets.md) - where credentials live.
7. [Versioning and backup](../guides/versioning-and-backup.md) - snapshots, restore, GitHub.

## See also

- [Data references](./data-references.md) for the `trigger.*`, `steps.*`, `env.*` syntax every node uses.
- [Partners reference](../reference/partners.md) for the partner config fields.
- [Observability reference](../reference/observability.md) for traces, logs, and dashboards.
