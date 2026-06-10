# Import from Pipedream

How to bring an existing Pipedream workflow into Bidspoke: paste the raw JSON export, preview what it maps to, and import it onto the canvas. The importer is a best-effort converter; it gets you most of the way and flags everything you need to review.

## What you need

The raw JSON export of a Pipedream workflow. The importer accepts either the common shape with a top-level `steps` array, or the alternate shape with a `components.triggers` / `components.actions` object. If the JSON does not parse, or has no steps, the importer tells you.

## Run the import

1. Open the workflow canvas where you want the imported nodes. Importing adds the parsed nodes to that canvas.
2. Open the Import dialog ("Import from Pipedream").
3. Paste the raw Pipedream JSON into the text area.
4. Click Parse. The dialog shows a preview: the workflow name, the node and edge counts, and each node as a `type` badge plus its namespace.
5. Review the warnings (amber). Each item that needs attention is listed; see [What to check after import](#what-to-check-after-import).
6. Click Import to canvas to drop the nodes in. Or click Back to edit the JSON and parse again.

Nothing is saved until you Save the workflow on the canvas. Import only places the nodes; review them first.

## What maps to what

The importer reads each Pipedream step and produces a Bidspoke node:

| Pipedream step | Becomes | Notes |
|----------------|---------|-------|
| Trigger (`type: 'trigger'` or namespace `trigger`) | The workflow trigger, not a node | Sets an HTTP webhook trigger (`POST`, API-key auth). Downstream refs to it become `trigger.payload.*`. |
| Step with `_filter.type === 'evalRuleGroup'` | [Filter node](../nodes/filter.md) | Rule group is converted to the filter's condition format. Gets a `pass` outgoing edge. |
| Step with `_controlFlow.type === 'ifelse'` | [Branch node](../nodes/branch.md) | Each condition becomes a labeled branch, plus an `else` edge. |
| Step with namespace `constants` | [Constants node](../nodes/constants.md) | Created empty; you fill in workflow constants. Partner data (UUIDs, sell-off copy) comes from partner settings, not the import. |
| Any other step (code or app action) | [Code node](../nodes/code.md) | The Pipedream code is translated (see below). App-integration steps also map to a Code node and raise a warning. |

Steps are wired in sequence: each node connects to the next. Filter nodes contribute a `pass` edge; Branch nodes contribute one edge per branch plus an `else` edge. The final step's outgoing edge is left unwired so you can attach a [Response node](../nodes/response.md) yourself.

### Operator mapping

Filter and Branch rule operators are mapped from Pipedream's names to Bidspoke operators. Equality, comparison, contains, and existence operators map directly (for example `greater_than` to `gte` is via `gt`/`gte` names, `is_blank` to `not_exists`, `is_not_empty` to `exists`). Approximate operators (`starts_with`, `ends_with`, `regex`, `matches`) have no exact equivalent and are mapped to `contains` with a warning. An unknown operator defaults to `eq` with a warning. Always review converted rules.

## Code translation notes

When a step becomes a Code node, the importer rewrites the most common Pipedream-isms into Bidspoke equivalents. It is a text transform, so review every imported script before running it.

What gets rewritten:

- `import ... from '@pipedream/platform'` and bare `import axios from 'axios'` are removed (Bidspoke Code nodes use native `fetch`).
- Data references are translated: `steps.trigger.event.body` and `steps.trigger.event` to `trigger.payload`; `steps.<ns>.$return_value` to `steps.<ns>.output`; `steps.trigger.context.trace_id` to `execution.trace_id`.
- `process.env.VAR` to `env.VAR`.
- `this.prop` to `config.prop`.
- Salesforce OAuth token (`config.salesforce.$auth.oauth_access_token`) to `env.SALESFORCE_ACCESS_TOKEN`.
- Equifax credentials (`config.equifaxUsername` / `config.equifaxPassword`) to `env.EQUIFAX_USERNAME` / `env.EQUIFAX_PASSWORD`.
- Pipedream data store reads (`config.dataStore.get(X)`) to an env-var pattern `BIDDING_ACTIVE_<X>` check.
- `$.export('$summary', msg)` to `console.log(msg)`; other `$.export(field, val)` to a commented note.
- `$.flow.exit(reason)` to `return { exit: true, reason }`.
- `$.respond({ ... })` to `return { response: { ... } }`.
- `axios($, { ... })` and `axios.post(...)` to rough `fetch(...)` calls (these especially need manual cleanup).

What you must do by hand:

- Rewritten `fetch` calls from `axios` are approximate. Fix the method, headers, and body.
- Any environment variable the script now reads (`env.SALESFORCE_ACCESS_TOKEN`, `env.EQUIFAX_USERNAME`, custom keys) must exist on the [Environment Variables page](./environment-variables-and-secrets.md). Partner and workflow credentials go there, not in Cloudflare secrets.
- App-integration steps were flattened to Code nodes. Consider replacing them with first-class nodes: a [Salesforce node](../nodes/salesforce.md) for Salesforce, a [Webhook node](../nodes/webhook.md) for outgoing HTTP, or a [Bid Group node](../nodes/bid-group.md) for partner bidding.

## Auto-layout

Imported nodes are auto-positioned in a single vertical column (fixed X, evenly spaced Y) so nothing overlaps. Once on the canvas you can drag them, and the canvas relayout will tidy connected nodes.

## What to check after import

Work through the dialog's warnings, then on the canvas:

1. Read every Code node script. The translation is mechanical and approximate, especially the `axios` to `fetch` rewrites.
2. Confirm Filter and Branch operators and values, especially any that mapped to `contains` or defaulted to `eq`.
3. Fill in the Constants node if one was created.
4. Wire the last node to a [Response node](../nodes/response.md) (or [Exit node](../nodes/exit.md)) so the workflow returns something.
5. Add any referenced env vars on the [Environment Variables page](./environment-variables-and-secrets.md).
6. Replace flattened app actions with first-class nodes where it makes sense.
7. Save (creates a [version snapshot](./versioning-and-backup.md)), then run it through [Testing and debugging](./testing-and-debugging.md) with a sample payload before enabling.

## See also

- [Code node](../nodes/code.md) for the Bidspoke execution model and available globals.
- [Filter node](../nodes/filter.md) and [Branch node](../nodes/branch.md) for the converted routing logic.
- [Environment variables and secrets](./environment-variables-and-secrets.md) for the env vars imported scripts expect.
- [Data references](../concepts/data-references.md) for the translated `trigger.*`, `steps.*`, `env.*` syntax.
- [Testing and debugging](./testing-and-debugging.md) to validate the imported workflow.
