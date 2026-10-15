# Partner Bid node

Requests a bid from a single partner and returns the result. It loads that partner's saved config, runs a fixed sequence of pre-flight checks (circuit breaker, daily cap, dedup), resolves a bid (by formula, matrix lookup, or live API call), classifies the response, and returns a structured outcome. Use it when you want one explicit partner attempt on the canvas.

For the common case of sending one lead to several partners and picking a winner, use the [Bid Group node](./bid-group.md) instead. A Bid Group fans out to N partners internally as a single canvas node, runs the exact same partner-bid logic for each, and picks a winner. Reach for a standalone Partner Bid node only when you need a single partner wired in on its own.

## How a bid is produced

When this node runs it always follows this order. Any step that "skips" returns immediately with a `skip_reason` and no further steps run.

1. **Load partner config.** Reads the partner row identified by `partner_id`. If the partner does not exist, the step throws.
2. **Inactive check.** If the partner is toggled off (`is_active = false`), skip with `partner_inactive`.
3. **Circuit breaker check.** If the partner's circuit breaker is enabled and currently open, skip with `circuit_open`. See [Partners reference: circuit breakers](../reference/partners.md).
4. **Daily cap check.** If the partner has a daily cap and today's count is at or above it, skip with `cap_exceeded`. The cap is enforced per partner per UTC day. See [Partners reference: daily caps](../reference/partners.md).
5. **Dedup check.** If the partner has a dedup endpoint configured, the lead payload is POSTed to it. A duplicate response skips with `duplicate`.
6. **Resolve the bid.** Depending on the partner's resolver type, the bid comes from a formula, a matrix lookup, or a live API call. See [Bid resolution](#bid-resolution).
7. **Classify the response.** A partner can decline the lead (skip with `rejected`), or return a bid below the partner's `min_bid` (skip with `bid_below_min`), or return a usable bid (accepted).
8. **Record the outcome** to the circuit breaker (success or error) and return the result.

Almost everything that drives this node lives on the partner's saved configuration, not on the node. The node config itself is tiny: it just names which partner to query.

## Config schema

The executor reads `node.config` as:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `partner_id` | string (UUID) | Yes | none | The partner to request a bid from. This is the `id` of a partner row, not its slug. In the editor this is the "Partner" dropdown. If missing, the step throws `Partner Bid node is missing required config: partner_id`. |

The editor also writes `partner_name` (the partner's display name) into config for readability. The engine ignores it; only `partner_id` is read.

Everything else that affects the bid (resolver type, formula, matrix, daily cap, min bid, circuit breaker thresholds, dedup endpoint, outbound field mapping, response classification, alert config) is configured on the partner itself in **Partners**, not on this node. See the [Partners reference](../reference/partners.md).

## Bid resolution

The partner's `bid_resolver_type` decides how the bid is produced:

| Resolver | How the bid is found |
|----------|----------------------|
| `formula` | Evaluates the partner's bid formula against the lead. The formula can reference the trigger payload (`debt_amount * 0.65`), earlier step outputs (`steps.eligibility.output.final`), env vars (`env.X`), and Bid-Group-scoped values (`context.finalDebt`). Only references that resolve to a finite number are usable. See [data references](../concepts/data-references.md). |
| `matrix` | Looks up a bid in the partner's bid matrix (a table of rules synced from Salesforce) using fields on the lead such as credit score and debt. The matched row, the config id, and the last sync time are returned in `output.matrix` so the "why no bid?" view can explain the result. |
| `api` | POSTs the lead to the partner's `api_endpoint` and reads the bid out of the response. |

If `bid_resolver_type` is not set on an older partner row, the resolver falls back to: use `api` if the partner has an `api_endpoint`, else `formula` if it has a bid formula, else `api`.

### API resolver specifics

- The outbound request is `POST` with `Content-Type: application/json` and an `X-Trace-Id` header. If the partner has a Cloudflare secret key configured, its value is sent as `Authorization: Bearer <secret>`.
- Before the body is sent, the partner's [outbound field mapping](../reference/partners.md) is applied (rename or reshape fields to match the partner's wire contract). With no mapping, the raw lead payload is sent as-is. Dedup and formula inputs always see the original payload; mapping only changes what goes on the wire.
- The bid is read from the response. By default the resolver scans the top-level fields `bid`, `bid_amount`, `amount`, `price`, `offer` for a number. A partner can set a specific `bid_path` (for example `data.bid`) to read a nested value instead.
- The fetch has a 15-second timeout.
- A partner can declare a `response_classification` that maps certain responses to a rejection or to a transient/permanent error. A response classified as a rejection returns `skip_reason: rejected`. A transient or permanent classification throws (and trips the circuit breaker).
- If the partner responded `2xx` but no bid field could be read, `output.bid_reason` explains why (for example `no recognized bid field in response`), so "no bid" is not confused with a genuine decline.

### Bid mode

A partner stores `bid_mode: 'commit'` (default) or `bid_mode: 'ping_only'`. The node reads it only to copy it into the step's resolved input (the `bid_mode` key of `baseTemplate` in `executePartnerBidNode`, `apps/worker/src/engine/nodes/partner-bid.ts`) and runs the same resolve-and-classify path either way. Ping-only semantics (returning a bid plus a click URL, with conversion handled out of band) are implemented on the partner and its API contract, not branched inside this node. The setting is no longer on the partners page (PM-9, #2136); the column stays until a contract step drops it.

