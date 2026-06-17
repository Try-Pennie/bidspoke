import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import webhooks from './routes/webhooks'
import api from './routes/api/index'
import { createSupabaseClient } from './lib/supabase'
import { runVolumeAnomalyCheck } from './lib/volume-anomaly'
import { runVolumeCliffCheck } from './lib/volume-cliff'
import { runTimeoutAuditCheck } from './lib/timeout-audit'
import { runSlowExecutionCheck } from './lib/slow-execution-rate'
import { runSightingsExport } from './lib/sightings-export'
import { runAchieveExport } from './lib/achieve-export'
import { prewarmKvCaches } from './lib/cache-prewarm'
import { syncAllSalesforceConfigs } from './lib/bid-matrix-sync'
import { runMatrixAudit } from './lib/sf-matrix-audit'
import { isCustomEndpointHost, handleCustomEndpoint } from './routes/custom-endpoint'

export { DailyCapObject } from './durable-objects/daily-cap'
export { CircuitBreakerObject } from './durable-objects/circuit-breaker'

export interface Env {
  // KV namespaces
  WORKFLOW_CACHE: KVNamespace
  IDEMPOTENCY: KVNamespace
  SUBMISSIONS: KVNamespace

  // Durable Objects
  DAILY_CAP: DurableObjectNamespace
  CIRCUIT_BREAKER: DurableObjectNamespace

  // Supabase (secrets)
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_JWKS_URL: string  // public var in wrangler.toml

  // Webhook auth — JSON string: { [apiKey: string]: sourceName }
  API_KEY_MAP: string

  // PII redaction — comma-separated field patterns, empty = disabled (PRD 12.4)
  PII_REDACTION_FIELDS: string

  // Frontend URL — used for deep links in Slack alerts
  APP_URL: string

  // External hostname the volume-cliff monitor hits to confirm the worker is
  // reachable from outside Cloudflare. Must be a stable bidspoke-owned URL that
  // routes to this worker. Optional — falls back to a built-in default.
  SELF_CHECK_URL?: string

  // Cloudflare API — for syncing secrets (PRD 12.3)
  CLOUDFLARE_API_TOKEN: string
  CLOUDFLARE_ACCOUNT_ID: string

  // Env var secret encryption — AES-GCM key, base64-encoded 32 bytes
  // Generate: openssl rand -base64 32 | wrangler secret put SECRET_ENCRYPTION_KEY
  SECRET_ENCRYPTION_KEY: string

  // SSN hash pepper — used for indexed dedup lookups on persons.ssn_hash
  // Generate: openssl rand -base64 32 | wrangler secret put SSN_HASH_PEPPER
  // CRITICAL: rotating this secret breaks all dedup lookups (old hashes become unmatchable)
  SSN_HASH_PEPPER: string

  // Snowflake REST API — nightly export of lead_sightings + lead_sighting_bids.
  // Auth: key-pair JWT. Service user `bidspoke_service` with role `bidspoke_role`.
  SNOWFLAKE_ACCOUNT: string         // URL prefix, e.g. 'jyc55588.us-east-1'
  SNOWFLAKE_USER: string
  SNOWFLAKE_PRIVATE_KEY: string     // RSA PEM (PKCS#1 or PKCS#8)
  SNOWFLAKE_DATABASE: string
  SNOWFLAKE_SCHEMA: string
  SNOWFLAKE_WAREHOUSE: string
  SNOWFLAKE_ROLE: string

  // Dynamic Worker dispatch — code node sandboxing (PRD Section 5.4)
  DYNAMIC_WORKER_LOADER: DispatchNamespace

  // GitHub backup — push workflow definitions on save (PRD Section 3.2)
  // Optional: set via `wrangler secret put GITHUB_TOKEN` and wrangler.toml [vars] GITHUB_REPO
  GITHUB_TOKEN?: string
  GITHUB_REPO?: string

  // Anthropic API — used to draft changelog summaries on workflow save
  // Optional: set via `wrangler secret put ANTHROPIC_API_KEY --name bidspoke-worker`
  ANTHROPIC_API_KEY?: string

