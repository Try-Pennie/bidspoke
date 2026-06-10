# Transform node

Reshapes data into a new object using an explicit list of field mappings. Each mapping pulls a value from a source (a step reference, a literal, or a small expression) and writes it to a target field in the output. Only the fields you map appear in the output. Use it to rename fields, pull nested values up, build a partner-specific payload, or compute a derived value.

The Transform node is purely a data step. It does not route; it always continues to its single next node.

## When to use it

- Rename or restructure an upstream step's output into the shape a partner or Salesforce expects.
- Pull a nested value (or an array of values) up to a top-level field.
- Add static fields or compute a simple derived value (for example, applying a multiplier).

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mappings` | `Array<{ source: string; target: string }>` | Yes | `[]` | The ordered list of field mappings. Each row reads `source` and writes the result to `target`. Rows with an empty `source` or `target` are skipped. |

Each mapping:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | Yes | Where to read the value from. See [Source formats](#source-formats). Trimmed before evaluation. |
| `target` | string | Yes | The output field path. Supports dot-paths for nesting, for example `applicant.name`. Trimmed before use. |

In the editor this is the two-column "Field mappings" list: source on the left, target on the right, one row per field.

## Source formats

The `source` string is interpreted in this order:

| Form | Example | Result |
|------|---------|--------|
| Quoted string literal | `"pending"` or `'pending'` | The literal string `pending`. |
| Number literal | `42`, `3.14`, `-1` | The number. |
| Boolean / null literal | `true`, `false`, `null` | The boolean or null. |
| Array map-over | `steps.bids.output.list[*].amount` | An array: the `amount` of every element. `[*]` with no suffix returns the whole array. |
| Dot-path reference | `steps.validate.output.score`, `trigger.payload.email`, `env.API_BASE`, `steps.x.output.list[0].id` | The resolved value. Array indices `[n]` are supported. |
| Expression | `steps.credit.output.score * 0.85` | The evaluated result. References inside are resolved, then the expression is computed. `Math` is available. |

Notes on references:

- `steps.<ns>.output.<path>` and `steps.<ns>.<path>` resolve identically. The explicit `.output` is tolerated to match the copy-path format from the UI.
- `steps.<ns>` with no further path returns that step's whole output.
- Supported roots are `trigger`, `steps`, and `env`. See [data references](../concepts/data-references.md) for the full reference syntax.
- An expression that fails to evaluate yields `undefined` for that field.

## Target paths

The `target` is a dot-path written into the output object. `applicant.name` produces `{ "applicant": { "name": ... } }`. Intermediate objects are created as needed. A plain `amount` writes a top-level field.

## Output shape

`steps.<id>.output` is the assembled object containing only your mapped targets:

```json
{
  "applicant": { "name": "Jane Doe" },
  "amount": 850,
  "status": "pending",
  "bid_amounts": [42.0, 38.5, 30.0]
}
```

Unmapped fields from upstream steps do not pass through. If you need a field in the output, map it explicitly.

## Example

```json
{
  "id": "transform_payload",
  "namespace": "build_partner_payload",
  "type": "transform",
  "config": {
    "mappings": [
      { "source": "trigger.payload.first_name", "target": "applicant.name" },
      { "source": "steps.credit.output.score",  "target": "credit_score" },
      { "source": "steps.credit.output.score * 0.85", "target": "adjusted_score" },
      { "source": "\"pending\"",                "target": "status" },
      { "source": "true",                        "target": "consent" },
      { "source": "steps.bids.output.list[*].amount", "target": "bid_amounts" }
    ]
  }
}
```

This produces an object with a nested `applicant.name`, the credit score and a derived `adjusted_score`, a static `status` and `consent`, and an array of every bid amount.

## See also

- [Data references](../concepts/data-references.md) for the `trigger.*`, `steps.*`, `env.*` reference and expression syntax.
- [Response node](./response.md) for using a transformed object in an HTTP response body.
- [Parallel node](./parallel.md) for producing the result arrays a Transform node can map over with `[*]`.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
