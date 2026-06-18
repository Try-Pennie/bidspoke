/**
 * Shadow mirror route — Phase 4.3.
 * Verifies: API-key auth, 204 ack, and that it runs the workflow as a dry-run
 * shadow test (isTest + shadowMode + __shadow source, no source enforcement).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

vi.mock('../../engine/index', async () => {
  const actual = await vi.importActual<typeof import('../../engine/index')>('../../engine/index')
  return { ...actual, executeWorkflow: vi.fn() }
})
vi.mock('../../lib/supabase')

import { executeWorkflow } from '../../engine/index'
import { createSupabaseClient } from '../../lib/supabase'
import shadow from '../shadow'

const KEY_MAP = JSON.stringify({ sk_test_key: 'website_form' })
const testEnv = {
  API_KEY_MAP: KEY_MAP,
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_ANON_KEY: 'fake-anon-key',
} as unknown as Env

function request(workflowId: string, apiKey: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey !== undefined) headers['X-API-Key'] = apiKey
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
  return shadow.request(`/${workflowId}`, { method: 'POST', headers, body: JSON.stringify(body) }, testEnv, mockCtx)
}

describe('POST /shadow/:workflow_id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createSupabaseClient).mockReturnValue({} as ReturnType<typeof createSupabaseClient>)
    vi.mocked(executeWorkflow).mockResolvedValue({ executionId: 'e1', response: {}, status: 200, traceId: 't1' })
  })

  it('rejects a missing API key with 401 and does not run the engine', async () => {
    const res = await request('wf-1', undefined, { lead: 1 })
    expect(res.status).toBe(401)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('returns 204 and runs the workflow as a dry-run shadow test', async () => {
    const res = await request('wf-1', 'sk_test_key', { lead: 1 })
    expect(res.status).toBe(204)
    expect(executeWorkflow).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(executeWorkflow).mock.calls[0][0]
    expect(opts).toMatchObject({
      workflowId: 'wf-1',
      payload: { lead: 1 },
      source: 'website_form__shadow',
      isTest: true,
      shadowMode: 'dry_run',
      enforceSourceAssignment: false,
    })
  })
})
