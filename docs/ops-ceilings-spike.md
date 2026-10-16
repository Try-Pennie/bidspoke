# Ops Worker ceilings and self-dispatch (Spike 0, #1946)

Spike 0 gates the #1698 run engine (plan: discussion #1945): the lease length, the
slice budget, the per tick claim count `k` and whether R2 checkpoint resume (B4) is
needed all follow from the ceilings measured here. Every premise below carries the
command that re-measures it. A reading is what that command returned when it was
last run; re-run the command before relying on the number (L316).

The work is in two stages. Stage 1 (this change) measured everything that needs no
deploy, and adds the code the rest needs, inert. Stage 2 deploys that code to the
ops Worker and arms one probe at a time; it needs Dan's approval because it touches
production. Its steps are at the end.

## What the code adds

- `apps/worker/src/ops/spike/ceilings.ts`: nine probes the ops Worker's minute
  `scheduled()` runs, one per arming. Inert unless the `OPS_SPIKE_ARM` secret is
  set. An unarmed tick touches no binding and logs nothing.
- `apps/worker/src/ops/internal.ts`: `OpsInternal`, a named `WorkerEntrypoint`,
  the self-dispatch target. `ping()` proves arrival; `probe()` runs a callee probe
  only for the current arming. The run engine's run method goes here later.
- `apps/worker/wrangler.ops.toml`: the `SELF` service binding to the Worker's own
  `OpsInternal` entrypoint, and a `* * * * *` cron.
- `OPS_SPIKE_ARM` on the ops Worker's secret allowlist
  (`apps/worker/src/lib/secret-lists.ts`), so the parity check accepts it.
- `scripts/ops-ceilings-spike/`: the local catch-up model and the Workers Logs
  queries used below.

Tests: `apps/worker/src/ops/__tests__/spike-ceilings.test.ts` and
`ops-internal.test.ts` (Node), and `self-dispatch.workers.test.ts` (workerd, the
`ops` project of `pnpm --filter worker test:do`), which proves the real `SELF`
binding reaches `OpsInternal`, that `scheduled()` reaches it through the binding,
that `OpsInternal` refuses a probe it is not armed for, and that every internal
looking path on the public fetch handler answers the ops not found.

### Arming a probe

The arm is JSON: `{"probe": <name>, "nonce": <8 to 64 of a-z 0-9 ->, "until": <ISO time at most 3 hours ahead>}`.
A malformed, expired or too distant arm is refused by name in the logs and runs
nothing. Each nonce runs once: its first tick claims
`spike/1946/<nonce>/claim.json` in the `bidspoke-porting-tee` bucket with a write
that refuses to overwrite, so the next minute, an overlapping tick and Cloudflare's
retry of a killed cron all stand down. A probe that survives writes
`spike/1946/<nonce>/result.json`. Probes built to be killed leave only the claim;
the kill itself, with its CPU and wall time, is in Workers Logs.

| Probe | Measures | Expected end |
|---|---|---|
| `cron_wall` | wall clock of a minute cron | killed near 900,000 ms, outcome `exceededWallTime` |
| `cron_cpu` | CPU of a minute cron | killed, outcome `exceededCpu`; documented 30,000 ms |
| `cron_subrequests` | subrequests per invocation (R2 HEADs) | refused near 10,000 (`Too many subrequests`), recorded in `result.json` |
| `dispatch_ping` | `scheduled()` reaches `OpsInternal` over `SELF` | `result.json` holds `{lane: ops, entrypoint: OpsInternal}` |
| `dispatch_wall` | wall clock of a dispatched sub-invocation | which of caller and callee is killed first, and when |
| `dispatch_cpu` | CPU of a dispatched sub-invocation | whether the callee has its own CPU limit or shares the caller's |
| `dispatch_subrequests` | subrequests inside a sub-invocation | whether the callee has its own budget |
| `dispatch_detached` | a sub-invocation not awaited by its caller | how long the callee's progress lines continue after `detached_returned` |
| `dispatch_fanout` | 40 concurrent dispatches from one invocation | how many succeed, and the first refusal's text (documented limit 32) |

