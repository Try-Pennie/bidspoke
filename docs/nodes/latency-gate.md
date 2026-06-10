# Latency Gate node

Measures the elapsed time between two events in a lead's lifecycle and routes on whether it stayed under a threshold. It was built for networks that charge on a match: they ping us, take a bid, then send a separate Bid Win Confirmation after a waiting period. The longer that wait, the higher the risk that the redirect to the lead failed. The Latency Gate lets you reject confirmations that took too long.

It works in two operations. `mark` stamps the bid moment. `check`, later, reads that stamp on the confirmation, computes how long it took, and routes `within` or `exceeded`.

## When to use it

- A partner like Lead Economy pings, you bid, and they confirm the win separately. Mark the bid time, then check the latency on the confirmation and reject if it is over the partner's window.
- Any match-charging integration where the time between bid and confirmation matters and must be gated.

## How the two operations connect

Both operations use a correlation key: an id the network echoes back on both the bid and the confirmation. `mark` writes the current time into the `SUBMISSIONS` KV namespace under that key. `check`, in a later run triggered by the confirmation, reads it back by the same key.

Because the two events arrive as separate requests (often separate workflow runs), the KV store is what bridges them. If the mark is missing or expired when `check` runs, the gate fails safe and routes `exceeded` (reject due to latency).

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `operation` | `'mark'` \| `'check'` | Yes | none | `mark` stamps the time; `check` measures and gates. The node throws if missing. |
| `correlation_key` | string | Yes | none | The id echoed on both the bid and the confirmation. Supports `{{trigger.*}}`, `{{steps.*.output.*}}`, `{{env.*}}` templates. The node throws if it resolves empty. |
| `scope` | string | No | none | Optional key namespace (template), so two partners cannot collide on the same id. Often the partner slug. |
| `ttl_seconds` | number | `mark` only | `86400` (24h) | How long to keep the mark in KV. Minimum is 60; values below are raised to 60. Set above the longest expected waiting period. |
| `threshold_ms` | number | `check` only (or set `partner_id`) | none | Explicit latency threshold. When set, it overrides the partner's configured window. |
| `partner_id` | string | `check` only (or set `threshold_ms`) | none | Resolves the threshold from `partner_configs.confirmation_window_ms` for this partner when no `threshold_ms` override is given. |

In the editor: an "Operation" toggle (mark / check), a "Correlation key" field, an optional "Scope" field, a "TTL (seconds)" field (mark only), and "Threshold partner" plus "Threshold override (ms)" (check only).

### How the threshold is resolved (check)

1. If `threshold_ms` is set on the node, use it.
2. Otherwise look up `partner_configs.confirmation_window_ms` for `partner_id`.
3. If neither is available (no override, no `partner_id`, or the partner has no `confirmation_window_ms`), the check throws.

Set the partner's window on the partner's settings page (`partner_configs.confirmation_window_ms`). The node `threshold_ms` always wins when present.

## The KV key

The key is built from `scope` and the resolved `correlation_key`:

- With a scope: `latency:<scope>:<id>`
- Without a scope: `latency:<id>`

Both `mark` and `check` must resolve to the same key, so use the same `correlation_key` and `scope` on both nodes.

## Routing: within vs exceeded

`check` returns `_route` of `'within'` or `'exceeded'`. The engine follows the outgoing edge whose `source_handle` matches `_route`:

- Latency is at or under the threshold: `_route` is `'within'`.
- Latency is over the threshold: `_route` is `'exceeded'`.
- The mark is missing or expired: `_route` is `'exceeded'` (fail safe, reason `mark_not_found`).

`mark` has a single output and does not route.

## Output shape

### mark

```json
{
  "operation": "mark",
  "key": "latency:leadeconomy:abc-123",
  "marked_at": 1717000000000,
  "ttl_seconds": 86400
}
```

### check

```json
{
  "operation": "check",
  "key": "latency:leadeconomy:abc-123",
  "hit": true,
  "marked_at": 1717000000000,
  "latency_ms": 4200,
  "threshold_ms": 5000,
  "within_threshold": true,
  "_route": "within",
  "reason": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `operation` | `'mark'` \| `'check'` | Which operation ran. |
| `key` | string | The KV key used. |
| `hit` | boolean | (check) Whether a mark was found. |
| `marked_at` | number \| null | (check) The timestamp the mark stored, or `null` if not found. |
| `latency_ms` | number \| null | (check) `now - marked_at`, or `null` if no mark. |
| `threshold_ms` | number | (check) The threshold used. |
| `within_threshold` | boolean | (check) Whether latency was at or under the threshold. |
| `_route` | `'within'` \| `'exceeded'` | (check) The edge handle the engine follows. |
| `reason` | string \| null | (check) `null` when within, `latency_exceeded` when over, `mark_not_found` when no mark. |
| `marked_at` | number | (mark) The time stamped. |
| `ttl_seconds` | number | (mark) The effective TTL applied. |

## Examples

### Mark the bid moment

```json
{
  "id": "gate_mark",
  "namespace": "stamp_bid",
  "type": "latency_gate",
  "config": {
    "operation": "mark",
    "correlation_key": "{{trigger.payload.lead_id}}",
    "scope": "{{trigger.source}}",
    "ttl_seconds": 86400
  }
}
```

### Check on the confirmation, gating on the partner window

```json
{
  "id": "gate_check",
  "namespace": "gate_confirmation",
  "type": "latency_gate",
  "config": {
    "operation": "check",
    "correlation_key": "{{trigger.payload.lead_id}}",
    "scope": "{{trigger.source}}",
    "partner_id": "9d8c7b6a-0000-1111-2222-333344445555"
  }
}
```

With routing edges:

```json
[
  { "id": "e1", "source": "gate_check", "source_handle": "within",   "target": "accept_confirmation" },
  { "id": "e2", "source": "gate_check", "source_handle": "exceeded", "target": "reject_due_to_latency" }
]
```

### Check with an explicit threshold override

```json
{
  "id": "gate_check_override",
  "namespace": "gate_confirmation",
  "type": "latency_gate",
  "config": {
    "operation": "check",
    "correlation_key": "{{trigger.payload.lead_id}}",
    "threshold_ms": 5000
  }
}
```

## See also

- [Filter node](./filter.md) and [Branch node](./branch.md) for other conditional routing nodes.
- [Response node](./response.md) for returning the reject-due-to-latency answer on the `exceeded` path.
- [Data references](../concepts/data-references.md) for the `{{...}}` syntax used in `correlation_key` and `scope`.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
