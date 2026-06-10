# Configure a partner

How to add or edit a partner on the Partners page: choose whether it is a source or a buyer, set how its bid is resolved (API, matrix, or formula), wire daily caps and a circuit breaker, map outbound fields, and turn it on or off. Partners are configured here, not on the canvas. [Bid Group](../nodes/bid-group.md) and Partner Bid nodes reference them by their saved configuration.

For the full list of fields and their database shape, see the [partners reference](../reference/partners.md).

## Source vs buyer

The first decision is the partner Type. It is a segmented toggle at the top of the form.

- Source - this partner sends leads to Pennie. Source partners have sell-off offer copy and a list of sub-account UUIDs. They do not bid, so the API, bidding, circuit breaker, response classification, and alert sections are hidden.
- Buyer - this partner receives bids. Buyer partners get the full set of sections below (bid resolution, endpoints, limits, circuit breaker, response classification, alerts).

Pick the type first; the rest of the form changes to match.

## Add or edit a partner

1. Go to the Partners page.
2. Click New to add a partner, or select an existing partner to edit it.
3. Set Name. For a new partner the slug auto-fills from the name (you can override it). The slug is the stable identifier that Bid Group and Partner Bid nodes use, for example `tripoint`.
4. Set Type to Source or Buyer.
5. Set Status with the Partner active toggle. Inactive partners are skipped globally across all workflows (the execution detail shows "Partner inactive" for the skipped attempt). This is the global on/off switch; to drop a partner from a single workflow, remove it from that workflow's Bid Group config instead.
6. For buyers, optionally set Priority (used for ordering/tiebreaking).

Remember to click Save. The form does not auto-save.

## Bid resolution (buyer only)

The Bid resolution section sets how a buyer's bid amount is determined. Choose a resolver type:

