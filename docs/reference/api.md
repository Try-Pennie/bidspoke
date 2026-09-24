# Management API reference

The REST API for managing Bidspoke from the app: workflows, executions, environment variables, sources, partners, integrations, and more. Every route under `/api/*` is here. This is the management plane. To trigger a workflow over HTTP, see the [webhook contract](./webhook-contract.md) instead.

All examples use the worker base URL. In production that is `https://bidspoke.trypennie.dev` (the same host the app talks to). Replace it with your own worker URL if different.

## Authentication

Every `/api/*` route requires a Supabase JWT, passed as a bearer token:

```
Authorization: Bearer <supabase_jwt>
```

The middleware verifies the token against Supabase's JWKS, then looks up the calling user's row to resolve their `organization_id`. All queries are scoped to that organization, and Postgres row-level security enforces the same scoping at the database layer. You cannot read or write another organization's data, even by guessing IDs. A request with a missing, malformed, or expired token returns `401`. A valid token whose user has no matching row also returns `401`.

Triggering a workflow is a separate auth scheme (`X-API-Key` or token auth on the webhook routes). That is documented in the [webhook contract](./webhook-contract.md), not here.

### Common error shape

Errors return a JSON object with an `error` string and an appropriate status code:

```json
{ "error": "Workflow not found" }
```

Common statuses: `400` (bad request body or query), `401` (auth), `404` (not found or not in your org), `409` (conflict, e.g. duplicate name or idempotency race), `500` (server or upstream error).

A `PATCH` or `DELETE` whose target row does not exist, or belongs to another organization, returns `404`. It never returns a success for a write that changed nothing. Four endpoints are deliberate exceptions, because clearing something that was never set is a no-op rather than an error, and they return `200` either way: `DELETE /api/integrations/slack`, `DELETE /api/settings/anthropic-key`, `DELETE /api/sources/:name/workflows/:workflow_id`, and `DELETE /api/field-coverage/:workflowId/silence`. Even there, nothing is written to the audit log unless a row actually changed.

## Workflows

`/api/workflows`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/workflows` | List workflows in your org (summary fields, newest-updated first). |
| POST | `/api/workflows` | Create a workflow. |
| POST | `/api/workflows/:id/duplicate` | Clone a workflow with its full version history. |
| GET | `/api/workflows/:id` | Get one workflow, including its full `definition`. |
| PUT | `/api/workflows/:id` | Save the definition. Creates a version snapshot and invalidates the KV cache. |
| PATCH | `/api/workflows/:id` | Lightweight field update (`is_active`, `capture_sightings`, `folder_id`). No version snapshot. |
| DELETE | `/api/workflows/:id` | Soft-delete (sets `deleted_at`, flips `is_active` off). |
| POST | `/api/workflows/:id/draft-changelog` | AI-drafted summary of pending changes (used by the save popover). |
| PATCH | `/api/workflows/:id/test-payloads` | Replace the saved test payload array. |
| GET | `/api/workflows/:id/versions` | List version snapshots (newest first). |
| GET | `/api/workflows/:id/versions/:version_id` | Get one version snapshot, including its `definition`. |
| POST | `/api/workflows/:id/versions/:version_id/restore` | Restore a version (creates a new version with the old definition). |
| POST | `/api/workflows/:id/test` | Run the workflow in test mode (does not count as production traffic). |
| POST | `/api/workflows/:id/test-node` | Re-run a single node using context from a prior execution or an inline payload. |
| GET | `/api/workflows/:id/rename-impact` | Report which partner bid formulas a node rename would affect. |
| POST | `/api/workflows/:id/rename-apply` | Rewrite `steps.OLD.*` references in partner formulas after a node rename. |

### Create a workflow

`POST /api/workflows`. Only `name` is required. If you omit `definition`, an empty HTTP-webhook definition is seeded.

```bash
curl -X POST https://bidspoke.trypennie.dev/api/workflows \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Lead intake",
    "description": "Validate and route inbound leads",
    "folder_id": null
  }'