  // Hyperdrive — direct Postgres connection for the execution-log hot path
  // (workflow_executions + execution_steps inserts/updates), bypassing
  // PostgREST so a schema-cache reload (triggered by the nightly partition
  // purge DDL) can't 503 the audit-trail writes. Optional: when the binding is
  // absent the engine stays on PostgREST. See wrangler.toml for the provisioning
  // runbook and lib/pg-writer.ts for the writer.
  HYPERDRIVE?: Hyperdrive
}

const app = new Hono<{ Bindings: Env }>()

app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = ['https://bidspoke.pages.dev', 'https://bidspoke.trypennie.dev']
      if (allowed.includes(origin)) return origin
      // Accept any localhost port in dev — Next.js bumps to 3001+ when 3000 is busy
      if (/^http:\/\/localhost:\d+$/.test(origin)) return origin
      return null
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: true,
    // Cache preflight for 24h so repeat requests from the app skip the OPTIONS round-trip
    maxAge: 86400,
  })
)

// Log the real error server-side, but return a generic message — never echo raw
// err.message to callers, which can leak internal/DB details (#107). Exported
// for unit testing.
export function genericOnError(err: Error, c: Context) {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
}
app.onError(genericOnError)

app.get('/', (c) => c.json({ status: 'ok', service: 'bidspoke-worker' }))

// Custom endpoint routing — handles *.trypennie.dev partner subdomains
// Must be registered before /webhooks and /api so it intercepts early
app.use('*', async (c, next) => {
  if (isCustomEndpointHost(c.req.header('host') ?? '')) {
    return handleCustomEndpoint(c)
  }
  return next()
})

// Webhook execution endpoint — authenticated via X-API-Key (PRD 12.2)
app.route('/webhooks', webhooks)

// REST API — JWT authenticated
app.route('/api', api)

// Scheduled handler — dispatches on cron string (see wrangler.toml [triggers])
export default {
  fetch: app.fetch.bind(app),
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const supabase = createSupabaseClient(env)
    if (event.cron === '0 9 * * *') {
      ctx.waitUntil(
        runSightingsExport(supabase, env)
          .then((s) => console.log('[sightings-export]', JSON.stringify(s)))
          .catch((e) => console.error('[sightings-export] failed:', e))
      )
      ctx.waitUntil(
        runAchieveExport(supabase, env)
          .then((s) => console.log('[achieve-export]', JSON.stringify(s)))
          .catch((e) => console.error('[achieve-export] failed:', e))
      )
    } else if (event.cron === '0 13 * * *') {
      ctx.waitUntil(
        runVolumeAnomalyCheck(supabase)
          .catch((e) => console.error('[volume-anomaly] check failed:', e))
      )
      ctx.waitUntil(
        runTimeoutAuditCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[timeout-audit] check failed:', e))
      )
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        syncAllSalesforceConfigs(env, supabase)
          .then((r) => console.log(`[bid-matrix-sync] ${r.successes.length} succeeded, ${r.failures.length} failed`))
          .catch((e) => console.error('[bid-matrix-sync] failed:', e))
      )
      ctx.waitUntil(
        runMatrixAudit(env, supabase)
          .then((r) => console.log(`[sf-matrix-audit] fetched=${r.rows_fetched} added=${r.rows_added} edited=${r.rows_edited} removed=${r.rows_removed} alerted=${r.alerted}`))
          .catch((e) => console.error('[sf-matrix-audit] failed:', e))
      )
    } else if (event.cron === '* * * * *') {
      ctx.waitUntil(
        prewarmKvCaches(supabase, env)
          .catch((e) => console.error('[prewarm] failed:', e))
      )
      ctx.waitUntil(
        runVolumeCliffCheck(supabase, env.IDEMPOTENCY, env.APP_URL, env.SELF_CHECK_URL)
          .catch((e) => console.error('[volume-cliff] check failed:', e))
      )
      ctx.waitUntil(
        runSlowExecutionCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[slow-spike] check failed:', e))
      )
    }
  },
}
