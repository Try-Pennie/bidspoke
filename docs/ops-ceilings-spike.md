# Ops Worker ceilings and self-dispatch (Spike 0, #1946)

Spike 0 gates the #1698 run engine (plan: discussion #1945): the lease length, the
slice budget, the per tick claim count `k` and whether R2 checkpoint resume (B4) is
needed all follow from the ceilings measured here. Every premise below carries the
command that re-measures it. Where that command needs the removed probes, it says
so and points at "Arming a probe", which says how to restore them; P3 also needs
the restored probe changed. A reading is what that command returned when it was
last run; re-run the command before relying on the number (L316).

The work was in two stages. Stage 1 (#2266) measured everything that needed no
deploy and shipped the probe code, inert. Stage 2 (2026-10-16, approved by Dan)
deployed it to the ops Worker, ran each probe once, and recorded the readings
below. #2286 then removed the probes and the `OPS_SPIKE_ARM` allowlist entry,
and a following change set `crons = []` to remove the cron (dropping the
`[triggers]` block alone left it registered), keeping the `SELF` binding and `OpsInternal.ping`
for the run engine's tick (B2).

## Measured in production (Stage 2)

Each line is one probe run once on `bidspoke-worker-ops` (compatibility date
2024-09-23, no `[limits]`, Workers Paid, standard usage model), read from Workers
Logs: the invocation's own `$workers.outcome`, `wallTimeMs` and `cpuTimeMs`.

| Probe (nonce) | Reading |
|---|---|
| `dispatch_ping` (s0-ping-01) | `scheduled()` reached `OpsInternal` through `SELF`: `result.json` = `{lane: ops, entrypoint: OpsInternal}`. The upload with a binding to the Worker's own new entrypoint was ACCEPTED in one step. |
| `cron_subrequests` (s0-csub-01) | Ran sequential R2 HEADs at about 4.7 a second (about 210 ms each) and was ended by the WALL limit before the subrequest limit: outcome `canceled`, wall 899,751 ms, CPU 822 ms, about 3,900 subrequests done. The 10,000 subrequest ceiling was not reached and stays documented, not measured. |
| `dispatch_subrequests` (s0-dsub-01) | The callee is its own invocation (`eventType: jsrpc`, entrypoint `OpsInternal`, its own requestId) and made about 4,600 R2 HEADs. Caller and callee end records carry the same timestamp (16:24:48.685 UTC), the caller's cron wall; their wall times differ by about 600 ms because the callee started about 600 ms later: caller `canceled` at 899,986 ms, callee `canceled` at 899,368 ms (CPU 982 ms). |
| `dispatch_fanout` (s0-fan-01) | 40 concurrent `ping()` dispatches from one `scheduled()`: 40 fulfilled, 0 refused, each its own `jsrpc` invocation of about 7 ms. The documented 32 invocations per request did NOT refuse 40 fanned out calls; a larger fan out was not tried. |
| `dispatch_detached` (s0-det-01) | A dispatch the caller did not await was CANCELED when the caller's invocation ended: callee `canceled` at 908 ms, before its first 10 s progress step. |
| `cron_cpu` (s0-ccpu-01) | Outcome `exceededCpu` at CPU 32,000 ms (wall 36,974 ms). The minute cron's CPU ceiling is the documented 30 s plus the platform's small allowance. |
| `dispatch_cpu` (s0-dcpu-01) | The callee has its OWN CPU budget: callee `exceededCpu` at 32,000 ms (wall 36,056 ms) while the caller used 1 ms and ended `ok`, receiving `Worker exceeded CPU time limit.` as the call's error. |
| `cron_wall` (s0-cwall-01) | Outcome `canceled` (not `exceededWallTime`) at wall 899,707 ms, CPU 7 ms; the last progress line read 890,000 ms. The minute cron's wall ceiling is 15 minutes, as for the hourly crons. |
| `dispatch_wall` (s0-dwall-01) | A callee asked to wait 16 minutes was ended with its caller: caller `canceled` at 899,749 ms, callee `canceled` at 899,057 ms, both logged at 17:05:48.507 UTC (the callee started about 700 ms later). A dispatched run has no wall clock of its own beyond its tick's. |

Also measured on the way:

- A new cron trigger took about 16 minutes to start firing: the schedule was
  created at 15:32:52 UTC and the first `scheduled()` ran at 15:49:00 UTC. Later
  deploys that kept the same trigger did not restart that wait.
- `scheduledTime` on this Worker's minute cron is not on the minute boundary (it
  read :48.004 within each minute), so nothing may key on it being aligned.
