# Filter node

A two-output gate that decides whether a workflow should continue. It evaluates a condition and routes the lead down either a `pass` path or an `exit` path. Use it as a guard: drop unqualified leads early, or stop a run when some required field is missing.

The Filter node never transforms data. It only routes. The data that reached the filter is still available to downstream steps; the filter just chooses which edge to follow.

## When to use it

- Drop leads that do not meet a minimum bar (for example, credit score below a threshold).
- Stop a run when an upstream step returned an error or an empty result.
- Add a quick yes/no gate before an expensive step like a partner bid.

For multiple labeled outcomes (more than two paths), use the [Branch node](./branch.md) instead.

## Config schema

The executor reads `node.config` as the shape below. There are two formats. The single-condition format is the current one used by the editor. The legacy multi-group `rules` format is still honored for backward compatibility.

### Single-condition format (current)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `operation` | `'continue_if'` \| `'end_if'` | No | `'continue_if'` | Direction of the gate. `continue_if`: route to `pass` when the condition is true. `end_if`: route to `exit` when the condition is true. |
| `condition.field` | string | Yes (for this format) | none | A [data reference](../concepts/data-references.md) to the value to test, for example `trigger.payload.status` or `steps.validate.output.score`. |
| `condition.operator` | operator enum | No | `eq` | Comparison operator. See [Operators](#operators). A missing operator is treated as `eq`. |
| `condition.value` | any | No (omit for value-less operators) | none | The value to compare against. Omit for `exists` / `not_exists` and the other value-less operators. |

In the editor, `operation` is the "Operation" dropdown ("Continue if condition is met" / "End if condition is met"). The condition row is field, operator, value.

### Legacy multi-group format

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `rules.groups` | `ConditionGroup[]` | Yes (for this format) | none | One or more condition groups. Each group has `conditions: EdgeCondition[]` and `logic: 'AND' \| 'OR'`. |
| `rules.logic` | `'AND'` \| `'OR'` | No | `'AND'` | How the groups combine. |

If both `condition.field` and `rules.groups` are present, the single-condition format wins. If neither is present, the condition defaults to met (the filter passes).

See [Workflow definition schema](../concepts/workflow-definition-schema.md) for the `ConditionGroup` and `EdgeCondition` shapes.

## Operators

These are the operators the engine evaluates. The single-condition editor exposes a subset (`equals`, `does not equal`, `greater than`, `greater than or equal`, `less than`, `less than or equal`, `contains`, `does not contain`, `exists`, `does not exist`); the rule builder used by the legacy format exposes the full set.

| Operator | Meaning | Value side |
|----------|---------|------------|
| `eq` | Equals. Coerces string config to the field's type, then falls back to string compare. | required |
| `neq` | Does not equal. | required |
| `gt` / `gte` / `lt` / `lte` | Numeric comparison. Both sides coerced to numbers; non-numeric yields false. | required |
| `contains` | String includes. | required |
| `not_contains` | String does not include. | required |
| `is_true` | Field strictly equals `true`. | none |
| `is_false` | Field strictly equals `false`. | none |
| `exists` | Field is not `undefined` and not `null`. | none |
| `not_exists` | Field is `undefined` or `null`. | none |
| `is_null` | Field is strictly `null`. | none |
| `is_not_null` | Field is not `null`. | none |
| `in_array` | Field equals one element of the value array. Value may be a literal array or a reference to one. | required (array or reference) |
| `not_in_array` | Field is not in the value array. | required (array or reference) |

## Routing: pass vs exit

The node returns `_route` of either `'pass'` or `'exit'`. The engine follows the outgoing edge whose `source_handle` matches `_route`:

- `operation: 'continue_if'` and the condition is true: `_route` is `'pass'`.
- `operation: 'continue_if'` and the condition is false: `_route` is `'exit'`.
- `operation: 'end_if'` and the condition is true: `_route` is `'exit'`.
- `operation: 'end_if'` and the condition is false: `_route` is `'pass'`.

Wire one edge with `source_handle: 'pass'` to the next step and, optionally, one with `source_handle: 'exit'` to where exits should go. If only the `pass` edge is wired and the lead routes to `exit`, the walk ends there (the run completes without continuing).

## Output shape

`steps.<id>.output` contains:

```json
{
  "passed": true,
  "_route": "pass"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `passed` | boolean | `true` when the lead routes to `pass`, `false` when it routes to `exit`. |
| `_route` | `'pass'` \| `'exit'` | The edge handle the engine follows. |

## Examples

### Continue only when score is high enough

```json
{
  "id": "filter_score",
  "namespace": "qualify",
  "type": "filter",
  "config": {
    "operation": "continue_if",
    "condition": {
      "field": "steps.credit.output.score",
      "operator": "gte",
      "value": 600
    }
  }
}
```

Leads with a score of 600 or more route to `pass`. Everything else routes to `exit`.

### Exit when the lead is a known duplicate

```json
{
  "id": "filter_dupe",
  "namespace": "dedupe_gate",
  "type": "filter",
  "config": {
    "operation": "end_if",
    "condition": {
      "field": "steps.dedup.output.is_duplicate",
      "operator": "is_true"
    }
  }
}
```

When `is_duplicate` is `true`, the lead routes to `exit`. Otherwise it routes to `pass`.

### Legacy multi-group format

```json
{
  "id": "filter_legacy",
  "namespace": "qualify",
  "type": "filter",
  "config": {
    "rules": {
      "logic": "AND",
      "groups": [
        {
          "logic": "AND",
          "conditions": [
            { "field": "steps.credit.output.score", "operator": "gte", "value": 600 },
            { "field": "trigger.payload.state", "operator": "neq", "value": "WI" }
          ]
        }
      ]
    }
  }
}
```

## See also

- [Branch node](./branch.md) for N labeled outputs.
- [Exit node](./exit.md) for explicit early termination.
- [Data references](../concepts/data-references.md) for the `trigger.*`, `steps.*`, `env.*` syntax.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
