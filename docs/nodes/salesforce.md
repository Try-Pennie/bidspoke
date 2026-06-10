# Salesforce node

Reads from and writes to Salesforce through its REST API as a workflow step. Handles OAuth token acquisition for you and supports create, update, upsert, query, and Apex REST operations, with first-class handling for Salesforce dedup validation errors.

## Purpose

The Salesforce node calls the Salesforce REST API (v60.0). It obtains an access token via the Client Credentials OAuth flow, caches the token, and then runs your chosen operation against the target object. Body, record IDs, external ID values, and SOQL are all template-enabled, so you can build the request from the trigger payload and upstream step outputs. See [data references](../concepts/data-references.md).

A common pattern is treating a Salesforce dedup/validation rejection as an expected business outcome rather than a failed run. The `expected_errors` config does exactly that (see Expected errors below).

## Required environment variables

The node needs these env vars (Bidspoke env vars or Cloudflare secrets). It throws if any are missing:

| Variable | Description |
|----------|-------------|
| `SALESFORCE_INSTANCE_URL` | Your instance, for example `https://trypennie.my.salesforce.com`. |
| `SALESFORCE_CLIENT_ID` | Connected app client ID. |
| `SALESFORCE_CLIENT_SECRET` | Connected app client secret. |

The access token is cached for about 58 minutes. On a `401` the cached token is evicted so the next attempt re-authenticates.

## Config schema

`node.config`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `operation` | string | Yes | `create` | One of `create`, `update`, `upsert`, `query`, `apex`. |
| `object` | string | For create/update/upsert | none | SObject API name, for example `Prospect__c`. Not used for `query` or `apex`. |
| `body` | any | For create/update/upsert/apex | none | Request body. Template-enabled JSON. |
| `record_id` | string | For `update` | none | Salesforce record ID to update. Template-enabled. |
| `external_id_field` | string | For `upsert` | none | External ID field API name. |
| `external_id_value` | string | For `upsert` | none | External ID value. Template-enabled. |
| `soql` | string | For `query` | none | SOQL query string. Template-enabled. |
| `apex_path` | string | For `apex` | none | Relative Apex REST path, for example `/services/apexrest/prospect-trades`. |
| `injected_fields` | object | No | none | Map of SF field name to template value, merged into `body`. Overrides `body` on key collision. Resolved per run. Handy for `{{execution.bidspoke_link}}`. |
| `expected_errors` | array | No | none | SF rejections to treat as a business outcome, not a failure (see below). |
| `transient_errors` | array | No | SF concurrency-limit entry | SF errors to retry despite a 4xx status (see below). |

Standard node-config fields (`timeout_ms`, `retries`, `retry_backoff`, `on_error`, `fallback_node`) also apply. The HTTP request itself uses a fixed 15-second timeout. See [workflow definition schema](../concepts/workflow-definition-schema.md).

### Operations

| Operation | Method | Endpoint built |
|-----------|--------|----------------|
| `create` | POST | `/services/data/v60.0/sobjects/<object>` |
| `update` | PATCH | `/services/data/v60.0/sobjects/<object>/<record_id>` |
| `upsert` | PATCH | `/services/data/v60.0/sobjects/<object>/<external_id_field>/<external_id_value>` |
| `query` | GET | `/services/data/v60.0/query?q=<soql>` |
| `apex` | POST | `<apex_path>` |

The config panel offers object and field dropdowns sourced from synced Salesforce schema metadata when a connection's schema is cached, so you can pick the SObject and see its fields while building the body.

### Expected errors

`expected_errors` lists SF rejections that should not fail the run. Each entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Salesforce `errorCode` to match, for example `DUPLICATE_VALUE` or `FIELD_CUSTOM_VALIDATION_EXCEPTION`. |
| `message_contains` | string | No | Optional substring the SF error message must contain. Omit to match on `code` alone. |
| `response_body` | any | No | Template-enabled body returned to the caller instead of the raw SF error. |
| `response_status` | number | No | HTTP status for `response_body`. Defaults to `200`. |

When an SF error matches, the step is marked completed (not failed) and the workflow exits at this node. If `response_body` is set, that body is returned to the original caller; otherwise the run simply exits. This is the standard dedup pattern: a duplicate is a normal outcome, so the lead is rejected cleanly instead of erroring.

### Transient errors

By default the engine retries only `429` and `5xx`. `transient_errors` opts specific SF `errorCode`s back into retry even on a 4xx. Each entry is `{ code, message_contains? }`, matched the same way as `expected_errors`. New Salesforce nodes are pre-populated with one entry, `{ code: "REQUEST_LIMIT_EXCEEDED", message_contains: "Concurrent" }`, because SF concurrency limits return a 403 but clear within seconds. Clearing the list (saving an empty array) keeps it empty.

## Output shape

On success:

```json
{
  "status": 201,
  "body": { "id": "0035g00000ABCDE", "success": true, "errors": [] }
}
```

For `update`, Salesforce returns `204 No Content`, so `body` is `null`. For `query`, `body` is the SOQL result envelope (`{ totalSize, done, records }`). Read downstream as `steps.<namespace>.output.body.id`, `steps.<namespace>.output.body.records`, etc.

When an `expected_errors` entry matches, the output is `{ status, ok: false, errorCode, message, body }` and the run exits at this node.

On an unmatched non-2xx, the node throws and the engine classifies the error (transient vs permanent) and applies retry / fallback per the node's settings.

## Edges

The Salesforce node has a single outgoing edge. On success the workflow continues to the next node. On an expected-error match the run exits here. On an unhandled error the engine applies retry / fallback / error handling.

## Example

Create a prospect, treating a duplicate as a clean rejection with a custom response.

```json
{
  "id": "n_create_prospect",
  "namespace": "create_prospect",
  "type": "salesforce",
  "label": "Create prospect",
  "config": {
    "operation": "create",
    "object": "Prospect__c",
    "body": {
      "Email__c": "{{trigger.payload.email}}",
      "FirstName__c": "{{trigger.payload.first_name}}",
      "LastName__c": "{{trigger.payload.last_name}}",
      "LoanAmount__c": "{{steps.parse_lead.output.amount}}"
    },
    "injected_fields": {
      "Bidspoke_Run_Link__c": "{{execution.bidspoke_link}}"
    },
    "expected_errors": [
      {
        "code": "DUPLICATE_VALUE",
        "message_contains": "Email",
        "response_status": 200,
        "response_body": { "status": "duplicate", "message": "Lead already exists" }
      }
    ],
    "transient_errors": [
      { "code": "REQUEST_LIMIT_EXCEEDED", "message_contains": "Concurrent" }
    ]
  }
}
```

An upsert keyed on an external ID:

```json
{
  "id": "n_upsert",
  "namespace": "upsert_account",
  "type": "salesforce",
  "config": {
    "operation": "upsert",
    "object": "Account",
    "external_id_field": "External_Id__c",
    "external_id_value": "{{trigger.payload.account_ref}}",
    "body": { "Name": "{{trigger.payload.company}}" }
  }
}
```

## See also

- [Webhook node](./webhook.md)
- [Code node](./code.md)
- [Data references](../concepts/data-references.md)
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