- The ops project (P8): PostgREST `max_rows` is 1000; compute is Micro; Postgres
  17.11 on x86_64; `max_connections` 60. Role statement timeouts: `anon` 3 s,
  `authenticated` 8 s, `authenticator` 8 s (with `lock_timeout` 8 s), and
  `service_role` has NO statement timeout of its own, unlike the bidding project's
  30 s. A service_role request through PostgREST therefore runs under the
  `authenticator` session's 8 s, not 30 s, unless PostgREST applies a role setting
  that does not exist; this is inferred from the settings, not timed.

What it means for the run engine (#1698):

- B2: dispatching a run to `OpsInternal` gives it its own 30 s of CPU, but not its
  own wall clock. A dispatched run dies the moment the tick that dispatched it
  ends, whether the tick returns early (detached) or hits its 15 minute wall. So
  the tick must await every run it dispatches, and every run in one tick shares
  that tick's 15 minutes. Overlapping ticks are normal (the money Worker's minute
  cron already runs for minutes), so B2's claim must assume several live ticks.
- B3: the lease must be shorter than the time a tick can still live, and the
  heartbeat must come from the run itself. A run longer than its tick's remaining
  wall time is cut off with no error to the run, so per run work is bounded by
  (15 min minus the tick's elapsed time), and CPU by 30 s per dispatched run.
- B4: a run whose work exceeds about 30 s of CPU, or must outlive its tick, needs
  the R2 checkpoint and continuation. On these numbers B4 is needed for any long
  ported workflow, not optional.
- Fan out: 40 concurrent dispatches from one tick worked, so the documented 32 is
  not a per tick cap in practice; size `k` from the database (P8, P9), not from it.
- Database: plan B1 to B3 against an 8 s statement timeout on the ops project,
  or set service_role's own timeout deliberately, before relying on 30 s.

### Arming a probe (how the removed probes worked)

The probe code is REMOVED from the repository. To re-measure with it: on a
branch, revert the squash commit of pull request #2286 (found with
`git log --oneline --grep '#2286'`), which restores `src/ops/spike/ceilings.ts`, `OpsInternal.probe`, the cron and the
`OPS_SPIKE_ARM` allowlist entry; deploy that branch to `bidspoke-worker-ops`, wait
about 16 minutes for the new cron to fire, then arm as below. The code it restores
is the code #2266 merged as f5c19ef8. The rest of this section describes that
code, in the past tense.

The arm was JSON: `{"probe": <name>, "nonce": <8 to 64 of a-z 0-9 ->, "until": <ISO time at most 3 hours ahead>}`.
A malformed, expired or too distant arm was refused by name in the logs and ran
nothing. Each nonce ran once: its first tick claimed
`spike/1946/<nonce>/claim.json` in the `bidspoke-porting-tee` bucket with a write
that refused to overwrite, so the next minute, an overlapping tick and Cloudflare's
retry of a killed cron all stood down. A probe that survived wrote
`spike/1946/<nonce>/result.json`. Probes built to be killed left only the claim;
the kill itself, with its CPU and wall time, is in Workers Logs.

| Probe | Measures | How it ended in Stage 2 |
|---|---|---|
| `cron_wall` | wall clock of a minute cron | `canceled` at 899,707 ms (not `exceededWallTime`) |
| `cron_cpu` | CPU of a minute cron | `exceededCpu` at 32,000 ms |
| `cron_subrequests` | subrequests per invocation (R2 HEADs) | wall limit first, about 3,900 done, no refusal (the HEADs are sequential) |
| `dispatch_ping` | `scheduled()` reaches `OpsInternal` over `SELF` | reached; `result.json` holds `{lane: ops, entrypoint: OpsInternal}` |
| `dispatch_wall` | wall clock of a dispatched sub-invocation | both `canceled` with one end timestamp; caller 899,749 ms, callee 899,057 ms |
| `dispatch_cpu` | CPU of a dispatched sub-invocation | callee `exceededCpu` at 32,000 ms on its own budget; caller `ok` |
| `dispatch_subrequests` | subrequests inside a sub-invocation | wall limit first, about 4,600 done; own or shared budget not settled |
| `dispatch_detached` | a sub-invocation not awaited by its caller | callee `canceled` at 908 ms, as soon as its caller ended |
| `dispatch_fanout` | 40 concurrent dispatches from one invocation | 40 of 40 succeeded (documented limit 32) |

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
- Measured on the ops Worker: `cron_wall` ended `canceled` at 899,707 ms and
  `cron_subrequests` at 899,751 ms (readings table). Re-measure: `q scheduled-ceilings.json bidspoke-worker 168`,
  or restore the probes (Arming a probe, above) and arm `cron_wall`.

### P2. A minute cron's CPU ceiling is 30 seconds, an hourly one's 15 minutes

