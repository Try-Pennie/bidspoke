/**
 * Custom endpoint route error handling (#107): map known errors by type, and
 * return generic messages to external callers instead of echoing raw err.message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { Env } from '../../index'

// custom-endpoint only uses executeWorkflow from engine/index, so a full mock
// is enough (WorkflowNotFoundError is imported from definition-loader, unmocked).
vi.mock('../../engine/index', () => ({ executeWorkflow: vi.fn() }))
vi.mock('../../lib/supabase')

import { executeWorkflow } from '../../engine/index'
import { createSupabaseClient } from '../../lib/supabase'
import { WorkflowNotFoundError } from '../../engine/definition-loader'
import { handleCustomEndpoint } from '../custom-endpoint'

// Empty KV so the handler falls through to the DB lookup.
function makeUncachedEnv(): Env {
  return {
    WORKFLOW_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
    API_KEY_MAP: '{}',
  } as unknown as Env
}

// A Supabase client whose endpoint `.single()` resolves to the given result.
function makeSupabaseReturning(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve(result),
  }
  return { from: () => chain } as unknown as ReturnType<typeof createSupabaseClient>
}

function postUncached() {
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }
  return makeApp().request(
    'http://hook.trypennie.dev/tripoint/bidding',
    { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
    makeUncachedEnv(),
    executionCtx as unknown as ExecutionContext
  )
}

// Endpoint seeded into KV so the handler skips the DB lookup; auth_method 'none'
// skips the API-key check.
function makeEnv(): Env {
  const ep = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true, auth_method: 'none' })
  const store = new Map<string, string>([['ep:tripoint:/bidding', ep]])
  return {
    WORKFLOW_CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as Env
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>()
  app.all('*', (c) => handleCustomEndpoint(c))
  return app
}

function post() {
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }
  return makeApp().request(
    'http://hook.trypennie.dev/tripoint/bidding',
    { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
    makeEnv(),
    executionCtx as unknown as ExecutionContext
  )
}

beforeEach(() => vi.clearAllMocks())

describe('custom endpoint error mapping (#107)', () => {
  it('returns 404 with a generic message for WorkflowNotFoundError', async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new WorkflowNotFoundError('wf-1', true))
    const res = await post()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
  })

  it('returns 500 (not 404) for an internal error whose message contains "not found"', async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new Error('partner_bid_config not found: abc'))
    const res = await post()
    expect(res.status).toBe(500)
  })

  it('returns a generic 500 body, never echoing the raw error message', async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new Error('Database error at 10.0.0.5:5432'))
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Internal error')
    expect(body.error).not.toContain('10.0.0.5')
  })
})

describe('custom endpoint lookup failure handling (#303)', () => {
  it('returns 503 (retryable), not 404, on a real DB error during endpoint lookup', async () => {
    // A 404 tells the lead source the endpoint is gone, so it stops retrying and
    // the lead is dropped. A transient DB error must be retryable.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: '57P01', message: 'db connection lost' } })
    )
    const res = await postUncached()
    expect(res.status).toBe(503)
  })

  it('returns 404 when the endpoint genuinely does not exist (PGRST116 no-rows)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )
    const res = await postUncached()
    expect(res.status).toBe(404)
  })
})

// Lock the remaining lead-facing gates on this custom-endpoint door (#316). A
// corrupt cache or a disabled/unauthorized endpoint must resolve to the right
// status — never silently drop or misroute a live lead.
describe('custom endpoint cache + gate handling (#316)', () => {
  // KV returns the given value for the endpoint cache key; DB lookup is mocked.
  function envWithCache(cachedValue: string | null): Env {
    return {
      WORKFLOW_CACHE: { get: async () => cachedValue, put: async () => {}, delete: async () => {} },
      API_KEY_MAP: '{}',
    } as unknown as Env
  }
  function postTo(env: Env, headers: Record<string, string> = {}) {
    const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }
    return makeApp().request(
      'http://hook.trypennie.dev/tripoint/bidding',
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', ...headers } },
      env,
      executionCtx as unknown as ExecutionContext
    )
  }
  const activeEndpoint = {
    data: {
      id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true,
      workflows: { definition: { trigger: { config: { auth_method: 'none' } } } },
    },
    error: null,
  }

  it('falls through to the DB when the cache entry is corrupt — never fails the lead', async () => {
    // A stale/corrupt KV entry must not error the request; it falls through to
    // the DB and executes normally. Otherwise a bad cache write drops live leads.
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning(activeEndpoint))
    vi.mocked(executeWorkflow).mockResolvedValue({
      executionId: 'x', response: { ok: true }, status: 200, traceId: 't', idempotentReplay: false,
    } as Awaited<ReturnType<typeof executeWorkflow>>)
    const res = await postTo(envWithCache('{corrupt-not-json'))
    expect(res.status).toBe(200)
    expect(executeWorkflow).toHaveBeenCalledTimes(1)
  })

  it('returns 404 for a disabled endpoint (permanent — intentionally off)', async () => {
    const ep = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: false, auth_method: 'none' })
    const res = await postTo(envWithCache(ep))
    expect(res.status).toBe(404)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('returns 401 when an api_key endpoint is hit without an X-API-Key header', async () => {
    const ep = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true, auth_method: 'api_key' })
    const res = await postTo(envWithCache(ep))
    expect(res.status).toBe(401)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })
})
