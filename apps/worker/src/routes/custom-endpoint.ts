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
 * A second, durable copy (prefix 'ep-lastgood:', no TTL) is written on every
 * successful lookup and served when the lookup itself fails (#1296). On
 * 2026-09-10 Supabase was unresponsive for ten minutes: the 60 second copy
 * expired within a minute and every Engine lead was answered 503 while the
 * workflow definition and env vars sat in KV the whole time. The endpoint
 * record changes rarely, so a stale copy is the right answer to a lead that
 * would otherwise be refused. A genuinely missing endpoint (no rows) still
 * answers 404 and never consults the durable copy.
 *
 * To test locally, pass a spoofed Host header:
 *   curl -X POST http://localhost:8787/tripoint/bidding -H "Host: hook.trypennie.dev" -d '{}'
 */

import type { Context } from 'hono'
import type { Env } from '../index'
import { executeWorkflow, moneyRuntime, WorkflowLaneError } from '../engine/index'
import { PUBLIC_WRONG_LANE_ERROR, WRONG_LANE_STATUS } from './lane-refusal'
import { WorkflowNotFoundError } from '../engine/definition-loader'
import { createLeadSupabaseClient, leadRead } from '../lib/lead-read-budget'
import { isNotFoundError } from '../lib/api-error'
import { sourceForApiKey } from '../lib/api-key-map'

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

// The durable copy is read only on a failed lookup. A corrupt entry is a miss.
async function readLastGood(kv: KVNamespace, key: string): Promise<CachedEndpoint | null> {
  const raw = await kv.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CachedEndpoint
  } catch {
    return null
  }
}

export async function handleCustomEndpoint(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.method === 'GET') {
    // Health-check for partners to verify their endpoint is live
    return c.json({ ok: true })
  }

  if (c.req.method !== 'POST') {
    return c.json({ error: 'Method not allowed' }, 405)
  }

  // One client for this lead: its reads that have a last-good copy are bounded
  // and never retried, and once one fails the rest go straight to their copies
  // (#1844).
  const supabase = createLeadSupabaseClient(c.env)

  // Parse partner slug and path from URL: /tripoint/bidding → slug='tripoint', path='/bidding'
  const segments = new URL(c.req.url).pathname.split('/').filter(Boolean)
  if (segments.length < 1) {
    return c.json({ error: 'Endpoint not found' }, 404)
  }
  const partner = segments[0]
  const path = normalizePath('/' + segments.slice(1).join('/'))
  const cacheKey = `ep:${partner}:${path}`
  const lastGoodKey = `ep-lastgood:${partner}:${path}`

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
    const { data, error } = await leadRead(
      supabase,
      supabase
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
        }>(),
      'custom endpoint'
    )

    // `.single()` returns PGRST116 when zero rows match — a genuine "not found".
    // Any OTHER error is a real DB failure: returning 404 here tells the lead
    // source the endpoint is gone, so it stops retrying and the lead is dropped.
    // Return 503 (retryable) instead. Real error logged, not leaked (#107, #303).
    if (error && !isNotFoundError(error)) {
      // Serve the durable copy from the last successful lookup (#1296). Only when
      // there has never been one is the lead refused.
      const stale = await readLastGood(c.env.WORKFLOW_CACHE, lastGoodKey)
      if (stale) {
        console.error(`[custom-endpoint] endpoint lookup failed; serving last-good record for ${partner}${path}:`, error)
        endpoint = stale
      } else {
        console.error('[custom-endpoint] endpoint lookup failed and no last-good record exists:', error)
        return c.json({ error: 'Temporarily unavailable' }, 503)
      }
    } else if (!data) {
      return c.json({ error: 'Endpoint not found' }, 404)
    } else {
      const triggerAuth = data.workflows?.definition?.trigger?.config?.auth_method
      endpoint = {
        id: data.id,
        workflow_id: data.workflow_id,
        source_name: data.source_name,
        is_active: data.is_active,
        auth_method: triggerAuth === 'none' ? 'none' : 'api_key',
      }
      const serialized = JSON.stringify(endpoint)
      // Cache even if inactive: inactive endpoints just return 404 quickly.
      // The hot copy expires; the last-good copy does not (#1296).
      await c.env.WORKFLOW_CACHE.put(cacheKey, serialized, { expirationTtl: CACHE_TTL })
      await c.env.WORKFLOW_CACHE.put(lastGoodKey, serialized)
    }
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
    if (!sourceForApiKey(keyMap, apiKey)) {
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
      moneyRuntime(supabase),
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
    // Map by error type, not message substring, and keep the external message
    // generic so internal/DB details don't leak (#107). Real error is logged.
    if (err instanceof WorkflowNotFoundError) {
      return c.json({ error: 'Workflow not found' }, 404)
    }
    // An ops workflow on the money host (#1707): not this Worker's to run, and
    // not missing either, so a sender is told it reached the wrong place
    // rather than that the endpoint is gone. Forwarding to the ops Worker comes
    // with the ops lane (plan R5).
    if (err instanceof WorkflowLaneError) {
      return c.json({ error: PUBLIC_WRONG_LANE_ERROR }, WRONG_LANE_STATUS)
    }
    console.error('[custom-endpoint] execution error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
}
