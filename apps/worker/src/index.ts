import { Hono } from 'hono'

export { DailyCapObject } from './durable-objects/daily-cap'
export { CircuitBreakerObject } from './durable-objects/circuit-breaker'

export interface Env {
  WORKFLOW_CACHE: KVNamespace
  IDEMPOTENCY: KVNamespace
  DAILY_CAP: DurableObjectNamespace
  CIRCUIT_BREAKER: DurableObjectNamespace
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  SUPABASE_PUBLISHABLE_KEY: string
  SUPABASE_JWKS_URL: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', (c) => c.json({ status: 'ok', service: 'bidspoke-worker' }))

// Webhook execution endpoint — Phase 1.2
app.post('/webhooks/:workflow_id', (c) => {
  return c.json({ error: 'not implemented' }, 501)
})

// REST API — Phase 1.3
app.all('/api/*', (c) => {
  return c.json({ error: 'not implemented' }, 501)
})

export default app
