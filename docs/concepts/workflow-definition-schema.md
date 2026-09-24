# Workflow Definition Schema

The canonical JSON shape of a Bidspoke workflow. A workflow definition describes a trigger, a set of nodes, and the edges that connect them. The execution engine loads this object, finds the entry node, and walks the graph node by node, following edges to route from one node to the next. This page documents every field exactly as the engine reads it, so an AI or a person can build or edit a valid definition by hand.

For the expression syntax used inside node configs and edge conditions, see [data references](./data-references.md). For how a definition gets turned into a running execution, see [workflows and executions](./workflows-and-executions.md). For how a workflow is invoked, see [triggers and endpoints](./triggers-and-endpoints.md).

## Top-level object

A workflow definition is a single JSON object with these fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | The workflow's id (a UUID). Matches the `workflow_id` used in the trigger URL. |
| `name` | string | Yes | Human-readable workflow name. |
| `trigger` | object | Yes | How the workflow is invoked. See [Trigger](#trigger). |
| `nodes` | array | Yes | The nodes in the workflow. See [Nodes](#nodes). |
| `edges` | array | Yes | The connections between nodes. See [Edges](#edges). |

```json
{
  "id": "11111111-1111-1111-1111-111111111111",
  "name": "Lead intake",
  "trigger": { "type": "http_webhook", "config": { "method": "POST", "auth_method": "api_key" } },
  "nodes": [],
  "edges": []
}
```

## Trigger

The `trigger` object describes how the workflow is started. Today the only trigger type is `http_webhook`.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `"http_webhook"` | Yes | | The trigger type. Only `http_webhook` is supported. |
| `config.method` | string | Yes | | HTTP method the endpoint expects, normally `"POST"`. |
| `config.auth_method` | `"api_key"` \| `"none"` | Yes | | `api_key` requires a valid `X-API-Key` header. `none` skips key auth (custom endpoints only). See [triggers and endpoints](./triggers-and-endpoints.md). |
| `config.idempotency` | object | No | disabled | Duplicate-suppression config. See below. |
| `config.idempotency.enabled` | boolean | No | `false` | Turn idempotency on. |
| `config.idempotency.derive_from_fields` | string[] | No | | Payload field paths used to derive an idempotency key when no `X-Idempotency-Key` header is sent. |
| `config.idempotency.ttl_seconds` | number | No | `300` | How long a derived/sent key is remembered. Floored at 60 (Cloudflare KV minimum). |
| `config.duration_alert_ms` | number | No | | Per-run "slow" threshold used by the aggregated slow-spike alert. |
| `config.success_node_namespaces` | string[] | No | `[]` | Namespaces that, when completed, mark the execution outcome `successful` rather than `completed`. See [workflows and executions](./workflows-and-executions.md). |

```json
{
  "type": "http_webhook",
  "config": {
    "method": "POST",
    "auth_method": "api_key",
    "idempotency": { "enabled": true, "derive_from_fields": ["email", "ssn"], "ttl_seconds": 600 },
    "success_node_namespaces": ["offer_response"]
  }
}
```

## Nodes

`nodes` is an array of node objects. Each node has a stable `id`, a `namespace` used for data references and logging, a `type`, and a `config` envelope.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique node id within the workflow. Edges reference nodes by `id`. Stored as a UUID in step logs, so use a UUID. |
| `namespace` | string | Yes | The reference name. Downstream nodes read this node's output as `steps.<namespace>.output.<path>`. Keep it short and unique (for example `validate`, `credit_pull`). |
| `type` | string | Yes | The node type. See [Node types](#node-types). |
| `label` | string | No | Display label on the canvas. Does not affect execution. |
| `position` | `{ x, y }` | No | Canvas coordinates. Layout only, ignored by the engine. |
| `config` | object | Yes | Per-type configuration plus the shared execution options below. |
| `variables` | object | No | Optional map of template strings resolved before execution (used by some node types). |
| `parent` | string | No | For parallel children: the id of the owning `parallel` node. |
| `children` | string[] | No | Legacy: child node ids on a `parallel` node. Newer definitions wire children via `child-N` edges instead. |

### Shared config options

Every node's `config` may include these execution controls. They are read by the engine's step loop, not by the node executor.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `timeout_ms` | number | No | `30000` | Per-step timeout. |
| `retries` | number | No | `2` | Retry count for transient errors. Permanent errors (business 4xx) are never retried. |
| `retry_backoff` | `"linear"` \| `"exponential"` | No | `"exponential"` | Backoff strategy between retries (exponential: 500ms, 1s, 2s). |
| `on_error` | `"fail"` \| `"skip"` \| `"fallback"` | No | `"fail"` | What to do when the step fails after retries. `fail` stops the execution; `skip` marks the step skipped and continues; `fallback` routes to `fallback_node`. |
| `fallback_node` | string | No | | Node id to jump to when `on_error` is `"fallback"`. |

All other keys in `config` are node-type-specific. See the per-node docs under [../nodes/](../nodes/).

### Node types

The valid `type` values. Each links to its config and output shape where a dedicated page exists.

| `type` | Purpose | Routing | Doc |
|--------|---------|---------|-----|
| `code` | Run a sandboxed JavaScript script (Code node). Can respond/exit early. | Single next edge | ../nodes/code.md |
| `filter` | Two-output pass/exit gate. | `pass` / `exit` handles | [../nodes/filter.md](../nodes/filter.md) |
| `branch` | N conditional outputs plus `else`. | Branch label handles | ../nodes/branch.md |
| `branch_end` | Passive join for a `branch`. | Single next edge | ../nodes/branch.md |
| `parallel` | Fan out to child nodes concurrently. | Children via `child-N` handles | ../nodes/parallel.md |
| `parallel_end` | Join node for a `parallel`. | Single next edge | ../nodes/parallel.md |
| `partner_bid` | Request a bid from one partner. | Single next edge | ../nodes/partner-bid.md |
| `bid_group` | Fan out to N partners and pick a winner. | `winner` / `no_winner` handles | ../nodes/bid-group.md |
| `transform` | Map/reshape data into a new object. | Single next edge | ../nodes/transform.md |
| `webhook` | Outbound HTTP call (Integration node). | Single next edge | ../nodes/webhook.md |
| `salesforce` | Salesforce create/update/query. | Single next edge | ../nodes/salesforce.md |
| `data_store` | Read/write a key-value store. | Single next edge | ../nodes/data-store.md |
| `constants` | Emit workflow constants plus partner data. | Single next edge | ../nodes/constants.md |
| `response` | Send a structured HTTP response. | Terminates (or continues) | ../nodes/response.md |
| `exit` | End the execution early, optional body. | Terminates | ../nodes/exit.md |
| `latency_gate` | Mark/check a partner match latency window. | `within` / `exceeded` handles | ../nodes/latency-gate.md |
| `buyer_click_send` | Claim, post and count one click for a click sold buyer. | Seven handles, named by outcome | ../nodes/buyer-click-send.md |

## Edges

`edges` is an array of connections. The engine routes from a node by finding that node's outgoing edges and choosing the first one that applies.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique edge id. |
| `source` | string | Yes | The id of the node the edge leaves. The literal string `"trigger"` marks the entry edge into the first node. |
| `target` | string | Yes | The id of the node the edge enters. |
| `source_handle` | string | No | Which output of the source node this edge leaves from. See [Handles and routing](#handles-and-routing). |
| `target_handle` | string | No | Which input of the target node this edge enters. Layout only; the engine does not read it. |
| `condition` | object | No | A conditional gate. The engine follows this edge only when the condition evaluates true. See [Edge conditions](#edge-conditions). |

### Handles and routing

How the engine picks the next node from a node's outgoing edges:

- **Trigger edge.** The entry node is the target of the edge whose `source` is the literal `"trigger"`. If there is no trigger edge, the engine falls back to the node with no incoming edges from other nodes.
- **Handle-routed nodes.** `filter`, `branch`, `bid_group`, and `latency_gate` return a `_route` value in their output. The engine follows the outgoing edge whose `source_handle` equals that `_route`.
  - `filter`: `_route` is `"pass"` or `"exit"`.
  - `branch`: `_route` is the matched branch's `label`, or `"else"` when no branch matches.
  - `bid_group`: `_route` is `"winner"` or `"no_winner"`.
  - `latency_gate`: `_route` is `"within"` or `"exceeded"`.
  - `buyer_click_send`: `_route` is one of `"sent"`, `"refused"`, `"unknown"`, `"already_sent"`, `"in_progress"`, `"needs_review"` or `"not_sent"`, and an unwired one fails the step by name.
- **Unwired handle.** For `filter` and `branch`, if the chosen handle has no outgoing edge, the walk stops (the execution ends there). It does not fall through to another edge.
- **Parallel children.** A `parallel` node's children are the targets of its edges whose `source_handle` starts with `child-` (for example `child-0`, `child-1`). The matching `parallel_end` joins them.
- **Plain nodes.** For all other node types, the engine follows the first outgoing edge whose `condition` evaluates true (an edge with no `condition` always matches).
- **Terminating nodes.** A `response` node (without `continue_after_response`) and an `exit` node end the walk and produce the HTTP response. A `code` node can also respond and/or exit early via sentinels (see ../nodes/code.md).

### Edge conditions

An edge `condition` is evaluated against the current execution context. It is a set of condition groups combined by a top-level `logic`.

```ts
condition: {
  groups: Array<{
    conditions: Array<{ field: string; operator: Operator; value?: unknown }>
    logic: 'AND' | 'OR'   // how conditions within this group combine
  }>
  logic: 'AND' | 'OR'     // how the groups combine
}
```

- `field` is a [data reference](./data-references.md) such as `steps.validate.output.is_valid` or `trigger.payload.state`.
- `operator` is one of the values below.
- `value` is the comparison value (omitted for operators that need no value). For `in_array` / `not_in_array`, `value` may be a literal array or a reference string starting with `steps.`, `trigger.`, or `env.`.

#### Operators

| Operator | Meaning | Notes |
|----------|---------|-------|
| `eq` | equals | String config values are coerced to the field's type (so `0` matches number `0`, `"true"` matches boolean `true`). Default when `operator` is omitted. |
| `neq` | not equals | |
| `gt` / `gte` / `lt` / `lte` | numeric compare | Both sides coerced to Number. Non-numeric operands make the comparison false. |
| `contains` / `not_contains` | substring | String-coerced both sides. |
| `is_true` / `is_false` | strict boolean | Matches actual boolean `true` / `false`. |
| `exists` / `not_exists` | presence | True when the field is not `null` and not `undefined` (`exists`). |
| `is_null` / `is_not_null` | null check | Strict `null` check. |
| `in_array` / `not_in_array` | membership | `value` is an array literal or a reference string. |

The same operator set and condition-group shape is used inside `filter` and `branch` node configs. See [../nodes/filter.md](../nodes/filter.md).

## Complete minimal example

A valid webhook -> filter -> response workflow. A lead arrives, the filter passes only US leads, and the response returns an acknowledgment. Leads that fail the filter route to the `exit` node.

```json
{
  "id": "11111111-1111-1111-1111-111111111111",
  "name": "US lead intake",
  "trigger": {
    "type": "http_webhook",
    "config": { "method": "POST", "auth_method": "api_key" }
  },
  "nodes": [
    {
      "id": "n-filter",
      "namespace": "us_only",
      "type": "filter",
      "config": {
        "operation": "continue_if",
        "condition": { "field": "trigger.payload.country", "operator": "eq", "value": "US" }
      }
    },
    {
      "id": "n-response",
      "namespace": "ack",
      "type": "response",
      "config": {
        "status_code": 200,
        "headers": { "Content-Type": "application/json" },
        "body": { "received": true, "country": "{{trigger.payload.country}}" }
      }
    },
    {
      "id": "n-exit",
      "namespace": "rejected",
      "type": "exit",
      "config": { "response": { "received": false, "reason": "non-US lead" } }
    }
  ],
  "edges": [
    { "id": "e-trigger", "source": "trigger", "target": "n-filter" },
    { "id": "e-pass", "source": "n-filter", "source_handle": "pass", "target": "n-response" },
    { "id": "e-exit", "source": "n-filter", "source_handle": "exit", "target": "n-exit" }
  ]
}
```

Notes on the example:

- The entry node is `n-filter` because of the `source: "trigger"` edge.
- The filter returns `_route: "pass"` or `_route: "exit"`; the engine follows the matching `source_handle`.
- `n-response` terminates the walk and returns `{ "received": true, "country": "US" }` with status 200.
- `n-exit` terminates the walk and returns its `config.response` body.

## See also

- [Data references](./data-references.md) - the `{{ }}` and dot-path syntax used in configs and conditions.
- [Workflows and executions](./workflows-and-executions.md) - how a definition becomes a running execution.
- [Triggers and endpoints](./triggers-and-endpoints.md) - how a workflow is invoked.
- [Node reference](../nodes/) - per-node config and output shapes.
- [Webhook contract](../reference/webhook-contract.md) - the request/response contract.
