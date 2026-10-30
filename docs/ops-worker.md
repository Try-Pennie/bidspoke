# The ops Worker

The ops Worker (`bidspoke-worker-ops`, config `apps/worker/wrangler.ops.toml`,
code `apps/worker/src/ops/`) runs the workflows ported off Pipedream, against
its own database (CLAUDE.md, "The ops database is a separate Supabase project").
It serves only when its `LANE` var is `ops`. The rules a session needs before
touching it are in CLAUDE.md; this page holds the mechanics behind them.

Related pages: connection logins and the OpsConnections entrypoint are in
[ops-connections-logins.md](./ops-connections-logins.md); the tick's pages,
sweeps and heartbeats are in
[reference/observability.md](./reference/observability.md) ("The ops minute
cron"); the platform ceilings it was measured against are in
[ops-ceilings-spike.md](./ops-ceilings-spike.md); recovery and rollback floors
are in [disaster-recovery.md](./disaster-recovery.md).

## Reads

Its database client and its one read live in `src/ops/ops-db.ts`: every ops
query goes through `readOpsRows`, which takes an `OrganizationId` by type,
filters on it and refuses a row of any other organization.
`apps/web/src/lib/__guards__/worker/ops-reads-through-helper.test.ts` fails on
any other `.from(`, `.rpc(` or `.schema(` against the ops client.

Both database clients (bidding and ops) carry the local dev write guard in
`src/lib/local-dev-write-guard.ts` (CLAUDE.md, "Local dev is read-only against
production").

## Writes

Ops writes go through one choke point that the database enforces (#1948):
`service_role` holds SELECT only on the run engine tables, so every write is one
of the SECURITY DEFINER functions, and `callOpsRpc` in `src/ops/ops-writes.ts`
is the only `.rpc(` on the ops client and refuses any function not listed in
`src/ops/ops-rpcs.ts`. A new ops function goes in `ops-rpcs.ts`. A new run
status or reason goes in `src/ops/run-vocabulary.ts` together with its CHECK
constraint, which a test compares.

## Handing a run off

The ops Worker binds itself as `SELF` to the `OpsInternal` entrypoint, so a run
handed off there gets its own 30 s of CPU but no wall clock of its own: it is
cancelled the moment the invocation that sent it ends. So the sender must await
every run it dispatches (#1946, measured in
[ops-ceilings-spike.md](./ops-ceilings-spike.md)).

## The minute tick

Its minute cron (#1949) runs one tick of `src/ops/tick.ts`.

`wrangler.ops.toml` always names its cron, because a config that names no cron
leaves the old one firing.

**Observe mode, as deployed.** With `OPS_TICK_MODE` unset (or naming no mode,
which is reported as not configured), the tick computes which schedule slots are
due on the database clock, records each in `schedule_fire_observations`, and
sends each to `OpsInternal.observe` signed (`src/ops/dispatch-auth.ts`), but
claims and runs nothing. With `OPS_TICK_MODE=live` (#1950,
`src/ops/tick-live.ts`) it records real fires, claims runs and runs each.

**Workflow state.** It reads the ops workflows' state from the bidding Worker's
`OpsGateway` entrypoint over its `OPS_GATEWAY` binding (Dan's decision 4,
2026-10-16, recorded on #1698 and #1949: the bidding database stays the one home
of every definition) and keeps the last good copy in `ops_workflow_copies`. It
plans from that copy as saved, never from its own fetch, and a copy not newer
than the last known switch off may not start.

**Connections.** The same tick keeps the ops connections the same way (#2335,
`src/ops/connection-serve.ts`). `OpsGateway.opsConnections()` serves every
`ops_key` row's sealed envelope, public config and target, never a plaintext
login and never a `bidding_ring` row, each with `serve_until` 6 hours ahead
(Dan's decision 3), plus the removals of the last 7 hours. Each malformed row is
refused by name in `lib/ops-gateway-contract.ts`. With bidding down, a copy is
refused as `connection_copy_expired` once its window passes
(`src/ops/__tests__/connection-copy-outage.test.ts`; what that means for
recovery is in disaster-recovery.md, system inventory).

**Money's identity.** `OpsGateway.moneyIdentities(organizationId)` serves the
money Salesforce org id and username, measured daily on bidding
(`lib/money-identity.ts`, `money-identity` in `CRON_JOBS`), so ops verify can
refuse a connection that authenticates as money's user (ops-connections-logins.md,
OpsConnections).

**Heartbeat.** The tick stamps its heartbeat through the gateway, so the bidding
Worker watches it (`ops-tick` in `cron-heartbeat.ts`).

**Other sweeps.** The tick's other sweeps (Salesforce limits every 240 s,
connection checks every 14 minutes) and the Salesforce lane caps, which arrive
only by an approval migration naming who approved, are described in
reference/observability.md and ops-connections-logins.md.

## Rate limit waits

A step a service rate limits (a 429, or a 503 with Retry-After) suspends its run
as `rate_limit_wait`, which spends no retry attempt. One step may wait at most
10 times, and never past 6 hours after its first wait; the wait past either
fails the run as `requeue_cap_reached` (#2859). The bounds are
`OPS_STEP_REQUEUE_MAX` and `OPS_STEP_REQUEUE_WAIT_MAX_MS` in
`src/ops/run-vocabulary.ts`, which a test holds equal to
`complete_run_request`'s constants; Dan kept these values on 2026-10-27. How a
429 is read per service is in ops-connections-logins.md.

## Runs that cannot start

A claimed run whose definition (`definition_unavailable`, `src/ops/run-live.ts`)
or variables (`variables_unavailable`, `src/ops/tick.ts`) could not be had is
returned to the queue unstarted, spending no attempt (#3023), and names that
cause. `complete_run_request` counts each such return (`unstarted_returns`) and
gives the run up an hour into its wait, measured on the database clock from its
first unstarted return since it last started (`unstarted_since`): the return an
hour or more on fails the run as `unstarted_wait_exceeded` (#3039, Dan's
decision of 2026-10-30). The hour is `OPS_UNSTARTED_WAIT_MAX_MS` in
`src/ops/run-vocabulary.ts`, which a test holds equal to the function's
constant. Once a workflow's oldest such run has waited 15 minutes, the tick
pages it on a page of its own, Ops runs can't start (reference/observability.md).

## A run's environment variables

Dan's decisions of 2026-10-28 and 29 (#2982), reversing #2702's "frozen with the
version": a run reads each variable's CURRENT value when it starts, secrets
included ("Any secret, no exceptions").

- **Where the values come from.** After claiming runs, the minute tick asks the
  bidding Worker once per organization (`OpsGateway.opsRunVariables`,
  `readOpsRunVariables` in `lib/ops-gateway.ts`), which derives the names from
  the version it holds (`envReferences`), resolves them with the one resolver
  (`lib/resolve-variables.ts`, through `lib/current-variables.ts`) and decrypts
  each secret. Each run's answer rides its signed dispatch
  (`src/ops/run-variables.ts`).
- **What is kept.** A run's first start records the plain values and the secret
  NAMES only (`run_requests.run_variables`), so every retry and continued slice
  runs on what it started with. A secret's value is never stored on ops: it is
  masked out of every step record, error and log (`src/ops/mask-secrets.ts`).
- **While bidding cannot be reached**, a run may use the last good copy of the
  plain values (`ops_variable_copies`, `src/ops/variable-copies.ts`, written
  only by the tick); a run reading a secret cannot, and waits.
- **A missing variable.** A variable missing when a run starts fails it by name
  before anything sends (`runVariablesFor`), with the status reason
  `variable_unavailable` (#3000). The step test is sent the current
  values the same way (`routes/api/ops-step-test.ts`) and refuses a missing one
  (`step_test_variable_unavailable`).
- **At save.** Saving a switched on ops workflow, switching one on, or restoring
  onto one is refused up front (`variable_unavailable`) only when it reads a
  variable that does not exist for it; a secret is a variable like any other
  (#3003). `judgeVariables` in `lib/definition-env-references.ts` is that one
  judgement, for the live save and the step test.
- **What pages** (#3000, phase 4 of #2982). Each run reports where the
  variables it ran on came from and how old they were at its start
  (`RunInvocationReport.variables`), and the tick pages, each on a page of its
  own (`OPS_OWN_PAGES` in `lib/ops-gateway-contract.ts`, `judgeVariables` in
  `src/ops/tick.ts`): runs that started on the copy while bidding answered the
  copy's refresh in the same tick; the refresh failing three ticks in a row;
  an answer from bidding ops cannot read; and a switched on workflow's runs
  failing with `variable_unavailable`; and a switched on workflow's runs
  that bidding refused their variables (`refusedRunEnd`, status reason
  `variables_refused`, #3131), named from the refusal's fields, at once,
  except a refusal because the workflow is off the ops lane, which pages
  three ticks in a row. The refresh is skipped only when the
  tick's own workflow fetch failed, so it runs beside a claimed ask that failed.
  Each page is in reference/observability.md.
- **Retired.** The version capture #2702 added (`capture_version_env_variables`,
  `workflow_versions.env_capture`, `ops_workflow_definitions.variables`,
  `save_workflow_definition`'s `p_variables`) is dropped (#3003: bidding
  migration `20261030230000_drop_version_env_capture_3003.sql`, ops migration
  `20261030230000_drop_version_variables_3003.sql`). Switching an ops workflow
  on writes no version (Dan, 2026-10-30).

The ops Worker's own secrets are a separate list: see CLAUDE.md, Worker secrets.

## Testing a step

The canvas's test goes through `routes/api/ops-step-test.ts` to
`OpsConnections.testStep`, which runs the step on ops (`src/ops/step-test.ts`)
and keeps its result in `step_test_results`; `stepTestResult` reads it back. The
two methods, the `step_test_send_unconfirmed` refusal and what each writes are
in the OpsConnections table of ops-connections-logins.md. Both methods are on
`OPS_CONNECTIONS_METHODS` since the ops deploy carried them (#2764), so CI's
deployed ops check requires them. A kept result is purged after 7 days by
`purge_step_test_results`, nightly.

A test of an action that changes something is refused unless the person ticked
Send for real (`confirm_send`). Each such action says what a test sends in its
catalogue `realSend` (packages/service-catalogue/README.md).

## Step records

Each step an ops run walks is recorded on ops as it finishes (`record_ops_step`
into `ops_step_records`, purged past 7 days by `purge_ops_step_records`, #2703),
and `run_step_context` reads a past run's steps for Build from run.
