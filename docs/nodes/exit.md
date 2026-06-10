# Exit node

Ends a run early. The Exit node stops the walk at that point and, optionally, returns a stored response object to the caller. Use it to terminate cleanly when there is nothing more to do, for example after deciding a lead does not qualify.

## When to use it

- End a path that a [Filter node](./filter.md) or [Branch node](./branch.md) routed to when no further work is needed.
- Stop a run with a simple canned response object.

For a response that needs templated values resolved or specific status codes and headers, prefer the [Response node](./response.md). The Exit node returns its configured `response` object as-is without template resolution.

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `response` | any | No | `null` | An object (or any value) to return as the step output. If omitted, the output is `null`. The value is returned as-is, not template-resolved. |

The Exit node has no other configuration. It is intentionally minimal.

## How exit is represented in the engine

The engine treats `type: 'exit'` as a terminal node. When the walk reaches an Exit node it runs the node (which just returns `node.config.response ?? null` as its output) and then stops, the same way a default [Response node](./response.md) stops the walk. Outgoing edges from an Exit node are not followed.

Note that "exit" also appears as a routing outcome elsewhere in the platform that is distinct from this node:

- The [Filter node](./filter.md) emits `_route: 'exit'` to choose its exit edge. That is a routing handle, not an Exit node.
- Code nodes and some translated patterns can return an exit sentinel (`{ exit: true }`) to end the run from inside a script.

The Exit node is the explicit, drag-on-canvas way to do the same termination.

## Output shape

`steps.<id>.output` is exactly the configured `response` value, or `null` when no `response` is set:

```json
{ "qualified": false, "reason": "below_threshold" }
```

If no `response` is configured, the output is `null`.

## Examples

### Exit with a small response object

```json
{
  "id": "exit_unqualified",
  "namespace": "drop_lead",
  "type": "exit",
  "config": {
    "response": {
      "qualified": false,
      "reason": "below_threshold"
    }
  }
}
```

The run ends and the stored object becomes the step output.

### Bare exit, no response

```json
{
  "id": "exit_done",
  "namespace": "done",
  "type": "exit",
  "config": {}
}
```

The run ends with a `null` output.

## See also

- [Response node](./response.md) for a full HTTP response with status code, headers, and templated body.
- [Filter node](./filter.md) for routing a lead to an exit path via its `exit` handle.
- [Branch node](./branch.md) for sending unmatched leads down a terminating path.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
