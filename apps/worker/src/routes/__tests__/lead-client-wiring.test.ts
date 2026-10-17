import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../test-setup/wait-until'
import type { Env } from '../../index'

/**
 * Both routes a lead arrives on hand the engine a LEAD client (#1844), so the
 * reads with a last-good copy are bounded and stop asking a database that has
 * failed once. The database module is real here; only the engine is replaced,
 * to capture the client it is given, and the network beneath supabase-js.
 */
vi.mock('../../engine/index', async () => {
  const actual = await vi.importActual<typeof import('../../engine/index')>('../../engine/index')
  return { ...actual, executeWorkflow: vi.fn() }
})

import { executeWorkflow } from '../../engine/index'
import { leadRead, LEAD_DB_DOWN_CODE } from '../../lib/lead-read-budget'
import webhooks from '../webhooks'
import { handleCustomEndpoint } from '../custom-endpoint'
import { Hono } from 'hono'

let requests = 0
beforeEach(() => {
  vi.clearAllMocks()
  requests = 0
  vi.stubGlobal('fetch', vi.fn(async () => { requests++; throw new TypeError('fetch failed') }))
  vi.mocked(executeWorkflow).mockResolvedValue({ executionId: 'e1', response: {}, status: 200, traceId: 't1' } as Awaited<ReturnType<typeof executeWorkflow>>)
})
afterEach(() => vi.unstubAllGlobals())

const ctx = () => recordingContext()

// Each seeded entry is held as a healthy read just left it, confirmed now (#1847).
function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries))
  const meta = new Map<string, unknown>(Object.keys(entries).map((k) => [k, { confirmed_at: new Date().toISOString() }]))
  return {
    get: async (k: string) => store.get(k) ?? null,
    getWithMetadata: async (k: string) => ({ value: store.get(k) ?? null, metadata: meta.get(k) ?? null }),
    put: async (k: string, v: string, opts?: { metadata?: unknown }) => { store.set(k, v); meta.set(k, opts?.metadata ?? null) },
    delete: async (k: string) => { store.delete(k); meta.delete(k) },
  }
}

/** The client the route gave the engine, read through moneyRuntime's config. */
function clientGivenToEngine(): object {
  const runtime = vi.mocked(executeWorkflow).mock.calls[0][2] as { config: object }
  return runtime.config
}

/** A lead client answers a second read at once after the first one failed. */
async function expectLeadClient(client: object) {
  const db = client as { from: (t: string) => { select: (c: string) => Parameters<typeof leadRead>[1] } }
  const first = await leadRead(client, db.from('partner_configs').select('id'), 'probe')
  expect(first.error).not.toBeNull()
  const before = requests
  const second = await leadRead(client, db.from('partner_configs').select('id'), 'probe')
  expect((second.error as { code?: string } | null)?.code).toBe(LEAD_DB_DOWN_CODE)
  expect(requests).toBe(before)
}

describe('lead routes give the engine a lead client (#1844)', () => {
  it('the generic webhook route', async () => {
    const env = { API_KEY_MAP: JSON.stringify({ sk_test_key: 'website_form' }), SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env
    await webhooks.request('/wf-1', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'sk_test_key' }, body: '{}' }, env, ctx())
    expect(executeWorkflow).toHaveBeenCalledTimes(1)
    await expectLeadClient(clientGivenToEngine())
  })

  it('the custom endpoint route, which also reaches its last-good record after one request', async () => {
    const record = { id: 'ep1', workflow_id: 'wf-1', source_name: 'engine', is_active: true }
    const env = {
      API_KEY_MAP: JSON.stringify({ sk_engine: 'engine' }),
      SUPABASE_URL: 'https://db.example.test',
      SUPABASE_SECRET_KEY: 'k',
      WORKFLOW_CACHE: kv({ 'ep-lastgood:tripoint:/bidding': JSON.stringify(record) }),
    } as unknown as Env
    const app = new Hono<{ Bindings: Env }>()
    app.all('*', (c) => handleCustomEndpoint(c))
    const res = await app.request('http://tripoint.trypennie.dev/tripoint/bidding', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'sk_engine' }, body: '{}' }, env, ctx())
    expect(res.status).toBe(200)
    // Once, not four times over seven seconds as the library's retries did.
    expect(requests).toBe(1)
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toMatchObject({ workflowId: 'wf-1' })
    await expectLeadClient(clientGivenToEngine())
  })
})
