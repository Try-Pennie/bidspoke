# Getting started

This guide walks you through building, saving, testing, and triggering your first Bidspoke workflow. By the end you will have a live workflow that accepts a lead over HTTP and returns a response. It assumes no prior knowledge of the platform. Read the [Overview](../concepts/overview.md) first if you want the big picture.

## 1. Sign in

Open the Bidspoke app and sign in with your Pennie Google account. Access is limited to allowlisted `@trypennie.com` accounts. If you reach an access-denied screen, ask an admin to add you.

## 2. Create a workflow

From the workflows list, create a new workflow and give it a name. You land on the canvas: an open editing surface with a node palette on the left and a configuration panel on the right.

Every workflow starts with a trigger. The trigger is how the workflow is started over HTTP. For now, leave it as the default HTTP webhook. See [Triggers and endpoints](../concepts/triggers-and-endpoints.md) for the details.

## 3. Add and connect nodes

Drag nodes from the palette onto the canvas and connect them with edges. For a first workflow, build a simple three-step flow:

1. A [Filter](../nodes/filter.md) node that passes only the leads you want.
2. A [Webhook](../nodes/webhook.md) or [Salesforce](../nodes/salesforce.md) node that does something with the lead (optional for a first pass).
3. A [Response](../nodes/response.md) node that returns a result to the caller.

Connect the trigger to the first node, then each node to the next. The Filter node has two outputs, `pass` and `exit`: wire `pass` to your next node and `exit` to an [Exit](../nodes/exit.md) or [Response](../nodes/response.md) node so rejected leads still get a clean reply.

## 4. Configure each node

Select a node to open its configuration panel on the right. Each node type has its own form. To reference data from the incoming request or an earlier step, use a data reference like `trigger.payload.email` or `steps.validate.output.score`. Most fields accept templates, so you can write things like `Hello {{ trigger.payload.first_name }}`. See [Data references](../concepts/data-references.md) for the full syntax.

A node with required fields left unconfigured shows an amber ring on the canvas. You cannot enable a live workflow that has unconfigured nodes.

## 5. Save

Saving stores your changes and creates a version snapshot. You can browse and restore versions at any time, so save often. See [Versioning and backup](../guides/versioning-and-backup.md).

## 6. Test it

Before sending real traffic, use the Test Runner. Provide a sample JSON payload (or pick a saved one), run it, and watch the workflow execute step by step on the canvas. Expand any step to see its resolved input and its output. Test runs use the real engine but are flagged as tests, so they do not pollute your metrics or write production side effects. See [Testing and debugging](../guides/testing-and-debugging.md).

## 7. Set up a source and API key

To trigger a workflow from outside, callers need an API key. Create a source (for example "Website form"), which generates an API key, and assign the source to your workflow. See [Sources in the REST API reference](../reference/api.md) for the management endpoints.

## 8. Trigger it over HTTP

Make the workflow active, then call its webhook. The path is `POST /webhooks/:workflow_id`, with your API key in the `X-API-Key` header and the lead as a JSON body:

```bash
curl -X POST https://hook.trypennie.dev/<your-endpoint> \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your-api-key>" \
  -d '{"email": "lead@example.com", "state": "TX", "loan_amount": 15000}'
```

The JSON body becomes `trigger.payload`. The response is shaped by your Response node, and the `X-Trace-Id` header gives you the execution's trace id. See the [Webhook contract](../reference/webhook-contract.md) for headers, idempotency, and error responses.

## 9. Watch it run

Open the execution history for your workflow to see live runs. Click an execution to see each step, its inputs and outputs, timing, and (for bidding flows) why each partner did or did not bid. See [Observability](../reference/observability.md).

## Next steps

- Build a real bidding flow: [Building a bidding workflow](building-a-bidding-workflow.md).
- Understand the model: [Workflows and executions](../concepts/workflows-and-executions.md).
- Learn the node types: [Node catalog](../nodes/README.md).

## See also

- [Overview](../concepts/overview.md)
- [Data references](../concepts/data-references.md)
- [Webhook contract](../reference/webhook-contract.md)