## Premises, with the command that re-measures each

Commands that read Cloudflare need a token with Workers Observability read and
Workers Scripts read on account `3e7f907a9c19e51417873e2cce4fbc5c` in
`CLOUDFLARE_API_TOKEN`. Workers Logs keep 7 days; a longer window is silently
clamped to 7 days, and calculations are sampled (`sampleInterval` about 10), so a
max is a lower bound.

```bash
q() { # q <query file> <worker> <hours back>
  f="scripts/ops-ceilings-spike/queries/$1"; to=$(($(date +%s) * 1000)); from=$((to - $3 * 3600000))
  jq --arg w "$2" --argjson from "$from" --argjson to "$to" \
    '.timeframe = {from: $from, to: $to} | (.parameters.filters[] | select(.value == "WORKER")).value = $w' "$f" |
  curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/3e7f907a9c19e51417873e2cce4fbc5c/workers/observability/telemetry/query" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' --data @- |
  jq '.result.calculations // .result.events.events'
}
```

### P1. A cron's wall clock ceiling is 15 minutes

- Documented: Cron Triggers have 15 minutes of wall time per invocation
  (developers.cloudflare.com/workers/platform/limits, "Wall time limits by
  invocation type").
- Observed on this account: the bidding Worker's `23 * * * *` cron ended
  `exceededWallTime` at 899,991 ms and 900,000 ms on 2026-09-23 (requestIds
  e0dbc114358bad177a8ae2fe929b9577 and 3ba108b44b32baf34499205f693f6551). Both are
  now past log retention.
- Last 7 days, bidding Worker, outcome `ok`, max wall by cron: `* * * * *`
  319,877 ms, `23 * * * *` 402,421 ms, `37 */2 * * *` 316,091 ms, `0 * * * *`
  99,332 ms. No non `ok` scheduled outcome in the window. So a minute cron already
  runs for minutes and overlaps the next minute's.
- Re-measure: `q scheduled-ceilings.json bidspoke-worker 168`. On the ops Worker:
  Stage 2 probe `cron_wall`.

### P2. A minute cron's CPU ceiling is 30 seconds, an hourly one's 15 minutes

- Documented: CPU per Cron Trigger is 30 s below a one hour interval and 15 min
  at one hour or more (limits page, "CPU time"); `limits.cpu_ms` raises HTTP CPU
  to 5 minutes.
- Observed: the bidding Worker sets `cpu_ms = 30000`, yet its hourly
  `23 * * * *` cron used 44,760 ms of CPU with outcome `ok` in the last 7 days,
  and 55,456 ms on 2026-09-23. So `cpu_ms` did not bind an hourly cron. Its minute
  cron's max CPU was 221 ms, so the minute ceiling has never been approached here
  and is UNMEASURED.
- Re-measure: `q scheduled-ceilings.json bidspoke-worker 168` (the `max_cpu_ms`
  rows). On the ops Worker: Stage 2 probe `cron_cpu`. The ops Worker sets no
  `[limits]`: `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/3e7f907a9c19e51417873e2cce4fbc5c/workers/scripts/bidspoke-worker-ops/settings | jq '.result | {compatibility_date, compatibility_flags, limits, usage_model}'`.

### P3. Subrequests: 10,000 per invocation by default

- Documented: paid plans allow 10,000 subrequests per invocation by default,
  configurable to 10 million with `limits.subrequests` (changelog 2026-02-11, which
  removed the old 1,000). R2, KV and D1 calls count. Each call through a service
  binding counts toward the caller's subrequests.
- The bidding Worker's July evidence of a 1,000 budget (two purges sharing one
  invocation, #617) predates that change and no longer describes the platform.
- Re-measure: Stage 2 probes `cron_subrequests` and `dispatch_subrequests`.

### P4. A dispatched sub-invocation lives only as long as its caller

- Documented: a Worker called over RPC is "considered to have disconnected when
  its own execution context ends", and the callee is then canceled unless it
  extends itself with `ctx.waitUntil()`, which allows 30 seconds
  (developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle). "If Worker A
  does not await Worker B, Worker B will be terminated early" (service bindings,
  Lifecycle). A single request may make at most 32 Worker invocations, and each
  service binding call counts toward it (service bindings, Limits).
