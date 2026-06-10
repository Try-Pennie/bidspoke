# Testing and debugging

How to run a workflow with a test payload, watch it execute step by step on the canvas, read each node's resolved input and output, replay or resume a past run, and find out why a lead got no bid. Testing uses the same execution engine as production, flagged as a test, so what you see is what production does.

For traces, logs, and dashboards beyond a single run, see the [observability reference](../reference/observability.md).

## Run a test from the canvas

1. Open the workflow on the canvas and open the Test panel ("Test run"). It opens as a right-hand rail. It is labeled "Runs in test mode. No Slack alerts."
2. Enter a trigger payload as JSON in the Trigger payload box. This is the lead body you would normally POST to the webhook, available downstream as `trigger.payload.*`.
3. Click Run test.

The test runs against the current canvas definition (your unsaved edits are included), so you can iterate without saving first. Test runs are flagged `is_test` and skip Slack alerts and the production-only data writes.

## Saved test payloads

You do not have to retype payloads. To save the current payload for reuse:

1. Click "Save payload for reuse".
2. Give it a name (for example "happy path" or "no email").
3. Click Save.

Saved payloads appear at the top of the Test panel. Click one to load it into the editor; click the trash icon to delete it. Saved payloads are stored on the workflow, so the whole team sees them.

## Watch the steps execute

When a test runs, two things update:

- The Test panel shows a Steps list as results come in, with a status icon per step (completed, failed, failed-with-fallback, skipped, or pending), the step label, and its duration. The list also shows a wall-clock total. Structural markers like branch-end and parallel-end are hidden as noise.
- The canvas colors nodes and edges by result, so you can see the path the lead actually took. Node coloring is fed live from the run.

A step row that has output or an error is expandable. Click it to reveal:

- Error - the error message, if the step failed.
- Output - what the node returned, that is what downstream `steps.<id>.output.*` references will contain.
- Input - the resolved input the node received (all data references already resolved to concrete values).

Each block has a copy button. Reading the resolved Input is the fastest way to confirm a [data reference](../concepts/data-references.md) pointed where you expected.

The Test panel also surfaces a result banner with the final HTTP response body (or the error if the run failed before producing steps), and Suggestions when two adjacent steps have no data dependency and could run in [parallel](../nodes/parallel.md) to save time.

## Inspect a past execution

Every production run is recorded. Open a workflow's Executions list and select a run to see its detail page: the trigger payload, every step with its input and output, timing (including a cumulative "+Xs from trigger" and a per-step waterfall bar), and the final response.

## Replay from start vs resume from failure

From an execution's detail page (and from the execution banner on the canvas) you can re-run a past execution two ways. They are different:

- Replay - re-runs the workflow from the start with the same trigger payload. Every step runs fresh. Use this to reproduce a run or to verify a fix end to end. The new run links back to the original as a replay child.
- Resume - re-runs only the incomplete steps. Completed steps are inherited from the original run with their original outputs, so partial results are preserved and only the failed-or-after portion runs again. Use this to recover a run that died partway, for example a partner timed out mid-auction. Parallel resume re-runs only the incomplete children of a parallel/Bid Group step.

Both create a new execution that references the original via `parent_execution_id`, so replays and resumes both show up as children in the original's replay lineage.

## Why did this lead get no bid?

When a run goes through a [Bid Group](../nodes/bid-group.md), the execution detail page renders a "Bid attempts" section above the step list. For each partner tried, it shows:

- The partner slug.
- The resolver mode: Matrix, Matrix (sell-off), Formula, or Partner API.
- A result badge: Won, Bid, Outbid, No bid, Skipped, Rejected, Timed out, or Errored.
- The bid amount, when there is one.
- A human-readable "why".

The "why" is derived from the attempt's skip reason and matrix reason, so a no-bid is never a mystery. Common explanations:

- "Dedup match" - the partner's dedup endpoint said it already has this lead.
- "Daily cap (N)" - the partner hit its daily cap.
- "Circuit breaker open" - the partner's circuit breaker is open after repeated failures.
- "Partner inactive" - the partner is toggled off globally on the [Partners page](./configuring-a-partner.md).
- "Below min ($X)" - the bid came in under the partner's minimum bid.
- "No matrix row matched the lead" - the matrix resolver found no row for this lead's attributes.
- "Missing payload field: X" - the matrix resolver needed a field the payload did not have.
- "Matrix config inactive" - the matrix config is disabled.

The winning row is highlighted. When no partner won, the section gets a red header carrying the Bid Group's `reason`. To change a partner's caps, breaker, min bid, or matrix, see [Configure a partner](./configuring-a-partner.md).

## See also

- [Observability reference](../reference/observability.md) for traces, structured logs, and dashboards across runs.
- [Build a bidding workflow](./building-a-bidding-workflow.md) for the workflow you are testing.
- [Bid Group node](../nodes/bid-group.md) for the auction logic behind the bid-attempts view.
- [Data references](../concepts/data-references.md) for reading resolved inputs and outputs.
- [Configure a partner](./configuring-a-partner.md) for fixing skip and no-bid causes.
