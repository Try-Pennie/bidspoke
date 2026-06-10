# Glossary

Definitions of the terms used across the Bidspoke documentation. Each entry links to the page where the concept is covered in full.

## Core model

**Workflow** - a named, saved automation built on the canvas. It has a current definition (its nodes and edges) and a history of versions. A workflow can be active (live, reachable by its trigger) or inactive. See [Workflows and executions](workflows-and-executions.md).

**Workflow definition** - the JSON that describes a workflow: its `nodes` and `edges` plus a `trigger`. This is what the engine executes. See [Workflow definition schema](workflow-definition-schema.md).

**Version** - an immutable snapshot of a workflow definition. Every save creates a new version. You can browse, preview, and restore versions. See [Versioning and backup](../guides/versioning-and-backup.md).

**Execution** - one run of a workflow, produced when a trigger fires. It has a status, a trace id, and a list of steps. See [Workflows and executions](workflows-and-executions.md).

**Step** - the record of one node running during an execution. It captures the node's resolved input and its output, plus timing and any error. Downstream nodes read a step's output as `steps.<namespace>.output.<path>`.

**Node** - one unit of work in a workflow (a step type). Each node has a `type` and a `config`. See the [node catalog](../nodes/README.md).

**Edge** - a directed connection from one node to another. Edges can carry a `source_handle` (which output of the source node) and an optional `condition`. The engine follows edges to decide what runs next. See [Workflow definition schema](workflow-definition-schema.md#edges).

**Namespace** - the short reference name of a node (distinct from its `id`). Downstream nodes read its output as `steps.<namespace>.output.<path>`. See [Data references](data-references.md).

**Trigger** - how a workflow is started. Today the only trigger type is an HTTP webhook (`http_webhook`). See [Triggers and endpoints](triggers-and-endpoints.md).

## Triggering and auth

**Webhook** - the HTTP entry point that starts a workflow: `POST /webhooks/:workflow_id`. The request body becomes `trigger.payload`. See [Webhook contract](../reference/webhook-contract.md). Note: the **Webhook node** (`type: webhook`) is a different thing: it is the node that makes an outbound HTTP call. See [Webhook node](../nodes/webhook.md).

**Custom endpoint** - a friendly, source-specific URL that maps to a workflow, served on `hook.trypennie.dev/<subdomain>/<path>`. See [Triggers and endpoints](triggers-and-endpoints.md).

**Source** - the labeled origin of a lead (for example a website form, Wallet Owl, Reserve, or a network like Engine). A source has an API key, and sources can be assigned to specific workflows. The source name is stamped on each execution.

**API key** - the credential a caller passes in the `X-API-Key` header to authenticate a webhook request. See [Webhook contract](../reference/webhook-contract.md).

**Idempotency** - the mechanism that prevents a duplicate request from running a workflow twice. A repeated request returns the cached response with the `X-Idempotent-Replay: true` header. See [Webhook contract](../reference/webhook-contract.md).

**Trace id** - a unique id assigned to each execution, returned in the `X-Trace-Id` response header and propagated to outbound partner calls. Use it to follow one lead end to end. See [Observability](../reference/observability.md).

## Bidding

**Partner** - an external buyer or source of leads, configured in partner settings. A partner has a `partner_type` of `source` or `buyer`. Buyers bid on leads. See [Partners](../reference/partners.md).

**Bid** - an amount a partner offers for a lead. A bid can come from a formula, a matrix lookup, or the partner's API. See [Bidding model](bidding-model.md).

**Bid resolver** - how a partner's bid is computed: `formula`, `matrix`, or `api`. Set per partner via `bid_resolver_type`. See [Partners](../reference/partners.md).

**Bid matrix** - a table of bid amounts keyed by lead attributes (for example credit-score bands), synced from Salesforce. See [Partners](../reference/partners.md).

**Daily cap** - a per-partner limit on leads per day, enforced by a Durable Object and reset at midnight UTC. A capped partner is skipped. See [Bidding model](bidding-model.md).

**Circuit breaker** - per-partner failure protection with `closed`, `open`, and `half-open` states. An open breaker skips the partner until it recovers. See [Bidding model](bidding-model.md).

**Dedup** - a check that rejects a lead a partner has already seen, so you are not billed for duplicates. See [Bidding model](bidding-model.md).

**Hub-and-spoke** - the outbound routing pattern: a lead is validated and enriched, then bid out to all eligible partners in parallel, and the highest bidder wins, with Engine as the fallback buyer. See [Bidding model](bidding-model.md).

**Ping-post** - the inbound bidding pattern: an external network pings the workflow with a lead, the workflow evaluates it and responds with an offer or a rejection. See [Bidding model](bidding-model.md).

**Sell-off** - the offer copy and click URL shown when a lead is routed to a given source partner. Configured in partner settings and exposed through the [Constants node](../nodes/constants.md).

## Reliability and operations

**Error classification** - how the engine labels a failure: transient (retried) or permanent (not retried). A business rejection is a separate outcome (the lead is rejected and logged, not an error). See [Error handling](../reference/error-handling.md).

**Fallback node** - the node a step jumps to when it fails and its `on_error` is set to `fallback`. See [Error handling](../reference/error-handling.md).

**Resume** - re-running a failed execution from the failed step, keeping the steps that already succeeded. See [Testing and debugging](../guides/testing-and-debugging.md).

**Replay** - running a workflow again from the start with the original payload, producing a fresh execution. See [Testing and debugging](../guides/testing-and-debugging.md).

**Environment variable** - a named value available to all workflows as `env.<NAME>`. Marked `is_secret` to hide and encrypt it. Partner and workflow credentials live here, not in Cloudflare secrets. See [Environment variables and secrets](../guides/environment-variables-and-secrets.md).

**Estimated cost** - the per-execution cost estimate (`cost_usd`), assembled from partner API calls, code-node compute, Supabase writes, and the main worker's request and CPU time. See [Observability](../reference/observability.md).

## See also

- [Overview](overview.md)
- [Workflow definition schema](workflow-definition-schema.md)
- [Node catalog](../nodes/README.md)