- Consequence for #1698 B2 and B3, if Stage 2 confirms it: the minute tick cannot
  fire a run and return. It must stay alive, awaiting, for as long as each run it
  dispatched runs, so every run dispatched by one tick shares that tick's
  15 minute wall clock, and one tick can dispatch at most about 31 runs. A run that
  must outlive its tick needs a different carrier (the R2 checkpoint and
  continuation of B4, or a Durable Object alarm), and "hand each run to its own
  invocation" does not by itself give a run more time than the tick that sent it.
- Not documented, so measured in Stage 2: whether the callee's CPU and subrequest
  budgets are its own or the caller's (`dispatch_cpu`, `dispatch_subrequests`),
  which of the two is killed at the wall limit (`dispatch_wall`), and the real
  fan out limit (`dispatch_fanout`).

### P5. Self-dispatch rides a binding to a named entrypoint, never a fetch

- A service binding to a NAMED entrypoint (`entrypoint = "OpsInternal"`) is script
  config, not a zone route, so CI's Cloudflare token can deploy it. RPC over
  service bindings is the default from compatibility date 2024-04-03 and the ops
  Worker is on 2024-09-23, so no date bump is needed. `ctx.exports` would need the
  `enable_ctx_exports` flag (default from 2025-11-17) and is not used.
- Proven locally: wrangler's build of `wrangler.ops.toml` lists
  `env.SELF (bidspoke-worker-ops#OpsInternal)`, and workerd serves the binding
  (`pnpm --filter worker test:do`). Re-measure:
  `cd apps/worker && npx wrangler deploy --dry-run --config wrangler.ops.toml --outdir /tmp/ops-dist`
  (a build only: `--dry-run` uploads nothing).
- Not proven: that Cloudflare accepts a deployed Worker whose binding names
  itself, and an entrypoint the version being uploaded introduces. Stage 2 step 2
  and probe `dispatch_ping`.

### P6. The public edge cannot reach the internal surface

- Structural: Cloudflare routes public traffic to a Worker's default export only,
  so no public request can call a method of `OpsInternal`. The default fetch
  handler routes only `POST /porting/capture/:hashid`; `ops-internal.test.ts` and
  `self-dispatch.workers.test.ts` fail if any internal looking path answers
  anything but the ops not found.
- Observed: outside `/porting/*`, `ops.trypennie.dev` reaches NO Worker. Cloudflare
  answers HTTP 403 `error code: 1014` with no `x-bidspoke-worker` header. Under
  `/porting/*` the ops Worker answers, with the header. Re-measure:

```bash
curl -sS -o /dev/null -D - -X POST https://ops.trypennie.dev/internal/run/spike-probe | grep -i -E '^HTTP|x-bidspoke-worker'
curl -sS -X POST https://ops.trypennie.dev/internal/run/spike-probe
curl -sS -o /dev/null -D - -X POST -H 'content-type: application/json' --data '{}' https://ops.trypennie.dev/porting/capture/__spike_unenrolled | grep -i -E '^HTTP|x-bidspoke-worker'
```

  The first should print `HTTP/2 403` and no header, the second `error code: 1014`,
  the third `HTTP/2 404` and `x-bidspoke-worker: ops`. If the route is ever widened
  to `ops.trypennie.dev/*`, the first two start reaching the ops Worker's fetch
  handler, which still answers not found; that is what the tests hold.

### P7. The ops Worker today

- 33 fetch invocations in 7 days, max wall 3 ms, max CPU 2 ms, no scheduled
  invocations. Compatibility date 2024-09-23, no flags, no `[limits]`, usage model
  standard. Bindings: `PORTING_TEE`, `CODE_NODES_OPS`, `LANE`, and one secret,
  `PORTING_CAPTURE_MASTER`. `OPS_SUPABASE_URL` and `OPS_SUPABASE_SECRET_KEY` are
  NOT set, so the ops Worker cannot read the ops database yet.
