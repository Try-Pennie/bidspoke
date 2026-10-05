/**
 * The money gate replays a lead as each kind of run the bidding Worker starts
 * (#1730), and builds each kind's options the way its route does. These tests
 * drive the real shadow route and the real canvas Test Runner route with the
 * engine replaced, and hold the gate's options to exactly what each passed, so
 * a route that changes what it hands the engine fails here, by name, rather than
 * leaving the gate replaying a run the product no longer makes (L41).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uuidv7 } from '@bidspoke/uuidv7'
import type { Env } from '../../../src/index'
import { makeSupabase } from '../../../src/routes/api/__tests__/_supabase-mock'

vi.mock('../../../src/engine/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/engine/index')>()),
  executeWorkflow: vi.fn(),
}))
vi.mock('../../../src/lib/supabase')
vi.mock('../../../src/lib/jwt')
vi.mock('../../../src/lib/code-node-deployer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/code-node-deployer')>()),
  deployTestCodeBundle: vi.fn(),
}))

import { executeWorkflow } from '../../../src/engine/index'
import { createSupabaseClient } from '../../../src/lib/supabase'
import { verifyJwt } from '../../../src/lib/jwt'
import { deployTestCodeBundle } from '../../../src/lib/code-node-deployer'
import shadow from '../../../src/routes/shadow'
import { RUN_KINDS, fixtureId, runOptions } from '../run-kinds'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
const ORG = 'org-abc'
const payload = { lead: 1, state: 'TX' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(executeWorkflow).mockResolvedValue({ executionId: 'e1', response: {}, status: 200, traceId: 't1' })
})

describe('runOptions', () => {
  it('replays a live lead with the trigger alone, as it always has', () => {
    expect(runOptions('live', { workflowId: 'wf-1', payload, source: 'engine' })).toEqual({ workflowId: 'wf-1', payload, source: 'engine' })
  })

  it('names every kind it can build, live first', () => {
    expect(RUN_KINDS).toEqual(['live', 'test', 'shadow_dry_run'])
  })
})

describe('fixtureId', () => {
  it('keeps the live id as it was, and names the kind on every other', () => {
    expect(fixtureId('Main Flow', 'bid_race_tripoint_wins', 'live')).toBe('Main Flow/bid_race_tripoint_wins')
    expect(fixtureId('Main Flow', 'bid_race_tripoint_wins', 'test')).toBe('Main Flow/bid_race_tripoint_wins as test run')
    expect(fixtureId('Main Flow', 'bid_race_tripoint_wins', 'shadow_dry_run')).toBe('Main Flow/bid_race_tripoint_wins as shadow dry_run')
  })
})

describe('a shadow run is replayed with exactly what POST /shadow/:workflow_id passes', () => {
  it('matches the route field for field', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue({} as ReturnType<typeof createSupabaseClient>)
    const env = { API_KEY_MAP: JSON.stringify({ sk_test_key: 'website_form' }) } as unknown as Env
    const res = await shadow.request('/wf-1', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'sk_test_key' }, body: JSON.stringify(payload) }, env, ctx)
    expect(res.status).toBe(204)
    expect(executeWorkflow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toEqual(runOptions('shadow_dry_run', { workflowId: 'wf-1', payload, source: 'website_form' }))
  })
})

describe('a test run is replayed with exactly what POST /api/workflows/:id/test passes', () => {
  const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' } as unknown as Env
  const definition = { trigger: { config: {} }, nodes: [{ id: 'n1', namespace: 'pull', type: 'code', config: { script: 'return 1' } }], edges: [] }

  async function postTest(body: Record<string, unknown>) {
    vi.mocked(verifyJwt).mockResolvedValue({ sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabase({
      users: { single: { id: 'user-1', organization_id: ORG, email: 'dan@pennie.com' } },
      // The route refuses a workflow stored under another lane before deploying (#1725).
      workflows: { single: { id: 'wf-1', organization_id: ORG, lane: 'money' } },
    }) as unknown as ReturnType<typeof createSupabaseClient>)
    const { default: api } = await import('../../../src/routes/api/index')
    return api.request('/workflows/wf-1/test', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) }, env, ctx)
  }

  it('matches the route field for field when the canvas sends its definition and the code bundle deploys', async () => {
    vi.mocked(deployTestCodeBundle).mockResolvedValue({ bundleName: 'bs-wft-wf-1-0a1b2c3d' })
    const executionId = uuidv7()
    const res = await postTest({ payload, execution_id: executionId, definition })
    expect(res.status).toBe(200)
    // The gate deploys the test bundle through the same function, with the same arguments.
    expect(deployTestCodeBundle).toHaveBeenCalledWith('wf-1', definition, 'acct', 'tok', env.WORKFLOW_CACHE)
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toEqual(
      runOptions('test', { workflowId: 'wf-1', payload, source: 'ignored by a test run' }, { executionId, codeBundleName: 'bs-wft-wf-1-0a1b2c3d', definitionOverride: definition }),
    )
  })

  it('matches the route when no test bundle could be deployed: no bundle name is passed', async () => {
    vi.mocked(deployTestCodeBundle).mockResolvedValue({ bundleName: null })
    const executionId = uuidv7()
    await postTest({ payload, execution_id: executionId, definition })
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toEqual(
      runOptions('test', { workflowId: 'wf-1', payload, source: 'x' }, { executionId, codeBundleName: null, definitionOverride: definition }),
    )
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).not.toHaveProperty('codeBundleName')
  })
})
