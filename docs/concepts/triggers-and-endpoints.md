# Triggers and Endpoints

Every Bidspoke workflow is started by an HTTP request. There are two ways to invoke one: the generic webhook URL keyed by workflow id, and a custom endpoint mapped to a host and path. This page documents both, the authentication contract, idempotency, and how the `source` name is determined and stamped onto each run.

For what happens after the trigger fires, see [workflows and executions](./workflows-and-executions.md). For the byte-level request/response contract, see [the webhook contract reference](../reference/webhook-contract.md).

## Generic webhook

```text
POST /webhooks/:workflow_id
```

`:workflow_id` is the workflow's `id`. The request body is JSON and becomes the trigger payload (available to nodes as `trigger.payload.*`). The workflow must be **active** or the request returns 404.

Example:

```bash
curl -X POST https://<worker-host>/webhooks/11111111-1111-1111-1111-111111111111 \
  -H "X-API-Key: <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{ "email": "lead@example.com", "country": "US" }'
```

The generic webhook always requires API key auth and additionally enforces source-to-workflow assignment (see [Source identification](#source-identification-and-source_name)).

## Custom endpoints

Custom endpoints let partners post to a friendlier, partner-specific URL on the `hook.trypennie.dev` host instead of a raw workflow id. They are stored as `webhook_endpoints` rows that map a `subdomain` + `path` to a workflow and a `source_name`.

```text
POST https://hook.trypennie.dev/<subdomain>/<path>
```

The first path segment is the `subdomain` slug; the rest is the `path`. For example `POST https://hook.trypennie.dev/tripoint/bidding` looks up the endpoint with `subdomain='tripoint'` and `path='/bidding'`, then runs the mapped workflow with `source` set to that endpoint's `source_name`. A single-segment URL such as `hook.trypennie.dev/rml` maps to `subdomain='rml'`, `path='/'`.

Behavior:

- **`GET`** on any custom-endpoint URL returns `{ "ok": true }` (a health check partners can use to confirm the endpoint is live). **`POST`** runs the workflow. Other methods return 405.
- Endpoint records are cached in KV for 60 seconds, so changes to an endpoint can take up to a minute to take effect.
- An inactive endpoint returns 404.
- Custom endpoints are self-granting: they do not run the source-to-workflow assignment check (the mapping itself is the grant).

To test a custom endpoint locally, spoof the host header:

```bash
curl -X POST http://localhost:8787/tripoint/bidding \
  -H "Host: hook.trypennie.dev" \
  -H "X-API-Key: <your-api-key>" \
  -d '{ "lead_id": "abc" }'
```

## Authentication

### API key (`X-API-Key`)

Both the generic webhook and custom endpoints authenticate with an `X-API-Key` header by default. The platform holds a map of API key to source name. On each request:

- A missing `X-API-Key` returns 401.
- A key not present in the map returns 401.
- A valid key resolves to a `source` name, which is attached to the run.

For the generic webhook, auth is always required. For a custom endpoint, auth is required unless the mapped workflow's `trigger.config.auth_method` is `"none"`, in which case the key check is skipped for that endpoint.

### Token auth (`auth_mode`)

A token-based auth mode (`auth_mode: 'api_key' | 'token'` on endpoints, with a token-issuing route) is planned but not yet shipped. Until it lands, the live contract is API key auth as described above. Do not assume a token flow exists.

## Idempotency

Idempotency prevents the same lead from being processed twice (which would, for example, fire duplicate partner bids). It is opt-in per workflow via `trigger.config.idempotency` (see [the schema](./workflow-definition-schema.md#trigger)).

When idempotency is enabled, the engine derives a key for the request:

- If the caller sends an `X-Idempotency-Key` header, that value is the key.
- Otherwise, if `derive_from_fields` is configured, the key is derived by hashing those payload fields.

Behavior for a given key within its TTL (default 300 seconds, floored at 60):

- **First request**: runs normally; its response is cached against the key.
- **Duplicate after completion**: returns the cached response with the header `X-Idempotent-Replay: true` (the workflow does not run again).
- **Duplicate while the first is still in flight**: returns HTTP 409 with `{ "error": "Duplicate request in progress" }`.

If idempotency is not enabled, every request runs and no replay header is sent.

## Source identification and `source_name`

Every run is stamped with a `source` string that says where it came from. It is available to nodes and conditions as `trigger.source`, and it appears on the execution record.

- **Generic webhook**: the `source` is the source name mapped to the request's API key.
- **Custom endpoint**: the `source` is the endpoint's configured `source_name` (a passthrough label, independent of which API key was used).

### Source-to-workflow assignment (generic webhook only)

On the generic webhook, after resolving the source, the engine enforces source-to-workflow assignment:

- If there are no assignment rows for this source in the org, the source is unrestricted and any workflow is allowed.
- If any assignment rows exist for the source, it is locked to exactly those workflows. A request to a workflow the source is not assigned to returns 403.

Custom endpoints skip this check.

## Response headers

Every triggered run returns:

- `X-Trace-Id`: the run's trace id, for correlating with logs and execution detail.
- `X-Idempotent-Replay: true`: only on an idempotent replay of a completed run.

The response body and status are whatever the workflow's terminating node (a [response node](../nodes/response.md), an [exit node](../nodes/exit.md), or an early code-node response) produced. A workflow with no explicit response node returns the last node's output with status 200.

## See also

- [Workflows and executions](./workflows-and-executions.md) - what happens after the trigger fires.
- [Workflow definition schema](./workflow-definition-schema.md) - the `trigger` config, including idempotency and `auth_method`.
- [Webhook contract reference](../reference/webhook-contract.md) - the exact request/response contract.
- [API reference](../reference/api.md) - managing workflows, endpoints, and sources.
- [Response node](../nodes/response.md) - shaping the HTTP response.
