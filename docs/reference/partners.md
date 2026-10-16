# Partner configuration reference

Complete reference for configuring a partner in Bidspoke. A partner is a row in `partner_configs` that the [Partner Bid node](../nodes/partner-bid.md) and [Bid Group node](../nodes/bid-group.md) read at run time to decide whether and how to bid. This page documents every field a partner exposes, how each bid resolver computes a bid, and how caps, circuit breakers, dedup, response classification, and field mapping behave.

For the conceptual picture of where partners fit in a workflow, read [the bidding model](../concepts/bidding-model.md) first.

## Partner type: source vs buyer

Every partner has a `partner_type` of either `source` or `buyer`. This is a segmented toggle at the top of the partner settings page (the "Type" field). It controls which configuration sections apply.

| `partner_type` | Meaning | Sections that apply |
|----------------|---------|---------------------|
| `source` | Sends leads to Pennie. | Identity, Bid confirmation latency, Sell-off offer copy, Sub-account UUIDs. |
| `buyer` | Receives bids and buys leads. | Identity, Bid resolution, Endpoints, Outbound field mapping, Response handling, Bidding limits, Per-sub-account min bids, Circuit breaker, Response classification, Bid confirmation latency, Alert configuration. |

Default is `buyer`. The bidding sections (bid resolution, API, circuit breaker, response classification, alert config) are hidden in the form for source partners because they never receive a bid. Source partners exist mainly to hold sell-off offer copy and the sub-account UUID map that the Constants node reads.

