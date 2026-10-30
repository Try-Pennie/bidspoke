# Parallel node

Fans a lead out to several child branches that run at the same time, then collects their results into an array. Use it to call multiple partners or services concurrently instead of one after another, then hand the combined results to a downstream step.

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

The `children` slot list also lives in `node.config`; the editor manages it for you when you add slots and wire nodes. A slot entry may also carry `on_failure: 'continue'` (see [A slot whose failure does not stop the run](#a-slot-whose-failure-does-not-stop-the-run)); the editor does not show it. In the editor these map to: "Wait for" (All slots / First to succeed / Specific slot), "Wait for slot", "Timeout (ms)", "On timeout" (Continue with partial results / Fail the execution), and "On child error".

## Wait modes

### `all` (default)

Waits for every child (`Promise.allSettled`). When the timeout fires before all settle, `on_timeout` decides: `partial` continues with the settled results and marks the rest `timeout`; `fail` throws. After all settle, if `on_child_error` is `fail` and any child rejected or timed out, the node throws. Set `on_child_error: 'continue'` when a downstream step handles rejections itself.

### `first`

Races the children and resolves with the first child that succeeds (status `fulfilled`). The other children keep running in the background but their results are discarded. The node fails if all children reject, or if the timeout fires before any child succeeds. The output array holds only the winning child.

### `specific`

Waits for one named slot (`wait_for_slot`). Sibling slots keep running in the background but are not awaited; if they have not settled when the named slot finishes, they appear as `timeout` in the output. The named slot's status drives success: if it rejects or times out, the node throws.

## A slot whose failure does not stop the run

A slot entry in `children` marked `"on_failure": "continue"` never fails the block under `wait_for: 'all'`, whatever `on_child_error` says: when it fails, or is still running at the timeout with `on_timeout: 'partial'`, the block completes and the run goes on to the step after `parallel_end`. With `on_timeout: 'fail'` a timeout still fails the block, as it does whichever slot is late. Its failure is not silent. The failed step's row says what went wrong, and once the run's walk is done the failure is raised as the run's own: the run is recorded as degraded and the failure goes through the same alert as any Salesforce write after the answer that fails (the `sf_writeback` dead letter, and, for a Salesforce step, the failed write capture). This holds whether the block runs before the run answers or after: before, the slot's failure never stops the answer. A failure that ended the walk outranks it.

Every other slot follows `on_child_error` as before. Main Flow's `parallel_1` uses both once its collections stage is applied (#2832): the trades chain fails the block, so a failed trades call fails the run before any answer as it always has, and the collections slot (`child-2`) is marked, so a failed collections post never costs the lead its answer.

## Salesforce writes inside a block

Each step in a slot is watched exactly as a step of the main walk is: a Salesforce update after the answer has its at-risk record and write marker, and a credit inquiry post is recorded before it is sent. Each step carries its own watch with its call, so two slots writing at once never share one (#2832). While the slots run, the run names the steps they are on, so a run cut off 12 s after its answer names them rather than the block.

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

Three partners in parallel, continue even if some fail so a downstream step can pick the winner:

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
- A slot still running when the block stops waiting for it gets a step row on the step it was running, with the request that step had sent. Its own late finish writes nothing. When the block's timeout cut it off and the block carried on, or failed on that timeout, the row is `failed` and marked as the block's deadline (`timeout_kind` `parallel_block`). When a winner returned first under `wait_for: 'first'`, or the block failed on another slot that failed, the row is `skipped` (#3083), marked as the block's deadline only when that had passed (`wait_for: 'all'`), so the upstream outage check still reads the slot the block failed on.

## See also

- [Bid Group node](./bid-group.md) for a higher-level fan-out built specifically for partner bidding.
- [Exit node](./exit.md) and [Response node](./response.md) for terminating the run (use these outside a parallel block).
- [Data references](../concepts/data-references.md) for reading the result array downstream.
- [Workflow definition schema](../concepts/workflow-definition-schema.md) for the node and edge JSON shape.
