# Data References

Bidspoke nodes pull values from the trigger payload, earlier step outputs, environment variables, and per-run metadata using a small reference syntax. The same syntax appears in two places: as `{{ ... }}` templates inside node config strings (response bodies, Salesforce field maps, outbound payloads), and as bare `field` paths inside edge conditions and filter/branch rules. This page is the complete reference for that syntax.

For where these references are used, see [the workflow definition schema](./workflow-definition-schema.md) and the per-node docs under [../nodes/](../nodes/).

## Namespaces

A reference starts with one of these roots:

| Root | Resolves to | Example |
|------|-------------|---------|
| `trigger.payload.<path>` | A field of the inbound request body. | `trigger.payload.email` |
| `trigger.<field>` | Trigger metadata: `source`, `workflow_id`, `trace_id`, `org_id`, `execution_id`, `sighting_id`. | `trigger.source` |
| `steps.<namespace>.output.<path>` | A field of an earlier node's output, keyed by the node's `namespace`. | `steps.credit_pull.output.score` |
| `env.<KEY>` | An environment variable for the org. | `env.SALESFORCE_INSTANCE_URL` |
| `execution.<field>` | Per-run metadata: `workflow_id`, `trace_id`, `execution_id`, `bidspoke_link`. Available in `{{ }}` templates. | `execution.trace_id` |

### Step references and the optional `.output`

A step is referenced by the producing node's `namespace`, not its `id`. The `.output` segment is optional. These all resolve to the same place:

```text
steps.credit_pull.output.score
steps.credit_pull.score
```

`{{steps.credit_pull}}` and `{{steps.credit_pull.output}}` both resolve to the node's entire output object.

If the referenced step has not run (or does not exist), the reference resolves to `undefined`.

### There is no top-level `constants.` namespace

Workflow constants come from a [Constants node](../nodes/constants.md). You read them through that node's namespace like any other step output, not via a `constants.` root. If the Constants node's namespace is `constants`, read a value with `steps.constants.output.<key>`:

```text
steps.constants.output.minBid
steps.constants.output.activeBidding
```

## Dot paths and array access

After the root, the path walks nested objects with dots and arrays with `[index]`.

```text
steps.enrich.output.address.zip
steps.bids.output.partners[0].slug
trigger.payload.items[2].amount
```

Bare `[index]` works on a value that is itself an array:

```text
steps.parse.output[0]
```

Walking into a missing key or off the end of an array yields `undefined` (it does not throw).

## Single expression vs template string

This distinction is important and easy to get wrong.

### Single expression: `{{ expr }}`

When a config string is exactly one expression wrapped in `{{ }}` (nothing before or after), it returns the **typed value** of that expression: a number stays a number, a boolean stays a boolean, an object stays an object.

```json
{ "score": "{{steps.credit_pull.output.score}}" }
```

If `score` is the number `720`, the resolved value is the number `720`, not the string `"720"`.

```json
{ "eligible": "{{steps.validate.output.is_eligible}}" }
```

resolves to the boolean `true`, and

```json
{ "bids": "{{steps.bid_group.output.all_bids}}" }
```

resolves to the array/object itself.

### Template string: text or `{{ a }}{{ b }}`

When a string contains literal text, or more than one `{{ }}`, every expression is **stringified and concatenated** into the surrounding text.

```json
{ "greeting": "Hi {{trigger.payload.first_name}}, your score is {{steps.credit_pull.output.score}}." }
```

resolves to `"Hi Dana, your score is 720."`.

```json
{ "full_name": "{{trigger.payload.first}}{{trigger.payload.last}}" }
```

resolves to a single concatenated string (for example `"DanaSmith"`). Because there are two expressions, this is a template, so the result is always a string. Within a template, an expression that resolves to `undefined` becomes an empty string.

### Why it matters

Use a lone `{{ expr }}` when you need to preserve a number, boolean, object, or array. The moment you add surrounding text or a second `{{ }}`, the result becomes a string.

## Coalesce: `??`

Both `{{ }}` templates and condition `field` paths support a coalesce operator. `a ?? b ?? c` resolves to the first operand that is not `null` and not `undefined`. A real `false`, `0`, or `""` is kept (only `null`/`undefined` are skipped).

```text
steps.retry_call.output.result ?? steps.first_call.output.result
```

```json
{ "result": "{{steps.retry_call.output.result ?? steps.first_call.output.result}}" }
```

This is useful when two nodes (for example a node and its duplicate) might run, and you want whichever one actually produced output.

## Unresolved references

- In a **single expression**, an unresolved reference yields `undefined`. If that value is the whole config field and the config is later serialized to JSON, the key is dropped (JSON does not serialize `undefined`-valued keys). The engine warns about dropped body fields on outbound request nodes.
- In a **template string**, an unresolved reference becomes an empty string.
- In a **condition**, an unresolved field is compared as if it were `undefined`: `exists` is false, `not_exists` is true, numeric comparisons are false, `eq`/`neq` treat it as not equal to any real value.

## References inside conditions

Edge conditions and filter/branch rules use the bare path form (no `{{ }}`):

```json
{ "field": "steps.validate.output.score", "operator": "gte", "value": "650" }
```

In conditions, the `value` is normally a literal. For `in_array` / `not_in_array`, `value` may instead be a reference string that starts with `steps.`, `trigger.`, or `env.`, in which case it is resolved as a path:

```json
{ "field": "trigger.payload.state", "operator": "in_array", "value": "steps.constants.output.allowed_states" }
```

See the [operator table](./workflow-definition-schema.md#operators) for the full list.

## Quick examples

```text
trigger.payload.email                         a top-level payload field
trigger.payload.applicant.address.zip         nested payload field
trigger.source                                the source name (from the API key)
steps.validate.output.is_valid                an earlier step's boolean
steps.bid_group.output.winner.partner_slug    nested step output
steps.bids.output.all_bids[0].amount          array access into step output
env.TRIPOINT_PROXY_URL                         an environment variable
execution.trace_id                            this run's trace id
steps.b.output.x ?? steps.a.output.x          first non-null of two steps
```

## See also

- [Workflow definition schema](./workflow-definition-schema.md) - where references appear, plus the full operator table.
- [Constants node](../nodes/constants.md) - how to define workflow constants you read via `steps.<ns>.output.*`.
- [Response node](../nodes/response.md) - templated response bodies, headers, and status codes.
- [Workflows and executions](./workflows-and-executions.md) - what step outputs are and when they exist.