- Documented: CPU per Cron Trigger is 30 s below a one hour interval and 15 min
  at one hour or more (limits page, "CPU time"); `limits.cpu_ms` raises HTTP CPU
  to 5 minutes.
- Observed: the bidding Worker sets `cpu_ms = 30000`, yet its hourly
  `23 * * * *` cron used 44,760 ms of CPU with outcome `ok` in the last 7 days,
  and 55,456 ms on 2026-09-23. So `cpu_ms` did not bind an hourly cron. Its minute
  cron's max CPU was 221 ms, so the minute ceiling was never approached there.
- Measured on the ops Worker's minute cron: `exceededCpu` at 32,000 ms (readings
  table, `cron_cpu`).
- Re-measure: `q scheduled-ceilings.json bidspoke-worker 168` (the `max_cpu_ms`
  rows), or restore the probes (Arming a probe) and arm `cron_cpu`. The ops Worker sets no
  `[limits]`: `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/3e7f907a9c19e51417873e2cce4fbc5c/workers/scripts/bidspoke-worker-ops/settings | jq '.result | {compatibility_date, compatibility_flags, limits, usage_model}'`.

### P3. Subrequests: 10,000 per invocation by default

- Documented: paid plans allow 10,000 subrequests per invocation by default,
  configurable to 10 million with `limits.subrequests` (changelog 2026-02-11, which
  removed the old 1,000). R2, KV and D1 calls count. Each call through a service
  binding counts toward the caller's subrequests.
- The bidding Worker's July evidence of a 1,000 budget (two purges sharing one
  invocation, #617) predates that change and no longer describes the platform.
- Not reached in Stage 2: sequential R2 HEADs from the ops cron ran at about 4.7 a
  second, so 15 minutes of wall time ended both subrequest probes at about 3,900
  and 4,600. Reaching 10,000 needs concurrent subrequests, which the restored probe
  does not issue (it is sequential); measuring the ceiling means changing it to
  issue them in parallel batches first.

### P4. A dispatched sub-invocation lives only as long as its caller

- Documented: a Worker called over RPC is "considered to have disconnected when
  its own execution context ends", and the callee is then canceled unless it
  extends itself with `ctx.waitUntil()`, which allows 30 seconds
  (developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle). "If Worker A
  does not await Worker B, Worker B will be terminated early" (service bindings,
  Lifecycle). A single request may make at most 32 Worker invocations, and each
  service binding call counts toward it (service bindings, Limits).
- CONFIRMED in production (readings table, `dispatch_detached`,
  `dispatch_subrequests`, `dispatch_wall`): the callee is canceled when the caller
  ends, early or at its wall limit. The 32 invocation figure did not refuse 40
  concurrent dispatches (`dispatch_fanout`).
- Consequence for #1698 B2 and B3: the minute tick cannot
  fire a run and return. It must stay alive, awaiting, for as long as each run it
  dispatched runs, so every run dispatched by one tick shares that tick's
  15 minute wall clock (one tick dispatched 40 runs without refusal). A run that
  must outlive its tick needs a different carrier (the R2 checkpoint and
  continuation of B4, or a Durable Object alarm), and "hand each run to its own
  invocation" does not by itself give a run more time than the tick that sent it.
- Measured: the callee's CPU budget is its own (`dispatch_cpu`: callee killed at
  32,000 ms CPU, caller untouched). Whether its subrequest budget is its own is
  not settled: neither side came near 10,000.

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
- Proven in production: Cloudflare accepted the upload of a version whose `SELF`
  binding names its own new entrypoint, in one step, and `scheduled()` reached
  `OpsInternal` through it (`dispatch_ping`). Re-measure: the script settings `curl`
  in P2 with `bindings` in the `jq` shows `{type: service, name: SELF,
  service: bidspoke-worker-ops, entrypoint: OpsInternal}`.

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

### P7. The ops Worker before Stage 2

- Before Stage 2: 33 fetch invocations in 7 days, max wall 3 ms, max CPU 2 ms, no
  scheduled invocations (Stage 2 then registered a minute cron at 15:32 UTC, which
  ran the probes until about 17:06 and kept firing, from 19:05 throwing for want of
  a handler, until the `crons = []` deploy removed it; see Stage 2 step 4). Compatibility date 2024-09-23, no flags, no `[limits]`, usage model
  standard. Bindings before Stage 2: `PORTING_TEE`, `CODE_NODES_OPS`, `LANE`, and one
  secret, `PORTING_CAPTURE_MASTER`; after it, also `SELF` (service, entrypoint
  `OpsInternal`), and no cron. `OPS_SUPABASE_URL` and `OPS_SUPABASE_SECRET_KEY` are
  NOT set, so the ops Worker cannot read the ops database yet.
