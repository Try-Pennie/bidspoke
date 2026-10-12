/**
 * The money Worker's bindings, secrets and vars (#1707, plan 0.C). Lives in its
 * own module so code shared with the ops Worker can name the Env it needs
 * without importing the money Worker's entry point. Re-exported from
 * src/index.ts, so every existing `import type { Env } from '../index'` keeps
 * working.
 */
export interface Env {
  // KV namespaces
  WORKFLOW_CACHE: KVNamespace
  IDEMPOTENCY: KVNamespace
  SUBMISSIONS: KVNamespace

  // Durable Objects
  DAILY_CAP: DurableObjectNamespace
  CIRCUIT_BREAKER: DurableObjectNamespace
  // Inflight-concurrency limiter for Salesforce (ADR 0005 / #312)
  SALESFORCE_BULKHEAD: DurableObjectNamespace
  // Latency Gate bid marks (#488). A DO, not KV: the mark and the confirmation land
  // in different colos, and KV's propagation delay made a fast confirmation look
  // like a missing mark, which the gate rejects.
  LATENCY_MARK: DurableObjectNamespace
  // Alert claims (#1298): exactly one cron tick posts a given alert per cooldown.
  ALERT_CLAIM: DurableObjectNamespace
  // Buyer selection (#1410): one SQLite ledger per buyer, holding reservations
  // and outcomes; caps are counted from it. Sale state, not self healing.
  BUYER_LEDGER: DurableObjectNamespace
  // Buyer selection (#1410): one claim per lead, so a lead is sold at most once.
  LEAD_SALE: DurableObjectNamespace

  // Max simultaneous in-flight Salesforce calls (string env var; default 20,
  // kept below SF's ~25-slot concurrency governor). Optional.
  SALESFORCE_BULKHEAD_LIMIT?: string
  SALESFORCE_BULKHEAD_WAIT_MS?: string

  // Supabase (secrets)
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_JWKS_URL: string  // public var in wrangler.toml
  // Overrides the 45s per-request fetch deadline (#1484). Unset in production;
  // the outage drill sets it small so it need not wait the real deadline out.
  SUPABASE_REQUEST_DEADLINE_MS?: string

  // Webhook auth, a JSON string: { [apiKey: string]: sourceName }
  API_KEY_MAP: string

  // PII redaction: comma-separated field patterns, empty = disabled (PRD 12.4)
  PII_REDACTION_FIELDS: string

  // Field-presence capture (#419/#410). 'true' enables the dark write of the
  // per-execution watched-field presence map; off or unset disables it.
  // Default off so deploying before the migration is applied is safe.
  FIELD_PRESENCE_CAPTURE?: string

  // Frontend URL: used for deep links in Slack alerts
  APP_URL: string

  // Git commit the live worker was deployed from: stamped via `wrangler deploy
  // --var DEPLOYED_SHA:<sha>` in the deploy workflow, surfaced at GET / so a
  // scheduled check can detect a "committed but never deployed" worker (#327).
  DEPLOYED_SHA?: string

  // External hostname the volume-cliff monitor hits to confirm the worker is
  // reachable from outside Cloudflare. Must be a stable bidspoke-owned URL that
  // routes to this worker. Optional; falls back to a built-in default.
  SELF_CHECK_URL?: string

  // Cloudflare API: for syncing secrets (PRD 12.3)
  CLOUDFLARE_API_TOKEN: string
  CLOUDFLARE_ACCOUNT_ID: string
  // Logpush destination check (#1010). Optional: the check reports its own
  // absence rather than failing, so the worker runs without it. Note it carries
  // Logs EDIT, because Cloudflare's Logpush API requires write permission even
  // for a GET; read-only is not available for that API.
  CLOUDFLARE_LOGS_TOKEN?: string

  // Env var secret encryption: AES-GCM key, base64-encoded 32 bytes
  // Generate: openssl rand -base64 32 | wrangler secret put SECRET_ENCRYPTION_KEY
  SECRET_ENCRYPTION_KEY: string
  // Set only during a key rotation (#384): new writes lock with it and reads accept
  // either key. See lib/secret-crypto.ts and POST /api/admin/reencrypt-secrets.
  SECRET_ENCRYPTION_KEY_NEXT?: string

  // SSN hash pepper: used for indexed dedup lookups on persons.ssn_hash
  // Generate: openssl rand -base64 32 | wrangler secret put SSN_HASH_PEPPER
  // CRITICAL: rotating this secret breaks all dedup lookups (old hashes become unmatchable)
  SSN_HASH_PEPPER: string

