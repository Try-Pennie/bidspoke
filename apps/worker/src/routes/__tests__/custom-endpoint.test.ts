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
import { WorkflowNotFoundError } from '../../engine/definition-loader'
import { handleCustomEndpoint } from '../custom-endpoint'

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
