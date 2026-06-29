import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import webhooks from './routes/webhooks'
import shadow from './routes/shadow'
import api from './routes/api/index'
import { createSupabaseClient } from './lib/supabase'
import { runVolumeAnomalyCheck } from './lib/volume-anomaly'
import { runVolumeCliffCheck } from './lib/volume-cliff'
import { runBigTableGuard } from './lib/big-table-guard'
import { runDrainStallCheck } from './lib/drain-stall'
import { runSecretDriftCheck } from './lib/secret-drift'
import { runRequiredSecretsCheck } from './lib/required-secrets'
import { runRequiredEnvVarsCheck } from './lib/required-env-vars'
import { runSecretDecryptHealthCheck } from './lib/secret-decrypt-health'
import { notifyExportFailure } from './lib/export-alerts'
import { writeDailyHeartbeat, runDailyHeartbeatCheck } from './lib/cron-heartbeat'
import { runTimeoutAuditCheck } from './lib/timeout-audit'
import { runSlowExecutionCheck } from './lib/slow-execution-rate'
import { runFailureRateCheck } from './lib/failure-rate'
import { runUpstreamOutageCheck } from './lib/upstream-outage'
import { runSightingsExport } from './lib/sightings-export'
import { runAchieveExport } from './lib/achieve-export'
import { prewarmKvCaches } from './lib/cache-prewarm'
import { syncAllSalesforceConfigs } from './lib/bid-matrix-sync'
import { runMatrixAudit } from './lib/sf-matrix-audit'
import { isCustomEndpointHost, handleCustomEndpoint } from './routes/custom-endpoint'

export { DailyCapObject } from './durable-objects/daily-cap'
export { CircuitBreakerObject } from './durable-objects/circuit-breaker'
export { BulkheadObject } from './durable-objects/bulkhead'

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

  // Max simultaneous in-flight Salesforce calls (string env var; default 20,
  // kept below SF's ~25-slot concurrency governor). Optional.
  SALESFORCE_BULKHEAD_LIMIT?: string

  // Supabase (secrets)
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_JWKS_URL: string  // public var in wrangler.toml

  // Webhook auth — JSON string: { [apiKey: string]: sourceName }
  API_KEY_MAP: string

  // PII redaction — comma-separated field patterns, empty = disabled (PRD 12.4)
  PII_REDACTION_FIELDS: string

  // Field-presence capture (#419/#410). 'true' enables the dark write of the
  // per-execution watched-field presence map; off or unset disables it.
  // Default off so deploying before the migration is applied is safe.
  FIELD_PRESENCE_CAPTURE?: string

  // Frontend URL — used for deep links in Slack alerts
  APP_URL: string

  // Git commit the live worker was deployed from — stamped via `wrangler deploy
  // --var DEPLOYED_SHA:<sha>` in the deploy workflow, surfaced at GET / so a
  // scheduled check can detect a "committed but never deployed" worker (#327).
  DEPLOYED_SHA?: string

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

app.get('/', (c) => c.json({ status: 'ok', service: 'bidspoke-worker', version: c.env.DEPLOYED_SHA ?? 'unknown' }))

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

// Shadow mirror endpoint — dry-run shadow of engine traffic (Phase 4.3)
app.route('/shadow', shadow)

// REST API — JWT authenticated
app.route('/api', api)

