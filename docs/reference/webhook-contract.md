# Webhook contract

The exact HTTP contract for triggering a Bidspoke workflow: the URLs, required headers, request body, success and error responses, and idempotency behavior. This is the data-plane contract that external systems (lead providers, partner pings, your own forms) call. To manage workflows, use the [management API](./api.md) instead.

For the concepts behind the two trigger styles, see [triggers and endpoints](../concepts/triggers-and-endpoints.md).

## Two ways to trigger a workflow

There are two endpoints that run a workflow over HTTP. They share the same body, idempotency, and response rules.

| Style | URL | Auth |
|-------|-----|------|
| Generic webhook | `POST https://bidspoke.trypennie.dev/webhooks/:workflow_id` | `X-API-Key` |
| Custom endpoint | `POST https://hook.trypennie.dev/:subdomain[/:path]` | `X-API-Key` (or none, if the trigger opts out) |

A generic webhook addresses a workflow directly by its UUID. A custom endpoint maps a friendly subdomain and path (for example `hook.trypennie.dev/tripoint/bidding`) to a workflow and a source name. You create custom endpoints with the [endpoints API](./api.md#endpoints-custom-webhook-endpoints). Both run the same engine and obey the same contract below.

Only `POST` triggers a workflow. A `GET` to a custom endpoint returns `{ "ok": true }` as a liveness check for partners. The generic webhook route only accepts `POST`.

## Authentication

### Generic webhook: X-API-Key

Pass an API key in the `X-API-Key` header. The key maps to a source name, which is recorded on the execution as `source` and is available to the workflow as `trigger.source`. Create keys with the [sources API](./api.md#sources).

```
X-API-Key: 9a1f...e4c2
```

A missing `X-API-Key` returns `401`. An unrecognized key returns `401`.

If the source has been assigned to specific workflows (source-to-workflow scoping), a key that is not assigned to the target workflow is rejected with `403`. A source with no assignments can trigger any workflow.

### Custom endpoint: X-API-Key, or none

Custom endpoints require the same `X-API-Key` by default. A custom endpoint can opt out of key auth if its workflow's trigger config sets `auth_method: 'none'`, in which case no key is required. Use that only for sources that cannot send a header. When auth is required, a missing key returns `401` and an invalid key returns `401`.

## Request body

The body must be valid JSON. Whatever you send becomes `trigger.payload` inside the workflow, unchanged. There is no required schema. Nodes read fields with [data references](../concepts/data-references.md) like `trigger.payload.email`.

```
Content-Type: application/json
```

A body that is not valid JSON returns `400` with `{ "error": "Invalid JSON body" }`.

### Optional headers

| Header | Purpose |
|--------|---------|
| `X-API-Key` | Source authentication (see above). |
| `X-Idempotency-Key` | Explicit idempotency key for the request (see [Idempotency](#idempotency)). |
| `traceparent` | W3C trace context; logged and propagated to outbound partner calls. |

## Success response

On success the engine returns `200`. The response body is whatever the workflow produces:

- If the workflow ran a [Response node](../nodes/response.md), the status code, headers, and body are exactly what that node configured. A non-JSON `Content-Type` set by the Response node is honored and the body is sent as-is.
- If no Response node ran, the body is the engine's default result object.

Every response carries the trace ID header:

| Header | Meaning |
|--------|---------|
| `X-Trace-Id` | The execution's trace ID. Use it to find the run in the dashboard and across logs. |
| `X-Idempotent-Replay` | Present and set to `true` only when this response was served from an idempotency cache (see below). |

## Idempotency

Idempotency is opt-in per workflow, configured on the workflow's trigger. When it is enabled, Bidspoke deduplicates repeat requests so the same logical event runs once.

The idempotency key is resolved in this order:

1. The `X-Idempotency-Key` request header, if present.
2. Otherwise, a key derived from configured payload fields (`derive_from_fields` on the trigger), if set.

Behavior for a given key:

- First request: runs normally. While it is in flight the key is marked `processing`.
- A duplicate that arrives while the first is still `processing`: returns `409` with `{ "error": "Duplicate request in progress" }`.
- A duplicate that arrives after the first completed: returns the cached response with `200` and the `X-Idempotent-Replay: true` header. The workflow does not run again.

The cache entry lives for the trigger's configured `ttl_seconds` (minimum 60 seconds; default 300 if unset). After it expires, the same key runs fresh.

If idempotency is not enabled on the workflow, every request runs and no deduplication occurs.

## Error responses

| Status | When | Body |
|--------|------|------|
| `400` | Body is not valid JSON. | `{ "error": "Invalid JSON body" }` |
| `401` | Missing `X-API-Key`. | `{ "error": "Missing X-API-Key header" }` |
| `401` | Invalid `X-API-Key`. | `{ "error": "Invalid API key" }` |
| `403` | Source not authorized for this workflow (generic webhook only). | `{ "error": "..." }` |
| `404` | Unknown or inactive workflow; unknown or inactive custom endpoint. | `{ "error": "Endpoint not found" }` or `{ "error": "..." }` |
| `409` | Idempotency race: a duplicate arrived while the first request is still in flight. | `{ "error": "Duplicate request in progress" }` |
| `500` | Unhandled engine or upstream error. | `{ "error": "..." }` |

Note that a workflow's own [Response node](../nodes/response.md) can deliberately return any status code (for example a `400` rejection or a `200` offer). Those are workflow-shaped responses, not transport errors, and carry `X-Trace-Id`.

## Examples

### Basic trigger (generic webhook)

```bash
curl -X POST https://bidspoke.trypennie.dev/webhooks/8f3c2b10-... \
  -H "X-API-Key: 9a1f...e4c2" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "lead@example.com",
    "credit_score": 700,
    "loan_amount": 15000
  }'
```

A successful run with a Response node that returns an offer:

```
HTTP/1.1 200 OK
X-Trace-Id: 3Edhkz0pQ...
Content-Type: application/json

{ "decision": "offer", "partner": "tripoint", "bid": 42.50 }
```

### Basic trigger (custom endpoint)

```bash
curl -X POST https://hook.trypennie.dev/tripoint/bidding \
  -H "X-API-Key: 9a1f...e4c2" \
  -H "Content-Type: application/json" \
  -d '{ "email": "lead@example.com", "credit_score": 700 }'
```

### Idempotent retry

Send the same `X-Idempotency-Key` twice against a workflow with idempotency enabled. The first call runs; the second returns the cached response and the replay header. (You can also let the workflow derive the key from payload fields and omit the header entirely.)

```bash
# First request: runs the workflow
curl -X POST https://bidspoke.trypennie.dev/webhooks/8f3c2b10-... \
  -H "X-API-Key: 9a1f...e4c2" \
  -H "X-Idempotency-Key: lead-2026-06-09-0001" \
  -H "Content-Type: application/json" \
  -d '{ "email": "lead@example.com" }'

# Same key again, after the first completed: returns the cached response
curl -i -X POST https://bidspoke.trypennie.dev/webhooks/8f3c2b10-... \
  -H "X-API-Key: 9a1f...e4c2" \
  -H "X-Idempotency-Key: lead-2026-06-09-0001" \
  -H "Content-Type: application/json" \
  -d '{ "email": "lead@example.com" }'
```

The second response:

```
HTTP/1.1 200 OK
X-Trace-Id: 3Edhkz0pQ...
X-Idempotent-Replay: true
Content-Type: application/json

{ "decision": "offer", "partner": "tripoint", "bid": 42.50 }
```

If the second request arrives while the first is still running, you get `409` instead:

```
HTTP/1.1 409 Conflict

{ "error": "Duplicate request in progress" }
```

### Failed authentication

No key:

```bash
curl -i -X POST https://bidspoke.trypennie.dev/webhooks/8f3c2b10-... \
  -H "Content-Type: application/json" \
  -d '{ "email": "lead@example.com" }'
```

```
HTTP/1.1 401 Unauthorized

{ "error": "Missing X-API-Key header" }
```

Wrong key:

```
HTTP/1.1 401 Unauthorized

{ "error": "Invalid API key" }
```

## See also

- [Triggers and endpoints](../concepts/triggers-and-endpoints.md) - choosing between generic webhooks and custom endpoints.
- [Management API reference](./api.md) - creating workflows, sources, and endpoints.
- [Response node](../nodes/response.md) - how a workflow shapes its HTTP response.
- [Data references](../concepts/data-references.md) - reading `trigger.payload.*` inside a workflow.
