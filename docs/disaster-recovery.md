# Disaster recovery runbook

How to recover Bidspoke from a catastrophic loss. Bidspoke is live and routes real money-moving partner-bidding traffic, so the failure modes here are not hypothetical: incident #237 (a DDL storm that 503'd PostgREST and dropped `lead_sightings` rows) is the kind of event this plan exists for.

This is a living runbook. Lines marked **[OWNER-TODO]** need information only the team has (contacts, targets, escrow location) and should be filled in and kept current.

## Targets

Confirmed in the 2026-06-26 restore drill (#270 — see [restore-drill.md](./dr-restore-drill.md)).

- **RPO (how much data we can lose):** **up to ~24h** for the general database. Supabase is on the **Pro** plan with **daily** managed backups (7-day retention); PITR is **not** enabled (deliberate — the ~$100/mo add-on would cut this to ~2 min, revisit if 24h becomes unacceptable). Two highest-value data sets have a tighter effective RPO via independent backups: **workflow definitions** (~0, pushed to the `bidspoke-workflows` GitHub repo on every save) and **lead-sighting / bid outcomes** (<24h, nightly Snowflake export). PITR is also the only thing that recovers a *destructive migration* to the moment-before — without it, Scenario B loses up to a day.
- **RTO (how fast we must be back):**
  - **Resume bidding (config + schema restored): ~8 min proven** in the drill (laptop-driven logical restore), plus the Cloudflare Worker/Pages redeploy and worker-secret re-provisioning to actually serve traffic. A co-located runner or Supabase's native managed restore would be faster.
  - **Full system (all execution-log history + raw-SSN tables): hours**, dominated by the 25 GB physical restore (Supabase-side). Not on the critical path for getting money moving again.
  - Fastest mitigation while restoring: reroute the engine to the warm Pipedream flow (Scenario E).

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
2. Restore from backup. Tier confirmed (2026-06-26): **Supabase Pro daily backups, 7-day retention, PITR not enabled** — so restore is to the most recent nightly backup (RPO up to ~24h), not to an arbitrary point in time. The restore path is proven end-to-end in [restore-drill.md](./dr-restore-drill.md); for the config/system-of-record subset, `scripts/dr-restore-drill.sh` dumps and restores it in ~5 min. The bulk (execution logs, `persons`, `lead_sightings`) comes from Supabase's managed restore of the daily backup.
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

**Escrow status (2026-06-26): NOT YET ESCROWED — open blocker.** There is no shared team secret store today, so a restore operator would have to re-obtain each secret from its origin mid-incident. Two secrets cannot be re-derived and *must* be escrowed or they are lost forever: `SSN_HASH_PEPPER` (changing it breaks person-dedup continuity — treat as immutable) and, for old reveals, `SECRET_ENCRYPTION_KEY`.

To close this gap:
1. Stand up a shared secret store (a 1Password vault is the expected choice; any team-accessible manager works).
2. Run `wrangler secret list --name bidspoke-worker` for the authoritative live list, then copy each value (from its source) into the vault, grouped as in the categories above.
3. Grant the restore operators / on-call access to that vault and note its location here.
4. Re-confirm on each quarterly restore drill that the escrowed copy is current (new secrets get added over time).

## Escalation

**[OWNER-TODO]** Fill in the on-call / escalation order with names and contact methods, plus the account owners for: Cloudflare (account admin/billing), Supabase (project owner/billing), Salesforce admin, and each partner integration contact (Equifax, Tripoint/Brian, M1, Snowflake, Achieve).

## Drills

- **Restore drill: run quarterly.** Full procedure, the proven-RTO results log, and the reusable `scripts/dr-restore-drill.sh` live in [restore-drill.md](./dr-restore-drill.md). First drill ran 2026-06-26 (PASS). The cadence reminder is a recurring Google Calendar event linking that doc.
- Re-run after any migration that adds or removes a system-of-record table (the drill's row-count verification flags a table missing from the script's allow-list).
- Keep this runbook current as infrastructure changes (new secrets, new KV/DO bindings, new partners).
