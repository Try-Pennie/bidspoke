# Disaster recovery runbook

How to recover Bidspoke from a catastrophic loss. Bidspoke is live and routes real money-moving partner-bidding traffic, so the failure modes here are not hypothetical: incident #237 (a DDL storm that 503'd PostgREST and dropped `lead_sightings` rows) is the kind of event this plan exists for.

This is a living runbook. Lines marked **[OWNER-TODO]** need information only the team has (contacts, targets, escrow location) and should be filled in and kept current.

## Targets

Confirmed in the 2026-06-26 restore drill (#270 — see [restore-drill.md](./dr-restore-drill.md)).

- **RPO (how much data we can lose):** **up to ~24h** for the general database. Supabase is on the **Pro** plan with **daily** managed backups (7-day retention); PITR is **not** enabled (deliberate — the ~$100/mo add-on would cut this to ~2 min, revisit if 24h becomes unacceptable). Two highest-value data sets have a tighter effective RPO via independent backups: **workflow definitions** (~0, pushed to the `bidspoke-workflows` GitHub repo on every save) and **lead-sighting / bid outcomes** (<24h, nightly Snowflake export). PITR is also the only thing that recovers a *destructive migration* to the moment-before — without it, Scenario B loses up to a day.
- **RTO (how fast we must be back):**
  - **Resume bidding (config + schema restored): ~8 min proven** in the drill (laptop-driven logical restore), plus the Cloudflare Worker/Pages redeploy and worker-secret re-provisioning to actually serve traffic. A co-located runner or Supabase's native managed restore would be faster.
  - **Full system (all execution-log history + raw-SSN tables): hours**, dominated by the physical restore of a **27 GB** database (measured 2026-08-13, Supabase-side). Not on the critical path for getting money moving again.
  - While the Worker or Cloudflare is down, engine leads go unbid until it is restored; there is no failover. While only the database is down, the money flows the outage drill covers keep bidding from their stored copies for up to 30 minutes, which it proves on every pull request and weekly on main; Scenario E lists what it covers and what it does not.

### Per data class

Sizes measured 2026-08-13. Re-measure rather than copy these forward: the total grew from 25 GB to 27 GB in seven weeks, and the largest single contributor is data nothing reads.

| Data class | RPO | RTO | Why |
|---|---|---|---|
| Workflow definitions | ~0 | minutes | Pushed to the `bidspoke-workflows` GitHub repo on every save, so they survive a total Supabase loss and are re-importable without a restore. |
| Partner config, schema, org and auth records | up to ~24h | **~8 min proven** | The `scripts/dr-restore-drill.sh` subset. This is the set that has to come back for money to move. |
| Lead sightings and bid outcomes | <24h | hours | Nightly Snowflake export at 09:00 UTC is an independent copy that outlives the Postgres retention window. |
| Execution and audit logs | up to ~24h | hours | Largest live class: `execution_steps` daily partitions run around 2.5 GB each. Recovery is not time critical, since bidding resumes without log history. |
| Person PII (`persons`, raw SSN) | up to ~24h | hours | **Dormant since 2026-08-14 (#765).** The writer was removed and the table truncated (3.7 million rows to zero, 4.2 GB reclaimed), so it holds nothing to recover. Raw SSN for repeat lead grouping reaches Snowflake through `lead_sightings` and never depended on this table. |

Two items are pure dead weight in the figures above and removing them shortens the full-system RTO directly: `persons` (4,184 MB, #765) and the drained `lead_sightings_2026_06` partition (2,044 MB, zero live rows). Together roughly a quarter of the database.

**[OWNER-TODO]** The backup tier above was confirmed on 2026-06-26 and has not been re-checked since. Re-confirm the plan and whether PITR is still disabled at each quarterly restore drill, because every RPO figure here depends on it and nothing in CI can detect a change.

## What must be recovered (system inventory)

1. **Supabase** (project `xvrmivmpfykwwtriqwpg`): Postgres (all workflow, execution, lead-sighting, partner data), Auth (Google SSO users + `user_allowlist`), Realtime, and the pg_cron jobs (purge, strand drains, exports). The database is the only stateful system of record — everything else is redeployable from git.
   - The ops project "Bidspoke Ops" (`zwihpjxouklvkvngkvmw`, us-west-2, #1709): run data of the workflows ported off Pipedream, apart from the bidding database. Its migrations are `supabase-ops/supabase/migrations`, replayed from empty by `SQL_SUITE_PROJECT=ops bash scripts/sql-suite/run.sh`; restore the same way as the bidding project (Scenario A). Its database password was never stored: reset it from the Supabase dashboard when one is needed. Nothing writes to it before Phase 1 (#1698). Since #2334 it also holds the ops connections' last good copies (`connection_copies`: sealed envelopes only, never a plaintext login, each usable for at most 6 hours after it was served), their tombstones, health and measured Salesforce identity, and the ops Salesforce pool (`sf_leases`, `sf_budget_readings`, and the approved caps `sf_pool_caps` and `sf_bootstrap_caps`). The copies are a COPY of the bidding database's `service_connections.credential_enc` and are served again by bidding; the approved caps exist only as rows written by an approval migration, so they are restored by replaying the migrations.
2. **Cloudflare** (account `3e7f907a9c19e51417873e2cce4fbc5c`, "Pennie"):
   - Workers: `bidspoke-worker` (engine + API), the tail consumer (`apps/worker-tail`), and `bidspoke-compare-outbound` (`apps/compare-outbound`, #1708), which refuses every outbound request from the compare namespace so a shadow run sends nothing. It holds no secrets and no state; redeploy it from Actions (Deploy, Run workflow on main) or `pnpm --filter=compare-outbound exec wrangler deploy`.
   - The ops lane (#1709 part 4, live since 2026-10-06): the Worker `bidspoke-worker-ops` (`apps/worker/wrangler.ops.toml`, route `ops.trypennie.dev/porting/*`), its outbound Worker `bidspoke-ops-outbound` (`apps/ops-outbound`, refuses every request), the dispatch namespace `bidspoke-code-nodes-ops`, and the R2 bucket `bidspoke-porting-tee` (redacted Pipedream captures, a lifecycle rule `expire-90-days` deletes each object 90 days after it is written). The Deploy Ops Worker job redeploys the Worker, recreates the namespace when missing and proves the host; the bucket and its rule are recreated with `wrangler r2 bucket create bidspoke-porting-tee` and `wrangler r2 bucket lifecycle add bidspoke-porting-tee expire-90-days --expire-days 90` from `apps/worker`. Captures lost with the bucket are lost: Pipedream keeps no history to recover them from.
   - Pages: the Next.js frontend.
   - KV namespaces: `WORKFLOW_CACHE`, `IDEMPOTENCY`, `SUBMISSIONS` (all caches/ephemeral — rebuildable, not a system of record).
   - Durable Objects, seven classes. Five hold transient runtime state that self heals on eviction: `DailyCapObject`, `CircuitBreakerObject`, `BulkheadObject`, `LatencyMarkObject` (bid marks for the latency gate, #488) and `AlertClaimObject` (one alert post per cooldown, #1298). Two are SQLite backed and hold SALE state that does NOT self heal (#1410, migration `v5`): `BuyerLedgerObject` (one per buyer: every reservation and outcome, the record the caps are counted from) and `LeadSaleObject` (one per lead: the claim that stops a lead being sold twice). Their mirror in Postgres is `buyer_sales`, which is how sale history survives a loss of the objects; the objects are how caps and claims survive an outage of Postgres. A `wrangler rollback` cannot cross a migration tag, so a bad deploy carrying a new class is fixed forward, never rolled back: [ADR 0011](./adr/0011-durable-object-migrations-are-one-way.md).
   - **Rollback floors, one per Worker.** `bidspoke-worker` Durable Object migrations: `v5` (above). `bidspoke-worker-ops` Durable Object migrations: `v1` (#2334, `apps/worker/wrangler.ops.toml`), which creates `ConnectionTokenObject`, SQLite backed, the ops Worker's first and only class. The ops Worker's floor is the first deploy carrying `v1`: no `wrangler rollback --config wrangler.ops.toml` may go to a version before it, and a bad ops deploy from then on is fixed forward. It costs nothing today, because the class is inert in that deploy (exported, bound as `CONNECTION_TOKENS`, called by nothing) and ops runs no live workflow. From Phase 5 of #1689 it will hold person bound refresh tokens, and a lost object means that connection is reconnected by a person. The two Workers' migrations are separate lists in separate configs: neither binds the other's objects (the ops config test refuses a `script_name`).
   - Dispatch namespaces: `bidspoke-code-nodes` (Workers-for-Platforms, backs the code-node sandbox) and `bidspoke-code-nodes-compare` (#1708 part B: where shadow runs dispatch their code, with `bidspoke-compare-outbound` as its outbound Worker). Deploy Worker creates the compare namespace when it is missing (`.github/scripts/ensure-compare-namespace.sh`), and its bundles are deployed again on the next shadow run; recreate `bidspoke-code-nodes` with `wrangler dispatch-namespace create bidspoke-code-nodes` and redeploy every workflow's code from its save.
   - R2: the Logpush destination (cold-tier log archive).
   - DNS + routes: wildcard `*.trypennie.dev` (partner subdomain endpoints), the Worker route, and the `bidspoke.trypennie.dev` bypass route that protects Pages.
   - Crons: `0 9 * * *`, `0 13 * * *`, `0 * * * *`, `* * * * *` (defined in `apps/worker/wrangler.toml`).
3. **Worker secrets.** The two that cannot be re-derived (`SSN_HASH_PEPPER`, `SECRET_ENCRYPTION_KEY`) are in 1Password; every other one is re-obtained from its source. See Secret inventory.
4. **External integrations** whose credentials/config must be re-provisioned: Salesforce (External Client App "Bidspoke API", client-credentials flow), Equifax, the Tripoint proxy, M1, Snowflake (nightly export), the GitHub workflow-backup repo, Achieve, and Slack (alerts).

## Independent backups that survive a Bidspoke loss

- **Workflow definitions** are pushed to the GitHub backup repo (`bidspoke-workflows`) on every save, so the canvas logic survives a Supabase loss (re-import from there).
- **Lead-sighting + bid outcome data** is exported nightly (09:00 UTC) to Snowflake, so analytics-grade outcome history survives even past the Postgres retention window.
- **There is no standby for engine bidding, and the Pipedream engine flow is not one.** It was kept warm after the 2026-06-18 cutover, but it holds none of the engine bidding changes shipped since (`git log --oneline --since=2026-06-18 -- apps/worker/src/engine` lists them), so failing over to it would bid on June's rules, and Pipedream Workflows shuts down on 2027-03-31. Dan decided on 2026-10-07 (#1675) against any standby copy, since one would share Cloudflare and the database with the live flow: Bidspoke itself keeps bidding through a database outage instead, which the outage drill proves (Scenario E).

### The execution archive has NO independent backup, and that is a decision (#909)

`BIDSPOKE_ARCHIVE.EXECUTIONS` holds the full-fidelity copy of `workflow_executions` and `execution_steps`. Once A5 (#873) repoints the Postgres purge at the archive gate, it becomes the **only** place 13 months of execution history exists. Nothing copies it anywhere else.

That is accepted, with its limits stated rather than assumed. Decided by Dan on 2026-08-22.

| | |
|---|---|
| Time Travel on `execution_archive` | **30 days**, measured (#911), re-asserted daily (#980) |
| Fail-safe after that | 7 days, recoverable by Snowflake staff only, **not queryable by us** |
| What both cover | a mistaken or malicious DELETE, inside 30 days |
| What neither covers | a Snowflake account or billing problem, and a clone or share made before a delete |

The realistic loss modes are account level and credential level, not hardware. The eraser is the only identity in the account holding DELETE on this table, and since #914 that split is verified daily by having each identity attempt a delete rather than by reading its grants.

**A second copy in R2 is wanted and deliberately deferred**: issue #1001. Until it exists, a lost Snowflake account is a lost archive, and after A5 that is unrecoverable rather than inconvenient.

**When archive writes are slow or timing out**, [snowflake-slow-write.md](./snowflake-slow-write.md) finds where the time went (compiling, executing, queued, warehouse starting, or blocked on a lock), read only and without an admin role.

## Scenarios

### A. Supabase project loss or corruption

1. Confirm scope: is the project deleted, the DB corrupted, or just an outage? Check the Supabase status page and dashboard.
2. Restore from backup. Tier confirmed (2026-06-26): **Supabase Pro daily backups, 7-day retention, PITR not enabled** — so restore is to the most recent nightly backup (RPO up to ~24h), not to an arbitrary point in time. The restore path is proven end-to-end in [restore-drill.md](./dr-restore-drill.md); for the config/system-of-record subset, `scripts/dr-restore-drill.sh` dumps and restores it in ~5 min. The bulk (execution logs, `persons`, `lead_sightings`) comes from Supabase's managed restore of the daily backup.
3. If the project itself is gone, create a new project, restore the dump, then update every consumer of the project ref/keys: the `SUPABASE_SECRET_KEY` secret on BOTH workers (`bidspoke-worker` and `bidspoke-worker-tail`), `SUPABASE_JWKS_URL`, the CI/Deploy `SUPABASE_PROJECT_ID` var + `SUPABASE_ACCESS_TOKEN` secret, and re-link `supabase link`.
4. Re-run pending migrations against the restored DB (`supabase db push`) and verify pg_cron jobs are scheduled (`cron.job`).
5. Leads that arrive while the database is down are covered by Scenario E. Do not reroute the engine to Pipedream.

### B. Destructive or buggy migration

1. The expand/contract discipline (ADR 0007) makes most migrations additive and safe; a genuinely destructive one (DROP, irreversible data change) is the risk.
2. Recover the dropped data via PITR to immediately before the migration (RPO = the PITR granularity). There is no per-migration down-script today (tracked: production-readiness #28).
3. If only a function/policy was broken, `CREATE OR REPLACE` the prior definition from git history rather than a full restore.

### C. Cloudflare Worker / Pages loss (account intact)

Everything here is redeployable from git — no data loss, since state lives in Supabase.

1. Worker: start Deploy on main from the Actions tab (Actions, Deploy, Run workflow, branch main), which deploys every target at main's newest commit. With the worker gone, fill in `money_gate_base` with a full 40 character commit hash: the commit of the newest Deploy run that succeeded, or main's newest commit when that is not known. Left empty, the money gate asks the live worker which commit it runs, gets no answer, and refuses, so Verify fails and nothing deploys. Re-running an old Deploy run is not the same thing: it redeploys that run's own commit. By hand, `pnpm --filter worker exec wrangler deploy --var DEPLOYED_SHA:$(git rev-parse HEAD)` also works; without the `--var` the worker reports no deployed commit and Deploy Drift alerts that it is unstamped until Deploy runs. Either recreates the worker from `wrangler.toml` (KV/DO/dispatch bindings, routes, crons).
2. Re-provision the worker secrets (Secret inventory below) via `wrangler secret put <NAME> --name bidspoke-worker` or the CF dashboard. NOTE: `wrangler secret put` through a non-interactive shell uploads blank — use a real terminal or the dashboard.
3. KV namespaces / DOs / dispatch namespace: if deleted, recreate (`wrangler kv namespace create ...`) and paste the new IDs into `wrangler.toml`. KV/DO contents are caches/transient and self-rebuild; no restore needed.
4. Pages: the same Deploy run on main redeploys the frontend (its Deploy Pages job), because a started run deploys every target (#1761).
5. DNS/routes: recreate the wildcard `* CNAME -> bidspoke-worker.workers.dev`, the Worker route `*.trypennie.dev/*`, and the `bidspoke.trypennie.dev/*` bypass route (no worker) that protects Pages. These are configured in the CF dashboard, not wrangler.

### D. Cloudflare account loss

1. The hard case: a new account means new account ID, new KV/DO/dispatch IDs, and re-provisioning everything in Scenario C against the new account, plus updating `account_id` in `wrangler.toml` and the `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` secrets.
2. **[OWNER-TODO]** confirm who holds CF account admin / billing and that recovery access (not just a single personal login) exists. This is the single biggest unescrowed dependency.

### E. Region / partial outage, or "just get bidding back"

1. Cloudflare Workers run globally, so a single-region outage is largely absorbed. A Supabase region outage is the real exposure (the DB is single-region).
2. There is no failover for engine bidding, and a database outage needs none: Bidspoke keeps bidding from stored copies, which the outage drill proves (below). Do not reroute the engine to the Pipedream flow: it is the 2026-06-18 cutover snapshot and would bid on old rules. The custom endpoint record, the workflow definition, the partner config, environment variables (Salesforce credentials among them), partner constants, buyer profiles (switched off click buyers included) and the bid matrix are served from a last-good copy when the database read fails (#1296, #1845, #1849). The custom endpoint and partner config copies are removed whenever the endpoint or partner is edited, switched off or deleted (#1846), so an outage does not bring back something switched off before it began. When KV refuses that removal, or a workflow's copy cannot be refreshed after a change, the change still saves with a warning, and a sweep on the every minute cron (`apps/worker/src/lib/stored-copy-sweep.ts`, logged as `[stored-copy-sweep]`) compares every endpoint, partner, workflow and bid matrix copy with its rows and repairs any that disagree while the database is up. Workflow definitions are too since #1845: a live run whose definition read fails runs the copy written at the workflow's last successful load (key `workflow-def-lastgood:<workflow id>` in `WORKFLOW_CACHE`), and logs `stored_copy_served` with the copy's age, as every loader now does when it serves its copy (#1848). A workflow switched off or deleted before the outage leaves a copy that refuses, and a test or shadow run never uses the copy, so it fails at once. Every one of these copies is served for at most 30 minutes after it was last confirmed against the database (#1847, `apps/worker/src/lib/stored-copy-age.ts`): healthy reads, the every minute prewarm and the sweep confirm each copy about every five minutes, so on a healthy day none is older than about twelve minutes. An outage longer than 30 minutes therefore refuses leads by name rather than bidding on rules nobody has confirmed: each refusal logs `stored_copy_refused` with the copy, the reason (`no_copy`, `copy_too_old`, `copy_age_unknown`, or `copy_unusable` for a copy that was there but could not be read, parsed or decrypted) and its age. A workflow definition copy that is missing, could not be read, was left unverified by a change or cannot be run logs `workflow_definition_copy_refused` with the reason instead (only its age refusals use `stored_copy_refused`), and the run fails as it would with no copy. Environment variables with no copy at all are refused the same way, never run blank. Since #1844 each of those reads with a last-good copy, the definition load included, has a one second limit on the lead path (half a second for buyer profiles) and no retries, and once one fails the rest of that lead go straight to their copies, so a lead reaches them within about a second rather than after the database library's 7 seconds of retries. The writes a lead waits on are bounded too (#1849): the buyer_sales copy and the held click record get one second, a write that runs out of time is reported as `outcome_unknown` rather than undone, and once a lead has seen its database fail, writes with their own repair (the minute drain, the next click) are not sent at all. If the Worker or Cloudflare is down, Engine's requests fail and those leads go unbid until it is back.
   - **The outage drill proves it** (`apps/worker/money-gate/harness/outage.workers.test.ts`, the `Outage drill` check; how to read it is in `apps/worker/money-gate/README.md`). Every live fixture of every money flow (Engine Bidding, Main Flow, the Liberty1 click handler, Lead Economy and the two RML flows, 96 in all) is run with the database up, then again from the same stored copies with every database call failing in each of four ways: a refused connection, a PostgREST 503, a Cloudflare HTML 522, and a database that hangs until the caller's own deadline. Each failing run must answer exactly as its twin did, send the same requests to every partner and buyer, take the same routes and leave the same Durable Object state, and in the hang it must also answer within 2 seconds of its twin. On 2026-10-07 all 384 runs matched with no exemption. It runs on every pull request and weekly on main (Mondays 09:00 UTC, dispatched by the schedule watch if GitHub drops the cron). A change that breaks bidding through an outage fails its pull request.
   - **What the drill does not prove**: the custom endpoint route (the drill calls the engine directly; the stored record has its own tests); the bid matrix and the latency gate (no live flow uses them, so no fixture reaches them; their copies have their own tests); test and shadow runs (they never use a copy and fail at once); an outage longer than 30 minutes (every copy is then refused by name, by design); that a run's logging survives (writes are not compared, since losing logging is allowed); flows with no live runs when the fixtures were exported, which have no fixtures (listed in the money gate README); and a Cloudflare outage (nothing runs).
   - **Three alerts watch these copies**: one while leads are being served from them, and two for a copy that would not be there when needed (#1848, `apps/worker/src/lib/stored-copy-signals.ts`, run every minute right after the sweep). Every serve and every refusal is counted per copy and per minute in KV (`stored-copy-ledger:<minute>:<isolate>` in `IDEMPOTENCY`, written after the response so a lead never waits on it).
     - **"Leads are being served from stored copies"** posts once stored copies were used in 3 of the last 5 minutes (a healthy day misses a lead read deadline about once an hour, in a minute of its own; an outage uses copies every minute), with each copy's count and the oldest copy's age. It posts again at once, titled "Leads are being refused", when copies start being refused for age or absence, and an all-clear follows once none has been used for 30 minutes. It finds Slack the way every scheduled alert does (next bullet): the database first, under a short deadline, and the encrypted saved copy the database probe keeps in KV (`slack-conns-lastgood`) when the database does not answer, so it reaches Slack with the database down; it follows the volume alerts toggle. Mute it by writing `stored-copy-serving:cooldown` in `IDEMPOTENCY` with a TTL.
     - **"Stored copies have gone stale"** names every copy a live lead could need that was last confirmed more than 30 minutes ago, or carries no readable time: such a copy would be refused if the database failed now. Muted with `export-alert:stored-copy-stale:cooldown`.
     - **"The stored copy sweep keeps failing"** posts once the sweep has failed on every run for 5 minutes, because a copy an edit could not clear is repaired only by it. Muted with `export-alert:stored-copy-sweep:cooldown`.
     - The last two wait while stored copies are in use at all: in an outage copies age and the sweep fails because the database is down, which the first alert already says.
   - **Every other scheduled alert finds its Slack connection the same way** (#1303, `apps/worker/src/lib/scheduled-slack.ts`). The scheduled handler's one client a tick asks the database for a Slack connection once under a 3 second deadline, with no retries, and answers from that same `slack-conns-lastgood` copy on any failure; after the first failure in a tick, every later lookup goes straight to the copy. So a check whose finding needs no database (the cron heartbeat, bid matrix sync failure, the export and archive failures, required secrets, though not the required environment variables check, which reads the database) still posts during an outage. A check whose finding needs the database still cannot. Each lookup logs `[scheduled-slack]` with what answered: live, the saved copy and its age, no connection, or `nobody can be told` with the reason (no saved copy, the copy holds no connection for that organization, or the copy cannot be read). Request and engine path alerts never use the copy this way.
   - **How current that copy is** (#2060). It records when it was saved (`__saved_at` inside it), so the age in those log lines is real. It is rewritten by the database probe (#2061, below), and only on a minute the probe's one bounded read of the Slack connections answers within 5 seconds: the copy is then replaced with that answer, an empty answer included, so it never outlives every organization disconnecting. A read that fails or takes longer than 5 seconds leaves it as it was, and so does an answer with rows of which none can be read as a Slack connection (logged as an error), so a busy minute when that read times out writes nothing even though the database is up. Disconnecting Slack, changing its settings or saving a new connection on the Integrations page edits that organization's entry in the same request; if KV refuses that edit, the change is still saved and the answer carries `stored_copy_warning`, and the next healthy minute repairs the copy. It is used at any age, by Dan's decision (#1874): it only decides where an alert goes, and refusing it in a long outage would silence every alert. The reason is recorded as `STORED_COPY_AGE_EXEMPTIONS` in `lib/stored-copy-age.ts`.
   - **"Bidspoke cannot read its database" has one owner** (#2061, `apps/worker/src/lib/database-reachability.ts`). Every scheduled read that fails reports to it, and it alone pages, from the saved copy, naming how old the Slack settings it posts with are. A failure of one of the volume check's three reads (Slack connections, workflows, execution counts) pages at once, as it always did. A failure of the minute database probe (one read of the Slack connections, 5 seconds, job `database-reachability`, which is also the copy's writer) or of the first scheduled Slack lookup of a tick pages only when a failure was also reported in the minute before, because those deadlines are short and were never calibrated against the 08:15 to 09:10 UTC batch window. The first reminder is 15 minutes, then the shared backoff. The all-clear goes out only once no scheduled read has failed for 30 minutes and the probe and the volume check have each answered throughout those 30 minutes (at least every 5 minutes), and it says what was measured. Its state is in `IDEMPOTENCY`: `db-unreachable:<organization id>:cooldown` and `:condition` (the same keys as before #2061), `db-reachability:source:<reader>` and `db-reachability:failed-minutes`. Mute it by writing `db-unreachable:<organization id>:cooldown` with a TTL.
3. A database outage used to lose leads: on 2026-09-10 Supabase was unresponsive for about 10 minutes and roughly 400 Engine leads went unbid, because the endpoint lookup and the partner config read refused when the database did (fixed by #1296, and proven since by the drill in point 2). Leads that are lost, in an outage past 30 minutes or one the drill does not cover, are not replayed (Dan, 2026-09-10). What an outage still costs is part of a run's own records, depending on which write it caught (#1850):
   - The strand drains recover only rows that exist. An execution row whose first insert landed but whose finalize did not is left at `running`, and the drain restores it after 30 minutes from its answer journal (#1883: what the run answered, status, outcome, final node and the redacted response, written to KV at the answer and kept 3 days), or failing that labels it from its step history or the sighting's recorded outcome. The finalize itself goes out at the answer, beside the step write, not 15 seconds later behind it; on 2026-10-08 five runs' late finalizes never ran. A sighting left `in_flight` is finalized from the execution row's `sighting_finalize` projection, which exists only if that finalize landed.
   - A run whose first insert failed leaves no row for any drain to find, and its step rows cannot be written without that row. Finalize rebuilds the row, and then the step rows, if the database is back before the run's retries end. Otherwise the run is lost: a write that returned an error is dead-lettered as `execution_finalize`, and one that only timed out is read back by the unconfirmed write sweep below, which reports it lost only if it never landed. The same holds for a sighting whose insert failed (`lead_sightings.insert`, then `lead_sightings.finalize`).
   - Every one of those retries happens after the response, and Cloudflare cancels that work 30 seconds after the response. All of a run's post-response writes and their dead letters therefore share one budget of 25 seconds from the response (`POST_RESPONSE_BUDGET_MS` in `apps/worker/src/lib/post-response-budget.ts`), so an outage longer than that cannot be outlasted. This is separate from the lead read budget in point 2, which covers only the reads a lead waits on before the answer. The dead letter is written to KV, so it lands even with the database down, but its Slack alert needs the Slack connection from the database and is usually dropped mid-outage. The KV count keeps climbing for 30 minutes, so the first dead letter after the database returns posts the alert with the whole outage's count; if none follows within 30 minutes, the count expires unannounced.
   - A write that only timed out at that budget (no error came back, so it may still have landed) is not dead-lettered (#1880). It is recorded in KV as unconfirmed, naming the record and the effect that proves it landed, and the minute cron's `unconfirmed-write-sweep` (`apps/worker/src/lib/unconfirmed-write-sweep.ts`) reads it back once it is 2 minutes old. Landed: dropped silently. Missing: the usual Outcome Record Lost alert. Database still not answering after 15 minutes: one "Records could not be confirmed" alert, posted from the last-good Slack copy if need be, and the sweep keeps reading them back. A write that came back with an error is still dead-lettered at once. On 2026-10-08 a 90 second stall paged every timed out write as lost, and all of them had landed.
   - One slowdown sends one message (#1881). A run whose step rows only timed out is recorded `degraded`, not `failed`, and pages nobody per run. Once the sweep has read back everything a slowdown left, it posts one "Database slowdown" summary: how many runs, which workflows, and which records did not land. A slowdown in which every record landed posts nothing (#2165); it is recorded in that tick's `job_runs` row under `summary.slowdowns` (with `all_saved: true`), and three of them inside 24 hours post one "Database slowdowns are repeating" alert naming each, since that means the database keeps falling behind. The dead letter's cooldown is an AlertClaim keyed on org, label and cause (timed out or returned an error), so a burst posts once per 30 minutes while an unrelated failure still posts on its own; its loss count is kept in KV and is approximate, which the alert says.
   - **Every slowdown takes a database snapshot while it happens** (#2292). On 2026-10-16 writes stalled for minutes three times and nothing recorded what the database was doing, so the cause could not be found afterwards. Now the first post-response write a stall times out calls `public.db_stall_snapshot()` (service role only): every non-idle backend with its role, application, client address, state, wait event, transaction and query start and the first 300 characters of its query; the blocking chains (who waits on whom, for which lock); and every backend counted by state and by role and application, beside `max_connections`, so a full PostgREST pool shows as its own row. It is taken at most once every 2 minutes across isolates (an AlertClaim, `db-stall-snapshot`), so a 10 minute stall takes about five, and never delays the write chain or the answer: it runs in its own `waitUntil` with a 3 second deadline. A read that did not answer in 3 seconds is kept as `timed_out`, which is evidence in itself: the database, or the connection pool in front of it, could not answer a catalogue read. Each is kept in `IDEMPOTENCY` for 3 days under `db-stall-snapshot:<ms>:<id>`, never in the database it is about. Both slowdown alerts carry one line saying how many were taken and how they ended, never their contents. Code: `apps/worker/src/lib/db-stall-snapshot.ts`.
     - **To read them:** `GET /api/admin/db-stall-snapshots?limit=5` on the worker (any signed in user; at most 20 in full, the rest listed by time and outcome). The query text, and the run and workflow of the write that set each snapshot off, are withheld there, because the snapshots are platform wide and those belong to whichever organization they came from. With Cloudflare access, list the keys and read one in full from `apps/worker`: `pnpm exec wrangler kv key list --binding IDEMPOTENCY --prefix db-stall-snapshot: --remote`, then `pnpm exec wrangler kv key get --binding IDEMPOTENCY --remote --text "<key>"`. Query text can carry customer data: read it, do not paste it into an issue or Slack.

### F. Secret loss or compromise

1. Re-provision from each source (Secret inventory). For a compromise, rotate at the source first, then update the worker secret.
2. **Special case — `SECRET_ENCRYPTION_KEY`:** rotating it breaks "reveal" for env-var secrets created before the rotation (users see "rotate to enable reveal" until they re-save). See CLAUDE.md.
3. **Special case, `SSN_HASH_PEPPER`:** never generate a new one. The execution archive stores its hash of each lead's SSN to find a person's records for an erasure request, so a new value leaves every earlier record unfindable. Restore it from 1Password.

## Cloudflare log access IS partner API key access (#958)

Measured 2026-09-09 against production, and recorded here because the belief was
previously unverified and the question would otherwise be re-opened from scratch.

The `Workers trace events` stream carries `event.request.headers` on every
request event, with values intact. `x-api-key` is among them, so **every partner
webhook API key in `API_KEY_MAP` is readable in plain text by anyone who can tail
the worker or read Workers Logs for this account.** Header values were proved to
survive verbatim using a throwaway probe header, so no real key had to be read to
establish it. `cf-connecting-ip`, the consumer's IP address, is in the same
stream.

**It is also applicant PII access, and that is the larger fact.** The same stream
carries the `Logs` field, every `console.log` a Worker emits, and the Main Flow
prints the full applicant before calling Eligibility Scout: SSN, date of birth,
name and address, on roughly 180 runs a day. So anyone who can tail this worker
can read consumer identity data live, not only partner credentials.

Masking those prints was considered and **deliberately declined** on 2026-09-09
(#1214), because the external egress had been closed by narrowing the Logpush
field list (#1007) and what remains is inside our own systems, which ADR 0006
allows and which was reaffirmed the same day. That decision is sound, and it is
what makes this permanent rather than a gap awaiting a fix. Grant log access on
that basis.

Two consequences for anyone working from this runbook:

1. Treat Cloudflare log access as equivalent to holding every partner key. Grant
   it on that basis, and if it is ever granted to someone who should not hold the
   keys, the keys are compromised and rotating them is the remedy.
2. A `wrangler tail` capture written to a file is a file full of live partner
   credentials. Delete it when finished. Never attach one to an issue, a PR or a
   support ticket.

**Established on 2026-09-09 (#1007):** the Logpush job to the external vendor
Better Stack DID carry these fields. Its field list was narrowed that day to
remove `Logs` and `Event`, verified by reading the job back, and it has delivered
under the narrowed list since, so no header value reaches that vendor from then
on. Dan decided the same day not to pursue what the vendor already holds (who
owns the account, its retention, a purge); that decision is recorded on #1007 so
the exposure is stated rather than silent. The R2 job (#1008) was measured
delivering nothing for months, so it forwards nothing. Reading a job's field list
needs the Cloudflare API plugin's credential, not one this codebase holds
(#1010).

**Logpush was off from 2026-09-26 to 2026-09-28 (#1613).** Cloudflare refused
the account's job list with `1004 logpush is not enabled for this account`, and
Dan accepted that. Logpush was then switched back on for the shared account, and
the Better Stack job (1740821) came back with it, which the daily
`logpush-destinations` check reported on 2026-09-28. Dan chose that day to keep
the job, so the check expects it again on its seven metadata fields and reports
any change to its fields, destination or delivery, or Logpush going off again.

## Secret inventory (and escrow)

The authoritative live list is `wrangler secret list --name bidspoke-worker`. Two of them are escrowed (see Escrow status below); every other one is re-obtained from its origin if lost. Categories (re-provision source in parentheses):

- Supabase: `SUPABASE_SECRET_KEY` (a secret key of the new `sb_secret_` kind, from the dashboard under Settings, API Keys; NOT the legacy JWT service_role key), `SUPABASE_JWKS_URL`. `bidspoke-worker-tail` holds its own copy of `SUPABASE_SECRET_KEY`, so it is set twice. Rotation is zero downtime because several secret keys can be live at once: create a new key in the dashboard, `wrangler secret put SUPABASE_SECRET_KEY` on both workers (pipe the value in, never on the command line), confirm `workflow_executions` keeps gaining rows with `cost_usd` filled, update `apps/worker/.dev.vars`, then delete the old key, which is irreversible. Last rotated 2026-09-25 (the old key had sat in plain text in a local permission rules file). Other workers and Pages projects in the same Cloudflare account hold same named secrets for OTHER Supabase projects (Slate, PaperBoi, PET, Migo, Eavesly); measured 2026-09-25, none reads this project.
- Cloudflare: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (for partner-secret sync).
- Encryption/PII: `SECRET_ENCRYPTION_KEY` (unlocks every secret environment variable on every run; in 1Password; rotate only with the steps in CLAUDE.md), `SSN_HASH_PEPPER` (never rotate; in 1Password), `PII_REDACTION_FIELDS`.
- Salesforce: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_INSTANCE_URL` (External Client App in SF Setup).
- Partners: Equifax (`EQ_USER`, `EQ_PASS`), Eligibility Scout (`SCOUT_KEY`), Tripoint proxy secret, Achieve (`ACHIEVE_USERNAME`, `ACHIEVE_PASSWORD`, `ACHIEVE_API_URL`, ...), webhook keys (`API_KEY_MAP`).
- Achieve firewall identity: `ACHIEVE_PARTNER_KEY`, a secret we choose and share with Achieve. Their Cloudflare Skip rule matches on it, so without it every call to `oauth.prd.ffngcp.com`, `fdrapis-gateway.prd.fdrgcp.com` and `api.freedomfinancialnet.com` is refused with a 403 before reaching them (that outage ran 2026-09-05 to 09-10). Re-provisioning it means generating a new value AND telling Achieve, because both sides hold it. Set it in the Bidspoke Environment Variables page as a secret, not with `wrangler secret put`: that page stores it for the Eligibility Scout code node and syncs it to the worker binding the Achieve node reads, in one write.
- Link token signing key: `LINK_TOKEN_SECRET` (#2089). The Engine Bidding and Lead Economy code nodes sign every trypennie.com offer link with it, the three RML bidding flows sign their reservemyloan.com links and the Forms flow its submit link (#2092) (`?t=`, HMAC-SHA256 of the record id), and trypennie.com refuses a link to a record created after its cutoff without a valid one. The same value is held by Salesforce (its `LinkToken` class), trypennie.com and the Pipedream bidding workflows, so it is re-obtained from whoever holds it there, never regenerated here alone: a new value on one side only breaks every new customer link. trypennie.com also accepts `LINK_TOKEN_SECRET_PREVIOUS`, which is how a rotation is staged. Set it in the Bidspoke Environment Variables page as an organization wide secret, which stores it for the code nodes and syncs it to the worker binding the daily required secrets check reads. Unset, runs still succeed and the step output says `link_token: missing_secret`.
- Data export: `SNOWFLAKE_*` (account/user/private key/role/db/schema/warehouse).
- Execution archive (#870, three separate identities in `BIDSPOKE_ARCHIVE`): `ARCHIVE_WRITER_USER` + `ARCHIVE_WRITER_PRIVATE_KEY`, `ARCHIVE_READER_USER` + `ARCHIVE_READER_PRIVATE_KEY`, `ARCHIVE_ERASER_USER` + `ARCHIVE_ERASER_PRIVATE_KEY`. Re-provision by generating a fresh RSA key pair per identity and setting the public half on the Snowflake service user (`ALTER USER ... SET RSA_PUBLIC_KEY`); the users, roles and grants themselves are re-createable from `docs/snowflake-archive-setup.sql`. None of the three needs escrow: all six are freely re-derivable, because rotating a key pair costs one `ALTER USER` and loses no data. **The archived data itself is the thing that cannot be re-derived**, and the eraser identity is the only credential in the account that can destroy it, so treat it with the care its blast radius deserves rather than the care its re-provisioning cost suggests.
- Porting recorder (#1705), on the separate `bidspoke-worker-ops` Worker, not on `bidspoke-worker`: `PORTING_CAPTURE_MASTER`. Set with `wrangler secret put PORTING_CAPTURE_MASTER --config wrangler.ops.toml` from `apps/worker`. Each recorded Pipedream workflow's capture key is derived from it (HMAC of the workflow's hashid) and pasted into Pipedream as `PORTING_KEY_<hashid>`, and the redaction key and the minute cron's dispatch key (`src/ops/dispatch-auth.ts`, #1949) are derived from it too. A new value therefore means re-deriving and re-pasting every recorded workflow's key, and captures redacted before the change no longer compare equal with those after, so it is escrowed in `Bidspoke recovery keys`, field `PORTING_CAPTURE_MASTER` (2026-10-06, read back from 1Password and compared byte for byte before it was set). Restore it from there: never generate a new one unless the old one is lost.
- Better Stack outage page (#2063), optional and feature gated: `BETTERSTACK_OUTAGE_TOKEN` (the source token of the Better Stack HTTP log source that receives the "nobody can be told" line) and `BETTERSTACK_OUTAGE_URL` (that source's ingesting host, as `https://<ingesting host>`, because the host is per source). Re-obtain both from the source's page in Better Stack Telemetry (Sources, the source, its token and ingesting host); a lost token can be regenerated there at no cost, since the source holds nothing else. Neither needs escrow. Unset, the worker pages nobody in Better Stack and each scheduled tick that would have paged logs once that nothing was sent; the daily required secrets check does not report them (`FEATURE_GATED_SECRETS` in `apps/worker/src/lib/secret-lists.ts`). After setting or re-obtaining either, prove both with the drill, `POST /api/admin/nobody-told-page/drill` (#1303), which sends one page through the real request and should fire the `Bidspoke Slack alerts down` alert. See [observability](./reference/observability.md#when-nobody-can-be-told-in-slack-better-stack).
- Other: `GITHUB_TOKEN` + `GITHUB_REPO` (workflow backup), `GITHUB_ACTIONS_TOKEN` (reads `GITHUB_CODE_REPO`'s Actions history for the scheduled-workflow watch, and since #1058 also DISPATCHES those workflows because GitHub stopped delivering their cron events reliably; re-obtain as a fine-grained GitHub token scoped to this repository with **Actions: read and write** plus Metadata: read. Read alone can list runs but cannot start one, and the dispatch then fails with 403), `ANTHROPIC_API_KEY`, `APP_URL`.

**Escrow status (2026-09-28): the two secrets that cannot be re-derived are escrowed (#384).** Both live in the 1Password item `Bidspoke recovery keys`, fields `SSN_HASH_PEPPER` and `SECRET_ENCRYPTION_KEY`. Each copy was proved against production that day without the value being printed:
- `SSN_HASH_PEPPER` was handed over once by the worker, sealed to a key held offline, and the saved copy produced the same hash of a canary value as production. The handover route and the offline key were deleted afterwards, so the pepper has no path out of the worker.
- `SECRET_ENCRYPTION_KEY` was rotated to a new key generated for the purpose and saved in 1Password first. Production was set from the 1Password copy, and all 24 secret environment variables plus the one app setting then opened with it alone, with no failed executions across the swap.

To restore either: set it on the worker from the 1Password field with `wrangler secret put <NAME> --name bidspoke-worker`, piping the value in rather than typing it on a command line.

**Still not escrowed:** every other worker secret. Each can be re-obtained from its source (see the categories above), which is slow mid-incident but loses nothing. Copying them into the same vault would shorten a recovery; that is a separate choice.

On each quarterly restore drill, confirm the item still exists and that `SECRET_ENCRYPTION_KEY` has not been rotated since without the 1Password copy being updated (the rotation steps in CLAUDE.md save it there first).

## Configuration that exists only in a dashboard (#1011)

Everything below is live, load bearing, and mentioned in no executable file. Each can be
changed by one person in a browser with no review and no record. This list is the output of
one pass, not a set of fixes: individual items become their own issues.

The pass was prompted by Logpush being invisible to the compliance milestone for weeks
(#1007). That was structural rather than an oversight: the enumeration of where identity data
lands was built by reading the codebase, and no audit done that way can find configuration
that lives in a browser.

**The account is shared.** `bidspoke-worker` runs in the Pennie Cloudflare account alongside
other Pennie projects (of the 15 KV namespaces on the account, 7 belong to Bidspoke and the
rest to other work). Anything scoped to the ACCOUNT rather than to the worker is therefore
not Bidspoke's alone: someone configuring another project can change what happens to
Bidspoke's data without touching this repository or knowing Bidspoke exists. Account scoped
Logpush is the clearest case and is the likeliest explanation for how the Better Stack
destination arrived.

| What | Touches customer data | Would anything notice a change | Declarable in the repo |
|---|---|---|---|
| Logpush job to Better Stack (1740821, `Workers trace events`, account scoped). Off from 2026-09-26 to 2026-09-28 (#1613), kept when it came back; the R2 job (1564508) was deleted 2026-09-09 (#1008) | Not on its expected fields: seven metadata fields since 2026-09-09 (#1214). The dataset carries request headers verbatim, `x-api-key` included (#958), so an added field could | Yes. The daily `logpush-destinations` check compares its fields, destination and delivery against the expectation | Yes. `apps/worker/src/lib/logpush-expectation.ts` |
| R2 bucket `bidspoke-logs` and any lifecycle or retention rule on it | Intended to hold worker logs. Currently 2 objects, 96 bytes | No | Yes. Noted as dashboard configured at `apps/worker/wrangler.toml:177` |
| Worker route `*.trypennie.dev/*` to `bidspoke-worker` | Yes. It is the ingress for partner lead traffic | Partly. `SELF_CHECK_URL` probes `hook.trypennie.dev` | Not today. `apps/worker/wrangler.toml:86` records that the CI token lacks Zone Workers Routes Edit, so declaring it would fail the deploy |
| Worker route `ops.trypennie.dev/porting/*` to `bidspoke-worker-ops` (#1709, created 2026-10-06 by a local `wrangler deploy --config wrangler.ops.toml` while the route was still in that file) | Yes, once Pipedream workflows send redacted captures to it | **Yes**: every Deploy Ops Worker run proves it with `.github/scripts/prove-ops-host.sh` and fails when the host is not answered by the ops Worker | Not today: CI's Cloudflare token cannot manage zone routes (Deploy run 37535186964 failed on `/zones/.../workers/routes`). Recreate it with a local deploy after putting the `routes` line back, or in the dashboard |
| Bypass route `bidspoke.trypennie.dev/*` protecting Pages from the worker | No, but its loss takes the app down | No | Same constraint as above |
| Wildcard DNS `*` CNAME to `bidspoke-worker.workers.dev` on the `trypennie.dev` zone | Yes, same ingress | No | Same constraint as above |
| Supabase Auth redirect URL allowlist | No, but it decides who can complete a sign in | No | Yes |
| Supabase backup tier and PITR window | It is the recovery path for all of it | No. #43 wants an alert on a change | Not directly, but readable and assertable |
| Cloudflare Pages project settings and build environment variables for `apps/web` | Indirectly | Partly, a bad value fails the build | Yes |
| Snowflake grants and Time Travel retention | Yes, the archive is 13 months of unredacted identity data | **Yes**, verified daily by #914 and #980 | Already partly, `docs/snowflake-archive-setup.sql` |

The Snowflake row is the model for the rest: it is the only entry whose current value is
re-established on a schedule rather than remembered, and it got that way by a check that
attempts the thing and reports an unreadable answer as its own condition rather than as
health.

## Why a CLI-role query timeout will NOT prevent a `db push` outage (#397, closed)

A natural reaction to the 2026-06-26 outage is "put a `statement_timeout` on the `cli_login_postgres` role so a runaway CLI query self-aborts." We investigated and **closed #397 without doing this**, because the live config disproves the premise:

- **The cluster already caps every query at 2 minutes.** `statement_timeout` is set to `120000` ms at the cluster level (`pg_settings.source = 'configuration file'`), which applies to any role/session without an explicit override — including `cli_login_postgres`. A role-level `5min` would have been *looser*, not tighter.
- **`pg_dump` disables the cap for its own session, and nothing can stop it.** `supabase db push` runs a `pg_dump` of prod first; `pg_dump` issues `SET statement_timeout = 0` (plus `lock_timeout` / `idle_in_transaction_session_timeout` / `transaction_timeout` = 0) as its first statements. Those are per-session USERSET settings, so they override the 2-minute cluster default *and* any role-level value. The ~10-minute COPYs on 2026-06-26 ran precisely because of this. No `statement_timeout` anywhere — role, database, or cluster — can constrain a `pg_dump`.
- **We could not set it anyway.** Altering `cli_login_postgres` needs `supabase_admin`; Supabase does not grant even the account owner true superuser (the `postgres` role gets only limited `supautils` privileges). Attempting the `alter role` in the dashboard returns `42501: permission denied to alter role`.

**The real mitigation is the process rule (#392): don't `db push` from a laptop; apply small additive migrations via the dashboard SQL editor.** Pool-exhaustion visibility is tracked separately (#395). The one genuine gap — no `idle_in_transaction_session_timeout` on the CLI role (it is `0` cluster-wide) — was judged not worth a support request, since `pg_dump` disables that too and it would only catch an abandoned-mid-transaction connection, not this outage.

## Escalation

**[OWNER-TODO]** Fill in the on-call / escalation order with names and contact methods, plus the account owners for: Cloudflare (account admin/billing), Supabase (project owner/billing), Salesforce admin, and each partner integration contact (Equifax, Tripoint/Brian, M1, Snowflake, Achieve).

## Drills

- **Restore drill: run quarterly.** Full procedure, the proven-RTO results log, and the reusable `scripts/dr-restore-drill.sh` live in [restore-drill.md](./dr-restore-drill.md). First drill ran 2026-06-26 (PASS). The cadence reminder is a recurring Google Calendar event linking that doc.
- Re-run after any migration that adds or removes a system-of-record table (the drill's row-count verification flags a table missing from the script's allow-list).
- **Outage drill: automatic.** Runs on every pull request and weekly on main; see Scenario E for what it proves and what it does not. A red drill on a pull request means that change stops a money flow bidding through a database outage. Fix it, or list it in `apps/worker/money-gate/outage-exemptions.json` with the issue that removes it and an expiry date.
- Keep this runbook current as infrastructure changes (new secrets, new KV/DO bindings, new partners).
