# Error handling

How Bidspoke classifies, retries, and surfaces errors: the error categories, per-step retry and timeout config, per-step `on_error` and `fallback_node`, per-partner response classification overrides, alert configuration, and how to resume or replay a failed run. Everything here reflects the engine's actual behavior.

For the execution model these errors live inside, see [Workflows and executions](../concepts/workflows-and-executions.md). For monitoring and reading failures, see [Observability](./observability.md). For partner-specific behavior, see [Partners](../reference/partners.md).

## Error categories

Bidspoke distinguishes two error types and one separate outcome:

- `transient` - likely to succeed on retry (network failures, timeouts, DNS errors, and HTTP `429`, `502`, `503`, `504`). The engine retries these.
- `permanent` - will not succeed on retry (other `4xx` responses, and anything unrecognized). The engine does not retry these. Unknowns default to `permanent` so retries are not wasted.
- Business rejection - the upstream succeeded but declined the lead (for example a partner returns a rejection code in a `200` body). This is not an error; it routes the lead down the appropriate path (such as a Partner Bid's reject/no-bid outcome) and is logged rather than throwing. See [Per-partner response classification](#per-partner-response-classification-overrides).

The error type stored on a step is `transient`, `permanent`, or `null` (no error). It drives retry behavior, the Slack failure alert label, and per-partner alert suppression.

### Default classification rules

| Condition | Classified as |
|-----------|---------------|
| HTTP `429`, `502`, `503`, `504` | `transient` |
| Any other HTTP `>= 400` | `permanent` |
| Network error, timeout, DNS failure | `transient` |
| Error explicitly marked `permanent: true` (e.g. a Branch node whose `else` edge is set to error) | `permanent` |
| Unrecognized | `permanent` |

## Per-step retry, backoff, and timeout

Every step runs through a retry wrapper. Only `transient` errors are retried; a `permanent` error throws immediately. These are read from the node's `config`:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `retries` | number | No | `2` | Number of retries after the first attempt. `0` means a single attempt. Total attempts are `retries + 1`. |
| `retry_backoff` | `"linear"` \| `"exponential"` | No | `"exponential"` | Delay growth between retries. |
| `timeout_ms` | number | No | `30000` | Per-attempt timeout. An attempt that exceeds this is aborted and treated as a `transient` timeout error. |

Backoff timing (base `500ms`):

- `exponential`: `500ms`, `1s`, `2s`, ... (`500 * 2^attempt`)
- `linear`: `500ms`, `1s`, `1.5s`, ... (`500 * (attempt + 1)`)

The retries actually consumed are recorded on the step (`retries_used`) and shown in the Slack failure alert when greater than 0. `0` means the step succeeded on its first attempt or failed permanently before any retry.

Some node types enforce a minimum reliable `timeout_ms` (a node-type floor). Setting `timeout_ms` below that floor causes the step to time out before its work even starts on a cold run, failing on every retry. The config panel suggests a sensible timeout, and the daily config audit alerts on sub-floor timeouts (see the Timeout Below Reliable Minimum alert in [Observability](./observability.md)).

## Per-step on_error and fallback_node

When a step fails (after retries are exhausted), the engine reads `node.config.on_error` to decide what happens next:

| `on_error` | Behavior |
|------------|----------|
| `"fail"` (default) | The step is marked `failed` and the whole execution fails. |
| `"skip"` | The step is marked `skipped`, no error is raised, and the engine continues to the next node. |
| `"fallback"` | The step is marked `failed_with_fallback`, and the engine jumps to the node named in `fallback_node` instead of failing. If `fallback_node` is not found, the execution errors. |

`fallback_node` is the `namespace` (id) of another node in the same workflow. It is only used when `on_error` is `"fallback"`.

### Example: retry with timeout and a fallback

This Integration node retries transient failures three times with exponential backoff and a 10-second per-attempt timeout. If it still fails, the engine routes to the `notify_ops` node instead of failing the run.

```json
{
  "namespace": "enrich_lead",
  "type": "integration",
  "config": {
    "service": "salesforce",
    "retries": 3,
    "retry_backoff": "exponential",
    "timeout_ms": 10000,
    "on_error": "fallback",
    "fallback_node": "notify_ops"
  }
}
```

To instead skip a non-critical step and keep going, set `"on_error": "skip"` and omit `fallback_node`.

## Per-partner response classification overrides

By default, partner responses are classified by the rules above. A partner can override this with a `response_classification` config (stored on the partner, `partner_configs.response_classification`) so a specific signal is reclassified. This is how you teach the engine that a partner's `200`-with-a-code response is actually a rejection, or that a particular status is transient even though it is `4xx`.

The config has three optional lists, evaluated in this order: rejection signals first, then transient, then permanent. The first match wins; if nothing matches, the defaults apply.

```json
{
  "response_classification": {
    "rejection_signals": [
      { "field": "data.createLead.resultCode", "in": ["3001", "3002"] }
    ],
    "transient_signals": [
      { "status_code": 409 }
    ],
    "permanent_signals": [
      { "status_code": 422, "body_field": "error.code", "equals": "INVALID_SSN" }
    ]
  }
}
```

### Rejection signals

Body-only checks (the HTTP status is ignored). A match classifies the response as a business rejection, routing the lead down the reject path instead of throwing.

| Field | Type | Description |
|-------|------|-------------|
| `field` | string | Body field to read. Dot-path supported, e.g. `data.createLead.resultCode`. |
| `equals` | any | Loose-equality match (a numeric `1000` matches the string `"1000"`). |
| `contains` | string | Substring match (string fields only). |
| `in` | array | Value is loosely in this list. |
| `not_in` | array | Value is present and loosely not in this list. |
| `present` | boolean | `true`: field exists; `false`: field is absent. |

### Transient and permanent signals

Status-aware checks. A match classifies the error as `transient` or `permanent` respectively.

| Field | Type | Description |
|-------|------|-------------|
| `status_code` | number | HTTP status to match. If omitted, matches any status. |
| `body_field` | string | Body field to inspect (dot-path supported). |
| `header` | string | Response header to check (matched case-insensitively). |
| `equals` / `contains` / `in` / `not_in` / `present` | - | Same semantics as rejection signals, applied to `body_field` or `header`. |

All value comparisons use loose equality, coercing numbers and booleans to and from their string forms in both directions, so a partner's numeric `resultCode` matches a string entered in config and vice versa.

## Alert configuration

Failure alerts fire to Slack when an execution fails (see [Observability](./observability.md) for the full alert catalog). You can suppress alerts by error type at the partner level.

A partner's `alert_config` (`partner_configs.alert_config`) controls whether its failures alert:

```json
{
  "alert_config": {
    "transient_errors": { "alert": false },
    "permanent_errors": { "alert": true }
  }
}
```

- Both keys default to alerting. Omit the config entirely to alert on everything.
- Set `alert` to `false` to suppress that category. The example above stops alerting on transient partner failures (noisy, self-healing) while still alerting on permanent ones.

Per-workflow alert routing is set with the workflow's `slack_channel` override (failure and slow alerts for that workflow post there instead of the org default channel). Org-wide alert toggles for volume-cliff, matrix-change, and timeout-config alerts live on the Integrations page. See [Observability](./observability.md#slack-alerts).

## Resuming or replaying a failed execution

A failed (or partially completed) execution can be re-run two ways. Both create a new execution row linked back to the original via `parent_execution_id`, so the relationship is visible in the [execution detail view](./observability.md#execution-detail-view).

- Resume (`POST /api/executions/:id/resume`) re-runs the workflow but skips steps that already completed on the original run, picking up from where it failed. Completed upstream steps are inherited and shown as completed. For a parallel group, only the incomplete children re-run.
- Replay (`POST /api/executions/:id/replay`) starts a fresh run from the beginning using the original trigger payload. Nothing is skipped.

Both replay the original `trigger_payload`. Both return the new run's `X-Trace-Id` and `X-Execution-Id` headers. Resume is the right tool when an upstream service had a blip and you want to preserve partial results; replay is for re-running the whole thing from scratch.

## See also

- [Observability](./observability.md) - dashboards, logs, trace IDs, and the full alert catalog
- [Workflows and executions](../concepts/workflows-and-executions.md) - statuses, outcomes, resume vs replay
- [Testing and debugging](../guides/testing-and-debugging.md) - running test payloads and inspecting step results
- [Partners](../reference/partners.md) - caps, dedup, circuit breakers, and bid resolution
- [Data references](../concepts/data-references.md) - the `steps.*`, `trigger.*`, `env.*` syntax
