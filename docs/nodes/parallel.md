# Parallel node

Fans a lead out to several child branches that run at the same time, then collects their results into an array. Use it to call multiple partners or services concurrently instead of one after another, then hand the combined results to a downstream step like a Bid Evaluation node.

A Parallel node owns a set of slots. Each slot is one branch (one child node, which may itself lead a small chain). The engine runs every slot concurrently and waits according to the `wait_for` mode.

## When to use it

- Send a lead to several partners at once and pick the best bid.
- Hit two enrichment services in parallel and merge the results.
- Race a fast path against a slow path and take whichever returns first.

## How children and edges work

Slots are defined in the node config under `children` (each with an `id` like `child-0` and a `label`). Each slot connects to its branch via an outgoing edge whose `source_handle` is the slot id (`child-0`, `child-1`, and so on). The engine sorts the wired child edges by slot index and runs them concurrently.

Every step produced inside the parallel block is tagged with the same `parallel_group_id` so the execution view can group the fan-out and so a resume can re-run only the children that did not finish.

## Config schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `wait_for` | `'all'` \| `'first'` \| `'specific'` | No | `'all'` | How long to wait. See [Wait modes](#wait-modes). |
| `wait_for_slot` | string | Only when `wait_for` is `'specific'` | none | The slot handle id (for example `child-0`) to wait for. Must be a connected slot, or the node throws. |
| `timeout_ms` | number | No | `15000` | How long to wait before the timeout fires, in milliseconds. |
| `on_timeout` | `'partial'` \| `'fail'` | No (applies to `wait_for: 'all'`) | `'partial'` | On timeout, `partial` continues with whatever settled (unsettled children marked `timeout`); `fail` throws. |
| `on_child_error` | `'fail'` \| `'continue'` | No (applies to `wait_for: 'all'`) | `'fail'` | When a child rejects, `fail` stops the workflow; `continue` keeps going so a downstream step can handle the rejection in the result array. |

The `children` slot list also lives in `node.config`; the editor manages it for you when you add slots and wire nodes. In the editor these map to: "Wait for" (All slots / First to succeed / Specific slot), "Wait for slot", "Timeout (ms)", "On timeout" (Continue with partial results / Fail the execution), and "On child error".

## Wait modes

### `all` (default)

Waits for every child (`Promise.allSettled`). When the timeout fires before all settle, `on_timeout` decides: `partial` continues with the settled results and marks the rest `timeout`; `fail` throws. After all settle, if `on_child_error` is `fail` and any child rejected or timed out, the node throws. Set `on_child_error: 'continue'` when a Bid Evaluation node downstream handles rejections itself.

### `first`

Races the children and resolves with the first child that succeeds (status `fulfilled`). The other children keep running in the background but their results are discarded. The node fails if all children reject, or if the timeout fires before any child succeeds. The output array holds only the winning child.

### `specific`

Waits for one named slot (`wait_for_slot`). Sibling slots keep running in the background but are not awaited; if they have not settled when the named slot finishes, they appear as `timeout` in the output. The named slot's status drives success: if it rejects or times out, the node throws.

## Output shape

`steps.<id>.output` is an array of child results, one per slot (except `wait_for: 'first'`, which returns just the winner):

```json
[
  { "namespace": "tripoint_bid", "status": "fulfilled", "output": { "bid": 42.0 } },
  { "namespace": "m1_bid",       "status": "rejected",   "error": "circuit breaker open" },
  { "namespace": "engine_bid",   "status": "timeout" }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `namespace` | string | The child node's namespace. |
| `status` | `'fulfilled'` \| `'rejected'` \| `'timeout'` | How the child finished. |
| `output` | any | The child's output. Present when `status` is `'fulfilled'`. |
| `error` | string | Error message. Present when `status` is `'rejected'`. |

A downstream step reads the array, for example `steps.<id>.output[0].output.bid`.

## Example

Three partners in parallel, continue even if some fail so a Bid Evaluation node can pick the winner:

```json
{
  "id": "parallel_bids",
  "namespace": "bid_fanout",
  "type": "parallel",
  "config": {
    "wait_for": "all",
    "timeout_ms": 10000,
    "on_timeout": "partial",
    "on_child_error": "continue",
    "children": [
      { "id": "child-0", "label": "tripoint" },
      { "id": "child-1", "label": "m1" },
      { "id": "child-2", "label": "engine" }
    ]
  }
}
```

With slot edges wiring each child:

```json
[
  { "id": "e0", "source": "parallel_bids", "source_handle": "child-0", "target": "tripoint_bid" },
  { "id": "e1", "source": "parallel_bids", "source_handle": "child-1", "target": "m1_bid" },
  { "id": "e2", "source": "parallel_bids", "source_handle": "child-2", "target": "engine_bid" }
]
```

## Notes

- Early-response and early-exit sentinels are not allowed inside a parallel block. A child cannot respond to the caller or exit the whole workflow while siblings are still running. If a child needs to signal failure, throw an error instead.
- The default timeout is 15000ms and the default `on_timeout` is `partial`, so by default a slow slot does not fail the whole run; it just shows as `timeout` in the output.

## See also

- [Bid Group node](./bid-group.md) for a higher-level fan-out built specifically for partner bidding.
- [Exit node](./exit.md) and [Response node](./response.md) for terminating the run (use these outside a parallel block).
- [Data references](../concepts/data-references.md) for reading the result array downstream.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
