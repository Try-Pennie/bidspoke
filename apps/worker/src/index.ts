import { Hono } from 'hono'
import webhooks from './routes/webhooks'
import api from './routes/api/index'

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

  // Cloudflare API — for syncing secrets (PRD 12.3)
  CLOUDFLARE_API_TOKEN: string
  CLOUDFLARE_ACCOUNT_ID: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', (c) => c.json({ status: 'ok', service: 'bidspoke-worker' }))

// Webhook execution endpoint — authenticated via X-API-Key (PRD 12.2)
app.route('/webhooks', webhooks)

// REST API — JWT authenticated
app.route('/api', api)

export default app
