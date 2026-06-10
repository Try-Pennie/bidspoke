# Branch node

A multi-way router. It evaluates an ordered list of named branches and follows the first one whose condition is true. If none match, it can fall through to an `else` edge, end silently, or fail the run. Use it when a lead can take one of several labeled paths.

The Branch node does not transform data. Like the [Filter node](./filter.md), it only routes. Each branch has a label, and that label is the edge handle the engine follows.

## When to use it

- Route by a category: new vs returning, in-state vs out-of-state, tier A vs B vs C.
- Pick a downstream partner or response template based on lead attributes.
- Anything that needs more than the two outputs a [Filter node](./filter.md) gives you.

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `branches` | `BranchEntry[]` | Yes | `[]` | Ordered list of branches. The first one whose condition matches wins. |
| `else_behavior` | `'output'` \| `'none'` \| `'error'` | No | `'output'` | What to do when no branch matches. See [No-match behavior](#no-match-behavior). |
| `use_else` | boolean | No | `true` | Legacy flag, superseded by `else_behavior`. `use_else: false` is equivalent to `else_behavior: 'none'`. |

Each `BranchEntry`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `label` | string | Yes | none | The branch name. This becomes the edge `source_handle`. Must be unique within the node. |
| `condition.groups` | `ConditionGroup[]` | Yes | none | One or more condition groups (each with `conditions` and a per-group `logic`). |
| `condition.logic` | `'AND'` \| `'OR'` | No | `'AND'` | How the groups combine. |

See the [Filter node operators table](./filter.md#operators) for the full operator list (the rule builder shared with branches exposes all of them: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `in_array`, `not_in_array`, `is_true`, `is_false`, `is_null`, `is_not_null`, `exists`, `not_exists`). See [Workflow definition schema](../concepts/workflow-definition-schema.md) for the `ConditionGroup` and `EdgeCondition` shapes.

In the editor, each branch is a labeled card with a rule builder. "When no branch matches" is a three-way toggle: "Else output", "Do nothing", "Throw error".

## Routing: branch handles map to edges

Branches are evaluated top to bottom; the first match wins. The node returns `_route` set to the matching branch's `label`, or `'else'` when nothing matched. The engine follows the outgoing edge whose `source_handle` equals `_route`.

So a branch labeled `in_state` produces an edge handle `in_state`. Wire one edge per branch label, plus one `else` edge when `else_behavior` is `'output'`.

## No-match behavior

`else_behavior` controls what happens when no branch matches:

| Value | Behavior |
|-------|----------|
| `'output'` (default) | Returns `_route: 'else'`. Wire an edge with `source_handle: 'else'` to handle this path. |
| `'none'` | No else handle. If no branch matches, the walk stops there and the run completes. |
| `'error'` | Throws a permanent error and the run fails. Use when reaching no branch is a bug. |

## Output shape

`steps.<id>.output` contains:

```json
{
  "matched_branch": "in_state",
  "_route": "in_state"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `matched_branch` | string \| null | The label of the branch that matched, or `null` when none matched. |
| `_route` | string | The matching branch label, or `'else'` when none matched. This is the edge handle the engine follows. |

## Example

Two branches plus an else path:

```json
{
  "id": "branch_route",
  "namespace": "route_by_state",
  "type": "branch",
  "config": {
    "else_behavior": "output",
    "branches": [
      {
        "label": "in_state",
        "condition": {
          "logic": "AND",
          "groups": [
            {
              "logic": "AND",
              "conditions": [
                { "field": "trigger.payload.state", "operator": "eq", "value": "CA" }
              ]
            }
          ]
        }
      },
      {
        "label": "high_score",
        "condition": {
          "logic": "AND",
          "groups": [
            {
              "logic": "AND",
              "conditions": [
                { "field": "steps.credit.output.score", "operator": "gte", "value": 700 }
              ]
            }
          ]
        }
      }
    ]
  }
}
```

With matching edges:

```json
[
  { "id": "e1", "source": "branch_route", "source_handle": "in_state",   "target": "node_ca" },
  { "id": "e2", "source": "branch_route", "source_handle": "high_score", "target": "node_prime" },
  { "id": "e3", "source": "branch_route", "source_handle": "else",       "target": "node_default" }
]
```

A lead with `state` of `CA` follows `in_state` (even if it also has a high score, because branches are first-match). A lead with `state` of `NV` and a score of 720 follows `high_score`. Anything else follows `else`.

## See also

- [Filter node](./filter.md) for a simple two-output pass/exit gate and the full operator reference.
- [Exit node](./exit.md) for explicit early termination.
- [Data references](../concepts/data-references.md) for condition field syntax.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
