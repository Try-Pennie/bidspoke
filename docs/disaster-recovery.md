# Disaster recovery runbook

How to recover Bidspoke from a catastrophic loss. Bidspoke is live and routes real money-moving partner-bidding traffic, so the failure modes here are not hypothetical: incident #237 (a DDL storm that 503'd PostgREST and dropped `lead_sightings` rows) is the kind of event this plan exists for.

This is a living runbook. Lines marked **[OWNER-TODO]** need information only the team has (contacts, targets, escrow location) and should be filled in and kept current.

## Targets

- **RTO (how fast we must be back):** **[OWNER-TODO]** — propose a target per tier (e.g. engine bidding back within X minutes; full system within Y hours).
- **RPO (how much data we can lose):** **[OWNER-TODO]** — bounded by the Supabase backup/PITR window (confirm in the backup/restore drill, #270).

## What must be recovered (system inventory)

1. **Supabase** (project `xvrmivmpfykwwtriqwpg`): Postgres (all workflow, execution, lead-sighting, partner data), Auth (Google SSO users + `user_allowlist`), Realtime, and the pg_cron jobs (purge, strand drains, exports). The database is the only stateful system of record — everything else is redeployable from git.
2. **Cloudflare** (account `3e7f907a9c19e51417873e2cce4fbc5c`, "Pennie"):
   - Workers: `bidspoke-worker` (engine + API) and the tail consumer (`apps/worker-tail`).
   - Pages: the Next.js frontend.
   - KV namespaces: `WORKFLOW_CACHE`, `IDEMPOTENCY`, `SUBMISSIONS` (all caches/ephemeral — rebuildable, not a system of record).
   - Durable Objects: `DailyCapObject`, `CircuitBreakerObject`, `BulkheadObject` (transient runtime state — self-heals).
   - Dispatch namespace: `bidspoke-code-nodes` (Workers-for-Platforms, backs the code-node sandbox).
   - R2: the Logpush destination (cold-tier log archive).
   - DNS + routes: wildcard `*.trypennie.dev` (partner subdomain endpoints), the Worker route, and the `bidspoke.trypennie.dev` bypass route that protects Pages.
   - Crons: `0 9 * * *`, `0 13 * * *`, `0 * * * *`, `* * * * *` (defined in `apps/worker/wrangler.toml`).
3. **Worker secrets** (NOT escrowed today — see Secret inventory). The `wrangler secret put` values are not in git; losing them without an escrow copy means re-obtaining each from its source.
4. **External integrations** whose credentials/config must be re-provisioned: Salesforce (External Client App "Bidspoke API", client-credentials flow), Equifax, the Tripoint proxy, M1, Snowflake (nightly export), the GitHub workflow-backup repo, Achieve, and Slack (alerts).

## Independent backups that survive a Bidspoke loss

- **Workflow definitions** are pushed to the GitHub backup repo (`bidspoke-workflows`) on every save, so the canvas logic survives a Supabase loss (re-import from there).
- **Lead-sighting + bid outcome data** is exported nightly (09:00 UTC) to Snowflake, so analytics-grade outcome history survives even past the Postgres retention window.
- **The engine bidding flow stays warm on Pipedream** as the designated rollback target (the original platform, kept live since the cutover). This is the fastest mitigation for an engine-bidding outage — reroute the engine to Pipedream while Bidspoke is restored (see Scenario E).

## Scenarios

### A. Supabase project loss or corruption

1. Confirm scope: is the project deleted, the DB corrupted, or just an outage? Check the Supabase status page and dashboard.
2. Restore from backup / point-in-time recovery (PITR) to just before the event. **[OWNER-TODO]** confirm PITR is enabled and the window (do this in the #270 restore drill, not during an incident).
3. If the project itself is gone, create a new project, restore the dump, then update every consumer of the project ref/keys: the worker secret `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, the CI/Deploy `SUPABASE_PROJECT_ID` var + `SUPABASE_ACCESS_TOKEN` secret, and re-link `supabase link`.
4. Re-run pending migrations against the restored DB (`supabase db push`) and verify pg_cron jobs are scheduled (`cron.job`).
5. While restoring, reroute the engine to the warm Pipedream flow (Scenario E) so bidding keeps moving.

### B. Destructive or buggy migration

1. The expand/contract discipline (ADR 0007) makes most migrations additive and safe; a genuinely destructive one (DROP, irreversible data change) is the risk.
2. Recover the dropped data via PITR to immediately before the migration (RPO = the PITR granularity). There is no per-migration down-script today (tracked: production-readiness #28).
3. If only a function/policy was broken, `CREATE OR REPLACE` the prior definition from git history rather than a full restore.

### C. Cloudflare Worker / Pages loss (account intact)

Everything here is redeployable from git — no data loss, since state lives in Supabase.

1. Worker: `pnpm --filter worker exec wrangler deploy` (or re-run the Deploy workflow). This recreates the worker from `wrangler.toml` (KV/DO/dispatch bindings, routes, crons).
2. Re-provision the worker secrets (Secret inventory below) via `wrangler secret put <NAME> --name bidspoke-worker` or the CF dashboard. NOTE: `wrangler secret put` through a non-interactive shell uploads blank — use a real terminal or the dashboard.
3. KV namespaces / DOs / dispatch namespace: if deleted, recreate (`wrangler kv namespace create ...`) and paste the new IDs into `wrangler.toml`. KV/DO contents are caches/transient and self-rebuild; no restore needed.
4. Pages: re-deploy the frontend (Deploy workflow's Deploy Pages job).
5. DNS/routes: recreate the wildcard `* CNAME -> bidspoke-worker.workers.dev`, the Worker route `*.trypennie.dev/*`, and the `bidspoke.trypennie.dev/*` bypass route (no worker) that protects Pages. These are configured in the CF dashboard, not wrangler.

### D. Cloudflare account loss

1. The hard case: a new account means new account ID, new KV/DO/dispatch IDs, and re-provisioning everything in Scenario C against the new account, plus updating `account_id` in `wrangler.toml` and the `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` secrets.
2. **[OWNER-TODO]** confirm who holds CF account admin / billing and that recovery access (not just a single personal login) exists. This is the single biggest unescrowed dependency.

### E. Region / partial outage, or "just get bidding back"

1. Cloudflare Workers run globally, so a single-region outage is largely absorbed. A Supabase region outage is the real exposure (the DB is single-region).
2. Fastest mitigation for an engine-bidding outage: **reroute the engine to the warm Pipedream flow.** **[OWNER-TODO]** document the exact reroute step (where the engine's destination URL is configured) so this is a one-action failover.
3. Bidspoke logging/finalize tolerates transient DB blips (PostgREST retry ladder + the strand drains recover lost finalizes), so a brief Supabase hiccup degrades gracefully rather than dropping leads.

### F. Secret loss or compromise

1. Re-provision from each source (Secret inventory). For a compromise, rotate at the source first, then update the worker secret.
2. **Special case — `SECRET_ENCRYPTION_KEY`:** rotating it breaks "reveal" for env-var secrets created before the rotation (users see "rotate to enable reveal" until they re-save). See CLAUDE.md.
3. **Special case — `SSN_HASH_PEPPER`:** changing it changes the peppered SSN hash, breaking person-dedup continuity for `lead_sightings`. Treat as effectively immutable; escrow it.

## Secret inventory (and the escrow gap)

The authoritative live list is `wrangler secret list --name bidspoke-worker`. Worker secrets are **not escrowed** today — losing the worker without a copy means re-obtaining each from its origin. Categories (re-provision source in parentheses):

- Supabase: `SUPABASE_SECRET_KEY` (Supabase dashboard service-role key), `SUPABASE_JWKS_URL`.
- Cloudflare: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (for partner-secret sync).
- Encryption/PII: `SECRET_ENCRYPTION_KEY` (regenerate = breaks old reveals), `SSN_HASH_PEPPER` (immutable — escrow), `PII_REDACTION_FIELDS`.
- Salesforce: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_INSTANCE_URL` (External Client App in SF Setup).
- Partners: Equifax (`EQ_USER`, `EQ_PASS`), Eligibility Scout (`SCOUT_KEY`), Tripoint proxy secret, Achieve (`ACHIEVE_USERNAME`, `ACHIEVE_PASSWORD`, `ACHIEVE_API_URL`, ...), webhook keys (`API_KEY_MAP`).
- Data export: `SNOWFLAKE_*` (account/user/private key/role/db/schema/warehouse).
- Other: `GITHUB_TOKEN` + `GITHUB_REPO` (workflow backup), `ANTHROPIC_API_KEY`, `APP_URL`.

**[OWNER-TODO]** Escrow all of the above in a shared secret store (e.g. a 1Password vault) so recovery does not depend on re-deriving each from its source mid-incident. This closes the issue's "worker secrets not escrowed" gap.

## Escalation

**[OWNER-TODO]** Fill in the on-call / escalation order with names and contact methods, plus the account owners for: Cloudflare (account admin/billing), Supabase (project owner/billing), Salesforce admin, and each partner integration contact (Equifax, Tripoint/Brian, M1, Snowflake, Achieve).

## Drills

- Run the backup-verification + restore drill (#270) on a cadence (**[OWNER-TODO]** quarterly?) to confirm the Supabase RPO and that a restore actually works before an incident needs it.
- Keep this runbook current as infrastructure changes (new secrets, new KV/DO bindings, new partners).