```

Response `201`:

```json
{
  "id": "8f3c2b10-...",
  "organization_id": "9d9d0d3a-...",
  "name": "Lead intake",
  "description": "Validate and route inbound leads",
  "definition": { "nodes": [], "edges": [], "trigger": { "type": "http_webhook", "config": { "method": "POST", "auth_method": "api_key" } } },
  "is_active": true,
  "folder_id": null,
  "created_at": "2026-06-09T12:00:00Z",
  "updated_at": "2026-06-09T12:00:00Z"
}
```

### Save a workflow (create a version)

`PUT /api/workflows/:id`. Send the full `definition`. The save creates a numbered version snapshot, invalidates the workflow's KV cache so the next trigger loads the new definition, deploys any Code node bundles, and (best-effort, asynchronously) pushes the definition to the GitHub backup repo. An optional `message` is stored on the version row.

```bash
curl -X PUT https://bidspoke.trypennie.dev/api/workflows/8f3c2b10-... \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "definition": { "nodes": [], "edges": [], "trigger": { "type": "http_webhook", "config": { "method": "POST", "auth_method": "api_key" } } },
    "message": "Add validation filter"
  }'
```

Response `200` returns the updated workflow plus `version_id`. If any Code node bundle failed to deploy, `deploy_errors` is present:

```json
{
  "id": "8f3c2b10-...",
  "name": "Lead intake",
  "definition": { "nodes": [], "edges": [], "trigger": { "...": "..." } },
  "updated_at": "2026-06-09T12:05:00Z",
  "version_id": "a1b2c3d4-...",
  "deploy_errors": null
}
```

You may also pass `name`, `description`, and `slack_channel` (per-workflow alert channel override) in the same `PUT`.

### Restore a version

`POST /api/workflows/:id/versions/:version_id/restore`. This does not overwrite history. It writes the old definition as a brand-new version and points the workflow at it.

```bash
curl -X POST https://bidspoke.trypennie.dev/api/workflows/8f3c2b10-.../versions/a1b2c3d4-.../restore \
  -H "Authorization: Bearer $JWT"
```

Response `200`:

```json
{ "ok": true, "version_number": 12 }
```

### Run a test

`POST /api/workflows/:id/test`. Runs the workflow through the same engine as production but flagged as a test, so it does not appear in production volume or counts. Pass the `payload` that becomes `trigger.payload`. Pass `definition` to test unsaved canvas changes (the engine runs that definition instead of the saved one and deploys a temporary Code node bundle). Pass `execution_id` to resume a prior test run.

```bash
curl -X POST https://bidspoke.trypennie.dev/api/workflows/8f3c2b10-.../test \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { "email": "lead@example.com", "credit_score": 700 }
  }'
```

The response is the workflow's response body (whatever a [Response node](../nodes/response.md) produced, or an error), with `X-Trace-Id` set on the response headers. Use [`GET /api/executions/:id`](#executions) to inspect the per-step results.

## Executions

`/api/executions`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/executions` | List production executions (newest first, max 100 per page, filterable). |
| GET | `/api/executions/step-duration-stats` | Percentile timing for one step, used to suggest a timeout. |
| GET | `/api/executions/:id` | Get one execution with its steps and any replay/resume children. |
| GET | `/api/executions/:id/steps/:stepId` | Lazy-load a single step's input/output/logs. |
| POST | `/api/executions/:id/resume` | Resume a failed execution, skipping completed steps. |
| POST | `/api/executions/:id/replay` | Replay from the start with the original payload (fresh execution). |

### List executions

`GET /api/executions`. Returns at most 100 rows. Query params, all optional:

| Param | Description |
|-------|-------------|
| `workflow_id` | Scope to one workflow (must belong to your org). |
| `status` | Filter by status, e.g. `completed`, `failed`. |
| `outcome` | Filter by business outcome. |
| `source` | Filter by the source that triggered the run. |
| `from`, `to` | ISO timestamps bounding `started_at`. |
| `before`, `before_id` | Keyset cursor for infinite scroll (load rows strictly older than this pair). |

```bash
curl "https://bidspoke.trypennie.dev/api/executions?workflow_id=8f3c2b10-...&status=failed" \
  -H "Authorization: Bearer $JWT"
```

Response `200` (array; `has_children` is true when the row has been replayed or resumed):

