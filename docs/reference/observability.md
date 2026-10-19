# Observability

How to monitor and debug Bidspoke workflows: the dashboard, execution history, the execution detail view, structured logs and trace IDs, Slack alerts, estimated cost per run, and how long log data is kept. Everything here reflects what the platform actually exposes today.

For the underlying execution model (statuses, outcomes, steps, resume vs replay), see [Workflows and executions](../concepts/workflows-and-executions.md). For a hands-on debugging walkthrough, see [Testing and debugging](../guides/testing-and-debugging.md).

## Dashboard

The dashboard summarizes execution activity for your organization over a rolling window. It is backed by `GET /api/stats?window=<days>`.

- `window` is the number of days to look back. It defaults to `7` and is clamped to the range `1` to `30`.
- All summary, per-day, and per-workflow counts cover production runs only. Test runs (`is_test = true`) are excluded from counts and durations. Estimated cost is the one exception: per-workflow cost includes test runs.

### Summary

The top-level summary reports, for the window:

| Field | Meaning |
|-------|---------|
| `total` | Total production executions |
| `completed` | Executions with status `completed` |
| `failed` | Executions with status `failed` |
| `exited` | Executions with status `exited` (ended at an Exit node) |
| `successful` | Executions whose outcome reached a success node (`outcome = 'successful'`) |
| `avg_duration_ms` | Mean execution duration across the window |
| `success_rate` | `completed / total`, as a whole-number percent |

Note: `p95_duration_ms` is present in the response shape but is always `null` (it is not computed at the rollup level and the dashboard does not render it).

### By day

`by_day` is one row per calendar day in the window (UTC), each with `completed`, `failed`, `exited`, and `total` counts. Days with no runs are present with zero counts, so the series is gap-free for charting.

### By workflow

`by_workflow` breaks the window down per workflow, sorted by total runs descending (ties broken by cost). Each row includes:

- `total`, `completed`, `failed`, `exited`, `successful`
- `success_rate` (percent, or `null` if the workflow had no runs)
- `avg_duration_ms`, plus per-outcome averages: `avg_duration_completed_ms`, `avg_duration_successful_ms`, `avg_duration_failed_ms`
- `cost_usd` (estimated, includes test runs). See [Estimated cost per execution](#estimated-cost-per-execution).

### Recent failures

`recent_failures` is the latest 10 failed production executions in the window, newest first. Each entry carries `id`, `workflow_id`, `workflow_name`, `error_message`, `started_at`, `source`, and `trace_id`. Use the `trace_id` to follow a failure across the structured logs (see [Tracing a single lead](#structured-logs-and-trace-ids)).

## Execution history

The execution list is backed by `GET /api/executions`. It returns up to 100 production executions (test runs are excluded), newest first, and supports keyset pagination for infinite scroll via the `before` and `before_id` cursor query params.

Filters (all optional query params):

| Param | Description |
|-------|-------------|
| `workflow_id` | Limit to one workflow (must belong to your org) |
| `status` | `completed`, `failed`, `exited`, or `in_progress` |
| `outcome` | e.g. `successful`, `completed`, `failed` |
| `source` | The execution's source label (e.g. the API source or custom endpoint name) |
| `from`, `to` | ISO timestamps bounding `started_at` |

Each list row carries `status`, `outcome`, `final_node_namespace`, `source`, `started_at`, `duration_ms`, `error_message`, and `has_children`. `has_children` is `true` when the execution has been resumed or replayed at least once (both link back via `parent_execution_id`).

## Execution detail view

Open a single execution to see the full step-by-step record. This is backed by `GET /api/executions/:id`, which returns the execution row plus its `steps[]` and any `child_executions[]` (resumes and replays).

Pass `?summary=1` to omit each step's `input`, `output`, and `logs` (used by the canvas overlay to color nodes quickly). Individual heavy step payloads are then lazy-loaded via `GET /api/executions/:id/steps/:stepId`.

### Step list, resolved inputs and outputs

Each step shows its namespace, type, status, duration, and any error. When you open a step you get:

- `input` (also called the resolved input): the actual values passed into the node after [data references](../concepts/data-references.md) were resolved. This is what the node really saw, not the template.
- `output`: what the node produced. Downstream `steps.<namespace>.output.*` references read from here.
- `logs`: any structured log lines the step emitted.

On a resumed execution, completed steps inherited from the parent run are shown as completed (green) with their original outputs, so the full path is visible even though those steps did not re-run.

### Waterfall and elapsed-from-trigger

For each step the detail view shows `+<duration> from trigger`, the cumulative wall-clock time from the execution start to that step's completion (`step.completed_at - execution.started_at`), plus a thin per-step waterfall bar positioned by wall-clock offset. Because the bars use real offsets, parallel steps overlap visually, which makes it obvious which branch was the long pole. Pre-run steps inherited on a resume are excluded from the waterfall (they started before this run).

### Bid attempts ("why didn't this lead get a bid?")

For every [BidGroup](../reference/partners.md) step (`step_type = 'bid_group'`), the detail page renders a Bid attempts table above the step list, one row per partner that was considered. Each row shows the partner slug, the resolver mode, a result badge, the bid amount, and a plain-language reason. This is driven by fields the Partner Bid output carries: `resolver_type`, `skip_reason`, `bid`, and (for matrix resolvers) a `matrix` object with `config_id`, `matched_row_id`, `last_synced_at`, `is_sell_off`, and `reason`.

Resolver mode is shown as:

- `Matrix` (or `Matrix (sell-off)` when `is_sell_off` is true)
- `Formula`
- `API`

Result badges and the reasons that produce them:

| Badge | When | Example reason shown |
|-------|------|----------------------|
| `Won` | This partner was the BidGroup winner | (winner row, highlighted) |
| `Bid` | Partner returned a usable bid | bid amount |
| `No bid` | Resolver returned nothing usable | `No matrix row matched the lead`, `Missing payload field: credit_score`, `Matrix config inactive`, `Below min ($12)` |
| `Skipped` | Partner was not called | `Dedup match`, `Daily cap (250)`, `Circuit breaker open`, `Partner inactive` |
| `Rejected` | Partner declined the lead | `Partner declined` |

These map to the Partner Bid `skip_reason` values (`duplicate`, `cap_exceeded`, `circuit_open`, `partner_inactive`, `bid_below_min`, `rejected`) and the matrix `reason` values (`no_matching_cell`, `missing_payload_field:<field>`, `config_inactive`). When no partner won, the section gets a red header showing the BidGroup's own `reason`. See [Partners](../reference/partners.md) for how each skip reason is produced (caps, dedup, circuit breakers, matrix resolution).

## Structured logs and trace IDs

Every Worker invocation emits structured JSON log lines via `console.log()`. Cloudflare captures them automatically; they are also exportable via Logpush. Each line shares a consistent shape so you can filter and aggregate without custom parsing.

Common fields on every line: `event`, `trace_id`, and (where applicable) `workflow_id`, `workflow_version_id`, `execution_id`, `step_namespace`, `step_type`, `duration_ms`, `error_type`, `error_message`, `partner_id`.

Event types include: `execution_start`, `execution_complete`, `execution_failed`, `step_start`, `step_complete`, `step_error`, `step_skipped`, `partner_bid`, `circuit_open`, `cap_check`, and `idempotency_hit`.

### Tracing a single lead end to end

Every execution is assigned a `trace_id` when it starts. To trace one lead:

1. Find the `trace_id` from the dashboard recent-failures list, the execution detail view, or the `X-Trace-Id` response header returned to the caller (webhooks, custom endpoints, resume, and replay all return it).
2. Filter the structured logs by that `trace_id`. You will see the full sequence from `execution_start` through each step to `execution_complete` or `execution_failed`.

### X-Trace-Id propagation to partners

Outbound calls the engine makes to upstream services carry the same `trace_id` as an `X-Trace-Id` request header, so a single lead can be correlated across systems that log it. This is set on Partner Bid API calls, the bid resolver's API calls, Integration node calls, and Salesforce calls.

## Slack alerts

Alerts post to the Slack channel configured on your org's Slack connection (`default_channel`). A workflow can override the channel with its own `slack_channel` setting. If Slack is not connected, alerts are silently skipped. Headers in alerts use no emoji.

| Alert | Trigger | Toggle |
|-------|---------|--------|
| Workflow Execution Failed | A production execution fails. Shows workflow, failed step, error type (Transient/Permanent), retries used (only when > 0), the error body (truncated at ~2000 chars), and a `View execution` link. | Per-partner and per-workflow alert config (see [Error handling](./error-handling.md)) |
| Workflow Volume Cliff | The trailing 5-minute execution rate for an active workflow drops below 25% of the prior hour's median rate (baseline must be at least 10/min). Includes a self-check that probes whether the Worker is reachable, to distinguish an upstream traffic stop from a Bidspoke/Cloudflare problem. 30-minute per-workflow cooldown. | `volume_alerts_enabled` (Integrations) |
| Slow Execution Spike | Over a 5-minute window, at least 5 runs AND at least 50% of runs exceed the workflow's `duration_alert_ms` threshold. Aggregated, not per-run. 30-minute per-workflow cooldown. | Requires `duration_alert_ms` set on the workflow trigger |
| Bid Matrix Changed | The hourly Salesforce to bid-matrix sync detects added, edited, or removed rows. Lists the per-row diffs. | `matrix_alerts_enabled` (Integrations); optional dedicated `matrix_alerts_channel` |
| Timeout Below Reliable Minimum | The daily config audit finds active workflow steps whose configured `timeout_ms` is below the node-type reliability floor (these fail on every cold run). Links straight to each offending node. | `config_alerts_enabled` (Integrations) |
| Circuit Breaker Opened / Recovered | An upstream service circuit breaker opens or recovers. | Always on when Slack is connected |
| Output Field Stopped | Hourly. A workflow output field that normally carries a value on at least 90% of runs, with very low variance, has collapsed today. Names the field, its own baseline rate, and today's rate. 12-hour per-field cooldown, with an all-clear when it recovers. See [Silent output field detection](./silent-output-detection.md). | `volume_alerts_enabled` (Integrations) |
| engine-script-drift | Hourly. A code node on a kept workflow (the Engine Bidding Workflow, and the Liberty1 click workflow once its id is recorded in `KEPT_CANVAS_WORKFLOWS`) holds a script that is neither the kept copy in `apps/worker/src/engine/scripts/<folder>/` nor the canvas script that copy was derived from, or the node is missing. Names the node and the first differing line. A kept file whose paste has not happened yet is recorded in `job_runs` as `awaiting_paste`, not paged. | `config_alerts_enabled` (Integrations) |
| Lead sightings buffer fell behind | Daily at 13:00 UTC. For `lead_sightings`, `lead_sighting_bids` and `achieve_evaluations`: more rows than tolerated have waited past their export window (6 hours for sightings and bids, 30 for Achieve), or were exported longer ago than the purge window (30 hours, 54 for Achieve) and are still in Supabase. Counts stop at 10,000. A table it cannot read is reported on its own alert, Lead sightings buffer unmeasured, the same day, and the lag alert is not cleared that day. The lag alert clears on the next fully measured healthy read. Thresholds live in `apps/worker/src/lib/sightings-buffer-lag.ts` (#463). | Always on when Slack is connected |
| Output Field Not Resolving | Daily. A workflow output field that something reads has carried a value on at most 0.1% of at least 200 runs over 7 days. Mostly fields that carried values and stopped (usually the upstream), plus never resolved fields whose key cannot be judged yet. See [Silent output field detection](./silent-output-detection.md). | `volume_alerts_enabled` (Integrations) |
| Output Field Path Not Found | Daily. A field that has never carried a value and whose key never appeared on at least 200 runs over 3 or more days: the reference names something the step does not return. Correct or remove it. A key that appears with an empty value is empty by design and never pages. | `volume_alerts_enabled` (Integrations) |

The volume, matrix, and config toggles live on the Integrations page (Slack settings) and all default to on (opt-out). They are read and written through `GET`/`PATCH /api/integrations` as `volume_alerts_enabled`, `matrix_alerts_enabled`, and `config_alerts_enabled`.

The volume-cliff and slow-spike checks run on a per-minute cron and only evaluate active workflows in orgs that have Slack connected.

### The ops minute cron (`export-alert:ops-tick`)

The ops Worker (`bidspoke-worker-ops`) runs one tick a minute and sends its report to the bidding Worker through the OpsGateway. The bidding Worker judges the last report every minute (`runOpsTickReportCheck` in `apps/worker/src/lib/ops-gateway.ts`) and pages through the shared export alerter, so its page and all clear pair up in `alert_incidents` as signal `export-alert`, subject `ops-tick`.

| Page | Means |
|---|---|
| The ops minute cron reported a problem | A tick reported a problem that is due to page: one that pages at once, or one that three ticks in a row reported. A context line `Reported by 3 or more ticks in a row.` says every problem on the page is the second kind. |
| The ops minute cron is not configured | A secret the tick needs is unset or unusable. It names the secret and its remedy, and pages at once. |
| An ops connection needs to be reconnected | Sent to the connection's own organization (its Slack alert channel, under the configuration alerts toggle), naming the connection and its service. Its login is in `needs_reauth`: the service refused it, refused its requests after a new login, or its sign in service failed for more than 15 minutes. A person reconnects it on the Connections page. Pages at once. |
| An ops connection cannot sign in | Sent the same way. Its login is in `refresh_failing` and has met Dan's decision 2 bound: 5 failed sign ins in a row, the first at least 15 minutes ago, each because the service's sign in did not answer. Its next failure turns it into `needs_reauth`. Check the service's status; if its sign in works, reconnect the connection. |

**Three ticks in a row (#2506, Dan's decision 2026-10-19).** Every problem in a report carries a key: its kind, and what it is about where there is one (a sweep, a workflow, a connection, a secret), such as `sweep_failed:run_expiry`. The bidding Worker counts each key's ticks in a row as the report arrives, never by the problem's sentence, which carries an error's own words and figures. A problem a passing tick would clear pages only on the third tick in a row that reports it; one tick's is logged and counted. A tick without that problem, a clean one included, ends its count. The rule for each kind is `OPS_TICK_PROBLEM_RULES` in `apps/worker/src/lib/ops-gateway-contract.ts`:

| Rule | Kinds |
|---|---|
| Three ticks in a row | `start_stamp`, `db_clock`, `sweep_claim_failed` (any sweep), `sweep_failed` (lease_expiry, run_expiry, tombstone_expiry, sf_lease_expiry), `workflows_fetch_failed`, `workflows_save_failed`, `copies_read_failed`, `schedule_plan_failed`, `claim_depth_failed`, `probe_failed`, `connections_fetch_failed`, `connections_save_failed`, `tombstone_record_failed`, `problems_left_out`, `connection_logins_failed` (the login states, read every tick, could not be read) |
| At once, not transient | `db_not_configured`, `not_configured`, `secrets_unchecked`, `queue_disagreement`, `workflow_refused`, `workflows_too_many`, `copies_read_limit`, `schedule_refused`, `schedule_no_version`, `connections_list_unreadable`, `connection_refused`, `connections_too_many`, `connection_copies_expired`, `connections_step_failed` |
| At once, never reported again by a later tick | `slot_missed` (recorded once), `dispatch_failed` (a slot is dispatched once), `agreement_check_failed` (the check runs every 14 minutes) |
| At once, written by the bidding Worker | `report_unreadable`, and `unkeyed` for each problem of an ops release before #2506, except a lone missed start stamp, which is held as `start_stamp` |
| At once, from the sf_limits sweep, which runs every fourth tick and so holds a passing failure itself | `sf_limits_failed` (the list of measured orgs could not be read), `sf_limits_orgs_limit` (as many measured orgs as one sweep reads), `sf_limits_refused` (a refusal the next read meets again, per org), `sf_limits_unreadable` (a DailyApiRequests that cannot be read, per org), `sf_limits_read_failed` (a timeout, a busy pool, a 5xx, a rate limit or a write the ops database missed, paged only once the org's reading is older than 7 minutes, so the second failure in a row, per org) |
| At once, from the connection_check sweep, which runs every fourteenth tick and so holds a passing failure itself, and from the login states | `connection_check_failed` (the list of connections could not be read), `connection_check_limit` (as many connections as one sweep checks), `connection_check_refused` (a refusal the next probe meets again: a 4xx, a refusal by rule, an identity other than the one verified, per connection), `connection_check_unreadable` (an identity answer that is not one, per connection), `connection_check_unavailable` (a timeout, a 5xx, a network error, a busy pool, a budget floor or a rate limit, paged only once the connection's last passing check is older than 20 minutes, so the second in a row, per connection), `connection_logins_limit` (more connections, or more logins due, than one read or report carries) |

A kind the bidding Worker has no rule for pages at once. A page lists only the problems due to page; problems held beside them are in the logs. A tick whose every problem is held pages nothing and is not read as clean either, so an open incident stays open until a clean tick stands it down.

**How to read it.** In the bidding Worker's logs (`bidspoke-worker`):

- `ops_tick_problem_held`: a problem held, with its `key`, `in_a_row` and `pages_at` (3). One line per held problem per tick.
- `ops_tick_count_unknown`: the count in KV could not be read (`why: read`) or written (`why: write`). That tick's problems page rather than being held, since a count that cannot be carried could hold a problem for ever.
- `[ops-tick] held tick`: the minute check found only held problems.

Every problem's sentence is in the ops Worker's own logs (`bidspoke-worker-ops`), event `ops_tick`, step `problem`, with its `key`.

**The count in KV.** One record, `ops-tick:problem-streaks` in `IDEMPOTENCY`, written as each report arrives, with a 10 minute expiry that every tick keeping a problem standing renews; a clean tick removes it. A record older than 10 minutes, by its own time, starts every count afresh even before KV expires it. The same report delivered twice counts once. Two overlapping ticks, or a KV read in another location that does not yet see the last write, can delay a page by a tick.

**A tick that stops reporting** is not this page's to catch: the `ops-tick` cron heartbeat (`apps/worker/src/lib/cron-heartbeat.ts`) pages on a tick that never starts or never finishes, and a report older than 10 minutes is left to it.

**The sf_limits sweep (#2336).** Inside the tick, claimed every 4 minutes (`claim_ops_sweep('sf_limits', ..., 240)`), the sweep reads each measured Salesforce org's `/services/data/v60.0/limits` through `connectionFetch` (purpose `sf_limits`) and writes its `DailyApiRequests` remaining to `sf_budget_readings`, source `limits`, so `acquire_sf_lease` has a reading younger than 15 minutes whether or not ops is calling that org. Its problems are in the table above. Its counts are in the tick's `finished` line: `sf_limits_orgs`, `sf_limits_recorded`, `sf_limits_held` (a passing failure held, each also logged as step `sf_limits_held` with the org, the cause and the reading's age) and `sf_limits_stamps_failed`. With no measured org (until the first ops Salesforce connection is verified) it finds nothing and reports nothing.

**A sweep that stops** is the `ops-sf-limits` cron heartbeat's to catch. The sweep stamps start and completion through `OpsGateway.opsJobStarted` and `opsJobCompleted` (`lib/ops-gateway.ts`, #2340) each time it owns its claim, and the bidding Worker pages: stale when no start has arrived for 30 minutes (the tick's own 25 plus one sweep interval, so a dark tick pages as `ops-tick` first), never ran when its entry has been registered for 30 minutes with no start, and vanished when starts go on and nothing has finished for 15 minutes (three sweeps). A stamp the gateway misses once is counted in `sf_limits_stamps_failed` and pages nothing. The bidding Worker logs each completion as `ops_job_completed` with the sweep's counts, and a completion whose report it cannot read as `ops_job_report_unreadable`, still stamped.

**The connection_check sweep (#2340).** Inside the tick, claimed every 14 minutes (`claim_ops_sweep('connection_check', ..., 840)`), so it runs every 14 or 15 minutes, 16 with a missed tick. For each ops connection whose copy can serve (`connection_check_targets`: the ones it probes first, least recently checked first among them, then the ones it skips, at most 50 a sweep) and that is not in `needs_reauth`, it asks the service who the credential is, through `connectionFetch` (purpose `connection_check`) with the service's identity probe, the one verify uses (Salesforce `/services/oauth2/userinfo`, which must still be the org and user verify measured; Snowflake `CURRENT_USER()` and the account, which must be the declared ones), and writes the result with `record_connection_check`, which writes the `last_check_*` columns only. The connections of one Salesforce org are probed one after another, since the `connection_check` purpose share is 1; each has a 45 second deadline, and no probe starts once 10 seconds of the sweep have passed, so a sweep takes at most 55 seconds and a connection not reached (`connection_check_deferred`) goes first next sweep. A busy pool, a budget floor or a rate limit is not a failed check and records nothing. A refused login or a failing token endpoint is recorded as a failed check and left to the login page below. Its counts are in the tick's `finished` line: `connection_check_connections`, `connection_check_passed`, `connection_check_held` (each also logged as step `connection_check_held` with the connection, the cause and the last pass's age), `connection_check_not_run`, `connection_check_login_failed`, `connection_check_skipped_reauth`, `connection_check_not_servable`, `connection_check_unprobed`, `connection_check_gone`, `connection_check_deferred`, `connection_check_record_failed` and `connection_check_stamps_failed`. With no ops connection (until the first is saved) it finds nothing and reports nothing.

**A connection_check sweep that stops** is the `ops-connection-check` cron heartbeat's to catch, stamped like `ops-sf-limits`: stale when no start has arrived for 50 minutes (the tick's 25 plus one interval with a missed tick, rounded up past the drought), never ran when its entry has been registered for 50 minutes with no start, and vanished when starts go on and nothing has finished for 45 minutes (three sweeps).

**The login page (#2340, signal `ops-connection-login`).** Every tick, whether or not it runs the sweep, reads every connection's login state from the same list after saving the served connections, and its report carries `connection_logins`: each connection in `needs_reauth`, and each in `refresh_failing` with 5 failures, the first at least 15 minutes old (the bound `record_connection_refresh` escalates by, `REFRESH_FAILING_PAGE_FAILURES` and `REFRESH_FAILING_PAGE_SPAN_MS`, held equal to it by `refresh-failing-page-bound.test.ts`). The bidding Worker's minute job `ops-connection-logins` (`lib/ops-connection-logins.ts`) pages each to the connection's organization, keyed on the connection id, named by its `service_connections.name` and service. A change from `refresh_failing` to `needs_reauth` pages at once; a repeat follows the shared reminder schedule. The all clear goes once a complete list no longer names the connection: at once for `needs_reauth`, which only a Reconnect clears, and after the 30 minute re-arm window for `refresh_failing`. A report that is missing, older than 10 minutes, unreadable, not complete, or from a tick that could not read the states sends neither a page nor an all clear and keeps every open incident; the `ops-tick` heartbeat covers a tick that stopped. Its state is `ops-connection-login:state` in `IDEMPOTENCY`, written only when it changes.

### When nobody can be told in Slack (Better Stack)

A scheduled check finds who to tell by reading the org's Slack connection. When the database does not answer, it falls back to the saved copy of the Slack connections. When that fallback fails too, no Slack alert can be posted at all, and the worker's own log lines do not reach Better Stack (log forwarding was narrowed on 2026-09-09 to keep applicant data out, #1007). For that one case the worker sends a fixed line straight to a Better Stack HTTP log source (#2063, `apps/worker/src/lib/nobody-told-page.ts`). Neither the database nor Slack is on that path.

| | |
|---|---|
| Alert | `Bidspoke Slack alerts down`, a Better Stack logs alert on the source below (the name Dan gave it on 2026-10-16, the constant `BETTER_STACK_ALERT_NAME`) |
| Match | The alert's query is `raw ILIKE '%bidspoke nobody can be told in Slack: the database did not answer and no saved Slack copy could stand in%'`, threshold above 0. The text is the event's `message`, the constant `NOBODY_TOLD_LINE`, pinned by `nobody-told-page.test.ts`; change both together or the alert stops matching. The alert matches on this line, never on its own name. |
| Means | The database did not answer a scheduled Slack lookup and the saved copy could not stand in: `reason` is `no_copy` (there is no saved copy, as after a fresh deploy), `org_not_in_copy` (the copy holds no connection for that organization, or, with `organization_id` null, for any organization) or `copy_unreadable` (the copy did not decrypt, most likely written under a key since rotated). Every scheduled alert for that organization is going unsaid. Check the database first (the Supabase dashboard), then the saved copy. A `reason` of `drill` is not an outage: somebody sent a drill page (below). |
| Source | The Better Stack HTTP log source `Bidspoke outage line`. Its token is the worker secret `BETTERSTACK_OUTAGE_TOKEN`, its ingesting host `BETTERSTACK_OUTAGE_URL`. It also carries the row cap line (below, #1436), which is why each alert matches on its own line and never on the whole source. |
| Fields | Exactly four: `message`, `organization_id` (null when the read was for every organization at once, and on a drill), `reason`, and `dt` (when it happened). Never applicant data or any other field; a test pins the whole event. |
| Cadence | At most once per organization per scheduled tick, and once sent, not again for that organization for an hour (a KV record in `IDEMPOTENCY` under `nobody-told-page:`). A send Better Stack refuses or that takes over 5 seconds writes no record, so the next tick tries again. It never delays or fails the check that raised it. |

**The source and the alert are created by hand in Better Stack, separately from this code**, and until both secrets are set the worker pages nobody here: each tick that would have paged logs `BETTERSTACK_OUTAGE_TOKEN or BETTERSTACK_OUTAGE_URL is unset`. To switch it on: create an HTTP log source, set its token and `https://<ingesting host>` as the two worker secrets, then create the logs alert on that source matching the line above and route it to the on call escalation policy. Then prove it with a drill.

**Proving the page works: the drill (#1303).** Nothing else sends this page on demand, so until an outage the stored URL, the token and the alert are unproven. `POST /api/admin/nobody-told-page/drill` sends ONE page through the same request a real outage sends, with the worker's own two secrets: the same line as `message`, `organization_id` null, and `reason: 'drill'`. It takes no body. Any signed in user on the access allowlist may call it, as for every `/api/admin` route; it reads no tenant data, and the caller's organization is used only for its audit row (`outage_page`, action `outage_page_drilled`, with the outcome). It never reads or writes the `nobody-told-page:` record in `IDEMPOTENCY`, so a drill cannot hold back a real outage's page in the hour after it. **The alert should fire and page whoever it is routed to**, so say so before running it. The answer always carries `alert` (the alert's name) and `audited` (whether its audit row was actually written, since a failed audit write must not read as recorded), and says what happened:

| Status | `outcome` | Means |
|---|---|---|
| 200 | `sent`, with `status` (Better Stack's answer, normally 202) | Better Stack took the line. The alert should fire within its check interval; if it does not, the alert's query or source is wrong. |
| 503 | `not_configured`, with `missing` (the unset secret names) | Nothing was sent: a secret is unset, so a real outage would page nobody either. |
| 502 | `refused`, with `status` | Better Stack refused it, so the stored token or URL is wrong (a 401 or 403 most likely means the token). A real page would be refused the same way. |
| 504 | `no_answer`, with `deadline_ms` | No answer within the 5 second page deadline; the send was abandoned. |
| 502 | `threw`, with `error` | The request itself failed (a malformed URL, a DNS or network failure). |

### A read stopped at the row cap (Better Stack)

PostgREST answers at most 1,000 rows (the `max_rows` setting of the Supabase project's Data API, set in the Supabase dashboard, outside this repo; `ROW_CAP` in `apps/worker/src/lib/row-cap.ts` equals the pagination page size) and says nothing about having stopped there. The Worker's Supabase client checks every read's `Content-Range` header (#1436). A read that came back with 1,000 rows and declared no limit of its own (no `.limit(n)` with n at most 1,000 and no `.range()`; a `.single()` read, a `head: true` count and writes are exempt) is reported every time, and inside a scheduled job the read also fails, with the error code `BIDSPOKE_ROW_CAP` and a message naming the table or rpc and the query. An rpc not on the read only list (`apps/worker/src/lib/read-only-rpcs.json`) is only reported, even in a scheduled job, because it has already written by the time its rows come back. On a request or the engine path the read answers as before. Dan's decisions on #1437, 2026-10-18.

| | |
|---|---|
| Line | `bidspoke read stopped at the PostgREST row cap without a declared limit`, the event's `message` and the constant `ROW_CAP_LINE`. Every hit writes it to the Worker's log as one JSON line, and sends it to the same Better Stack source as the outage line above, since the Worker's own logs do not reach Better Stack. |
| Alert | To be created by hand in Better Stack: a logs alert on the `Bidspoke outage line` source whose query is `raw ILIKE '%bidspoke read stopped at the PostgREST row cap without a declared limit%'`, threshold above 0. Until it exists, the line is sent and nothing pages. |
| Fields | Exactly eight: `message`, `relation` (the table, view or rpc), `kind` (`table` or `rpc`), `query` (the query string with every filter value replaced by `?`), `rows`, `total` (the count when the read asked for one, else null), `in_scheduled_tick` (the read ran in a scheduled job, where it failed unless it was an rpc not on the read only list), and `dt`. Never a row value; a test pins the whole event. |
| Cadence | Logged on every hit. Sent to Better Stack at most once per call site (table and query shape) per 10 minutes per Worker isolate. A send that fails or takes over 3 seconds is logged and tried again on the next hit. On a request it never delays the read; in a scheduled job it is sent before the read fails. |
| Means | A list read is missing rows, or holds exactly 1,000. Fix it in the code: declare the limit the read needs, or read every row with `fetchAllPaged` (`apps/worker/src/lib/paginate.ts`) under a full order. |

## Estimated cost per execution

Each execution gets an estimated USD cost in `workflow_executions.cost_usd` (and CPU time in `cpu_ms`). It is assembled in two parts:

1. The engine writes a step-based slice at finalize time: a flat Supabase per-run estimate, plus Workers-for-Platforms request and CPU cost for each Code node (approximated from the step's `duration_ms`), plus per-call partner API cost for any partner bid that actually called out.
2. The tail consumer worker (`apps/worker-tail`) adds the main-Worker Cloudflare request and CPU slice once Cloudflare reports the true `cpuTime` for the request, correlating on the `execution_complete` / `execution_failed` log line.

Rates live in `apps/worker/src/engine/cost-rates.ts`. Current rates: `$0.30` per million Worker requests and `$12.50` per million CPU-ms (same for code-node Workers-for-Platforms), plus a flat `~$0.00005` Supabase per-run estimate. Per-partner per-call rates are empty until contracts are confirmed, so partner API calls contribute `$0` to the estimate today. Cost is surfaced as the `Est. cost` column on the dashboard's by-workflow table.

## Log retention

Execution and step data is kept hot, then dropped. The `workflow_executions` and `execution_steps` tables are partitioned daily.

- A pg_cron job drops any partition older than the retention window. The current window is 7 days, enforced by partition `DROP` (instant, reclaims disk immediately) rather than row-level `DELETE`.
- A 03:00 UTC compaction cron nulls out heavy step payloads on rows that are about to age out, shortly before their partition is dropped.
- A separate 90-day purge job exists but is guarded by an `app_config.logpush_active` flag and will not delete anything until Logpush archival to long-term storage is confirmed active. Structured logs are exportable via Cloudflare Logpush for long-term, queryable retention beyond the hot window.

In practice this means the dashboard, execution history, and execution detail views cover roughly the last 7 days. Use the structured logs (and any Logpush archive) to investigate anything older.

### Lead sightings buffer (export and purge)

`lead_sightings`, `lead_sighting_bids` and `achieve_evaluations` are a write buffer: rows are exported to Snowflake, which is canonical for analytics, and purged from Supabase 24 hours after export.

- **Every run is recorded.** Each export and purge run writes one row to `job_runs` (`sightings-export`, `achieve-export`, and `sightings-buffer-purge` for the purge described below) with its counts, its errors and their classes (#745). A row with `finished_at` null is a run that was killed. The last day of one job: `select started_at, finished_at, outcome, detail, summary from job_runs where job = 'sightings-export' order by started_at desc limit 12;`

### Lead sightings purge

Rows in `lead_sightings`, `lead_sighting_bids` and `achieve_evaluations` are deleted from Supabase once they were exported to Snowflake more than 24 hours ago, by the database itself: the pg_cron job `purge-exported-sightings` runs `purge_exported_sightings()` hourly at :13, deleting committed pages of up to 5,000 rows round robin across the three tables within a 60 second budget (#541). Rows not yet exported, rows set aside because Snowflake refused them, and Achieve sandbox rows are never touched. A `lead_sighting_bids` row is also held until its `lead_sightings` row has been purged, so the two tables always cover the same stretch and can be queried as a pair (#1167). Each run is recorded in `job_runs` as `sightings-buffer-purge`, with the rows deleted per table and `ok` (drained) or `budget` (stopped with work left for the next hour). A failed or missing run is paged by the pg_cron watch.

### Past-month sightings partitions

`lead_sightings`, `lead_sighting_bids` and `achieve_evaluations` are partitioned by month and drained row by row once exported to Snowflake. A nightly pg_cron job (`drop-exported-sighting-partitions`, 08:10 UTC) then drops a past month's partition, but only when no row in it is still waiting to export, none was set aside because Snowflake refused it (#427), and every row was exported more than 24 hours ago. The current month and the months ahead are never touched. Every decision, including a refusal and its reason, is logged in `purge_run_log` under job `sightings-partition-drop` (#464).

A dropped month can no longer be re-imported with `POST /api/admin/backfill-sightings`, which writes rows with their original timestamps: the insert fails until the month's partition is recreated by hand (`CREATE TABLE public.lead_sightings_YYYY_MM PARTITION OF public.lead_sightings FOR VALUES FROM (...) TO (...)`, and the same for `lead_sighting_bids`). Those months are already in Snowflake, which is canonical.

## See also

- [Error handling](./error-handling.md) - error classification, retries, fallbacks, and alert configuration
- [Workflows and executions](../concepts/workflows-and-executions.md) - statuses, outcomes, resume vs replay
- [Testing and debugging](../guides/testing-and-debugging.md) - running test payloads and reading results
- [Partners](../reference/partners.md) - caps, dedup, circuit breakers, and bid resolution
- [Data references](../concepts/data-references.md) - the `steps.*`, `trigger.*`, `env.*` syntax