- Re-measure: `q invocations-by-type.json bidspoke-worker-ops 168` and the
  settings `curl` in P2 (add `bindings` to the `jq`).

### P8. The ops database: 30 s statement timeout, 1,000 rows per read

- Encoded: `OPS_READ_ROW_CAP = 1000` in `apps/worker/src/ops/ops-db.ts`;
  `readOpsRows` refuses a larger limit.
- Measured on the BIDDING project, not this one: service_role
  `statement_timeout=30s` (`pg_db_role_setting`, 2026-07-10).
- NOT measured on the ops project in Stage 1: the session's permission policy
  refused a production read. Re-measure (read only), with a Supabase access token
  in `SUPABASE_ACCESS_TOKEN`:

```bash
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects/zwihpjxouklvkvngkvmw/postgrest | jq '{max_rows, db_schema}'
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects/zwihpjxouklvkvngkvmw/billing/addons | jq '[.selected_addons[] | {type, variant: .variant.identifier}]'
curl -s -X POST -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'content-type: application/json' \
  "https://api.supabase.com/v1/projects/zwihpjxouklvkvngkvmw/database/query?read_only=true" \
  -d '{"read_only": true, "query": "select r.rolname, s.setconfig from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname in (''service_role'',''authenticator'',''anon'',''authenticated'') union all select ''max_connections'', array[current_setting(''max_connections'')]"}'
```

### P9. The catch-up backlog after an outage

