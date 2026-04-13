/**
 * Custom endpoint routing — handles *.trypennie.dev partner subdomains.
 *
 * POST https://tripoint.trypennie.dev/bidding
 *   → looks up webhook_endpoints WHERE subdomain='tripoint' AND path='/bidding'
 *   → executes the mapped workflow with source=source_name
 *
 * Endpoint records are cached in WORKFLOW_CACHE KV (prefix 'ep:') with a
 * 60-second TTL to avoid a Supabase lookup on every inbound request.
 *
 * To test locally, pass a spoofed Host header:
 *   curl -X POST http://localhost:8787/bidding -H "Host: tripoint.trypennie.dev" -d '{}'
 */

import type { Context } from 'hono'
import type { Env } from '../index'
import { executeWorkflow } from '../engine/index'
import { createSupabaseClient } from '../lib/supabase'

const BASE_DOMAIN = 'trypennie.dev'
// Subdomains reserved for internal use — never treated as custom endpoints
const RESERVED = new Set(['bidspoke', 'worker', 'api', 'app', 'www', 'mail', 'admin', 'staging', 'dev', 'go'])
const CACHE_TTL = 60 // seconds

interface CachedEndpoint {
  id: string
  workflow_id: string
  source_name: string
  is_active: boolean
}

/**
 * Returns true if the given host header belongs to a partner custom endpoint
 * rather than a reserved internal domain.
 */
export function isCustomEndpointHost(host: string): boolean {
  const hostname = host.split(':')[0].toLowerCase()
  if (!hostname.endsWith(`.${BASE_DOMAIN}`)) return false
  const sub = hostname.slice(0, hostname.length - BASE_DOMAIN.length - 1)
  // Reject if multi-level (e.g. foo.bar.trypennie.dev) or reserved
  if (!sub || sub.includes('.')) return false
  return !RESERVED.has(sub)
}

/** Normalize a URL path: lowercase, leading slash, no trailing slash. */
function normalizePath(raw: string): string {
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
  return '/' + stripped
}

export async function handleCustomEndpoint(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.method === 'GET') {
    // Health-check for partners to verify their endpoint is live
    return c.json({ ok: true })
  }

  if (c.req.method !== 'POST') {
    return c.json({ error: 'Method not allowed' }, 405)
  }

  const host = (c.req.header('host') ?? '').split(':')[0].toLowerCase()
  const subdomain = host.slice(0, host.length - BASE_DOMAIN.length - 1)
  const path = normalizePath(new URL(c.req.url).pathname)
  const cacheKey = `ep:${subdomain}:${path}`

  // --- KV cache lookup ---
  let endpoint: CachedEndpoint | null = null
  const cached = await c.env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) {
    try {
      endpoint = JSON.parse(cached) as CachedEndpoint
    } catch {
      // stale/corrupt cache entry — fall through to DB
    }
  }

  // --- DB lookup on cache miss ---
  if (!endpoint) {
    const supabase = createSupabaseClient(c.env)
    const { data, error } = await supabase
      .from('webhook_endpoints')
      .select('id, workflow_id, source_name, is_active')
      .eq('subdomain', subdomain)
      .eq('path', path)
      .single()

    if (error || !data) {
      return c.json({ error: 'Endpoint not found' }, 404)
    }

    endpoint = data as CachedEndpoint
    // Cache even if inactive — inactive endpoints just return 404 quickly
    await c.env.WORKFLOW_CACHE.put(cacheKey, JSON.stringify(endpoint), {
      expirationTtl: CACHE_TTL,
    })
  }

  if (!endpoint.is_active) {
    return c.json({ error: 'Endpoint not active' }, 404)
  }

  // Require a valid API key — same auth contract as generic webhooks
  const apiKey = c.req.header('X-API-Key')
  if (!apiKey) {
    return c.json({ error: 'Missing X-API-Key header' }, 401)
  }
  let keyMap: Record<string, string>
  try {
    keyMap = JSON.parse(c.env.API_KEY_MAP) as Record<string, string>
  } catch {
    return c.json({ error: 'Internal configuration error' }, 500)
  }
  if (!keyMap[apiKey]) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const idempotencyKey = c.req.header('X-Idempotency-Key') ?? undefined
  const supabase = createSupabaseClient(c.env)

  try {
    const result = await executeWorkflow(
      {
        workflowId: endpoint.workflow_id,
        payload,
        source: endpoint.source_name,
        idempotencyKeyHeader: idempotencyKey,
        isTest: false,
      },
      c.env,
      supabase,
      c.executionCtx
    )

    const headers: Record<string, string> = { 'X-Trace-Id': result.traceId }
    if (result.idempotentReplay) headers['X-Idempotent-Replay'] = 'true'

    return c.json(result.response, result.status as 200 | 409 | 500, headers)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message.includes('not found') || message.includes('inactive')) {
      return c.json({ error: message }, 404)
    }
    return c.json({ error: message }, 500)
  }
}
