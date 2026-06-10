# Data Store node

Reads and writes key/value data in a Cloudflare KV store from within a workflow. Use it to stash a value during one run and read it back in a later run, for example marking a submission as seen or correlating an out-of-band callback.

## Purpose

The Data Store node performs a single `set`, `get`, or `delete` against a named KV store. Keys and values are template-enabled, so you build them from the trigger payload, upstream steps, and environment variables. See [data references](../concepts/data-references.md).

There is currently one store, `submissions`. KV is eventually consistent and best for short-lived correlation data, not as a primary database.

## Config schema

`node.config`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `operation` | string | Yes | `set` (UI default) | One of `set`, `get`, `delete`. |
| `key` | string | Yes | none | The KV key. Template-enabled, for example `{{trigger.payload.Submission__c}}`. Must resolve to a non-empty string. |
| `store` | string | No | `submissions` | Which KV store to target. Only `submissions` is available today. |
| `value` | any | For `set` | `null` | Value to store on `set`. Any JSON-serializable value; template-enabled anywhere inside. Ignored for `get` and `delete`. |
| `ttl_seconds` | number | For `set` (optional) | none | Expiry in seconds for `set`. Cloudflare's minimum is 60; smaller values are clamped up to 60. Omit for no expiry. |

Standard node-config fields (`timeout_ms`, `retries`, etc.) also apply. See [workflow definition schema](../concepts/workflow-definition-schema.md).

The node throws if `operation` or `key` is missing, or if `key` resolves to an empty string.

## Output shape

The output depends on the operation.

`set`:

```json
{ "store": "submissions", "operation": "set", "key": "lead-123", "ttl_seconds": 604800 }
```

`ttl_seconds` is the applied TTL, or `null` if none was set.

`get`:

```json
{ "store": "submissions", "operation": "get", "key": "lead-123", "value": { "...": "stored value, parsed from JSON" }, "hit": true }
```

`value` is `null` and `hit` is `false` when the key is absent. Stored values are JSON-parsed on read; if a stored value was not JSON, the raw string is returned.

`delete`:

```json
{ "store": "submissions", "operation": "delete", "key": "lead-123" }
```

Read downstream as `steps.<namespace>.output.hit`, `steps.<namespace>.output.value`, etc. A common pattern is a `get` followed by a [Branch](./branch.md) or [Filter](./filter.md) node keyed on `steps.<namespace>.output.hit`.

## Edges

The Data Store node has a single outgoing edge and always continues to the next node. It performs no routing on its own; branch on its output if you need to react to a hit or miss.

## Example

Mark a submission as seen for 7 days:

```json
{
  "id": "n_mark_seen",
  "namespace": "mark_seen",
  "type": "data_store",
  "label": "Mark submission seen",
  "config": {
    "store": "submissions",
    "operation": "set",
    "key": "{{trigger.payload.Submission__c}}",
    "value": "{{steps.engine_call.output.uuid}}",
    "ttl_seconds": 604800
  }
}
```

Later, check whether it was seen:

```json
{
  "id": "n_check_seen",
  "namespace": "check_seen",
  "type": "data_store",
  "label": "Check submission seen",
  "config": {
    "store": "submissions",
    "operation": "get",
    "key": "{{trigger.payload.Submission__c}}"
  }
}
```

`steps.check_seen.output.hit` is then `true` if the submission was previously stored.

## See also

- [Branch node](./branch.md)
- [Filter node](./filter.md)
- [Code node](./code.md)
- [Data references](../concepts/data-references.md)
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