  // Snowflake REST API: export of lead_sightings + lead_sighting_bids (every 2h).
  // Auth: key-pair JWT. Service user `bidspoke_service` with role `bidspoke_role`.
  SNOWFLAKE_ACCOUNT: string         // URL prefix, e.g. 'jyc55588.us-east-1'
  SNOWFLAKE_USER: string
  SNOWFLAKE_PRIVATE_KEY: string     // RSA PEM (PKCS#1 or PKCS#8)
  SNOWFLAKE_DATABASE: string
  SNOWFLAKE_SCHEMA: string
  SNOWFLAKE_WAREHOUSE: string
  SNOWFLAKE_ROLE: string

  // Execution archive (#870, Phase A2). Three identities in their own Snowflake
  // database, split by what each may DESTROY: the writer and the reader hold no
  // DELETE, and the eraser is the only one that does, so a bug or a leaked
  // credential on the hourly ingest or the read path cannot remove archived rows.
  //
  // The account, database, schema and warehouse are NOT repeated per identity:
  // all three live in BIDSPOKE_ARCHIVE.EXECUTIONS on ARCHIVE_WH, created by
  // docs/snowflake-archive-setup.sql, and a second copy of those values is a
  // second thing to keep in step.
  //
  // Deliberately NOT in REQUIRED_SECRETS yet. That guard alerts every org's Slack
  // daily, so registering six secrets before the Snowflake identities exist would
  // page for nothing every day until they do. They join it in A3 (#871), when the
  // archiver that reads them ships.
  ARCHIVE_WRITER_USER: string
  ARCHIVE_WRITER_PRIVATE_KEY: string    // RSA PEM, the PRIVATE half of the writer key pair
  ARCHIVE_READER_USER: string
  ARCHIVE_READER_PRIVATE_KEY: string
  ARCHIVE_ERASER_USER: string
  ARCHIVE_ERASER_PRIVATE_KEY: string

  // Dynamic Worker dispatch: code node sandboxing (PRD Section 5.4)
  DYNAMIC_WORKER_LOADER: DispatchNamespace
  /**
   * The compare namespace (#1708 part B): where shadow runs dispatch their code,
   * with bidspoke-compare-outbound as its outbound Worker, which refuses every
   * request. Optional, so a run without it refuses a shadow run by name.
   */
  COMPARE_CODE_LOADER?: DispatchNamespace

  // GitHub backup: push workflow definitions on save (PRD Section 3.2)
  // Optional: set via `wrangler secret put GITHUB_TOKEN` and wrangler.toml [vars] GITHUB_REPO
  GITHUB_TOKEN?: string
  GITHUB_REPO?: string

  // This repository, for the scheduled-workflow dead-man's-switch (#805). Distinct
  // from GITHUB_REPO above, which points at the separate workflow-BACKUP repo.
  // Set in wrangler.toml [vars].
  GITHUB_CODE_REPO?: string

  // Read-only credential for GITHUB_CODE_REPO's Actions history (#842). Separate
  // from GITHUB_TOKEN because that one is the BACKUP repo's push credential and
  // cannot see this repository, which is what left the check reporting "cannot
  // tell" from the day it shipped. GITHUB_TOKEN stays as a fallback so the check
  // does not go dark before this is set.
  // Set via `wrangler secret put GITHUB_ACTIONS_TOKEN --name bidspoke-worker`.
  GITHUB_ACTIONS_TOKEN?: string

  // Anthropic API: used to draft changelog summaries on workflow save
  // Optional: set via `wrangler secret put ANTHROPIC_API_KEY --name bidspoke-worker`
  ANTHROPIC_API_KEY?: string

  // Set to 'true' ONLY in apps/worker/.dev.vars (gitignored, never in production).
  // Local `wrangler dev` shares the real production Supabase project and Slack
  // connection (there is no separate local backend), so this flags "running
  // locally" for guards that would otherwise fire real production alerts from
  // local testing (e.g. the GitHub-backup-failure Slack alert).
  LOCAL_DEV?: string

  // 'on' lets the partner reachability probe (#1274) post to Slack. Anything else
  // is observe mode: the probe runs every five minutes and logs what it would
  // have posted, so its setup is proven on real traffic before a page can be
  // false. Set in wrangler.toml [vars]; #1396 flips it after the observe day.
  PARTNER_PROBE_ALERTS?: string

  // Set to 'true' ONLY in apps/worker/.dev.vars, alongside LOCAL_DEV, to opt a
  // local session into writing to the remote (production) Supabase project.
  // Without it, local dev is read-only against a remote database: the Worker
  // connects as service_role and bypasses RLS, so an unguarded local write can
  // land anywhere in production (#669). See lib/supabase.ts.
  ALLOW_PROD_WRITES?: string

}
