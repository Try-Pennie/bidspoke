/**
 * Custom endpoint routing — handles hook.trypennie.dev partner endpoints.
 *
 * POST https://hook.trypennie.dev/tripoint/bidding
 *   → looks up webhook_endpoints WHERE subdomain='tripoint' AND path='/bidding'
 *   → executes the mapped workflow with source=source_name
 *
 * Endpoint records are cached in WORKFLOW_CACHE KV (prefix 'ep:') with a
 * 60-second TTL to avoid a Supabase lookup on every inbound request.
 *
 * To test locally, pass a spoofed Host header:
 *   curl -X POST http://localhost:8787/tripoint/bidding -H "Host: hook.trypennie.dev" -d '{}'
 */

import type { Context } from 'hono'
import type { Env } from '../index'
import { executeWorkflow } from '../engine/index'
import { createSupabaseClient } from '../lib/supabase'

const HOOK_HOST = 'hook.trypennie.dev'
const CACHE_TTL = 60 // seconds

interface CachedEndpoint {
  id: string
  workflow_id: string
  source_name: string
  is_active: boolean
  auth_method: 'api_key' | 'none'
}

/**
 * Returns true if the request is for the custom endpoint host.
 */
export function isCustomEndpointHost(host: string): boolean {
  return host.split(':')[0].toLowerCase() === HOOK_HOST
}

// Normalize a URL path: lowercase, leading slash, no trailing slash.
// Empty input becomes '/' — matches the single-segment endpoint row
// (subdomain='x', path='/') for URL hook.trypennie.dev/x.
function normalizePath(raw: string): string {
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
  return stripped === '' ? '/' : '/' + stripped
}

export async function handleCustomEndpoint(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.method === 'GET') {
    // Health-check for partners to verify their endpoint is live
    return c.json({ ok: true })
  }

  if (c.req.method !== 'POST') {
    return c.json({ error: 'Method not allowed' }, 405)
  }

  // Parse partner slug and path from URL: /tripoint/bidding → slug='tripoint', path='/bidding'
  const segments = new URL(c.req.url).pathname.split('/').filter(Boolean)
  if (segments.length < 1) {
    return c.json({ error: 'Endpoint not found' }, 404)
  }
  const partner = segments[0]
  const path = normalizePath('/' + segments.slice(1).join('/'))
  const cacheKey = `ep:${partner}:${path}`

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
      .select('id, workflow_id, source_name, is_active, workflows!inner(definition)')
      .eq('subdomain', partner)
      .eq('path', path)
      .single<{
        id: string
        workflow_id: string
        source_name: string
        is_active: boolean
        workflows: { definition: { trigger?: { config?: { auth_method?: string } } } }
      }>()

    if (error || !data) {
      return c.json({ error: 'Endpoint not found' }, 404)
    }

    const triggerAuth = data.workflows?.definition?.trigger?.config?.auth_method
    endpoint = {
      id: data.id,
      workflow_id: data.workflow_id,
      source_name: data.source_name,
      is_active: data.is_active,
      auth_method: triggerAuth === 'none' ? 'none' : 'api_key',
    }
    // Cache even if inactive — inactive endpoints just return 404 quickly
    await c.env.WORKFLOW_CACHE.put(cacheKey, JSON.stringify(endpoint), {
      expirationTtl: CACHE_TTL,
    })
  }

  if (!endpoint.is_active) {
    return c.json({ error: 'Endpoint not active' }, 404)
  }

  // Require a valid API key unless the trigger opts out with auth_method='none'
  if (endpoint.auth_method !== 'none') {
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

    const headers: Record<string, string> = {
      ...(result.responseHeaders ?? {}),
      'X-Trace-Id': result.traceId,
    }
    if (result.idempotentReplay) headers['X-Idempotent-Replay'] = 'true'

    const bodyStr = JSON.stringify(result.response)
    console.log(
      JSON.stringify({
        event: 'response_emit',
        trace_id: result.traceId,
        endpoint: `${partner}${path}`,
        status: result.status,
        body_bytes: bodyStr.length,
        inbound_traceparent: c.req.header('traceparent') ?? null,
        idempotent_replay: result.idempotentReplay ?? false,
      })
    )

    return c.json(result.response, result.status as 200 | 409 | 500, headers)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error'
    if (message.includes('not found') || message.includes('inactive')) {
      return c.json({ error: message }, 404)
    }
    return c.json({ error: message }, 500)
  }
}
