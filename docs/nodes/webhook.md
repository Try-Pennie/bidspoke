# Webhook node

Makes an outbound HTTP request to an external service as a workflow step. Use it for credit pulls, eligibility checks, partner APIs, or any REST endpoint that is not Salesforce. Its node `type` is `webhook` and it is labeled "Webhook" in the node palette. The PRD and some older material call it the Integration node, or the HTTP node. They all refer to this node.

## Purpose

The Webhook node sends a templated HTTP request and returns the response. It is service-aware: picking a service (Equifax, Eligibility Scout, LendSwift, Salesforce, or Custom) sets sensible auth defaults, and for services with a synced schema (Salesforce, Supabase, Snowflake) the config panel offers object and field dropdowns drawn from cached schema metadata to help you build the request body.

All URL, header, body, and auth fields are template-enabled, so you can interpolate values from the trigger payload, upstream steps, and environment variables. See [data references](../concepts/data-references.md).

For structured Salesforce operations (create / update / upsert / query / apex) prefer the dedicated [Salesforce node](./salesforce.md), which handles OAuth and dedup. Use the Integration node for plain HTTP.

## Config schema

`node.config` (the node type is `webhook`):

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | none | Request URL. Template-enabled, for example `{{env.EQUIFAX_URL}}` or a literal. Must resolve to a non-empty string. |
| `method` | string | No | `POST` | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`. Case-insensitive. |
| `headers` | object | No | none | Map of header name to value. Values are template-enabled. `Content-Type: application/json` and `X-Trace-Id` are always added. |
| `body` | any | No | none | Request body. Template-enabled JSON. Skipped for `GET` and `HEAD`. Objects are JSON-stringified; strings are sent as-is. |
| `auth` | object | No | `{ type: 'none' }` | Auth config (see below). |
| `service` | string | No | none | Service preset label. One of `equifax`, `eligibility_scout`, `lendswift`, `salesforce`, `custom`. Affects UI defaults only. |
| `action` | string | No | none | Display label, also used in circuit-breaker naming. |
| `timeout_ms` | number | No | `15000` | Request timeout in milliseconds. The request aborts if exceeded. |

Standard node-config fields (`retries`, `retry_backoff`, `on_error`, `fallback_node`) also apply. See [workflow definition schema](../concepts/workflow-definition-schema.md).

### Auth

`config.auth` selects how credentials are attached. Reference secrets via `{{env.SECRET_NAME}}` rather than pasting literals.

| `auth.type` | Fields used | Result |
|-------------|-------------|--------|
| `none` | (none) | No auth header. |
| `bearer` | `token` | Adds `Authorization: Bearer <token>`. |
| `basic` | `username`, `password` | Adds `Authorization: Basic <base64(user:pass)>`. |
| `api_key` | `key`, `header` | Adds `<header>: <key>`. `header` defaults to `X-API-Key`. |

All auth field values are template-enabled.

## Output shape

On a 2xx response the node output is:

```json
{
  "status": 200,
  "body": { "...": "parsed JSON, or the raw text if not JSON" },
  "headers": { "content-type": "application/json" }
}
```

Read it downstream as `steps.<namespace>.output.status`, `steps.<namespace>.output.body.<field>`, etc.

On a non-2xx response the node does not produce this output. It throws the HTTP response so the engine can classify the error (transient vs permanent) and apply retry or fallback per the node's `on_error` and `retries` settings.

## Edges

The Integration node has a single outgoing edge. On success the workflow continues to the next node. On a non-2xx error the node fails and the engine applies its retry / fallback / error handling.

## Example

A POST to an eligibility service with bearer auth and a templated body.

```json
{
  "id": "n_elig",
  "namespace": "eligibility_check",
  "type": "webhook",
  "label": "Eligibility Scout",
  "config": {
    "service": "eligibility_scout",
    "action": "check_eligibility",
    "method": "POST",
    "url": "{{env.ELIGIBILITY_SCOUT_URL}}/v1/check",
    "headers": {
      "X-Partner-Id": "{{env.ELIGIBILITY_PARTNER_ID}}"
    },
    "auth": {
      "type": "bearer",
      "token": "{{env.ELIGIBILITY_SCOUT_TOKEN}}"
    },
    "body": {
      "ssn": "{{trigger.payload.ssn}}",
      "state": "{{trigger.payload.state}}",
      "loan_amount": "{{steps.parse_lead.output.amount}}"
    },
    "timeout_ms": 10000
  }
}
```

## See also

- [Salesforce node](./salesforce.md)
- [Code node](./code.md)
- [Data references](../concepts/data-references.md)
- [Workflow definition schema](../concepts/workflow-definition-schema.md)
