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
| The ops minute cron reported a problem | A tick reported a problem that is due to page: one that pages at once, or one that three ticks in a row reported, or for a kind judged by its sweep's runs, three runs of that sweep. A context line `Reported by 3 or more ticks in a row.` (or `runs of its sweep`, or `ticks, or runs of its sweep`) says every problem on the page is the second kind. |
| The ops minute cron is not configured | A secret the tick needs is unset or unusable. It names the secret and its remedy, and pages at once. |
| An ops connection needs to be reconnected | Sent to the connection's own organization (its Slack alert channel, under the configuration alerts toggle), naming the connection and its service. Its login is in `needs_reauth`: the service refused it, refused its requests after a new login, or its sign in service failed for more than 15 minutes. A person reconnects it on the Connections page. Pages at once. |
| An ops connection cannot sign in | Sent the same way. Its login is in `refresh_failing` and has met Dan's decision 2 bound: 5 failed sign ins in a row, the first at least 15 minutes ago, each because the service's sign in did not answer. Its next failure turns it into `needs_reauth`. Check the service's status; if its sign in works, reconnect the connection. |

**Three ticks in a row (#2506, Dan's decision 2026-10-19).** Every problem in a report carries a key: its kind, and what it is about where there is one (a sweep, a workflow, a connection, a secret), such as `sweep_failed:run_expiry`. The bidding Worker counts each key's ticks in a row as the report arrives, never by the problem's sentence, which carries an error's own words and figures. A problem a passing tick would clear pages only on the third tick in a row that reports it; one tick's is logged and counted. A tick without that problem, a clean one included, ends its count, except for a kind judged by its sweep's runs (below). The rule for each kind is `OPS_TICK_PROBLEM_RULES` in `apps/worker/src/lib/ops-gateway-contract.ts`:

| Rule | Kinds |
|---|---|
| Three ticks in a row | `start_stamp`, `db_clock`, `sweep_claim_failed` (any sweep), `sweep_failed` (lease_expiry, run_expiry, tombstone_expiry, sf_lease_expiry), `workflows_fetch_failed`, `workflows_save_failed`, `copies_read_failed`, `schedule_plan_failed`, `claim_depth_failed`, `probe_failed`, `connections_fetch_failed`, `connections_save_failed`, `tombstone_record_failed`, `problems_left_out`, `connection_logins_failed` (the login states, read every tick, could not be read), `sf_limits_read_failing` (three runs of the sf_limits sweep in a row, not three ticks: a timeout, a busy pool, a 5xx, a rate limit or a write the ops database missed while the org's reading is still under 7 minutes old, per org) |
| At once, not transient | `db_not_configured`, `not_configured`, `secrets_unchecked`, `queue_disagreement`, `workflow_refused`, `workflows_too_many`, `copies_read_limit`, `schedule_refused`, `schedule_no_version`, `connections_list_unreadable`, `connection_refused`, `connections_too_many`, `connection_copies_expired`, `connections_step_failed` |
| At once, never reported again by a later tick | `slot_missed` (recorded once), `dispatch_failed` (a slot is dispatched once), `agreement_check_failed` (the check runs every 14 minutes) |
| At once, written by the bidding Worker | `report_unreadable`, and `unkeyed` for each problem of an ops release before #2506, except a lone missed start stamp, which is held as `start_stamp` |
| At once, from the sf_limits sweep, judged by its runs | `sf_limits_failed` (the list of measured orgs could not be read), `sf_limits_orgs_limit` (as many measured orgs as one sweep reads), `sf_limits_refused` (a refusal the next read meets again, per org), `sf_limits_unreadable` (a DailyApiRequests that cannot be read, per org), `sf_limits_read_failed` (the same failure once the org's reading is 7 minutes old or more, or the org has none, so the pool is going unmeasured, per org) |
| At once, from the connection_check sweep, which runs every fourteenth tick and so holds a passing failure itself, and from the login states | `connection_check_failed` (the list of connections could not be read), `connection_check_limit` (as many connections as one sweep checks), `connection_check_refused` (a refusal the next probe meets again: a 4xx, a refusal by rule, an identity other than the one verified, per connection), `connection_check_unreadable` (an identity answer that is not one, per connection), `connection_check_unavailable` (a timeout, a 5xx, a network error, a busy pool, a budget floor or a rate limit, paged only once the connection's last passing check is older than 20 minutes, so the second in a row, per connection), `connection_logins_limit` (more connections, or more logins due, than one read or report carries) |
| At once, from the write back check, which rides the connection_check sweep's interval | `write_back_unreadable` (a ConnectionTokenObject that could not say whether it holds a login not yet saved back: unreachable, past its 10 second deadline, failed, refused, an answer that cannot be read, or not asked because the check's budget was spent, per connection), `write_back_limit` (more connections than one read carries, or more due than one report carries), `write_back_check_failed` (the list of connections could not be read on the tick that owns the sweep, or the check threw) |

Kinds judged by their sweep's runs (`OPS_TICK_PROBLEM_SWEEPS`, #2340): `sf_limits_failed`, `sf_limits_orgs_limit`, `sf_limits_refused`, `sf_limits_unreadable`, `sf_limits_read_failed`, `sf_limits_read_failing`, each the sf_limits sweep's.

**Judged by its sweep's runs (#2340).** The sf_limits sweep runs on one tick in four, so its problems are on one report in four. Each report says which sweeps its tick ran (`sweeps_run`: each whose claim it owned). On a tick that did not run the sweep, the bidding Worker carries each of that sweep's problems as it stood, with its sentence and its count, so it neither counts, ends, nor is stood down: the page stands, and its all clear goes out only once a run of the sweep no longer reports it (and nothing else stands). Three in a row for such a kind is three runs of the sweep, about 8 to 10 minutes after the first failure. Before this, the clean tick after a sweep's page was read as its all clear and the next run paged it as new. A report from an ops release that does not say which sweeps ran carries nothing. A clean tick whose count could not be read is neither paged nor read as clean, since a sweep's problem may still stand. The connection_check sweep, the write back check and the queue_agreement sweep report the same way and are not judged by their runs yet.

A kind the bidding Worker has no rule for pages at once. A page lists only the problems due to page; problems held beside them are in the logs. A tick whose every problem is held pages nothing and is not read as clean either, so an open incident stays open until a clean tick stands it down.

**How to read it.** In the bidding Worker's logs (`bidspoke-worker`):

- `ops_tick_problem_held`: a problem held, with its `key`, `in_a_row`, `pages_at` (3) and `counted_by` (`tick`, or the sweep whose runs judge it). One line per held problem per tick that reports it.
- `ops_tick_count_unknown`: the count in KV could not be read (`why: read`) or written (`why: write`). That tick's problems page rather than being held, since a count that cannot be carried could hold a problem for ever.
- `[ops-tick] held tick`: the minute check found only held problems.

Every problem's sentence is in the ops Worker's own logs (`bidspoke-worker-ops`), event `ops_tick`, step `problem`, with its `key`.

**The count in KV.** One record, `ops-tick:problem-streaks` in `IDEMPOTENCY`, written as each report arrives, with a 10 minute expiry that every tick keeping a problem standing renews; a clean tick with nothing carried removes it. Beside each count of a kind judged by its sweep's runs it keeps that problem's sentence (`texts`), which a tick that did not run the sweep carries; a count from a release before that carries the problem named by its key. A record older than 10 minutes, by its own time, starts every count afresh even before KV expires it. The same report delivered twice counts once. Two overlapping ticks, or a KV read in another location that does not yet see the last write, can delay a page by a tick.

**A tick that stops reporting** is not this page's to catch: the `ops-tick` cron heartbeat (`apps/worker/src/lib/cron-heartbeat.ts`) pages on a tick that never starts or never finishes, and a report older than 10 minutes is left to it. It pages after 25 minutes with no start, which Dan kept on 2026-10-20 because the next tick recovers a single skipped minute. To check whether the tick ran in a given minute, do not count its log lines: Workers Logs and the ops project's `edge_logs` both lose a few percent of them, so a gap there is not a missed tick. How to count exactly is in the "Counting ticks" section of `docs/ops-ceilings-spike.md` (#2347).

**The sf_limits sweep (#2336).** Inside the tick, claimed every 4 minutes (`claim_ops_sweep('sf_limits', ..., 240)`), the sweep reads each measured Salesforce org's `/services/data/v60.0/limits` through `connectionFetch` (purpose `sf_limits`) and writes its `DailyApiRequests` remaining to `sf_budget_readings`, source `limits`, so `acquire_sf_lease` has a reading younger than 15 minutes whether or not ops is calling that org. Its problems are in the table above. Its counts are in the tick's `finished` line: `sf_limits_orgs`, `sf_limits_recorded`, `sf_limits_held` (a passing failure while the org's reading is still young, reported as `sf_limits_read_failing` and logged as step `sf_limits_held` with the org, the cause and the reading's age; the problem's sentence names neither, so the alerter reads the same failure on every run as one standing problem, #1768) and `sf_limits_stamps_failed`. With no measured org (until the first ops Salesforce connection is verified) it finds nothing and reports nothing.

**A sweep that stops** is the `ops-sf-limits` cron heartbeat's to catch. The sweep stamps start and completion through `OpsGateway.opsJobStarted` and `opsJobCompleted` (`lib/ops-gateway.ts`, #2340) each time it owns its claim, and the bidding Worker pages: stale when no start has arrived for 30 minutes (the tick's own 25 plus one sweep interval, so a dark tick pages as `ops-tick` first), never ran when its entry has been registered for 30 minutes with no start, and vanished when starts go on and nothing has finished for 15 minutes (three sweeps). A stamp the gateway misses once is counted in `sf_limits_stamps_failed` and pages nothing. The bidding Worker logs each completion as `ops_job_completed` with the sweep's counts, and a completion whose report it cannot read as `ops_job_report_unreadable`, still stamped.

**The connection_check sweep (#2340).** Inside the tick, claimed every 14 minutes (`claim_ops_sweep('connection_check', ..., 840)`), so it runs every 14 or 15 minutes, 16 with a missed tick. For each ops connection whose copy can serve (`connection_check_targets`, in three bands (each login state that may page, needs_reauth or refresh_failing, first; then the other servable copies; then the expired ones), least recently checked first within each, read up to 500, the same list the login states are read from; at most 50 probed a sweep) and that is not in `needs_reauth`, it asks the service who the credential is, through `connectionFetch` (purpose `connection_check`) with the service's identity probe, the one verify uses (Salesforce `/services/oauth2/userinfo`, which must still be the org and user verify measured; Snowflake `CURRENT_USER()` and the account, which must be the declared ones), and writes the result with `record_connection_check`, which writes the `last_check_*` columns only. The connections of one Salesforce org are probed one after another, since the `connection_check` purpose share is 1; each check, its record included, has a 30 second deadline, and no check starts once 10 seconds have passed since the sweep began, so a whole sweep, its stamps and read included, takes at most 55 seconds; a connection not reached (`connection_check_deferred`) is held or paged as a check that could not be made (cause `sweep_budget`) and goes first next sweep. A busy pool, a budget floor or a rate limit is not a failed check and records nothing. A refused login or a failing token endpoint is recorded as a failed check and left to the login page below. Its counts are in the tick's `finished` line: `connection_check_connections`, `connection_check_passed`, `connection_check_held` (each also logged as step `connection_check_held` with the connection, the cause and the last pass's age), `connection_check_not_run`, `connection_check_login_failed`, `connection_check_skipped_reauth`, `connection_check_not_servable`, `connection_check_unprobed`, `connection_check_gone`, `connection_check_deferred`, `connection_check_record_failed` and `connection_check_stamps_failed`. With no ops connection (until the first is saved) it finds nothing and reports nothing.

**A connection_check sweep that stops** is the `ops-connection-check` cron heartbeat's to catch, stamped like `ops-sf-limits`: stale when no start has arrived for 50 minutes (the tick's 25 plus one interval with a missed tick, rounded up past the drought), never ran when its entry has been registered for 50 minutes with no start, and vanished when starts go on and nothing has finished for 45 minutes (three sweeps).

**The login page (#2340, signal `ops-connection-login`).** Every tick, whether or not it runs the sweep, reads every connection's login state from the same list after saving the served connections, and its report carries `connection_logins`: each connection in `needs_reauth`, and each in `refresh_failing` with 5 failures, the first at least 15 minutes old (the bound `record_connection_refresh` escalates by, `REFRESH_FAILING_PAGE_FAILURES` and `REFRESH_FAILING_PAGE_SPAN_MS`, held equal to it by `refresh-failing-page-bound.test.ts`). The bidding Worker's minute job `ops-connection-logins` (`lib/ops-connection-logins.ts`) pages each to the connection's organization, keyed on the connection id, named by its `service_connections.name` and service. A change from `refresh_failing` to `needs_reauth` pages at once; a repeat follows the shared reminder schedule. The all clear goes once a complete list no longer names the connection: at once for `needs_reauth`, which only a Reconnect clears, and after the 30 minute re-arm window for `refresh_failing`. A report that is missing, older than 10 minutes, unreadable, not complete, or from a tick that could not read the states sends neither a page nor an all clear and keeps every open incident; the `ops-tick` heartbeat covers a tick that stopped. Its state is `ops-connection-login:state` in `IDEMPOTENCY`, written only when it changes.

**The write back page (#2340 phase 10 item 4, signal `ops-connection-write-back`; the requirement is #2425's).** A person bound login's refresh token rotates, and its `ConnectionTokenObject` keeps the new one in its own storage and hands it back to `service_connections.credential_enc` by its alarm, retried at 0, 0.5, 1.5, 3.5, 7.5 and 15.5 minutes and then every 15. Until it lands the object holds the only copy of that login. The object records when the write back went pending (`pendingSince` in its stored login, version 2; a login it stored before that time was kept is read as pending since an unknown time, never as fresh). The tick that owns the connection_check claim asks every listed connection's object (`writeBackState`, over `CONNECTION_TOKENS`, at most 6 at a time, 10 seconds each, none started past 15 seconds; `src/ops/write-back-check.ts`), so each object is asked once every 14 to 15 minutes and never every minute, and its report carries `write_backs`: each connection pending 30 minutes or more (six tries failed and the wait at its 15 minute ceiling), or pending since an unknown time. The bidding Worker keeps that list apart from the report, as `ops-tick:write-backs` in `IDEMPOTENCY` (a tick that judged none leaves it as it was), and its minute job `ops-connection-write-backs` pages each to the connection's organization, keyed on the connection id, named by its name and service, saying since when and how many tries failed. The all clear goes at once once a complete list no longer names it. A judgement missing, older than 35 minutes (two intervals with a missed tick), unreadable or not complete sends neither a page nor an all clear and keeps every open incident; an object that could not say is the tick problem `write_back_unreadable`. Its state is `ops-connection-write-back:state`. **When it fires:** the login is not lost yet. Check whether Bidspoke itself is failing (an `ops-tick` or bidding alert would say so); if it is up, read the `bidspoke-worker` logs for errors from `store_rotated_envelope`, the compare and set that saves it. A Reconnect does not help, since its new login is saved the same way.

**The three minute jobs that deliver the report (#2519).** `ops-tick-report` (the problems page above), `ops-connection-logins` (the login page) and `ops-connection-write-backs` (the write back page, #2340) each stamp their own heartbeat on the bidding Worker's minute cron, under their own `CRON_JOBS` entries: stale after 10 minutes with no start, and vanished when starts go on and nothing has finished for 10 minutes, as every minute job of the bidding Worker. So a tick that keeps running while its report stops being delivered pages as the job that stopped, not as the tick. A run that throws is logged and still stamps its completion, as every cron job's does (#985), and pages after three in a row as a scheduled job failing every run (below, #2523).

**The owner check (#2340, signal `ops-connection-owner`).** Once a day on the 13:00 UTC batch (`lib/ops-connection-owner-check.ts`, `ops-connection-owner` in `CRON_JOBS`), the bidding Worker reads every person bound connection (`service_connections.person_bound`, owner `user_id`) and pages the connection's organization for each whose owner's email, lowercased, is no longer on `user_allowlist`, the list access itself reads (the Access page's remove deletes only that row; the `users` row stays). A person bound connection with no owner recorded pages as its own kind. The page names the connection, its owner by display name (never an email), and the organization's workflows whose definition names the connection's id, a switched off one marked. It repeats daily while it stands; the all clear goes once a complete read no longer finds it. A read of the connections, the owners or the Access list that fails judges nothing, keeps every open incident, and pages `The ops connection owner check could not run` through the export alerter (`export-alert:ops-connection-owner`). Its state is `ops-connection-owner:state` in `IDEMPOTENCY`.

**The bulkhead limit check (#2336, signal `salesforce-bulkhead-limit`).** Once a day on the 13:00 UTC batch (`lib/salesforce-bulkhead-check.ts`, `salesforce-bulkhead-check` in `CRON_JOBS`), the bidding Worker pages every organization while `salesforceBulkheadLimit` resolves to anything other than `OPS_LANE_SIZED_FOR_BULKHEAD_LIMIT` (20), the bulkhead limit the ops Salesforce lane's cap was sized against, and sends the all clear once it matches again.

### A scheduled job that stops (`cron-heartbeat`)

The cron heartbeat (`apps/worker/src/lib/cron-heartbeat.ts`) pages a watched job that stops starting (`<job> is dark`) or starts and never finishes (`<job> started and never finished`), and sends one all-clear once a never finished job finishes a run. Jobs dark for one reason share one page (#2117). When every watched job on one schedule is stale together, the schedule did not run, and the page is `Every job that runs <schedule> is dark`, listing the jobs. The jobs of one scheduled run that started and never finished are `<n> jobs of one scheduled run started and never finished`, and once they finish they get one all-clear naming them all. Each job keeps its own reminder schedule and incident; only the Slack post is shared. The never finished page tells the reader to watch whether the next run finishes, because a run Cloudflare cancels can leave no outcome record, and Cloudflare's retry of it, under the same scheduled time, logs `[cron-once] took over` with `previous_age_ms` and can carry an `ok` outcome of its own (#2578).

### A scheduled job failing every run (`minute-job-failing`)

The cron heartbeat (`apps/worker/src/lib/cron-heartbeat.ts`) pages a job that stops starting or stops finishing. A job whose every run finishes but fails reads healthy to it, because a failed run still stamps its completion (#985). So the bidding Worker counts each such job's failed runs in a row (`apps/worker/src/lib/minute-job-failures.ts`, #2523, #2526) and pages every Slack organization past a bound set by its cron (`FAILED_RUN_CADENCES`). The signal is `minute-job-failing`, keyed on the job id, for every cadence; its name predates the slower ones.

| Cron | Jobs | Pages at | Why |
|---|---|---|---|
| Every minute | `buyer-sale-drain`, `unconfirmed-write-sweep`, `salesforce-read-back`, `writeback-drain`, `ops-tick-report`, `ops-connection-logins`, `ops-connection-write-backs` | 3 failed runs in a row, about 2 minutes after the first | One or two failed runs in a row are a blip. Far inside the 10 minute completion drought a dead job pages at. |
| Every 5 minutes | `partner-reachability`, `database-memory`, `partner-page-monitor`, `incident-drain`, `writeback-backlog` | 3, 10 minutes after the first | The same as the heartbeat's 15 minute stale page for a job that stopped from that run on. |
| Every 15 minutes | `buyer-sales-checks`, `tripoint-ping-outcome-rate`, `click-path-checks` | 3, 30 minutes after the first | The same as the 45 minute stale page. |
| Hourly, on the hour | `buyer-select-parity`, `live-share-refusals`, `engine-script-drift` | 2, an hour after the first | Three would be two hours, later than the 2 hour stale page. |

A test holds every bound to page no later than the heartbeat would page the same job had it stopped running. The daily, two hourly and `:23` hourly jobs are not counted.

**What counts as a failed run.** A run whose work throws: the job hands the error to `completeAfter`, which logs it with the job's own failure line, such as `[engine-script-drift] check failed:`, and counts it. The slower jobs count only a throw, never the faults their run summaries list, because those already page on their own (the backlog check's failed read, the incident drain's own failure page, the partner probe's broken probe, the memory check's broken feed, the drift check's unreadable mirror) or are bookkeeping the next run repairs. A throw is the one outcome in which the job's own check and page did not run at all, so nothing pages twice. Two minute jobs also count a run whose summary listed faults they only logged: the ops connection login and write back pages. The write back drain counts a run whose own alerts did not reach Slack (`alert_failures` above zero, #2527), logged as `[writeback-drain] alerts not delivered:`; its alerts stay in its outbox and are tried again each minute. One slower job also counts a summary fault (#2529): the Tripoint outcome rate on tripoint_ping counts a run with finished hours it could not count and keep for its baseline (`rollup_errors`), logged as `[tripoint-ping-outcome-rate] hours not recorded:` with each hour and its error. Each run retries the hours of the last 3 it has not kept, so its page at the third such run in a row (30 minutes) comes before an hour falls out of the baseline for good. Its notify carries only the rate's own lines, and job_runs records such a run as unmeasured without paging, so nothing else pages it. buyer-select-parity's days it could not summarise (`[buyer-select-parity] errors=`) are not counted: they already page, with an all clear, through the export alerter inside the refresh (`export-alert:buyer-select-parity`).

| | |
|---|---|
| Page | `<job> is failing every run`, for example `Engine script drift check is failing every run`. It says how many runs in a row failed, that each still finishes so its heartbeat reads healthy, what stops working while it fails (the job's `dependents` in `CRON_JOBS`), and the log line to search the `bidspoke-worker` logs for. For the write back drain's alerts it says instead that in each run alerts it owed did not reach Slack, and that nobody is told about a stored Salesforce write that was refused, given up or had a field left out. For the Tripoint outcome rate's hours (`Tripoint outcome rate on tripoint_ping is failing every run`) it says that in each run at least one finished hour of Tripoint sends could not be counted and kept for its baseline, that the hours not kept are missing from the 14 day baseline the outcome rate is judged against, and that an hour still not kept 3 hours after it ends is left out of it for good. When the count itself cannot be read or kept, the title is `<job> is failing` and it is sent at once, saying so. A reminder carries `(still)`. |
| All clear | `Recovered`: `<job> has run for 30 minutes without failing.`, once the job has run that long with no failed run, so an hourly job's comes with its first clean run. |
| Reminders | The shared reminder schedule, while the job keeps failing. |
| During a database outage | The page is not held; it carries the outage line, as every other alert does (Dan's decision of 2026-10-14). |

**When the write back drain's alerts cannot get out.** Its page goes to every Slack organization, not only the one the stored write belongs to, so it is heard when the drain's own post is refused or that organization has no Slack connection. When the database is down and no saved Slack copy can stand in, the Better Stack line below speaks instead. When Slack refuses every post for every organization, no Slack page can be heard, this one included.

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
