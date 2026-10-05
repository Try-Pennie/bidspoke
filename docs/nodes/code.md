# Code node

Runs your own JavaScript inside a sandboxed Cloudflare worker as a step in a workflow. Use it when no built-in node does what you need: custom validation, reshaping a payload, calling an internal helper, or short-circuiting the run with an early response.

## Purpose

The Code node executes an async JavaScript function body you write in the Monaco editor. The script receives the trigger payload, the outputs of upstream steps, your environment variables, execution metadata, and any declared props. Whatever it `return`s becomes the node's output, available downstream as `steps.<namespace>.output.*`. See [data references](../concepts/data-references.md) for how to read that output in later nodes.

Scripts are deployed on workflow save into a single bundled worker per workflow. The script runs in a V8 isolate with no filesystem and no module system. There is no `require` or `import`, and no Pipedream-style `$` object. You only have the globals listed below.

## Available globals

These are the only values in scope. There are no imports.

| Global | Type | Description |
|--------|------|-------------|
| `trigger` | object | `{ payload }` - the inbound webhook/trigger body is at `trigger.payload`. |
| `steps` | object | Outputs of upstream steps, keyed by node namespace. Read an upstream value as `steps.<namespace>.output.<field>`. |
| `env` | object | Merged environment variables: your Bidspoke env vars (secrets decrypted, a workflow's own over the organization's) plus Cloudflare secrets. Your env vars win on name collisions. |
| `execution` | object | Run metadata: `trace_id`, `execution_id`, `workflow_id`, and `bidspoke_link` (a deep link to this run). |
| `props` | object | Declared inputs resolved from templated sources (see Props below). Always an object, defaults to `{}`. |
| `console` | object | `console.log` / `.info` / `.warn` / `.error` / `.debug`. Captured per run and shown on the step's row (capped at 200 entries / 50 KB). |

Two convenience aliases also exist: `payload` (same as `trigger.payload`) and `process.env` (same as `env`). Prefer `trigger.payload` and `env` for clarity.

Your script is the body of an `async` function, so you can `await` and you must `return` a value.

## Config schema

`node.config` for a Code node:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `script` | string | Yes | none | The JavaScript function body. Must `return` a value. A node with no script throws at execution. |
| `props` | array | No | `[]` | Declared inputs. Each is `{ name, source }`. `name` becomes `props.<name>` in the script; `source` is a template (for example `{{steps.validate.output.amount}}`, `{{payload.field}}`, or `{{env.SOME_VAR}}`) resolved at execution time. |

Standard node-config fields (`timeout_ms`, `retries`, `retry_backoff`, `on_error`, `fallback_node`) also apply. See [workflow definition schema](../concepts/workflow-definition-schema.md).

### Props

Props let you declare named inputs in the config UI instead of digging into `steps` inside the script. In the editor, the Props section maps each `props.X` reference to a templated source. A prop source can be any template string, for example `{{steps.x.output.y}}` or `{{payload.field}}`. The resolved values arrive as the `props` global.

## Output shape

The node's output is exactly the value your script returns. If the script returns `undefined` or nothing, the output is `null`.

Downstream nodes read it as `steps.<namespace>.output.<...>`. For example, if your script returns `{ score: 720 }`, a later node references `steps.credit_check.output.score`.

## Early-exit patterns

A returned object with specific shapes is treated as a control-flow sentinel instead of plain output:

- Return `{ response: { status, body, headers? } }` to respond to the caller immediately and stop the workflow. `status` defaults to `200`, `body` defaults to `null`.
- Return `{ response: { ... }, continueExecution: true }` to send that response now but keep running the rest of the workflow.
- Return `{ exit: true }` (optionally with `reason`) to end the run with no response.

Anything else you return is treated as normal output.

## Edges

The Code node has a single outgoing edge. After a normal return, the workflow continues to the next node. After an early-exit sentinel (`{ response }` without `continueExecution`, or `{ exit: true }`), the run stops and downstream nodes do not execute.

## Example

A complete Code node that validates a lead, enriches it, and returns structured output.

```json
{
  "id": "n_score",
  "namespace": "score_lead",
  "type": "code",
  "label": "Score lead",
  "config": {
    "props": [
      { "name": "minScore", "source": "{{env.MIN_CREDIT_SCORE}}" }
    ],
    "script": "const email = trigger.payload.email\nif (!email || !email.includes('@')) {\n  return { response: { status: 400, body: { error: 'invalid email' } } }\n}\n\nconst credit = steps.credit_pull.output.body\nconst score = Number(credit.score)\nconsole.log('credit score', score, 'min', props.minScore)\n\nif (score < Number(props.minScore)) {\n  return { exit: true, reason: 'below minimum score' }\n}\n\nreturn {\n  email,\n  score,\n  tier: score >= 740 ? 'prime' : 'near_prime',\n  trace_id: execution.trace_id\n}"
  }
}
```

The same script, with the early-exit branches shown as standalone snippets:

```js
// Respond immediately and stop the workflow:
return { response: { status: 400, body: { error: 'invalid email' } } }

// Respond now but keep running:
return { response: { status: 202, body: { received: true } }, continueExecution: true }

// End the run quietly, no response:
return { exit: true, reason: 'below minimum score' }
```

## Notes

- Reference secrets with `env.SECRET_NAME`. Your Bidspoke env vars (secrets decrypted, and a workflow's own values in place of the organization's of the same name) and Cloudflare worker secrets are both on `env`. Your env vars win on a name collision; platform secrets are never exposed.
- Bidspoke statically scans your script for `steps.<name>` references and only ships those step outputs to the isolate, to keep payloads small. Dynamic access (for example `steps[key]`, `Object.keys(steps)`, `for (const k in steps)`, or assigning `const s = steps`) disables that optimization and the full `steps` object is sent. Behavior is the same either way; only payload size differs.
- Edits to a script take effect on workflow save (scripts are bundled and deployed at save time). Test runs deploy an ephemeral bundle so unsaved edits run immediately in the test runner.

## See also

- [Data references](../concepts/data-references.md)
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
- [Constants node](./constants.md)
- [Webhook node](./webhook.md)
- [Salesforce node](./salesforce.md)
