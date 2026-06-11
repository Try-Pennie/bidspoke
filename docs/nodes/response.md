# Response node

Builds the HTTP response that the webhook caller receives. You set a status code, optional headers, and a body. By default the Response node ends the run: the engine returns its output as the final HTTP response and stops walking the graph. With "Continue after response" enabled, the engine sends the response immediately and keeps walking so later steps can do post-response work.

## When to use it

- Return a structured answer to the caller (an offer, an acknowledgment, an error payload).
- Send the response right away, then keep running background steps like a Salesforce patch (use "Continue after response").

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `status_code` | number \| string | No | `200` | The HTTP status. May be a literal number or a template string like `{{steps.X.output.status}}` that resolves to a number. Falls back to `200` if blank or unresolvable. A string number is parsed; a float is truncated. |
| `headers` | `Record<string, string>` | No | `{}` | Response headers. Keys are sent as-is. Values support `{{...}}` templates; the resolved value is coerced to a string. A header whose template resolves to nothing (undefined/null) is omitted from the response. |
| `body` | any | No | `null` | The response body. Strings (including string values nested in an object) support [data reference](../concepts/data-references.md) `{{...}}` templates. |
| `continue_after_response` | boolean | No | `false` (omitted) | When `true`, send the response immediately and keep walking the graph. When false or omitted, this node ends the run. |

In the editor: "Status code", "Body (JSON or template)", a "Headers" key/value editor, and a "Continue after response" checkbox.

## Routing and termination

- Default (no `continue_after_response`): this node is terminal. The engine returns the resolved `{ status, headers, body }` as the HTTP response and stops. Outgoing edges are not followed.
- `continue_after_response: true`: the engine sends the response right away, then continues following outgoing edges. Use this for work that should not block the caller, such as writing back to Salesforce after answering. This mirrors the code-node "respond and continue" sentinel.

## Output shape

`steps.<id>.output` contains the resolved response:

```json
{
  "status_code": 200,
  "headers": { "Content-Type": "application/json" },
  "body": { "offer": 42.0, "approved": true }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status_code` | number | The resolved status code. |
| `headers` | object | The headers after `{{...}}` templates in values are resolved. |
| `body` | any | The body after `{{...}}` templates are resolved. |

## Examples

### Terminal response with a templated body

```json
{
  "id": "respond_offer",
  "namespace": "send_offer",
  "type": "response",
  "config": {
    "status_code": 200,
    "headers": { "Content-Type": "application/json" },
    "body": {
      "approved": true,
      "offer_amount": "{{steps.evaluate.output.winner.bid}}",
      "partner": "{{steps.evaluate.output.winner.partner}}"
    }
  }
}
```

The engine resolves the `{{...}}` references, returns this as the HTTP response, and ends the run.

### Respond now, keep working

```json
{
  "id": "respond_ack",
  "namespace": "ack",
  "type": "response",
  "config": {
    "status_code": 202,
    "body": { "received": true },
    "continue_after_response": true
  }
}
```

The caller gets a `202` immediately. The engine then continues to the next node (for example, a Salesforce write-back).

### Status code from an upstream step

```json
{
  "id": "respond_passthrough",
  "namespace": "relay",
  "type": "response",
  "config": {
    "status_code": "{{steps.partner.output.status}}",
    "body": "{{steps.partner.output.body}}"
  }
}
```

If `status` is missing or non-numeric, the status falls back to `200`.

## See also

- [Exit node](./exit.md) for ending a run with an optional response but no template resolution beyond the stored object.
- [Branch node](./branch.md) and [Filter node](./filter.md) for choosing which Response node a lead reaches.
- [Data references](../concepts/data-references.md) for the `{{...}}` template syntax used in the body, headers, and status code.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