// Scheduled handler — dispatches on cron string (see wrangler.toml [triggers])
export default {
  fetch: app.fetch.bind(app),
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    const supabase = createSupabaseClient(env)
    if (event.cron === '0 9 * * *') {
      ctx.waitUntil(
        runAchieveExport(supabase, env)
          .then((s) => {
            console.log('[achieve-export]', JSON.stringify(s))
            return notifyExportFailure(supabase, 'Achieve export', s.errors)
          })
          .catch((e) => {
            console.error('[achieve-export] failed:', e)
            return notifyExportFailure(supabase, 'Achieve export', [e instanceof Error ? e.message : String(e)])
          })
      )
    } else if (event.cron === '0 13 * * *') {
      // Dead-man's-switch heartbeat: stamp that this batch dispatched (#358).
      ctx.waitUntil(
        writeDailyHeartbeat(env.IDEMPOTENCY)
          .catch((e) => console.error('[cron-heartbeat] write failed:', e))
      )
      ctx.waitUntil(
        runVolumeAnomalyCheck(supabase)
          .catch((e) => console.error('[volume-anomaly] check failed:', e))
      )
      ctx.waitUntil(
        runTimeoutAuditCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[timeout-audit] check failed:', e))
      )
      ctx.waitUntil(
        runSecretDriftCheck(supabase, env)
          .then((r) => console.log(`[secret-drift] checked=${r.checked} missing=${r.missing} alerted=${r.alerted}`))
          .catch((e) => console.error('[secret-drift] check failed:', e))
      )
      ctx.waitUntil(
        runRequiredSecretsCheck(supabase, env)
          .then((r) => { if (r.missing.length) console.error(`[required-secrets] MISSING=${r.missing.join(',')} alerted=${r.alerted}`) })
          .catch((e) => console.error('[required-secrets] check failed:', e))
      )
      ctx.waitUntil(
        runRequiredEnvVarsCheck(supabase, env)
          .then((r) => { if (r.missing.length) console.error(`[required-env-vars] MISSING=${r.missing.join(',')} alerted=${r.alerted}`) })
          .catch((e) => console.error('[required-env-vars] check failed:', e))
      )
      ctx.waitUntil(
        runSecretDecryptHealthCheck(supabase, env)
          .then((r) => { if (r.undecryptable) console.error(`[secret-decrypt-health] undecryptable=${r.undecryptable} alerted=${r.alerted}`) })
          .catch((e) => console.error('[secret-decrypt-health] check failed:', e))
      )
      ctx.waitUntil(
        runBigTableGuard(supabase, env.IDEMPOTENCY)
          .then((r) => { if (r.offenders.length) console.log(`[big-table-guard] offenders=${r.offenders.join(',')} alerted=${r.alerted}`) })
          .catch((e) => console.error('[big-table-guard] check failed:', e))
      )
      ctx.waitUntil(
        runDrainStallCheck(supabase, env.IDEMPOTENCY)
          .then((r) => { if (r.stranded > 0) console.log(`[drain-stall] stranded=${r.stranded} alerted=${r.alerted}`) })
          .catch((e) => console.error('[drain-stall] check failed:', e))
      )
    } else if (event.cron === '0 */2 * * *') {
      // Lead sightings export runs every 2 hours in its own invocation so it gets a
      // full per-run subrequest budget. One run drains ~50K rows (the platform
      // ceiling, handled by exportTable's clean-stop) and inflow is ~83K/day, so a
      // once-daily run fell permanently behind; 12 runs/day stays well ahead.
      ctx.waitUntil(
        runSightingsExport(supabase, env)
          .then((s) => {
            console.log('[sightings-export]', JSON.stringify(s))
            return notifyExportFailure(supabase, 'Lead sightings export', s.errors)
          })
          .catch((e) => {
            console.error('[sightings-export] failed:', e)
            return notifyExportFailure(supabase, 'Lead sightings export', [e instanceof Error ? e.message : String(e)])
          })
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
      ctx.waitUntil(
        runFailureRateCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[failure-spike] check failed:', e))
      )
      ctx.waitUntil(
        runUpstreamOutageCheck(supabase, env.IDEMPOTENCY, env.APP_URL)
          .catch((e) => console.error('[upstream-outage] check failed:', e))
      )
      ctx.waitUntil(
        runDailyHeartbeatCheck(supabase, env.IDEMPOTENCY)
          .then((r) => { if (r.status === 'stale' || r.status === 'never_ran') console.error(`[cron-heartbeat] daily batch ${r.status} ageMs=${r.ageMs} alerted=${r.alerted}`) })
          .catch((e) => console.error('[cron-heartbeat] check failed:', e))
      )
    }
  },
}