- Partner API (`api`) - call the partner's API and read the bid from the response. Configure the API endpoint and the worker secret key used for auth, plus a sample response and extra extraction so the editor knows the response shape.
- Matrix lookup (`matrix`) - look up the bid in a bid matrix keyed on lead attributes (for example credit score band). See [Bid matrix sync](#bid-matrix-sync-matrix-resolver) below.
- Formula (`formula`) - compute the bid from a formula over lead fields and Bid Group context values.

The resolver type is stored on the partner as `bid_resolver_type`. There is no separate "Bid Lookup" node; the resolver lives on the partner.

### Bid matrix sync (matrix resolver)

When the resolver is Matrix, a Matrix section appears (you must save the partner first to attach one). In v1, Salesforce is the canonical source for matrix rows. The viewer shows a "Synced from Salesforce" badge, the last-synced time, and a Sync now button. An hourly cron pulls `BidRangeRow__c` rows from Salesforce into the local `bid_matrix_rows` table; Sync now pulls on demand.

The matrix is read-only in the UI by design while Salesforce stays canonical. If a matrix sync changes rows, Bidspoke records the diff and can post a Slack alert (see [partners reference](../reference/partners.md)). To debug why a lead did not match a matrix row, see [Testing and debugging](./testing-and-debugging.md#why-did-this-lead-get-no-bid).

## Endpoints (buyer only)

- Click URL - the landing page URL for leads routed to this partner. It is exposed to bidding workflows as `{Slug}ClickUrl` via the [Constants node](../nodes/constants.md).
- Dedup endpoint - optional. Called before each bid to check whether this lead was already sold to this partner. A dedup match skips the bid (the execution shows "Skipped - Dedup match").

## Response handling (buyer, API resolver only)

When the resolver is Partner API, set the Bid mode:

- Commit - the API call creates a lead on the partner's side (a real submission).
- Ping only (`ping_only`) - the call is a lightweight bid quote with no side effects (the conversion is a separate out-of-band step).

Use the Sample response and Extra extraction panels to capture the partner's response shape so the editor can map fields out of it.

## Outbound field mapping (buyer only)

The Outbound field mapping section is a two-column editor that renames fields on the wire just before the bid request is sent. The dedup payload and formula inputs still see the original payload field names; the mapping only changes what goes out to the partner's API. Use it when a partner's API expects different field names than your payload uses.

## Bidding limits (buyer only)

- Daily cap - max leads per day for this partner. Leave blank for unlimited. Caps are enforced by a per-partner, per-day Durable Object (`cap-{slug}-{YYYY-MM-DD}`) and reset at midnight UTC. A capped partner is skipped (the execution shows "Skipped - Daily cap").
- Minimum bid ($) - reject bids below this amount. A bid under the floor shows as "No bid - Below min".

### Per-sub-account min bids

Optional. Add rows of sub-account UUID plus a floor. When a lead arrives carrying a matching sub-account UUID, that floor overrides the partner-wide Minimum bid. A blank bid means "no override", not a $0 floor (a $0 floor would accept any bid). Leave the table empty to use only the partner-wide floor.

## Circuit breaker (buyer only)

Toggle Circuit breaker enabled to pause bids to a partner after repeated failures, then retry automatically. When enabled, set:

- Error threshold - errors before pausing (placeholder default shown as 5).
- Window (seconds) - the period over which errors are counted (placeholder 60).
- Pause duration (seconds) - how long to wait before retrying, that is the open-to-half-open cooldown (placeholder 300).

State (closed, open, half-open) is held in a Durable Object per partner. A partner with an open breaker is skipped (the execution shows "Skipped - Circuit breaker open").

## Response classification (buyer only)

Override how this partner's responses are classified into rejection, transient error, or permanent error. The rule builder lets you match on a Body field or an HTTP status, with conditions like equals, contains, in, not in, and present. Your rules are evaluated before the default HTTP-status-based classification. Leave all three sections empty to use only the defaults.

The three categories behave differently:

- Rejection - the partner declined the lead. Logged as a business rejection, never retried.
- Transient error - temporary failure. Retried per the workflow retry policy.
- Permanent error - unrecoverable failure. No retry, triggers alerts.

## Bid confirmation latency

The Confirmation window (ms) field sets the maximum acceptable time between your bid and the partner's Bid Win Confirmation, used by the [Latency Gate node](../nodes/latency-gate.md). Confirmations slower than this are rejected as "reject due to latency". This field is stored as `partner_configs.confirmation_window_ms` and applies to both source and buyer partners. Leave blank to require a node-level threshold override instead.

## Sell-off offer copy and sub-account UUIDs (source only)

Source partners have two extra sections:

- Sell-off offer copy - a Sell-off offer title and Sell-off offer details. Bidding workflows pull these into the [Constants node](../nodes/constants.md) to populate sell-off offer fields for this source.
- Sub-account UUIDs - the list of sub-account identifiers for this source, exposed to workflows via Constants.

## Alert configuration (buyer only)

Toggle whether transient and permanent errors for this partner fire alerts. Alerts go to your configured Slack channel. See the [observability reference](../reference/observability.md) for alert routing.

## The unsaved-changes guard

The form tracks a dirty state by comparing the current values against the values at mount. While you have unsaved edits:

- An amber "Unsaved changes" pill appears.
- Closing the tab, refreshing, clicking a link, hitting Cancel, switching partners, or clicking New all prompt with "You have unsaved changes. Leave without saving?" before discarding your edits.

Click Save to persist and clear the guard. If you flip a toggle but never click Save, the change does not take effect.

## See also

- [Partners reference](../reference/partners.md) for every field and its database column.
- [Bid Group node](../nodes/bid-group.md) for how partners are combined into an auction.
- [Latency Gate node](../nodes/latency-gate.md) for the confirmation-window gate.
- [Constants node](../nodes/constants.md) for click URLs, sell-off copy, and sub-account UUIDs.
- [Testing and debugging](./testing-and-debugging.md) to see why a partner was skipped or bid nothing.