Modelled on synthetic rows in a local Postgres held to Micro's published shape
(2 CPUs, 1 GB). The ROW COUNTS are exact for the inputs; the TIMINGS are a floor,
not a measurement of Micro, whose shared cores are slower than a laptop's. Inputs
not yet measured are stated bounds: 68 schedules is the export's count of switched
on timer triggers (59 crons and 9 intervals, discussion #1684, section 0.4), but
their periods are not in the repository, so every one is assumed to fire every
60 s; 50,000 arrivals a day is a model, not a count.

Re-measure: `bash scripts/ops-ceilings-spike/catch-up.sh [-v outage_h=24 -v period_s=300 ...]`
(Docker; it starts and removes its own container, and never connects anywhere
else). The inputs are psql variables named at the top of `catch-up.sql`.

| Read (rows returned, PostgREST pages of 1,000, ms on the proxy) | 6 h outage | 24 h outage | 72 h, 4x arrivals |
|---|---|---|---|
| every missed fire, materialised | 24,480 / 25 / 2.4 | 97,920 / 98 / 11.5 | 293,760 / 294 / 25.2 |
| latest missed fire per schedule (`catch_up: latest`) | 68 / 1 / 0.0 | 68 / 1 / 0.0 | 68 / 1 / 0.0 |
| expired leases (in flight at the crash) | 500 / 1 / 0.1 | 500 / 1 / 0.1 | 2,000 / 2 / 0.2 |
| queued runs, whole backlog | 12,500 / 13 / 0.8 | 50,000 / 50 / 5.9 | 600,000 / 600 / 35.2 |
| one fair claim call (CTE, LATERAL, SKIP LOCKED, k 5, limit 100) | 100 / 1 / 1.5 | 100 / 1 / 3.8 | 100 / 1 / 40.6 |
| reconciliation read over 24 h of history, NO index | 37,500 / 38 / 60.8 | 0 / 0 / 41.1 | 0 / 0 / 1,341.8 |

History: 1,513,000, 1,550,500 and 6,602,000 rows in `run_requests` respectively
(30 days of terminal rows plus the backlog).

What it says for B1 to B3:

- Every read that drains a backlog exceeds 1,000 rows after a few hours, so it
  must be an RPC with an explicit `LIMIT` looped until drained, or keyset
  paginated; a bare `readOpsRows` list would return the first 1,000 and read as
  "nothing more due" (L24). The only bounded reads are the latest fire per
  schedule (one per schedule) and the lease sweep (bounded by in flight runs).
- Materialising every missed fire is the volume to avoid: it grows as
  schedules x outage / period. `catch_up: latest` keeps it at one per schedule.
- On the proxy nothing approaches 30 s. The slowest statement is the one with no
  index (a full scan of `run_requests`, 1.3 s at 6.6 million rows), so every
  sweep over history needs an index or a partition bound; the fair claim's cost
  grows with the backlog (the `DISTINCT workflow_id` over the queue) and should be
  re-measured on Micro at the backlog B1 sizes for.
- Stage 2 re-runs the timing on the real Micro once B1's tables exist (#1948);
  until then these are the only numbers, and they are optimistic.

## Stage 2: deploy and measure (needs Dan's approval)

Each step names what it touches in production, its risk and its rollback.

1. Read the ops project's configuration (P8 commands). Touches: read only queries
   against the ops database and the Management API. Risk: none to data; it is a
   production read, which is why it waits. Rollback: none needed.
2. Deploy the branch to `bidspoke-worker-ops`, either by merging the pull request
   (CI's Deploy Ops Worker job deploys it and proves `ops.trypennie.dev` still
   answers) or, keeping it unmerged, `cd apps/worker && npx wrangler deploy --config wrangler.ops.toml`
   from the branch. Touches: the ops Worker's code, a new `SELF` binding and a new
   minute cron (one of the account's 250). The money Worker is untouched. Risk: the
   upload may be refused if Cloudflare will not let a version bind to an
   entrypoint it introduces itself; then deploy once without the `[[services]]`
   block and again with it. An unarmed minute cron costs about 43,000 invocations a
   month, inside the plan. Rollback: `npx wrangler rollback --name bidspoke-worker-ops`
   to the previous version, or redeploy main (which drops the cron and binding).
3. Arm `dispatch_ping` (prove self-dispatch in production first):
   `printf '%s' '{"probe":"dispatch_ping","nonce":"s0-ping-01","until":"<now + 1 h, ISO>"}' | npx wrangler secret put OPS_SPIKE_ARM --config wrangler.ops.toml`.
   Read: `npx wrangler r2 object get bidspoke-porting-tee/spike/1946/s0-ping-01/result.json --remote --pipe`.
   Touches: one secret (a new Worker version), two R2 objects. Risk: none beyond
   the binding. Rollback: `npx wrangler secret delete OPS_SPIKE_ARM --config wrangler.ops.toml`.
4. Arm, one at a time, each with a new nonce, waiting for each to end:
   `cron_subrequests`, `dispatch_subrequests`, `dispatch_fanout`,
   `dispatch_detached`, `cron_cpu`, `dispatch_cpu`, `cron_wall`, `dispatch_wall`.
   Read each with `q spike-events.json bidspoke-worker-ops 2` (after putting the
   nonce in place of `NONCE` in the query file's filter) for the progress lines and
   the requestId, then the invocation's own `$workers.outcome`, `cpuTimeMs` and
   `wallTimeMs` by filtering on that requestId. Touches: the ops Worker's CPU and
   wall time (a probe can hold a cron invocation for 15 minutes), up to 12,000 R2
   HEAD requests per subrequest probe (Class B, about $0.005), nothing else. Risk:
   none to the money path, which shares no Worker, binding or database with it; the
   ops Worker's porting capture route stays served by other isolates. Rollback:
   delete the secret; a running probe ends at its cap or its kill.
5. Disarm and remove: delete `OPS_SPIKE_ARM`, record each reading in this file
   beside its premise, then the change that closes #1946 removes `spike/ceilings.ts`,
   `OpsInternal.probe`, the spike cron and the allowlist entry, keeping `SELF` and
   `OpsInternal.ping` for B2. Delete `spike/1946/` from the bucket (or let its
   90 day lifecycle rule do it).
6. After B1's tables exist (#1948): rerun P9 against the real Micro (a copy of the B1
   schema seeded with synthetic rows in the ops project, then dropped), which is a
   load on the production ops database and needs its own approval.