- Re-measure the current state (not the pre Stage 2 reading, which is past log
  retention): `q invocations-by-type.json bidspoke-worker-ops 168` and the settings
  `curl` in P2 (add `bindings` to the `jq`).

### P8. The ops database: 1,000 rows per read, and an 8 s (not 30 s) statement timeout

- Encoded: `OPS_READ_ROW_CAP = 1000` in `apps/worker/src/ops/ops-db.ts`;
  `readOpsRows` refuses a larger limit.
- Measured on the BIDDING project, not this one: service_role
  `statement_timeout=30s` (`pg_db_role_setting`, 2026-07-10).
- Measured on the ops project (Stage 2): `max_rows` 1000; Micro; `max_connections`
  60; `service_role` has NO role statement timeout, `authenticator` has 8 s, so
  PostgREST requests on the ops project are expected to stop at 8 s (inferred from
  the settings; time a slow rpc to confirm once B1 has one). Re-measure (read only),
  with a Supabase access token in `SUPABASE_ACCESS_TOKEN`. The `/postgrest` answer
  also carries the project's JWT secret, so always filter it with `jq` as below:

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
| every missed fire, materialised | 24,480 / 25 / 2.2 | 97,920 / 98 / 8.3 | 293,760 / 294 / 27.3 |
| latest missed fire per schedule (`catch_up: latest`) | 68 / 1 / 0.1 | 68 / 1 / 0.0 | 68 / 1 / 0.1 |
| expired leases (in flight at the crash) | 500 / 1 / 0.1 | 500 / 1 / 0.1 | 2,000 / 2 / 0.4 |
| queued runs, whole backlog | 12,500 / 13 / 0.8 | 50,000 / 50 / 5.7 | 600,000 / 600 / 40.7 |
| one fair claim call (CTE, LATERAL, SKIP LOCKED, k 5, limit 100) | 100 / 1 / 1.4 | 100 / 1 / 3.5 | 100 / 1 / 73.7 |
| reconciliation read over the outage plus the 24 h before it, NO index | 50,000 / 50 / 37.0 | 50,000 / 50 / 130.7 | 200,000 / 200 / 767.7 |

Each timing is ONE run; the same statement moved by up to 2x between runs (the
72 h fair claim read 40.6 ms once and 73.7 ms the next), so read them as orders of
magnitude, not as yardsticks (L656). History: 1,513,000, 1,550,500 and 6,602,000 rows in `run_requests` respectively
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
  index (a full scan of `run_requests`, 0.77 s at 6.6 million rows), so every
  sweep over history needs an index or a partition bound; the fair claim's cost
  grows with the backlog (the `DISTINCT workflow_id` over the queue) and should be
  re-measured on Micro at the backlog B1 sizes for (74 ms at 600,000 queued on the proxy).
- The timing is re-run on the real Micro once B1's tables exist (#1948), with its own approval;
  until then these are the only numbers, and they are optimistic.

## Stage 2: what was run (2026-10-16)

1. Read the ops project's configuration (P8). Done; readings in P8.
2. Deployed by merging #2266 (CI's Deploy Ops Worker). The self binding was
   accepted in one step; the new cron fired about 16 minutes later.
3. Armed `dispatch_ping`, then the other eight probes one at a time, each with its
   own nonce and an expiry at most an hour ahead, with
   `printf '%s' '{"probe":"<name>","nonce":"<nonce>","until":"<ISO>"}' | npx wrangler secret put OPS_SPIKE_ARM --config wrangler.ops.toml`,
   and read each from `bidspoke-porting-tee/spike/1946/<nonce>/` and Workers Logs.
   Nothing outside the ops Worker and the spike prefix was touched; the R2 HEADs
   cost under one cent.
4. Disarmed (`npx wrangler secret delete OPS_SPIKE_ARM --config wrangler.ops.toml`)
   and removed the probe code, keeping `SELF` and `OpsInternal.ping`. The
   `spike/1946/` objects expire under the bucket's 90 day lifecycle rule.
   Removing the `[triggers]` block did NOT remove the cron: wrangler deploy keeps a
   Worker's schedules when the config names none, so from 19:05 UTC the minute
   cron threw "Handler does not export a scheduled() function" every minute until a
   deploy with `crons = []` removed it. Re-measure:
   `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/3e7f907a9c19e51417873e2cce4fbc5c/workers/scripts/bidspoke-worker-ops/schedules | jq .result`
   should list no schedules.
5. Not run: P9 against the real Micro once B1's tables exist (#1948). That puts load
   on the production ops database and needs its own approval.
