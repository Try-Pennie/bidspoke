import { Hono } from 'hono'
import { cors } from 'hono/cors'
import webhooks from './routes/webhooks'
import api from './routes/api/index'
import { createSupabaseClient } from './lib/supabase'
import { runVolumeAnomalyCheck } from './lib/volume-anomaly'

export { DailyCapObject } from './durable-objects/daily-cap'
export { CircuitBreakerObject } from './durable-objects/circuit-breaker'

export interface Env {
  // KV namespaces
  WORKFLOW_CACHE: KVNamespace
  IDEMPOTENCY: KVNamespace

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

  // Cloudflare API — for syncing secrets (PRD 12.3)
  CLOUDFLARE_API_TOKEN: string
  CLOUDFLARE_ACCOUNT_ID: string

  // Env var secret encryption — AES-GCM key, base64-encoded 32 bytes
  // Generate: openssl rand -base64 32 | wrangler secret put SECRET_ENCRYPTION_KEY
  SECRET_ENCRYPTION_KEY: string

  // Dynamic Worker dispatch — code node sandboxing (PRD Section 5.4)
  DYNAMIC_WORKER_LOADER: DispatchNamespace

  // GitHub backup — push workflow definitions on save (PRD Section 3.2)
  // Optional: set via `wrangler secret put GITHUB_TOKEN` and wrangler.toml [vars] GITHUB_REPO
  GITHUB_TOKEN?: string
  GITHUB_REPO?: string
}

const app = new Hono<{ Bindings: Env }>()

app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = ['http://localhost:3000', 'https://bidspoke.pages.dev', 'https://bidspoke.trypennie.dev']
      return allowed.includes(origin) ? origin : null
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: true,
  })
)

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message ?? 'Internal server error' }, 500)
})

app.get('/', (c) => c.json({ status: 'ok', service: 'bidspoke-worker' }))

// Webhook execution endpoint — authenticated via X-API-Key (PRD 12.2)
app.route('/webhooks', webhooks)

// REST API — JWT authenticated
app.route('/api', api)

// Scheduled handler — runs daily at 09:00 UTC (see wrangler.toml [triggers])
export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const supabase = createSupabaseClient(env)
    ctx.waitUntil(
      runVolumeAnomalyCheck(supabase, env.APP_URL)
        .catch((e) => console.error('[volume-anomaly] check failed:', e))
    )
  },
}