## Identity fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | none | Display name shown in the UI (for example, `Tripoint`). |
| `slug` | string | Yes (on create) | derived from name | Lowercase URL-safe identifier. Used in Durable Object IDs, node configs, and logs. Set once on create and cannot be changed afterward. The API lowercases it and replaces any character outside `[a-z0-9-]` with `-`. |
| `partner_type` | `'source'` \| `'buyer'` | No | `'buyer'` | See [above](#partner-type-source-vs-buyer). |
| `priority` | integer | No | `0` | Sort order in the partner list (buyer only). Lower sorts first. Does not affect bid comparison. |
| `is_active` | boolean | No | `true` | Master on/off switch. When `false`, the Partner Bid node skips this partner with `skip_reason: 'partner_inactive'` for every workflow, globally. Toggling this also drives the Constants node's `activeBidding` map. |

## Bid resolution

A buyer partner produces a bid through one of three resolvers, selected by `bid_resolver_type`. The resolver determines how the Partner Bid node gets a number.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bid_resolver_type` | `'formula'` \| `'matrix'` \| `'api'` | No | `'api'` | How this partner computes a bid. See the sections below. |
| `bid_resolver_config` | JSON object | No | `{}` | Resolver-specific settings (formula string, matrix config ID, pricing tiers, bid path). Shape depends on the resolver type. |
| `bid_formula` | string | No | `null` | Legacy formula field. Read only as a fallback when `bid_resolver_config.formula` is not set. Prefer setting the formula inside `bid_resolver_config`. |
| `bid_comparison_source` | `'auto'` \| `'api'` \| `'formula'` \| `'matrix'` | No | `'auto'` | For an API resolver, controls whether the bid number comes from the partner response (`api`/`auto`) or is computed locally with a formula (`formula`). See [API resolver](#api-resolver). |

If `bid_resolver_type` is unset on an old row, the resolver falls back to legacy precedence: if `api_endpoint` is set, it behaves as `api`; otherwise if `bid_formula` is set, it behaves as `formula`; otherwise `api`.

### Formula resolver

`bid_resolver_type: 'formula'`. The bid is computed by evaluating a formula string against the lead. The formula is read from `bid_resolver_config.formula`, falling back to the legacy `bid_formula` column.

The formula is a JavaScript-style numeric expression. References inside it resolve as follows:

- A bare identifier such as `debt_amount` resolves against `trigger.payload.debt_amount`.
- `trigger.foo.bar` resolves against the trigger.
- `steps.<id>.output.<field>` resolves against a named step's output.
- `env.KEY` resolves against the workflow's environment variables.
- `context.<key>` resolves against Bid Group context values (set by a [Bid Group node](../nodes/bid-group.md) before its partner attempts run).
- `Math` and its common functions (`floor`, `ceil`, `round`, `min`, `max`, `abs`, `sqrt`, `pow`) are available.

Only references that resolve to a finite number (or a numeric string) are usable. If the formula throws or produces a non-finite result, the bid is `null` (no bid).

```text
debt_amount * 0.65
```

```text
finalDebt > 12499 ? finalDebt * steps.constants.output.tripointHi
                  : finalDebt * steps.constants.output.tripointLo
```

The live Tripoint config uses the declarative `tiered_multiplier` form of the same
rule: `default_multiplier` up to `tiers[0].above`, `tiers[0].multiplier` above it.
Salesforce books the revenue for the same leads through the formula behind
`Lead.ExternalRevenue__c`, and the two are edited by hand in two products. A daily
check (`tripoint-pricing-check.ts`, alert name `tripoint-pricing-drift`, 13:00 UTC)
reads that formula through the Tooling API and reports any boundary or multiplier
the two disagree on, and separately refuses when the formula cannot be read or has
changed shape. `POST /api/admin/tripoint-pricing-check` runs it on demand. The one
standing difference it notes without alerting: Salesforce books nothing below
$10,000 of debt, and Bidspoke has no debt floor. Every line is labelled `Main Flow`,
because the same answer carries a second rule under `Engine`: Tripoint's pricing
tiers for the `engine` population on its buyer profile, read through the buyer
profile loader and reported, never compared (ADR 0010). A profile the check cannot
read is a finding of its own, not an absence of tiers.

The same check also compares the three Salesforce formulas that book partner
revenue with each other (#1419): `Lead.ExternalRevenue__c`,
`Submission__c.ExternalRevenue__c` and `Prospect__c.ExternalExchangeRevenue__c`.
Each carries its own copy of every partner's rates, and on 2026-09-30 the Lead copy
priced Tripoint at 0.0012 from $12,500 while the other two used 0.0013. Any partner
paid a rate on debt whose bands or rates differ between the formulas is alerted,
naming what each formula pays (`revenue-formula.ts`). A partner booked only as a
field or as nothing (Engine and AmOne, which the Prospect formula does not book) is
noted without alerting. A formula that cannot be read, or one rewritten into a
shape the check does not know, is its own finding, named for its object.

### Matrix resolver

`bid_resolver_type: 'matrix'`. The bid is looked up from a two-dimensional bid matrix. `bid_resolver_config` must contain:

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `bid_config_id` | string (UUID) | Yes | none | The `partner_bid_configs` row that owns the matrix to use. |
| `use_sell_off` | boolean | No | `false` | When `true`, the lookup uses sell-off rows (`is_sell_off = true`) instead of standard rows. |

See [Bid matrix](#bid-matrix) for how a matrix is defined and synced, and [matched-row logic](#matched-row-logic) for how a cell is selected.

### API resolver

`bid_resolver_type: 'api'`. The Partner Bid node POSTs the lead to the partner's API endpoint and reads the bid from the response.

Behavior:

- The request method is always `POST`, `Content-Type: application/json`, with an `X-Trace-Id` header carrying the execution trace ID.
- If `cf_secret_key` is set and that named Cloudflare secret exists, an `Authorization: Bearer <secret>` header is added.
- The request body is the lead payload, after [outbound field mapping](#outbound-field-mapping) is applied.
- The call times out after 15 seconds.
- By default the bid is read from the first of `bid`, `bid_amount`, `amount`, `price`, or `offer` in the response body that holds a number (or numeric string). To read from a nested path instead, set `bid_resolver_config.bid_path` (for example `data.bid`).
- If `bid_comparison_source` is `'formula'`, the bid is computed locally from the formula instead of read from the response. In that mode, `bid_resolver_config.pricing_mode` can be `'tiered_multiplier'` (a `source_field` value multiplied by the first matching tier's multiplier, or `default_multiplier`) or `'custom'`/unset (the raw formula string).
- If a 2xx response yields no readable bid number, the node returns no bid and sets `bid_reason` (for example `no recognized bid field in response`) so a missing bid is not confused with a real decline.

The response can also be classified and have extra fields pulled out. See [Response classification overrides](#response-classification-overrides) and the partner's `extra_extraction` config.

## Endpoints

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `api_endpoint` | string (URL) | Required for the `api` resolver | `null` | URL the Partner Bid node POSTs the lead to. |
| `cf_secret_key` | string | No | `null` | Name of a Cloudflare Worker secret. Its value is sent as a bearer token on the API call. The secret value itself is never stored in the partner row. |
| `click_url` | string (URL) | No | `null` | Landing page URL for leads routed to this partner. Exposed to the Constants node as `{Slug}ClickUrl`, and carried on the buyer_select sale so a sold lead lands on it. A buyer profile cannot be enabled without one. |
| `external_routing_code` | integer | No | `null` | The `ExternalRoutingCode__c` the Salesforce prospect patch carries for a sale to this buyer (Tripoint's is 2). Carried on the buyer_select sale; a buyer profile cannot be enabled without one. |
| `duplicate_signals` | Signal[] | No | `[]` | Decline answers that mean the buyer already holds the lead. A decline matching any of them is recorded as `Duplicate`, any other decline as `Fail`, an accept as `Success`. Same Signal shape as `accept_signals`. Empty means every decline is `Fail`. |
| `dedup_endpoint` | string (URL) | No | `null` | Optional dedup check called before each bid. See [Dedup](#dedup). |

## Response handling

These apply to the `api` resolver only.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bid_mode` | `'commit'` \| `'ping_only'` | Retired | `'commit'` | Retired (#2182): nothing reads or writes it, and a later migration drops the column. Not on the partners page since PM-9 (#2136). A create, save or page save that names it is refused with `field_not_editable` on `bid_mode`. A read still returns it until the column is dropped. |
| `extra_extraction` | JSON object | No | `null` | Declarative map of extra values to pull from the response. Each key becomes an entry in the node output's `extra`. A value is either a dot-path string into the response body, `{ path: '...' }`, or `{ classifier: '...' }` to run a named classifier (currently `tripoint_result`, which maps a Tripoint `resultCode` to `Success` / `Duplicate` / `Fail`). |
| `last_probe_response` | any | No | `null` | A saved sample response from the partner, used by the editor to help build extraction paths. Not used at run time. |

## Bidding limits

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `daily_cap` | integer | No | `null` (unlimited) | Maximum number of bids to this partner per UTC day. See [Daily caps](#daily-caps). |
| `min_bid` | number | No | `null` | Minimum acceptable bid in dollars. A resolved bid below this is treated as no bid (`skip_reason: 'bid_below_min'`). |

### Per-sub-account min bids

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sub_account_min_bids` | JSON object | No | `null` | Map of sub-account UUID to a per-UUID minimum bid floor. Used by buyers that price differently per referrer. A blank or non-positive value is dropped (it would otherwise bypass the partner-wide `min_bid`). |

The editor renders this as a two-column list of UUID and floor. When a lead arrives with a matching sub-account UUID, the per-UUID floor overrides the partner-wide `min_bid`. Leave empty to use only the partner-wide floor.

## Daily caps

Cap enforcement runs in a Durable Object, one per partner per UTC day, keyed `cap-{slug}-{YYYY-MM-DD}`. Before each bid, the Partner Bid node atomically checks the count against `daily_cap` and increments it if there is room.

- A `null` cap means unlimited; the cap check is skipped entirely.
- When the cap is reached, the partner is skipped with `skip_reason: 'cap_exceeded'` and the bid is not attempted.
- At midnight UTC a fresh Durable Object takes over with a count of zero, so the cap resets automatically. There is no scheduled reset job.
- `partner_daily_counts` in the database is for reporting only. The authoritative count lives in the Durable Object. The current day's count is available via the partner's cap-count API.

## Circuit breaker

The circuit breaker pauses bids to a partner after repeated failures, then probes for recovery. State (`closed` / `open` / `half_open`) lives in a Durable Object keyed by partner slug.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `circuit_enabled` | boolean | No | `true` | Whether the breaker is active for this partner. |
| `circuit_error_threshold` | integer | No | `5` | Number of errors within the window that trips the breaker to `open`. |
| `circuit_window_seconds` | integer | No | `60` | Sliding window, in seconds, over which errors are counted. |
| `circuit_cooldown_seconds` | integer | No | `300` | How long the breaker stays `open` before allowing a probe. Backs off by a factor of 1.5 for each consecutive failed probe. |

States:

- **closed** (normal): bids flow. Errors accumulate in the sliding window. When the count reaches `circuit_error_threshold`, the breaker trips to `open`.
- **open**: bids are skipped with `skip_reason: 'circuit_open'`. After the cooldown elapses, the next check transitions to `half_open`.
- **half_open**: a single probe bid is allowed through. If it succeeds, the breaker closes and counters reset. If it fails, the breaker reopens with a longer cooldown.

Only a buyer partner's bid attempts feed the breaker. Code-node calls to a partner API do not.

## Dedup

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `dedup_endpoint` | string (URL) | No | `null` | A dedup check URL. |

When set, before each bid the node POSTs the lead payload (with `X-Trace-Id`) to this endpoint. If the JSON response has a truthy `duplicate` or `is_duplicate`, the partner is skipped with `skip_reason: 'duplicate'`. A non-2xx response, a network error, or any other shape is treated as not a duplicate (fail open), so a dedup outage does not block bidding.

The dedup payload is the original lead payload, not the outbound-mapped wire body. See [outbound field mapping](#outbound-field-mapping).

## Response classification overrides

By default, a partner API error is classified by HTTP status: `429` and `502`/`503`/`504` are transient (retried), and other 4xx/5xx are permanent (not retried). A 2xx response that yields a bid is accepted; one that yields no bid is no bid.

`response_classification` lets you override this per partner. Rules are evaluated against the actual response before the defaults, in the order rejection, then transient, then permanent. The first matching rule wins.

| Field | Type | Description |
|-------|------|-------------|
| `response_classification.rejection_signals` | `RejectionSignal[]` | Body-only checks. A match means the partner declined the lead (a business rejection): logged, never retried, no error alert. |
| `response_classification.transient_signals` | `StatusSignal[]` | A match reclassifies the response as a transient error (retried). |
| `response_classification.permanent_signals` | `StatusSignal[]` | A match reclassifies the response as a permanent error (not retried, alerts). |

A `RejectionSignal` checks a body field (dot-path supported, for example `data.createLead.resultCode`):

| Key | Type | Description |
|-----|------|-------------|
| `field` | string | Body field to inspect. |
| `equals` | any | Exact match (loose: numeric strings and `"true"`/`"false"` coerce). |
| `contains` | string | Substring match on a string value. |
| `in` | array | Value is one of these (loose membership). |
| `not_in` | array | Value is not one of these (a missing field does not match). |
| `present` | boolean | Whether the field is present (`true`) or absent (`false`). |

A `StatusSignal` matches on HTTP status, a body field, or a response header:

| Key | Type | Description |
|-----|------|-------------|
| `status_code` | number | HTTP status to match. If omitted, any status matches. |
| `body_field` | string | Body field to inspect (dot-path supported). |
| `header` | string | Response header to inspect. |
| `equals` / `contains` / `in` / `not_in` / `present` | various | Same comparison semantics as the rejection signal. |

In the partner settings form, this is the "Response classification" section, built with a rule builder. Each rule is either a "Body field" rule or an "HTTP status" rule, with a condition dropdown (`equals`, `contains`, `in`, `not_in`, `is present`).

```json
{
  "rejection_signals": [
    { "field": "data.createLead.resultCode", "in": [1002, 1003, 1004, 1005, 1020] }
  ],
  "transient_signals": [
    { "status_code": 503 }
  ]
}
```

## Outbound field mapping

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `outbound_field_mapping` | JSON object | No | `null` | A two-column rename map applied to the lead payload right before the partner API call. |

Shape:

```json
{
  "mappings": [
    { "source": "debt_amount", "target": "DebtAmount__c" },
    { "source": "lead.email", "target": "Email" }
  ]
}
```

`source` is a dot-path into the lead payload; `target` is the wire-format field name (dot-paths in the target create nested objects). A missing source path produces `null` at the target. A `null` mapping, or one with no rows, sends the payload unchanged.

This mapping affects only the wire format of the API call. It does not change what the dedup check or the bid formula see: both reason over the original, payload-native field names. Use this to avoid adding a Transform node in front of every workflow that talks to a particular partner.

## Bid matrix

A matrix is a separate entity, `partner_bid_configs`, with its cells in `bid_matrix_rows`. One partner can own several matrices, but exactly one is `is_default`. A matrix resolver points at one matrix by `bid_config_id`.

In v1, Salesforce is canonical for matrix content. The matrix is read-only in Bidspoke and shown by the `BidMatrixViewer` with a "Synced from Salesforce" badge, the last-synced time, and a "Sync now" button. The schema is editable-ready (`sync_source` can be flipped to `manual`), but there is no in-app editor yet.

### Matrix config fields (`partner_bid_configs`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `partner_id` | UUID | Yes | none | The partner that owns this matrix. |
| `slug` | string | Yes | none | Lowercase identifier, unique per partner. |
| `name` | string | Yes | none | Display name. |
| `is_default` | boolean | No | `false` | Exactly one default per partner (enforced by a unique partial index). |
| `is_active` | boolean | No | `true` | When `false`, a matrix lookup returns no bid with reason `config_inactive`. |
| `sync_source` | `'salesforce'` \| `'manual'` | No | `'salesforce'` | `salesforce`: content is synced from Salesforce and read-only in app. `manual`: reserved for a future editor. |
| `sf_object` | string | Required for Salesforce sync | `null` | Salesforce object to pull rows from, typically `BidRangeRow__c`. |
| `sf_filters` | JSON object | No | `null` | SOQL scoping. `{ "partner_flag": "IsSoFi__c" }` adds `IsSoFi__c = TRUE`; `extra` is an arbitrary clause appended with `AND`. If no `partner_flag`, the sync defaults to the "all partner flags FALSE" slice (the default/catch-all config). |
| `dimensions` | array | Yes (for lookup) | `[]` | Up to two entries: `{ name, payload_field, column }`. Exactly one must have `column: 'row'`; an optional second has `column: 'range'`. `payload_field` is the lead field (dot-path) read for that dimension. |

### Matrix row fields (`bid_matrix_rows`)

Each row is a cell with one or two numeric bands and a bid amount. Bands come from Salesforce (`RowLow__c`/`RowHigh__c` for the row dimension, `RangeLow__c`/`RangeHigh__c` for the range dimension, `RangeValue__c` for the bid).

| Field | Type | Description |
|-------|------|-------------|
| `is_sell_off` | boolean | Standard row (`false`) or sell-off row (`true`). A lookup queries only one set, chosen by `use_sell_off`. |
| `row_low` / `row_high` | number \| null | Band for the row dimension. A `null` bound is open-ended on that side. |
| `range_low` / `range_high` | number \| null | Band for the optional range dimension. |
| `bid_amount` | number | The bid for this cell, in dollars. |
| `row_id` | string \| null | Salesforce `RowId__c`, for traceability. |
| `source_id` | string \| null | Salesforce record Id; the upsert key during sync. |

### Matched-row logic

For a lead, the lookup reads the numeric row value (and range value, if a range dimension exists) from `payload_field`, then finds the first row whose bands contain those values. A value is in a band when it is `>= low` (if `low` is set) and `<= high` (if `high` is set). The matched row's `bid_amount` becomes the bid.

The lookup returns no bid, with a reason, in these cases: the matrix is inactive (`config_inactive`), a required payload field is missing or non-numeric (`missing_payload_field:<field>`), or no row's bands contain the lead's values (`no_matching_cell`). These reasons surface on the Partner Bid output's `matrix.reason` and drive the "why didn't this lead get a bid?" view.

### Salesforce sync

An hourly cron syncs every active `partner_bid_configs` row with `sync_source: 'salesforce'`. For each, it queries the `sf_object` scoped by `sf_filters`, upserts rows into `bid_matrix_rows` keyed on the Salesforce record Id, deletes rows no longer present in Salesforce, and stamps `last_synced_at`. A sync error is recorded on the config's `last_sync_error` and does not stop other configs from syncing.

When a sync changes any rows, the change (added, edited, removed cells) is written to `bid_config_history` and an aggregated Slack alert is posted per organization. A manual "Sync now" from the UI also writes history but skips the Slack alert (those syncs usually follow a deliberate edit).

## Sell-off and sub-account fields (source partners)

These are read by the Constants node in bidding workflows.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sell_off_offer_title` | string | No | `null` | Sell-off offer headline for this partner. |
| `sell_off_offer_details` | string | No | `null` | Sell-off offer body copy. |

Sub-account UUIDs live in a separate table, `partner_uuid_map`, not on `partner_configs`. Each entry maps an external UUID to a partner slug; a partner can have many. The Constants node uses this map to resolve an inbound sub-account UUID to a partner slug (the `subAccountIdsMap`), and reads `is_active` into `activeBidding`. The partner settings form edits these in the "Sub-account UUIDs" section (source partners only).

## Bid confirmation latency

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `confirmation_window_ms` | integer | No | `null` | Maximum acceptable milliseconds between our bid and the partner's Bid Win Confirmation. Used by the Latency Gate node's `check`; a confirmation slower than this is rejected (reject due to latency). When `null`, the Latency Gate node must carry its own `threshold_ms` override. |

This field applies to both source and buyer partners.

## Alert configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `alert_config.transient_errors.alert` | boolean | No | `true` | When `false`, suppresses Slack alerts for transient errors from this partner. |
| `alert_config.permanent_errors.alert` | boolean | No | `true` | When `false`, suppresses Slack alerts for permanent errors from this partner. |

With no config, the partner alerts on all errors. Business rejections (matched rejection signals) never alert, regardless of this config.

```json
{
  "transient_errors": { "alert": false },
  "permanent_errors": { "alert": true }
}
```

## Partner Bid node output

For reference, the values a partner produces flow into the [Partner Bid node](../nodes/partner-bid.md) output, which downstream steps read as `steps.<id>.output.*`:

| Field | Type | Description |
|-------|------|-------------|
| `partner` | string | Partner slug. |
| `bid` | number \| null | Resolved bid, or `null` for no bid. |
| `accepted` | boolean | True when a usable bid was produced. |
| `skipped` | boolean | True when the partner was skipped before or after the bid attempt. |
| `skip_reason` | string | One of `partner_inactive`, `circuit_open`, `cap_exceeded`, `duplicate`, `bid_below_min`, `rejected`. |
| `resolver_type` | string \| null | The resolver used. |
| `matrix` | object \| null | For matrix resolvers: `config_id`, `matched_row_id`, `last_synced_at`, `is_sell_off`, `reason`. |
| `bid_reason` | string | Why an API resolver returned no bid despite a 2xx response. |
| `extra` | object | Values pulled via `extra_extraction`. |
| `cap_count` | number | Today's cap count after this attempt. |

## See also

- [The bidding model](../concepts/bidding-model.md)
- [Partner Bid node](../nodes/partner-bid.md)
- [Bid Group node](../nodes/bid-group.md)
- [Data references](../concepts/data-references.md)
