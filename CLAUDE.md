# Bidspoke — Project Conventions

@TODO.md

## Design
@.impeccable.md

## Stack
- **Frontend:** Next.js 14 (App Router) on Cloudflare Pages — `apps/web`
- **Worker:** Cloudflare Workers with Hono — `apps/worker`
- **Database/Auth:** Supabase (Postgres + Auth + Realtime)
- **Package manager:** pnpm workspaces
- **Language:** TypeScript everywhere, strict mode

## Monorepo
- `apps/web` — Next.js frontend
- `apps/worker` — Cloudflare Worker (API + execution engine)
- `apps/worker-tail`: tail consumer that writes per-execution cost, and copies each
  cron guard `FAILED OPEN` log line into `cron_guard_fail_opens` (#2166), the second
  record the hourly cron guard check counts alongside its own KV record, and copies
  each `[cron-once] delivery` line into `cron_tick_deliveries` (#2284), the record of
  every tick delivery the check reads to page on a tick that may have run twice
- `apps/compare-outbound`: the outbound Worker of the `bidspoke-code-nodes-compare`
  dispatch namespace (#1708). Shadow runs dispatch their code there, and it refuses
  every request a script makes, so a shadow run sends nothing. Its own deploy leg.
- `apps/ops-outbound`: the outbound Worker of the `bidspoke-code-nodes-ops` dispatch
  namespace the ops Worker binds (#1709). It refuses every request until Phase 2
  defines what ops code may reach. A separate Worker from compare-outbound, which
  must refuse for ever. Deployed by its own leg, Deploy Ops Outbound, since the ops
  lane went live on 2026-10-06 (`OPS_WORKER_DEPLOYED` in
  `apps/worker/src/lib/secret-lists.ts`); Deploy Ops Worker then deploys
  `bidspoke-worker-ops` and proves `ops.trypennie.dev` answers as it.
- `packages/*`: code both apps import, so there is one implementation rather than
  a copy per app. Plain TypeScript source with no build step, listed in
  `transpilePackages` for Next. A package with tests must also be named in the CI
  test job, which `apps/web/src/lib/__tests__/ci-runs-every-package-suite.test.ts`
  enforces, because that job names its suites one by one and a new one would
  otherwise be green locally and never run in CI.
  - `packages/uuidv7`: UUIDv7 execution ids, minted identically by the Worker for
    live runs and by the browser for canvas test runs, plus the UTC day the
    execution archive derives from them.
  - `packages/connection-seal` (#2333): `seal` and `open` for ops connection
    logins. Bidding seals to an ops PUBLIC key (RSA-OAEP-256 wrapping a fresh
    AES-256-GCM key), bound by the canonical JSON of `{organization_id,
    connection_id, service, generation, kid}`; only ops, holding the private
    key, opens. Public keys are the code constant `src/keys.ts` (empty until the
    ops key is generated); a test fails on any private key material in the package.
  - `packages/script-hygiene`: trailing whitespace stripping for code node scripts
    (#1117), applied by the canvas serialiser and by every worker route that writes
    a definition, so a pasted script cannot carry column padding into storage. It
    leaves lines inside template literals alone because those spaces are value.
  - `packages/buyer-profile`: the one vocabulary, validator and evaluator set for
    buyer profiles and the buyer_select node (#1408, milestone 52). Populations,
    the wired population list, US states, out reasons with labels, signal
    operators, the tier matcher both pricing homes walk (the legacy `above`
    ladder in `bid-resolver.ts` is adapted into it), the Eastern clock, the
    eligibility evaluator and ranking, the sale outcome rules (the classifier's
    signal matching lives here and is imported back), the profile validator, the
    sale payload builder, the deadline wrapper, and the two click node rules that
    their executors and save validation share: the buyer_click_send over cap
    percent (#1553), the partner id rule both click nodes store their buyer by (#1543),
    and the one cap predicate `isCap` that save validation and both click nodes judge
    a cap by, with buyer_click_check's budget and last good copy bound (#1557), and the `{prospect_id}` click URL rule both enabling a click buyer and buyer_click_check read (#1546), and a click buyer's delivery (`click-delivery.ts`, #1639): the success line rule (`successPatternOf`) that buyer_click_send, canvas save validation and the profile validator all apply, and the route choice by state (`pickClickRoute`) the node posts by and the profile form's save confirmation describes. `fixtures/tripoint/` holds the
    redacted response shapes captured from production on 2026-09-21.
  - `packages/node-types`: the one list of node types a saved definition can carry
    (`NODE_TYPES`, `NodeType`), the traits each has (`NODE_TRAITS`: network,
    dispatch or storage, walker only, synthesizes attempts, references partners,
    static handles, executor file) and `assertNever` (#1411). Both apps re-export
    it from their old paths (`apps/worker/src/types.ts`, `apps/web/src/types/workflow.ts`).
    Adding a node type: add it here with its traits, and the compiler then names
    every switch and record that must handle it (`executeNode`, save validation,
    colours, cards, heights); the coverage tests name the palette, preview, config
    panel, shadow exemption, changelog glossary and similar fallback placements.
  - `packages/service-catalogue`: the ops service catalogue (#2337, #1689 Phase 7).
    Two entry points and no root one: `@bidspoke/service-catalogue/schema` is
    declarative (services, actions, arguments, traits, the `(key, version)` lookup)
    for web, the validator and the MCP tool; `/runtime` holds each action's `run`
    and the services' auth function slots, for the Workers only. Web never imports
    `runtime` (`apps/web/src/lib/__tests__/service-catalogue-runtime-stays-out-of-web.test.ts`,
    which also scans every package web depends on), and `schema` never reaches it
    (the package's own `catalogue.test.ts`). An action is
    `{ key, name, version, arguments[], sideEffect, idempotent, run }` and is never
    edited once released (D1): `src/fingerprints.json` holds a sha256 per
    `key@version` over its arguments, traits and the source of its run file
    `src/runtime/actions/<key>.v<version>.ts` plus every file that run file
    reaches through relative value imports (type only imports are left out), and
    a changed one fails, asking for a new version. A new version's
    fingerprint line is printed by the failing test for you to add. Every action
    decides `sideEffect` and `idempotent` itself, with `idempotentBecause` saying
    why, never from a Pipedream annotation (R11). Steps resolve an action by
    `(key, version)` and a missing version is refused as `action_version_missing`,
    never run on the newest. The catalogue is empty until the first service PR;
    `src/__fixtures__/catalogue` is a test only service that proves the machinery.
  - `packages/slack-client` (#2337): `createSlackClient`, the one place a Slack Web
    API client is built, used by the Worker's alerts and Settings routes, and the
    one the catalogue's ops Slack actions must use once they exist. It pins slack-web-api-client exactly, with retry
    and debug logging off, and holds the only declaration of the library.
    `slack-calls-one-client.test.ts` scans every workspace package and fails on any
    other Slack client or import.

## Key conventions
- All Worker routes are in `apps/worker/src/index.ts`, handlers in `src/routes/`
- Durable Objects live in `src/durable-objects/`
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
- Partner saves are versioned (#2132). The partner edit route (`PUT /api/partners/:id`)
  writes through the `save_partner_config` function, which writes just the fields a save
  names and refuses one made from a version that is no longer stored (409 `stale_version`,
  carrying the current row and who last changed it). Other writers (a step rename's
  `rename_partner_step_namespace`, hand run SQL) do not go through it, which is why the
  `partner_configs_bump_version` trigger, not the function, moves `version`: every writer
  moves it. The columns it ignores are the ones `partner_configs_unversioned_columns()`
  lists, which the audit trigger reads too. A 428 `reload_required` means the page was
  opened before versioned saves shipped, so it must be reloaded.
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
runs `src/durable-objects/__tests__/*.workers.test.ts` inside workerd through
`@cloudflare/vitest-plugin` (`vitest.do.config.mts`), against the bindings in
`wrangler.toml`, because a SQLite backed object cannot be proven against a Map
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
Every change to main goes through a pull request that CI has passed. This is a
**rule, not an enforced constraint**, and the difference matters: server-side
branch protection is unavailable on this repo (both `/rulesets` and
`/branches/main/protection` answer 403, "Upgrade to GitHub Pro or make this
repository public"), and Dan decided on 2026-08-17 to keep detection rather than
pay for prevention. So nothing stops a direct push except this line.

What exists instead is **detection after the fact**. The `Main has no unreviewed direct push` step of the
Security scans job in `ci.yml` (#760) runs on every push to main and reports a
commit that arrived without a reviewed PR. It is deliberately fail-safe towards
staying quiet, because it makes an accusation rather than withholding an action,
and it confirms an empty commit-to-PR association against the PR record before
saying anything: GitHub's association index can be empty for a genuinely reviewed
merge, and a false accusation is what teaches everyone to ignore a guard.

The husky pre-push hooks (test gate, style gate) are also rules rather than
constraints: `--no-verify`, `SKIP_TEST_CHECK` and `SKIP_STYLE_CHECK` each bypass
them, which is by design for the rare justified case and useless as a barrier.

If the plan is ever upgraded, close this gap properly: require a PR, require the
CI checks, require one approving review, and disallow force-push and deletion.
- Always commit `pnpm-lock.yaml` in the same commit as `package.json` changes. Every CI job installs with `--frozen-lockfile`, so a lockfile that does not match `package.json`, or one with a duplicated entry, fails the build. The repo's pnpm version is declared once, as `packageManager` in the root `package.json` (pnpm 9.15.9, #1677): CI's `pnpm/action-setup` reads it (no workflow names a version of its own), a local pnpm 10 switches to it automatically, and Dependabot uses it. It must stay pnpm 9: pnpm 11 drops the root `pnpm.overrides` from the lockfile, which CI's frozen install then refuses, and next-on-pages finds the pinned Vercel CLI only under pnpm 9. `apps/web/src/lib/__tests__/pnpm-version-declared.test.ts` guards all of that. Regenerate the lockfile with `CI=true npx -y pnpm@9.15.9 install --lockfile-only`, never a plain install through npx, which rebuilds node_modules. `pnpm-lock.yaml` was corrupt on main for 18 days in 2026-07/08 precisely because nothing installed strictly; `apps/web/src/lib/__tests__/lockfile-integrity.test.ts` now guards it.

## Database migrations
Migrations must be **backward-compatible (expand/contract)** so schema and code can deploy in either order without a window where prod code and schema disagree. In short: additive-only in a single migration (add nullable/defaulted columns, tables, indexes); never rename or drop in the same release that starts using the change — split renames/drops across two releases (expand + dual-write, then contract later). The deploy pipeline only CHECKS migrations are applied; you apply them by hand with `supabase db push`. Full rules + deployment runbook: [docs/adr/0007-expand-contract-migrations.md](./docs/adr/0007-expand-contract-migrations.md).

**Prove a migration against a real Postgres before pushing it.** `bash scripts/sql-suite/run.sh` starts a throwaway `supabase/postgres` Docker container on port 54329 (never production: the harness reaches it only through `docker exec`, so it has no connection string that could point anywhere else), bootstraps the handful of objects the hosted platform provides outside migrations (`scripts/sql-suite/bootstrap.sql`), replays every file in `supabase/migrations/` from empty, then runs `supabase/tests/*.test.sql`. The pre push hook runs it whenever the branch itself changed `supabase/`, the rpc allowlist or the harness, measured from its merge base with origin/main by `scripts/pre-push-sql-suites.sh`, and runs both suites when that cannot be computed (#2412) (`SKIP_SQL_SUITE=1` for the one time reason, explained first). Regenerate `database.ts` from that container rather than from production: `SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres pnpm --filter worker db:types`. A function a route calls through `rpc` also needs an entry in `supabase/required-live-objects.json` and in `read-only-rpcs.json` (see the local dev section).

**The Data API's exposed schemas live in a migration, not the dashboard** (#1710). `20261006180000_porting_inventory_1710.sql` sets `ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, porting'`, and once that role setting exists the dashboard's "Exposed schemas" field no longer governs the list. To expose or drop a schema, change that setting in a new migration (listing every schema) and `NOTIFY pgrst, 'reload config'`; drop a schema from the list before dropping the schema itself, or PostgREST cannot build its cache (PGRST002). `supabase/tests/porting_inventory.test.sql` asserts the current list. The types generator names each schema the typed client reads (`public` and `porting`) in `apps/worker/scripts/gen-db-types.sh`.

**The `porting` schema** holds the Pipedream move's inventory (`pipedream_inventory`, `pipedream_workflow_map`, #1710): service role only, RLS on with no policy, anon and authenticated revoked. `node scripts/porting/load-inventory.ts <export dir> --org <uuid> [--apply]` loads an export (it prints its plan and writes nothing without `--apply`); `node scripts/porting/unlock-table.ts <export dir>` prints the unlock table and the derived build order. Both read the export through `packages/porting-evidence/src/inventory/`.

**The ops database is a separate Supabase project** (#1709, decision D8): "Bidspoke Ops", ref `zwihpjxouklvkvngkvmw` (repo variable `SUPABASE_OPS_PROJECT_ID`), us-west-2, Micro. It holds run data of workflows ported off Pipedream and serves no browser. Its migrations live in `supabase-ops/supabase/migrations` and its tests in `supabase-ops/supabase/tests`; prove them with `SQL_SUITE_PROJECT=ops bash scripts/sql-suite/run.sh` (its own container on port 54330, bootstrapped to the live project's measured grants), which the pre push hook runs when the branch itself changed `supabase-ops/` (measured from its merge base, as above). Apply them with `supabase --workdir supabase-ops link --project-ref zwihpjxouklvkvngkvmw` once, then `supabase --workdir supabase-ops db push --linked`, never from the repo root, which is linked to the bidding project. Every ops table carries `organization_id uuid NOT NULL` and RLS, and anon and authenticated reach nothing: the first migration revokes the platform's default grants.

**The ops Worker** (`apps/worker/wrangler.ops.toml`, `src/ops/`) serves only when its `LANE` var is `ops`. Its database client and its one read live in `src/ops/ops-db.ts`: every ops query goes through `readOpsRows`, which takes an `OrganizationId` by type, filters on it and refuses a row of any other organization, and `apps/web/src/lib/__guards__/worker/ops-reads-through-helper.test.ts` fails on any other `.from(`, `.rpc(` or `.schema(` against the ops client. Both database clients carry the local dev write guard in `src/lib/local-dev-write-guard.ts`. The ops Worker binds itself as `SELF` to the `OpsInternal` entrypoint, so a run handed off there gets its own 30 s of CPU but no wall clock of its own: it is cancelled the moment the invocation that sent it ends, so the sender must await every run it dispatches (#1946, measured in docs/ops-ceilings-spike.md). Its minute cron (#1949) runs one tick of `src/ops/tick.ts` in observe mode: it computes which schedule slots are due on the database clock, records each in `schedule_fire_observations`, and sends each to `OpsInternal.observe` signed (`src/ops/dispatch-auth.ts`), but claims and runs nothing. It reads the ops workflows' state from the bidding Worker's `OpsGateway` entrypoint over its `OPS_GATEWAY` binding (Dan's decision 4, 2026-10-16, recorded on #1698 and #1949: the bidding database stays the one home of every definition) and keeps the last good copy in `ops_workflow_copies`; it plans from that copy as saved, never from its own fetch, and a copy not newer than the last known switch off may not start. The tick stamps its heartbeat through the gateway, so the bidding Worker watches it (`ops-tick` in `cron-heartbeat.ts`). `wrangler.ops.toml` always names its cron, because a config that names no cron leaves the old one firing. Ops writes go through one choke point that the database enforces (#1948): `service_role` holds SELECT only on the run engine tables, so every write is one of the SECURITY DEFINER functions, and `callOpsRpc` in `src/ops/ops-writes.ts` is the only `.rpc(` on the ops client and refuses any function not listed in `src/ops/ops-rpcs.ts`. A new ops function goes in `ops-rpcs.ts`, and a new run status or reason goes in `src/ops/run-vocabulary.ts` together with its CHECK constraint, which a test compares. Every connection bound request goes through `connectionFetch` (`src/ops/connections/`), whose login minters (`minters/`) follow decision 2 (a refused login is needs_reauth at once; a timeout or 5xx is `refresh_failing` until 5 failures, the first at least 15 minutes old) and refuse a Google mailbox or drive not on the organization's `google_delegation_subjects` list (F129, proven by attempting one in `minters/__tests__/google.test.ts`); only connectionFetch and the restore drill script may open a sealed login (`connection-seal-open-callers.test.ts` lists them); the admin setup for each service is in docs/ops-connections-logins.md.

**Live privilege check** (`.github/scripts/db-privilege-check.mjs`, a step of CI's Security scans job on push to main): both projects are asked through the Management API, read only, for anything anon or authenticated can reach that they should not, and the step fails naming each one.

## Disaster recovery
Recovery runbook for catastrophic loss (Supabase, Cloudflare, secrets, destructive migration), and what happens to engine bidding while the database is down (Scenario E; there is no standby, #1675): [docs/disaster-recovery.md](./docs/disaster-recovery.md). The two worker secrets that cannot be re-derived are escrowed in 1Password (`Bidspoke recovery keys`, #384); the rest are re-obtained from their sources, see the runbook's Secret inventory.

## Worker secrets (production)
These are set via `wrangler secret put <NAME> --name bidspoke-worker` and never committed to git. There are ~20, not the handful below.

**Authoritative sources** (don't trust this table to be exhaustive):
- Live truth: `wrangler secret list --name bidspoke-worker`.
- Annotated inventory with where to re-obtain each (for recovery): [docs/disaster-recovery.md](./docs/disaster-recovery.md) (Secret inventory).
- The no-default secrets are runtime-guarded: a daily cron check (`apps/worker/src/lib/required-secrets.ts`, #386) alerts Slack if any is unset in prod. It covers the 15 core secrets plus the live partner secrets (Salesforce, Equifax `EQ_USER`/`EQ_PASS`, Tripoint); feature-gated partners (Achieve, Scout) are excluded to avoid false alarms.
- The ops Worker (`bidspoke-worker-ops`) may hold only the secrets `OPS_ALLOWED_SECRETS` names in `apps/worker/src/lib/secret-lists.ts` (#1709), never the main service key, the encryption key, the SSN pepper or a partner credential. CI's Worker secret parity step (Security scans, push to main) reads both Workers' secret names through the Cloudflare API and fails on a required secret missing from either or any secret on ops outside its allowlist. The lists live in that one module, which the daily guard reads too.
- Note: the worker's `Env` TypeScript interface (`apps/worker/src/env.ts`, re-exported from `src/index.ts`) is NOT a complete list. Several partner secrets (Salesforce, Achieve, Equifax) are read dynamically and aren't declared there.

| Group | Secrets |
|-------|---------|
| Supabase | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY` |
| Webhook auth | `API_KEY_MAP` (JSON map of webhook API keys to source names) |
| Cloudflare (partner-secret sync) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Encryption / PII | `SECRET_ENCRYPTION_KEY` (decrypts every secret environment variable on every run, and reveal, plus the `app_settings` encrypted values, the held Salesforce write-back deadletters and the sealed Slack bot token), `SSN_HASH_PEPPER` (the archive's erasure resolver, never rotate it) |
| Snowflake export | `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_PRIVATE_KEY`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_ROLE` |
| Salesforce | `SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` |
| Partner APIs | `EQUIFAX_USERNAME`, `EQUIFAX_PASSWORD`, `TRIPOINT_PROXY_SECRET`, `ACHIEVE_USERNAME`, `ACHIEVE_PASSWORD`, `ACHIEVE_API_URL`, `SCOUT_KEY`, `ACHIEVE_PARTNER_KEY` (shared with Achieve, matched by their firewall Skip rule; see disaster-recovery.md), `LINK_TOKEN_SECRET` (signs the trypennie.com offer links, #2089, the RML reservemyloan.com links and the Forms submit link, #2092; shared with Salesforce, trypennie.com and the Pipedream RML workflows) |
| Optional (feature-gated) | `GITHUB_TOKEN` (workflow backup), `GITHUB_ACTIONS_TOKEN` (reads this repo's Actions history for the scheduled-workflow watch, #842, and dispatches those workflows, #1058, so it needs Actions read AND write), `ANTHROPIC_API_KEY` (changelog drafting) |

### Cloudflare log access is partner API key access (#958)
The `Workers trace events` stream carries request headers with values intact, `X-API-Key` included, so anyone who can `wrangler tail` this worker or read Workers Logs can read every partner webhook key. Measured 2026-09-09. Grant log access on that basis, and delete any tail capture you write to a file: it is a file full of live partner credentials. The Better Stack Logpush job did forward those header fields until 2026-09-09, when its field list was narrowed to drop `Logs` and `Event`; the history it already holds stays there by Dan's decision (#1007, closed). The daily check now reads the Logpush job list itself, with a token that carries Logs Write because Cloudflare offers no read only scope for that API (#1010, closed). Full note in [docs/disaster-recovery.md](./docs/disaster-recovery.md).

Two secrets cannot be re-derived if lost, and are escrowed in the 1Password item `Bidspoke recovery keys` (#384): `SSN_HASH_PEPPER` (a new value leaves every archived record unfindable by SSN for an erasure request) and `SECRET_ENCRYPTION_KEY` (every stored secret environment variable, the `app_settings` encrypted values, the held Salesforce write-back deadletters and the sealed Slack bot token are locked with it).

### Rotating `SECRET_ENCRYPTION_KEY`
The engine decrypts every secret environment variable with this key on every execution (`lib/env-loader.ts`), so it is never swapped in one step: a secret that no longer decrypts is skipped, and a node reading it through `{{env.X}}` gets nothing. Rotate it in four steps with no window where anything fails to decrypt (#384):

1. Generate the new key and save it in the recovery 1Password item FIRST, then set it as `SECRET_ENCRYPTION_KEY_NEXT` (pipe the value in, never type it on a command line). While NEXT is set, new writes lock with it and reads accept either key (`secretKeys(env)` in `lib/secret-crypto.ts`).
2. `POST /api/admin/reencrypt-secrets` with `{"dryRun": false}` re-locks every stored value (the secret environment variables, `app_settings.value_encrypted`, and the encrypted columns of `outcome_writeback_deadletters`, the failed Salesforce writes held for replay, #1993, and the sealed Slack bot token in `service_connections.credential_enc` where `sealed_for` is `bidding_ring`, #2331). It previews by default. Re-run until it reports `ok: true` and nothing left to re-lock.
3. Wait at least 24 hours after step 1, then set `SECRET_ENCRYPTION_KEY` to the same value, from the 1Password copy, and delete `SECRET_ENCRYPTION_KEY_NEXT`. The wait is for the at-risk Salesforce write records in KV (`at-risk-write:`, #2022): the route does not re-lock them, so one written under the old key must expire (24 hours) before the old key stops opening it.
4. Run the route once more as a preview: every row should count as already current under the primary alone.

Every call site passes `secretKeys(env)`, never the raw key; `__guards__/worker/secret-key-ring-guard.test.ts` fails on one that does.
