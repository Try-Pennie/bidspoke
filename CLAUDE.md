# Bidspoke — Project Conventions

The planning list is [TODO.md](./TODO.md) (#2606): read it before work on anything it tracks, and tick off what you finish. It is linked rather than imported, because imported it put every session over the instruction size limit, and `apps/web/src/lib/__tests__/claude-md-imports.test.ts` keeps it that way.

## Design
@.impeccable.md

## Stack
- **Frontend:** Next.js 14 (App Router) on Cloudflare Pages — `apps/web`
- **Worker:** Cloudflare Workers with Hono — `apps/worker`
- **Database/Auth:** Supabase (Postgres + Auth + Realtime)
- **Package manager:** pnpm workspaces
- **Language:** TypeScript everywhere, strict mode

## Monorepo
Each package, and each of the three small apps, keeps its detail in its own README.md.
- `apps/web`: Next.js frontend
- `apps/worker`: Cloudflare Worker (API + execution engine)
- `apps/worker-tail`: tail consumer that writes per-execution cost and copies the log lines the cron guard, cron delivery and Slack refusal checks read
- `apps/compare-outbound`: outbound Worker that refuses every request a shadow run's code makes, for ever
- `apps/ops-outbound`: outbound Worker of the ops dispatch namespace, refusing every request until Phase 2
- `packages/*`: code both apps import, one implementation rather than a copy per app; plain TypeScript with no build step, listed in `transpilePackages`. A package with tests must also be named in the CI test job, which names its suites one by one (`ci-runs-every-package-suite.test.ts`), or it is green locally and never runs in CI.
  - `uuidv7`: execution ids, minted the same by the Worker and the browser
  - `connection-seal`: `seal` and `open` for ops connection logins
  - `script-hygiene`: strips trailing whitespace from code node scripts
  - `buyer-profile`: the one vocabulary, validator and evaluators for buyer profiles and the buyer_select and click nodes
  - `node-types`: the one list of node types and their traits; a new node type starts here
  - `service-catalogue`: the ops service catalogue; web imports only `/schema`, and a released action is never edited
  - `slack-client`: the one place a Slack Web API client is built

## Key conventions
- All Worker routes are in `apps/worker/src/index.ts`, handlers in `src/routes/`
- Durable Objects live in `src/durable-objects/`, except the ops Worker's `ConnectionTokenObject` (`src/ops/connection-token-object.ts`)
- Node type implementations live in `src/nodes/`
- All DB access goes through Supabase client, never raw SQL from the Worker
- RLS is enforced at the DB level — don't replicate org scoping in application code
- Secrets are injected via Cloudflare Worker secrets, never committed
- The money gate (`apps/worker/money-gate/`, #1704) replays synthetic leads through the
  bidding engine at the merge base and the head of every pull request touching it, and
  fails on any difference in what is sent or decided. A red gate on an intended change
  must be acknowledged in `apps/worker/money-gate/expected-changes.json` in the same pull
  request, or both the pull request and the deploy fail. How to read it and refresh its fixtures is
  in `apps/worker/money-gate/README.md`.
- Every alert that arms an all-clear marker names its signal from `INCIDENT_SIGNALS`
  (`lib/incident-signals.ts`, #2099). Its transitions go to the KV outbox
  (`lib/incident-outbox.ts`), never to Postgres on the alert path, because several of those
  alerts fire while Postgres is the thing failing. A new delivery site calls `recordPaged`
  after its marker is armed. The drain (`lib/incident-drain.ts`, five minute cron) writes
  `alert_incidents` and closes as lapsed an incident whose marker went with no end.
  A check that keeps its open incident in its own state instead of alert-recovery's
  marker (the cron heartbeat, #2103) names that key as its registry entry's `marker`,
  which is where the drain's lapse check reads it, and gives that key an expiry the
  check renews while the incident stands, so it can never keep an incident open for ever.
- A Supabase read that comes back at the 1,000 row cap without declaring a limit
  (`.single()`, `.limit(n)` with n at most 1,000, or `.range()`, which CI also requires an
  `.order()` beside) is reported to Better Stack every time,
  and inside a scheduled job the read fails with `BIDSPOKE_ROW_CAP` (#1436, `lib/row-cap.ts`).
  A list read that may pass 1,000 rows pages with `fetchAllPaged` under a full order. The cap
  is the Data API's `max_rows` dashboard setting; `ROW_CAP` equals `PAGE_SIZE`.
  CI holds every `.from(` in `apps/worker/src`, on any table, to those declarations before it
  ships (`worker-big-table-pagination.test.ts`), also accepting `.maybeSingle()`, which refuses
  more than one row itself. A read bounded by its filter
  says so as `// paginate-ok .eq(column): <why>`, naming a row selecting filter that is on the
  query. Reads unbounded today are listed in `worker-unbounded-reads-baseline.json`, which may
  only shrink: converting one means lowering its count in the same change.
- A workflow definition names a connection only by its id, and only a live connection of
  its own organization (#2338). The trigger `workflows_refuse_missing_connections` refuses
  any other definition write, holding the named connections FOR KEY SHARE so a save and
  `remove_ops_connection` cannot pass each other's check. Every definition writer in
  `routes/api/workflows.ts` asks `definition_connection_problems` first
  (`lib/workflow-connection-check.ts`), so it refuses by name and writes nothing;
  `__guards__/worker/workflow-connection-check-guard.test.ts` fails on one that does not.
  What counts as naming a connection is the one database predicate
  `definition_connection_ids`, which `connection_references` reads too.
- Partner saves are versioned (#2132): the partners page saves through
  `PUT /api/partners/:id/page`, and the `partner_configs_bump_version` trigger, not the save
  function, moves `version`, so every writer moves it. Stale saves and the retired routes:
  [docs/reference/partners.md](./docs/reference/partners.md) (Saving a partner).
- How soon bidding sees a partner change, from ANY writer, is `BIDDING_PICKUP`
  (`apps/web/src/lib/bidding-pickup.ts`), whose doc comment holds the method and the
  measured figures, and which `__guards__/worker/bidding-pickup-bound.test.ts` re-derives
  from the Worker's own constants. It holds while the partner constants reconfirm
  (`lib/partner-constants-reconfirm.ts`) succeeds; an API save also clears the copy at
  once. A failing reconfirm pages as `export-alert:partner-constants-reconfirm`, except
  during its observe window after the job first runs, when it only records (its log line
  says until when). When the reconfirm keeps failing, the stale copy alert is the ceiling.

## Code Standards
- Prefer TypeScript over JavaScript for all new code
- Use straight quotes (`'` and `"`) in all string literals — never smart/curly quotes
- No em dashes in copy or UI text — use periods, colons, or commas instead

## Codebase Navigation
A graphify knowledge graph of this codebase lives in `graphify-out/`. Before reading codebase files to answer a question or explore architecture, consult the graph first:
1. Grep `graphify-out/obsidian/` community files for relevant terms to identify which files are involved
2. Or grep `graphify-out/graph.json` for node labels/IDs
3. Then read only the specific files the graph points to

This avoids broad directory walks and full-file reads. Skip the graph only when you already know the exact file path.

## Workflow Preferences
- After completing a task that has an associated TODO or planning doc, always update that doc to reflect the completed work before moving on
- Never use the `open` command to preview files — triggers Island browser unexpectedly

## PRD reference
See [PRD.md](./PRD.md) for full specs. Phase sections in PRD map to TODO.md phases.

## Dev commands
```bash
pnpm dev:web       # Next.js dev server
pnpm dev:worker    # wrangler dev
pnpm typecheck     # typecheck all packages
pnpm lint          # lint all packages
pnpm --filter worker test:do   # the Durable Object suites, inside workerd
```

The worker has two vitest projects (#1410). `test:unit` is the Node suite. `test:do`
runs `src/durable-objects/__tests__/*.workers.test.ts` (project `do`, against the
bindings in `wrangler.toml`) and `src/ops/__tests__/*.workers.test.ts` (project `ops`,
against `wrangler.ops.toml`) inside workerd through `@cloudflare/vitest-plugin`
(`vitest.do.config.mts`), because a SQLite backed object cannot be proven against a Map
double. The Node config excludes those files and `tsconfig.do.json` typechecks them.
An object's clock is a field a test replaces through `runInDurableObject`; set it in
the FUTURE, because workerd fires an alarm whose time has passed at once, underneath
the test. CI names both suites and a guard fails if either is dropped.

> **pnpm gotcha:** Always use `pnpm run <script>`, never `pnpm <script>` — `pnpm deploy` hits the pnpm built-in, not the project script.

### Local dev is read-only against production (#669)
There is no separate local backend: `wrangler dev` and production share one Supabase project, and the Worker connects as `service_role`, which bypasses RLS. So an unguarded local run can write anywhere in production.

`apps/worker/src/lib/supabase.ts` therefore blocks writes (`insert`, `update`, `upsert`, `delete`) when `LOCAL_DEV` is set and `SUPABASE_URL` is not localhost. Reads stay allowed. An `rpc` call is allowed only when its name is on the `readOnly` list in `apps/worker/src/lib/read-only-rpcs.json`; a name on the `mutating` list, or one on neither, is refused the same way a write is (#1409). A web guard (`rpc-classification.test.ts`) requires every `.rpc('name')` in the worker to be on exactly one list, and the SQL suite checks the read only names are declared STABLE in a real database, so a write cannot be smuggled through as a read.

To write to prod deliberately from local, set `ALLOW_PROD_WRITES=true` in `apps/worker/.dev.vars` (gitignored). Unset it again afterwards; leaving it on permanently defeats the guard. This also means write-heavy e2e specs need the opt-in, or a database that is not prod.

The guard keys on the hostname, not a hardcoded project ref, so any database it cannot prove is local is treated as production. It is inert in production, where `LOCAL_DEV` is never set.

## GitHub
- Repo: https://github.com/Try-Pennie/bidspoke
- Commit and push after each meaningful chunk of work
- CI must pass before merging to main

### Never push straight to main (#266)
Every change to main goes through a pull request that CI has passed; the `Protect main` ruleset enforces it, but only while the repository is public. A renamed required CI check stays required under its old name, so rename it in the ruleset in the same change (L305). The ruleset, the detection behind it and why the local hooks are no barrier: [docs/main-branch-protection.md](./docs/main-branch-protection.md).
- Always commit `pnpm-lock.yaml` in the same commit as `package.json` changes. Every CI job installs with `--frozen-lockfile`, so a lockfile that does not match `package.json`, or one with a duplicated entry, fails the build. The repo's pnpm version is declared once, as `packageManager` in the root `package.json` (pnpm 9.15.9, #1677): CI's `pnpm/action-setup` reads it (no workflow names a version of its own), a local pnpm 10 switches to it automatically, and Dependabot uses it. It must stay pnpm 9: pnpm 11 drops the root `pnpm.overrides` from the lockfile, which CI's frozen install then refuses, and next-on-pages finds the pinned Vercel CLI only under pnpm 9. `apps/web/src/lib/__tests__/pnpm-version-declared.test.ts` guards all of that. Regenerate the lockfile with `CI=true npx -y pnpm@9.15.9 install --lockfile-only`, never a plain install through npx, which rebuilds node_modules. `pnpm-lock.yaml` was corrupt on main for 18 days in 2026-07/08 precisely because nothing installed strictly; `apps/web/src/lib/__tests__/lockfile-integrity.test.ts` now guards it.

### Where CI runs (#2768)
Every job's `runs-on` reads the org variable `PENNIE_CI_RUNNER`: exactly `pennie-mac` sends it to the runners on Dan's work MacBook, anything else to GitHub's `ubuntu-latest` (`github` since 2026-10-25, when the repo went public). [docs/ci-runners.md](./docs/ci-runners.md) says what a job must do to run on either, and `ci-runner-routing.test.ts` pins it. Every vitest config spreads `runnerTimeouts` (`vitest.runner-timeouts.ts`), 30 s a test only on a self-hosted runner, and the workerd projects take 30 s everywhere for the Worker's cold start.

## Database migrations
Migrations must be **backward-compatible (expand/contract)** so schema and code can deploy in either order without a window where prod code and schema disagree. In short: additive-only in a single migration (add nullable/defaulted columns, tables, indexes); never rename or drop in the same release that starts using the change — split renames/drops across two releases (expand + dual-write, then contract later). The deploy pipeline only CHECKS migrations are applied; you apply them by hand with `supabase db push`. Full rules + deployment runbook: [docs/adr/0007-expand-contract-migrations.md](./docs/adr/0007-expand-contract-migrations.md).

**Prove a migration against a real Postgres before pushing it** with `bash scripts/sql-suite/run.sh`, a throwaway container replaying every migration from empty; the pre push hook runs it when the branch changed `supabase/` (`SKIP_SQL_SUITE=1` only for a one time reason, explained first). Regenerate `database.ts` from that container, never from production. A function a route calls through `rpc` also needs an entry in `supabase/required-live-objects.json` and in `read-only-rpcs.json` (see the local dev section). The harness, its lock and the commands: [ADR 0007](./docs/adr/0007-expand-contract-migrations.md).

**The Data API's exposed schemas live in a migration, not the dashboard** (#1710): change `pgrst.db_schemas` only in a new migration listing every schema, and drop a schema from the list before dropping the schema itself. How: ADR 0007.

**The `porting` schema** (#1710) holds the Pipedream move's inventory, service role only. A workflow that will not be ported, or a step left out of a port, is recorded only by `node scripts/porting/record-decision.ts` (#2979), never by hand, and the decisions are Dan's. Its scripts: ADR 0007.

**The ops database is a separate Supabase project** (#1709, decision D8): "Bidspoke Ops", ref `zwihpjxouklvkvngkvmw` (repo variable `SUPABASE_OPS_PROJECT_ID`), us-west-2, Micro. It holds run data of workflows ported off Pipedream and serves no browser. Its migrations live in `supabase-ops/supabase/migrations` and its tests in `supabase-ops/supabase/tests`; prove them with `SQL_SUITE_PROJECT=ops bash scripts/sql-suite/run.sh`. Apply them with `supabase --workdir supabase-ops link --project-ref zwihpjxouklvkvngkvmw` once, then `supabase --workdir supabase-ops db push --linked`, never from the repo root, which is linked to the bidding project. Every ops table carries `organization_id uuid NOT NULL` and RLS, and anon and authenticated reach nothing: the first migration revokes the platform's default grants.

**The ops Worker** (`apps/worker/wrangler.ops.toml`, `src/ops/`) serves only when its `LANE` var is `ops`. Every ops read goes through `readOpsRows` (`src/ops/ops-db.ts`). A run handed off to `OpsInternal` is cancelled when the invocation that sent it ends, so await every run you dispatch. `wrangler.ops.toml` always names its cron. Ops writes go only through the functions listed in `src/ops/ops-rpcs.ts`, and a new run status or reason goes in `src/ops/run-vocabulary.ts` with its CHECK constraint. The tick, the gateway, rate limit waits, run variables and step tests: [docs/ops-worker.md](./docs/ops-worker.md).

**Ops connections**: every connection bound request goes through `connectionFetch` (`src/ops/connections/`); only the modules `connection-seal-open-callers.test.ts` lists may open a sealed login; a person bound (OAuth) login is refreshed only in its `ConnectionTokenObject`; a new ops key kid is named by its full date (`ops-YYYY-MM-DD`). How, and the checks behind each: [docs/ops-connections-logins.md](./docs/ops-connections-logins.md).

**The bidding Worker's binding to ops** (`OPS_CONNECTIONS`, #2335): bidding reaches it only through `src/lib/ops-connections-client.ts`, and nothing on the money path may import that or name the binding. Deadlines, CI's deployed check and the probe: docs/disaster-recovery.md.

**The App Action step** (`app_action`, ops only, [docs/nodes/app-action.md](./docs/nodes/app-action.md)): it runs its catalogue action at the version the step pinned, never the newest; a step on a person's own account runs only when whoever bound it owns the connection; a workflow holding an unfinished step cannot be switched on, saved live or restored onto a live workflow.

**An ops run's environment variables** (#2982): a run reads each variable's current value when it starts, and a secret's value is never stored on ops. `judgeVariables` (`lib/definition-env-references.ts`) is the one judgement of whether a definition's variables can be used. How: docs/ops-worker.md.

**Testing an ops step** (#2762): a test of an action that changes something is refused unless the person ticked Send for real (`confirm_send`), and each such action declares what a test sends in its catalogue `realSend`. The rest: docs/ops-worker.md.

**Ops services** (`packages/service-catalogue`, #2337): HTTP (#2760) and Supabase (#2763) join Snowflake, Slack, Salesforce, Google, OpenAI and Anthropic. An HTTP connection names one host, the header its key goes in, and a check path verify asks; the host is never another catalogue service's, never an address by number, and never one bidding sends to (`schema/http-host.ts`, `lib/connection-money-targets.ts`). A Supabase connection names one project, never the bidding project or the ops project itself (`schema/supabase-project.ts`, `laneProjectRefs` in `src/ops/ops-db.ts`), refused at save, at verify and on every send.

**Live privilege check** (`.github/scripts/db-privilege-check.mjs`, a step of CI's Security scans job on push to main): both projects are asked through the Management API, read only, for anything anon or authenticated can reach that they should not, and the step fails naming each one.

## Disaster recovery
Recovery runbook for catastrophic loss (Supabase, Cloudflare, secrets, destructive migration), and what happens to engine bidding while the database is down (Scenario E; there is no standby, #1675): [docs/disaster-recovery.md](./docs/disaster-recovery.md). The two worker secrets that cannot be re-derived are escrowed in 1Password (`Bidspoke recovery keys`, #384); the rest are re-obtained from their sources, see the runbook's Secret inventory.

## Worker secrets (production)
Set with `wrangler secret put <NAME> --name bidspoke-worker`, the value piped in, never committed. The live list is `wrangler secret list --name bidspoke-worker`; what each secret is, where it is re-obtained, and what checks the list (the daily required secrets check, CI's secret parity step) are in [docs/disaster-recovery.md](./docs/disaster-recovery.md) (Secret inventory). The ops Worker may hold, as Worker secrets, only those `OPS_ALLOWED_SECRETS` names in `apps/worker/src/lib/secret-lists.ts`, never the main service key, the encryption key, the SSN pepper or a partner credential; an ops run is still handed the decrypted value of any secret variable its definition reads, for that run only and never stored on ops (Dan, 2026-10-29, #2982). `SSN_HASH_PEPPER` is never rotated, and `OPS_CONNECTIONS_PRIVATE_KEY` (ops only) cannot be re-derived: restore either from 1Password, never generate a new one.

- **Cloudflare log access is partner API key access, and applicant PII access** (#958): grant it on that basis, and delete any `wrangler tail` capture written to a file. Why, and what Logpush forwards: docs/disaster-recovery.md.
- **Never swap `SECRET_ENCRYPTION_KEY` in one step**: rotate it with the four steps in docs/disaster-recovery.md (Rotating `SECRET_ENCRYPTION_KEY`). Every call site passes `secretKeys(env)`, never the raw key (`secret-key-ring-guard.test.ts`).
