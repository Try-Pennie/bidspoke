# Workflows and Executions

The core domain model behind Bidspoke: a workflow is the design you build on the canvas, a version is a saved snapshot of it, and an execution is one run of a version triggered by an incoming request. This page explains each of those, how a run is produced and logged, and the difference between resuming and replaying a run.

For the JSON behind a workflow, see [the workflow definition schema](./workflow-definition-schema.md). For how runs are triggered, see [triggers and endpoints](./triggers-and-endpoints.md).

## Workflow

A workflow is a named automation made of nodes and edges (its definition). It belongs to an organization and has a stable `id` that appears in its trigger URL. The live definition the engine runs is stored on the workflow record itself.

### Active vs inactive

A workflow is either active or inactive.

- **Active** workflows serve real webhook traffic. The generic webhook endpoint only loads and runs a workflow that is active.
- **Inactive** workflows are not reachable by live webhooks. You can still run them from the in-app test runner, which bypasses the active check so you can iterate before flipping a workflow live.

## Workflow version

Every time you save a workflow, Bidspoke writes a new immutable version: a numbered snapshot of the full definition at that moment. The engine always loads the latest version of a workflow. Versions give you history (browse and restore an earlier definition) and an exact record of which definition produced any given run.

Each execution records the `workflow_version_id` it ran, so a run is always traceable to the exact definition that produced it, even after the workflow is edited again.

### Definition loading and caching

When a workflow is triggered, the engine loads its latest version. To keep this fast, the loaded definition is cached in Cloudflare KV for 5 minutes, keyed by workflow id. Saving a workflow invalidates that cache immediately, so the next run picks up the new version. Test runs against inactive workflows skip the cache entirely (so an unsaved or inactive definition never pollutes the cache real webhooks read from).

## Execution

An execution is one run of a workflow version. It is created the moment a valid trigger request arrives and the definition loads. Each execution has:

- a unique `execution_id`,
- a `trace_id` (also returned to the caller in the `X-Trace-Id` response header) used to correlate logs across the run and any outbound partner calls,
- the `source` that triggered it (see [triggers and endpoints](./triggers-and-endpoints.md)),
- the trigger payload,
- a status and an outcome (below),
- timing and an estimated cost.

### How an execution is produced from a trigger

1. A request hits a trigger URL (the generic webhook or a custom endpoint). See [triggers and endpoints](./triggers-and-endpoints.md).
2. The request is authenticated and a `source` name is resolved from the API key (or the endpoint).
3. The engine loads the latest version of the target workflow (active workflows only for live webhooks).
4. If idempotency is enabled and this request is a duplicate, the prior response is returned instead of running again.
5. The engine builds an execution context (trigger payload, env vars, per-run metadata) and finds the entry node from the `trigger` edge.
6. It walks the graph node by node, following edges and handles, until a terminating node (`response` or `exit`), an early code-node response, or the end of the graph.
7. The response is returned to the caller. Logging and some finalization continue in the background after the response is sent.

### Status and outcome

An execution carries both a status and a finer outcome:

- **Status**: `running`, `completed`, or `failed`. A run is `failed` if a step fails with `on_error: fail`, if a code/response node returns a 5xx, if step logs fail to persist, or if the run never advanced past the trigger.
- **Outcome**: `successful`, `completed`, or `failed`. A non-failed run is marked `successful` when any node listed in the trigger's `success_node_namespaces` completed during the run; otherwise it is `completed`. This lets the dashboard distinguish "ran fine and produced the intended result" from "ran fine but did not reach the success node".

## Execution step

Each node the engine runs produces an execution step row. A step records:

- the node `namespace`, `id`, and `type`,
- its status: `running`, `completed`, `failed`, `skipped`, or `failed_with_fallback`,
- the resolved input and the output,
- any captured console logs (for code nodes),
- error message and error type (`transient` or `permanent`) on failure,
- retries used, timing, and step order.

Steps are accumulated during the walk and written to the database in a single batch after the run, off the response critical path. The execution detail page renders these steps, including a "Bid attempts" breakdown for `bid_group` steps.

### What gets logged

- One execution record per run (status, outcome, timing, response body, cost, trace id).
- One step row per executed node (including synthesized per-partner rows under a `bid_group`).
- Structured JSON log lines (trace id, workflow id, step namespace, event type) for observability tooling.
- Optional lead-sighting rows for analytics, when the workflow has sighting capture enabled (skipped for test runs).

Sensitive fields can be redacted at write time via the platform's PII redaction list before step inputs/outputs are persisted.

## Resume vs replay

Both let you re-run a workflow, but they differ in what they reuse:

- **Resume** continues a failed run from where it stopped. The engine pre-loads the already-completed steps from the original execution, skips re-running them (reusing their outputs), and only executes the steps that had not completed. Use this to recover a run after fixing a transient upstream problem without redoing successful work (such as a credit pull or a Salesforce write). For a parallel group, only the incomplete children are re-run.
- **Replay** starts a brand new run from the beginning with the same trigger payload. Nothing is reused. The new execution links back to the original via its parent execution id.

Test runs (from the in-app test runner) use the same engine, flagged as a test: they do not fire Slack alerts, do not write idempotency or lead-sighting rows, and can run against inactive workflows.

## See also

- [Triggers and endpoints](./triggers-and-endpoints.md) - how runs are started and authenticated.
- [Workflow definition schema](./workflow-definition-schema.md) - the definition a version snapshots.
- [Data references](./data-references.md) - how steps expose their output to later nodes.
- [API reference](../reference/api.md) - endpoints for listing executions, resuming, and replaying.