## Output shape

`steps.<id>.output` contains a `PartnerBidOutput`:

```json
{
  "partner": "tripoint",
  "bid": 19.82,
  "accepted": true,
  "skipped": false,
  "status": 200,
  "response_headers": { "content-type": "application/json" },
  "cap_count": 41,
  "resolver_type": "api",
  "raw_response": { "bid": 19.82 },
  "extra": { "leadId": "abc-123" },
  "matrix": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `partner` | string | The partner slug. |
| `bid` | number \| null | The resolved bid amount. `null` when skipped, declined, or no bid could be read. |
| `accepted` | boolean | `true` when a usable bid was returned (`bid` is non-null and not skipped). |
| `skipped` | boolean | `true` when the node short-circuited before or after resolving. |
| `skip_reason` | enum \| absent | Why it skipped. One of `partner_inactive`, `circuit_open`, `cap_exceeded`, `duplicate`, `bid_below_min`, `rejected`. Absent on a clean accept. |
| `status` | number \| null | HTTP status from the partner API. Null/absent for formula and matrix resolvers. (Named `http_status` before 2026-06-11; old executions show the old key.) |
| `response_headers` | object \| null | Partner API response headers, with sensitive headers (`authorization`, `cookie`, `set-cookie`, `proxy-authorization`) stripped. Null for non-API resolvers. |
| `cap_count` | number \| absent | Today's daily-cap count after this request. Absent when the partner has no cap. |
| `resolver_type` | `'formula'` \| `'matrix'` \| `'api'` \| null | Which resolver produced the bid. Used by the execution detail "why no bid?" view. |
| `raw_response` | unknown | The raw partner API response body (API resolver only). |
| `extra` | object \| absent | Partner-specific extracted values (for example `clickUrl`, `leadId`, classifier outputs), configured via the partner's extraction config. |
| `matrix` | object \| null | Present for the matrix resolver. Carries `config_id`, `matched_row_id`, `last_synced_at`, `is_sell_off`, and a `reason` (for example `no_matching_cell`) so the UI can explain a no-bid without re-running the lookup. |
| `bid_reason` | string \| absent | Why an API resolver returned a null bid despite a `2xx` response (shape drift or a missing `bid_path`). |

### Skip reasons

| `skip_reason` | Meaning |
|---------------|---------|
| `partner_inactive` | The partner is toggled off in **Partners**. Not contacted. |
| `circuit_open` | The partner's circuit breaker is open. Not contacted. |
| `cap_exceeded` | The partner is at its daily cap. Not contacted. |
| `duplicate` | The partner's dedup endpoint flagged the lead as a duplicate. Not contacted further. |
| `bid_below_min` | The partner returned a bid below its configured `min_bid`. |
| `rejected` | The partner declined the lead (a `2xx` response classified as a rejection). |

## Edges and handles

A standalone Partner Bid node has a single outgoing path. The engine continues to the next wired step with the node's output available as `steps.<id>.output`. There is no winner/no-winner branching at this node. To branch on the outcome, follow it with a [Filter](./filter.md) or [Branch](./branch.md) node that tests `steps.<id>.output.accepted` or `steps.<id>.output.bid`, or use a [Bid Group](./bid-group.md) (which has its own `winner` / `no_winner` edges).

## Errors

Pre-flight skips and rejections return normally (the step is not failed). Genuine failures throw and mark the step failed:

- Partner config not found.
- An API call that returns a non-`2xx` status not classified as a rejection.
- An API response classified as `transient` or `permanent` by the partner's response classification.
- A network error or timeout (15s) on the API call.

When the node throws and the circuit breaker is enabled, the failure is recorded to the breaker, which may trip it open. Retry and fallback behavior for a failed step follow the node's standard error handling (retries, `on_error`, `fallback_node`).

## Examples

### Query one partner

```json
{
  "id": "bid_tripoint",
  "namespace": "tripoint_bid",
  "type": "partner_bid",
  "config": {
    "partner_id": "8f3c1a90-2b4d-4e77-9a1c-7e21b0c5d6aa"
  }
}
```

This loads the `8f3c...` partner, runs the pre-flight checks, resolves a bid by that partner's resolver type, and returns a `PartnerBidOutput`. Downstream steps read `steps.tripoint_bid.output.bid` and `steps.tripoint_bid.output.accepted`.

### Gate on the result with a Filter

```json
{
  "id": "filter_has_bid",
  "namespace": "has_bid",
  "type": "filter",
  "config": {
    "operation": "continue_if",
    "condition": {
      "field": "steps.tripoint_bid.output.accepted",
      "operator": "is_true"
    }
  }
}
```

Continues only when the partner returned a usable bid; otherwise routes to the filter's `exit` path.

## See also

- [Bid Group node](./bid-group.md) for the primary "bid to N partners, pick a winner" node.
- [Partners reference](../reference/partners.md) for resolver types, the bid matrix, formulas, daily caps, circuit breakers, and outbound field mapping.
- [Bidding model](../concepts/bidding-model.md) for how bids, partners, and winners fit together.
- [Data references](../concepts/data-references.md) for the `trigger.*`, `steps.*`, `env.*`, and `context.*` syntax used in formulas.