```json
[
  {
    "id": "ce61a2f4-...",
    "workflow_id": "8f3c2b10-...",
    "status": "completed",
    "outcome": "won",
    "final_node_namespace": "return_response",
    "source": "website_form",
    "started_at": "2026-06-09T12:10:00Z",
    "duration_ms": 842,
    "error_message": null,
    "parent_execution_id": null,
    "has_children": false
  }
]
```

### Get one execution

`GET /api/executions/:id`. Returns the full execution row, its `steps` array, and any `child_executions` (replays and resumes). Add `?summary=1` to omit each step's heavy `input`, `output`, and `logs` (the canvas overlay uses this and lazy-loads payloads per step via the steps route).

```bash
curl "https://bidspoke.trypennie.dev/api/executions/ce61a2f4-..." \
  -H "Authorization: Bearer $JWT"
```

Response `200`:

```json
{
  "id": "ce61a2f4-...",
  "workflow_id": "8f3c2b10-...",
  "status": "completed",
  "outcome": "won",
  "trigger_payload": { "email": "lead@example.com" },
  "trace_id": "3Edhkz0...",
  "started_at": "2026-06-09T12:10:00Z",
  "duration_ms": 842,
  "steps": [
    {
      "id": "...",
      "step_namespace": "validate",
      "step_type": "filter",
      "status": "completed",
      "duration_ms": 4,
      "step_order": 1
    }
  ],
  "child_executions": []
}
```

### Resume and replay

`POST /api/executions/:id/resume` re-runs the workflow from where it failed, skipping steps that already completed and preserving their outputs. `POST /api/executions/:id/replay` runs a fresh execution from the start with the original `trigger_payload`. Both link the new run to the original via `parent_execution_id`.

```bash
curl -X POST https://bidspoke.trypennie.dev/api/executions/ce61a2f4-.../resume \
  -H "Authorization: Bearer $JWT"
```

Response `200` returns the workflow response body, with `X-Trace-Id` and `X-Execution-Id` (the new execution's ID) on the headers.

## Environment variables

`/api/env`. Workflow-accessible config and secrets. Non-secret values are returned in full; secret values are masked as `null` on read and only revealed through the dedicated endpoint. Secrets are also synced to Cloudflare Worker secrets and stored encrypted (for reveal). See [environment variables and secrets](../guides/environment-variables-and-secrets.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/env` | List variables (secret values masked to `null`). |
| POST | `/api/env` | Create a variable. |
| PUT | `/api/env/:id` | Update a variable's value, key, or folder. |
| GET | `/api/env/:id/reveal` | Decrypt and return a secret's value (audit-logged). |
| DELETE | `/api/env/:id` | Delete a variable (also removes the Cloudflare secret if it was one). |

### Create a variable

`POST /api/env`. `key` is required. For a secret, set `is_secret: true` and provide a `value`. `scope` defaults to `global`; pass a `workflow_id` to scope it to one workflow. `folder_id` is optional.

```bash
curl -X POST https://bidspoke.trypennie.dev/api/env \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "GIGFI_API_KEY",
    "value": "sk_live_...",
    "is_secret": true,
    "scope": "global"
  }'
```

Response `201` (secret value masked):

```json
{
  "id": "...",
  "key": "GIGFI_API_KEY",
  "value": null,
  "is_secret": true,
  "scope": "global",
  "workflow_id": null,
  "folder_id": null
}
```

### Reveal a secret

`GET /api/env/:id/reveal` decrypts and returns the plaintext. The read is recorded in the audit log. Returns `400` if the variable is not a secret, `422` if it has no stored encrypted value (created before the current encryption key, so it needs rotating to re-enable reveal).

### What the audit entries record

Every create, update and delete of a variable writes an `environment_variable` audit entry whose `changes` carry what moved as `{ old, new }` pairs (#1085): a plain variable's `value` (against `null` on create and delete), its `folder_id` when it moved, and `renamed_from` beside the new `key` on a rename. A secret's value is never recorded, in plaintext or as ciphertext; its entries say only `value_set` (created) or `value_rotated` (whether the save supplied a new value). `GET /api/audit-log?entity_type=environment_variable` returns them newest first.

```json
{ "value": "sk_live_..." }
```

## Sources

`/api/sources`. A source is a named API key used to authenticate webhook triggers (see the [webhook contract](./webhook-contract.md)). Keys are 32-character hex strings, returned in full only once at creation. Sources can be assigned to specific workflows to restrict which workflows a key may trigger.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sources` | List sources for your org. |
| POST | `/api/sources` | Create a source, returning the new key once. |
| GET | `/api/sources/assignments` | List all `(source_name, workflow_id)` assignments. |
| GET | `/api/sources/:name/workflows` | List workflow IDs a source is assigned to. |
| POST | `/api/sources/:name/workflows` | Assign a source to a workflow. |
| DELETE | `/api/sources/:name/workflows/:workflow_id` | Unassign a source from a workflow. |
| DELETE | `/api/sources/:name` | Revoke all keys for a source. |

### Create a source

`POST /api/sources`. `name` is required and is normalized to lowercase with spaces replaced by underscores. Pass `assign_workflow_id` to immediately scope the new key to one workflow. Returns `409` if the name is already in use.

```bash
curl -X POST https://bidspoke.trypennie.dev/api/sources \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "name": "website_form" }'
```

Response `201` (the only time the key is shown in full):

```json
{ "name": "website_form", "api_key": "9a1f...e4c2" }
```

`GET /api/sources` returns the same fields but is for display; treat the listed `api_key` as a record, not a place to re-read a freshly minted key.

## Integrations (Slack)

`/api/integrations`. Org-level Slack connection for failure and anomaly alerts.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/integrations/slack/resolve` | Validate a bot token and return the workspace name plus channel list. |
| POST | `/api/integrations/slack` | Save or update the Slack connection. |
| GET | `/api/integrations/slack` | Get the current connection (token masked). |
| GET | `/api/integrations/slack/channels` | List channels for the connected workspace. |
| PATCH | `/api/integrations/slack/settings` | Update alert toggles (volume, matrix-change, config warnings, etc.). |
| DELETE | `/api/integrations/slack` | Disconnect Slack. |

## Service connections (schema sync)

`/api/connections`. Connections to Salesforce, Supabase, and Snowflake, used to sync schema metadata for autocomplete in the Integration node.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/connections` | List connections (no credentials returned). |
| POST | `/api/connections` | Create or replace a connection. |
| DELETE | `/api/connections/:service_type` | Remove a connection. |
| POST | `/api/connections/:service_type/sync-schema` | Trigger a schema refresh. |

`:service_type` is one of `salesforce`, `supabase`, `snowflake`.

## Partners

`/api/partners`. CRUD for partner configurations (`partner_configs`): bid resolver type, daily cap, circuit breaker settings, response classification, outbound field mapping, and more. See [the Partner Bid node](../nodes/partner-bid.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/partners` | List partners (ordered by priority). |
| GET | `/api/partners/:id` | Get one partner. |
| POST | `/api/partners` | Create a partner. |
| PUT | `/api/partners/:id` | Update a partner. |
| DELETE | `/api/partners/:id` | Delete a partner. |
| GET | `/api/partners/:id/cap-count` | Current daily cap count (from the Daily Cap Durable Object). For a buyer sold on the click, today's distinct clicks from its click counter instead, on the Pacific day: `{ sold_on: 'click', count, date, day_zone }`, 503 `click_count_unavailable` when the counter does not answer. |
| GET | `/api/partners/:id/buyer-profile` | The buyer profile document, the partner's accept rules, and the live workflows selling to this partner outside buyer selection (`other_sellers`). `profile` is null until one is saved. |
| PUT | `/api/partners/:id/buyer-profile` | Save the profile. Body `{ expected_version, profile }`. Validated with the shared package first (422 `profile_invalid` with the errors), then saved through `save_buyer_profile`. A stale `expected_version` is 409 `stale_version` carrying the current document, so the form can show both sides. Switching a buyer sold on the click to the offer while a live workflow names it on a Buyer Click Check or Buyer Click Send node is 409 `sold_on_in_use`, with a `message` naming them and the `workflows` list; 503 `sold_on_unavailable` when the stored kind cannot be read. |
| GET | `/api/partners/:id/buyer-profile/history` | One audit entry per save, each changed path old to new. |
| GET | `/api/partners/:id/buyer-usage` | The buyer ledger's counts for the current Eastern hour and day with the breakdown by status, plus today's wins recorded for this buyer outside buyer selection. 503 `usage_unavailable` when the ledger does not answer; a count that could not be read is named in `unmeasured` rather than shown as zero. The body carries `sold_on: 'offer'`; a buyer sold on the click answers `{ sold_on: 'click', count, date, day_zone }` with today's distinct clicks on the Pacific day, the count buyer_click_check judges its cap against, or 503 `click_count_unavailable`. |

## Buyer sales

`/api/buyer-sales`. Sales the [Buyer Select node](../nodes/buyer-select.md) recorded, from the `buyer_sales` mirror of the buyer ledger. Settling is a ledger operation first: the route settles the ledger with the caller as the actor, then mirrors the settled entry inline; a mirror that fails is reported and delivered by the drain, and never fails the settlement.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/buyer-sales?status=unresolved&page=&limit=&partner_id=` | The queue, paged, with the partner slug on each row and the total. `partner_id` narrows it to one buyer, and the total is then that buyer's; an empty value is refused (400 `partner_id_invalid`). |
| POST | `/api/buyer-sales/:id/settle` | Body `{ outcome: 'accepted' \| 'released' }`. Accepted counts as sold to that buyer; released frees the slot. 409 `not_unresolved` names the state the sale is in; 503 when the ledger does not answer, with nothing changed. |

## Partner bid configs

`/api/partner-bid-configs`. First-class bid configurations and their matrix rows (`partner_bid_configs` + `bid_matrix_rows`). In v1 these are synced read-only from Salesforce on an hourly cron; the schema is editable-ready.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/partner-bid-configs` | List bid configs for your org. |
| GET | `/api/partner-bid-configs/:id` | Get one config with its matrix rows. |
| POST | `/api/partner-bid-configs` | Create a config. |
| PUT | `/api/partner-bid-configs/:id` | Update a config. |
| DELETE | `/api/partner-bid-configs/:id` | Delete a config. |
| POST | `/api/partner-bid-configs/:id/sync` | Sync this config's matrix from Salesforce now. |
| GET | `/api/partner-bid-configs/:id/history` | Change history for this config. |

## Partner UUIDs

`/api/partner-uuids`. The partner UUID map merged into the [Constants node](../nodes/constants.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/partner-uuids` | List partner UUID entries. |
| POST | `/api/partner-uuids` | Add an entry. |
| DELETE | `/api/partner-uuids/:id` | Remove an entry. |

## Endpoints (custom webhook endpoints)

`/api/endpoints`. Maps a subdomain plus path on `hook.trypennie.dev` to a workflow and source name. See the [webhook contract](./webhook-contract.md) for how these are triggered.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/endpoints` | List endpoints (includes mapped workflow name). |
| POST | `/api/endpoints` | Create an endpoint. |
| PUT | `/api/endpoints/:id` | Update an endpoint (invalidates the KV cache). |
| DELETE | `/api/endpoints/:id` | Delete an endpoint (invalidates the KV cache). |

`POST` requires `subdomain`, `workflow_id`, and `source_name`. `path` defaults to `/` (a single-segment endpoint). The subdomain must be a valid DNS label and not a reserved name. Returns `409` if an endpoint already exists at that subdomain and path.

## Circuit breakers

`/api/circuit`. Read and reset upstream circuit breaker state (closed / open / half-open), backed by a Durable Object.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/circuit/:name/status` | Current breaker state for a named service. |
| POST | `/api/circuit/:name/reset` | Manually close the breaker (audit-logged). |

## Stats

`/api/stats`. Aggregated dashboard metrics.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/stats` | Execution volume, duration, per-workflow breakdown, and recent failures. |

`?window=<days>` sets the lookback (1 to 30, default 7). The response includes a `summary` (totals, success rate, average and p95 duration), `by_day`, `by_workflow`, and `recent_failures`.

## Config warnings

`/api/config-warnings`. Proactive configuration audit (for example, node timeouts set below the type's known floor).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/config-warnings` | List configuration warnings for your org's live workflows. |

## Field coverage

`/api/field-coverage`. Coverage manifest for the silent-output-field detector: what fields it watches per workflow (each field's source and current health), the code nodes it cannot statically read, and the author-set silences (fields legitimately allowed to be empty). The manifest reports presence rates and booleans only, never resolved field values. Silences set here make the detector skip those fields.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/field-coverage/:workflowId` | Manifest: watched fields (path, source, health), unreadable nodes, and silences. |
| POST | `/api/field-coverage/:workflowId/silence` | Silence a field. Body `{ field, reason }`; reason is required. |
| DELETE | `/api/field-coverage/:workflowId/silence` | Clear a field's silence. Body `{ field }`. |

## Settings

`/api/settings`. Org-level settings. Currently the Anthropic API key used to draft changelog summaries on save.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/settings/anthropic-key` | Whether an Anthropic key is configured (value masked). |
| PUT | `/api/settings/anthropic-key` | Set or replace the Anthropic key. |
| DELETE | `/api/settings/anthropic-key` | Remove the Anthropic key. |

## Access (user allowlist)

`/api/access`. Manages which email addresses may sign in. Only `@trypennie.com` addresses are permitted.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/access` | List allowed emails. |
| POST | `/api/access` | Add an email to the allowlist. |
| DELETE | `/api/access/:email` | Remove an email from the allowlist. |

## Service presets

`/api/service-presets`. Reusable per-service field-mapping presets for the Integration node.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/service-presets` | List presets. |
| POST | `/api/service-presets` | Create a preset. |
| PUT | `/api/service-presets/:id` | Update a preset. |
| DELETE | `/api/service-presets/:id` | Delete a preset. |

## Folders

`/api/folders` (workflows) and `/api/env-folders` (environment variables). Organizational folders within your org. Both follow the same shape.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/folders` | List workflow folders. |
| POST | `/api/folders` | Create a workflow folder. |
| PATCH | `/api/folders/:id` | Rename or re-parent a folder. |
| DELETE | `/api/folders/:id` | Delete a folder. |
| GET | `/api/env-folders` | List environment-variable folders. |
| POST | `/api/env-folders` | Create one. |
| PATCH | `/api/env-folders/:id` | Update one. |
| DELETE | `/api/env-folders/:id` | Delete one. |

## Audit log

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/audit-log` | List recent mutations for your org (most recent first, max 200). |

Query params: `entity_type` (filter), `from`, `to` (ISO timestamps bounding `changed_at`).

## Admin

`/api/admin`. Operational maintenance routes. Still JWT-authenticated and org-scoped.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/admin/migrate-code-workers` | Redeploy Code node bundles for the org's workflows. |
| POST | `/api/admin/backfill-sightings` | Backfill the `persons` / lead-sightings tables. |
| POST | `/api/admin/run-export-now` | Trigger the nightly Snowflake export immediately. |
| GET | `/api/admin/buyer-select/parity` | The Stage A parity rows for the org's workflows: per Eastern day, the buyer_select node's decisions counted against the incumbent seller's, with `window_complete`, `counts_hash`, `unmeasured`, `refusal_counts` (buyers refused before a call, by reason: the four caps, the budget deadlines, cap_check_error, breaker_unreadable, circuit_open) and any sign off. Reads only. |
| POST | `/api/admin/buyer-select/parity/refresh` | Recompute the parity rows for today and yesterday, or one named day of any age (body: optional `workflow_id`, `day`). Writes the counts and their hash; never sets a sign off, and clears one whose numbers moved. |
| POST | `/api/admin/buyer-select/parity/:workflow_id/:day/sign-off` | Sign off one day against the `counts_hash` you saw (body: `counts_hash`, `note`). 409 `counts_changed` when a refresh has moved the numbers since. |

## See also

- [Webhook contract](./webhook-contract.md) - how to trigger a workflow over HTTP.
- [Triggers and endpoints](../concepts/triggers-and-endpoints.md) - generic webhooks vs. custom endpoints.
- [Environment variables and secrets](../guides/environment-variables-and-secrets.md).
- [Data references](../concepts/data-references.md) - the `steps.*`, `trigger.*`, `env.*` syntax used in workflows.
