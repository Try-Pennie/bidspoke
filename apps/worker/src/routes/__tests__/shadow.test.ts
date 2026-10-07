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
vi.mock('../../engine/definition-loader', async (orig) => ({ ...(await orig<object>()), loadWorkflowDefinition: vi.fn() }))
vi.mock('../../lib/code-node-deployer', async (orig) => ({ ...(await orig<object>()), deployCompareCodeBundle: vi.fn() }))

import { executeWorkflow } from '../../engine/index'
import { createSupabaseClient } from '../../lib/supabase'
import { loadWorkflowDefinition, WorkflowNotFoundError } from '../../engine/definition-loader'
import { deployCompareCodeBundle } from '../../lib/code-node-deployer'
import type { LoadedWorkflow, WorkflowDefinition } from '../../types'
import shadow from '../shadow'

const definitionWith = (...types: string[]): WorkflowDefinition =>
  ({
    trigger: { id: 'trigger', type: 'trigger', config: {} },
    nodes: types.map((type, i) => ({ id: `n${i}`, namespace: `${type}_${i}`, type, config: {} })),
    edges: [],
  }) as unknown as WorkflowDefinition

const loaded = (definition: WorkflowDefinition): LoadedWorkflow => ({
  definition,
  workflow_version_id: 'v1',
  workflow_name: 'Shadow test',
  org_id: 'org-1',
  slack_channel: null,
  lane: 'money',
})

const KEY_MAP = JSON.stringify({ sk_test_key: 'website_form' })
const compareLoader = { get: vi.fn() }
const workflowCache = {}
const testEnv = {
  API_KEY_MAP: KEY_MAP,
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_ANON_KEY: 'fake-anon-key',
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_API_TOKEN: 'tok',
  WORKFLOW_CACHE: workflowCache,
  COMPARE_CODE_LOADER: compareLoader,
} as unknown as Env

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(workflowId: string, apiKey: string | undefined, body: unknown, extra: { query?: string; mode?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey !== undefined) headers['X-API-Key'] = apiKey
  if (extra.mode !== undefined) headers['X-Shadow-Mode'] = extra.mode
  return shadow.request(`/${workflowId}${extra.query ?? ''}`, { method: 'POST', headers, body: JSON.stringify(body) }, testEnv, mockCtx)
}

describe('POST /shadow/:workflow_id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createSupabaseClient).mockReturnValue({} as ReturnType<typeof createSupabaseClient>)
    vi.mocked(executeWorkflow).mockResolvedValue({ executionId: 'e1', response: {}, status: 200, traceId: 't1' })
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded(definitionWith('transform', 'salesforce')))
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

  // The mode comes from a header, never the address (#1815): nothing a sender
  // puts in a query string is read, a fixed word included.
  it.each([
    ['stand_in', 'stand_in'],
    ['dry_run', 'dry_run'],
    ['Stand_In', 'dry_run'],
    ['someone@example.com', 'dry_run'],
  ])('runs an X-Shadow-Mode of %s as a %s shadow', async (mode, expected) => {
    const res = await request('wf-1', 'sk_test_key', { lead: 1 }, { mode })
    expect(res.status).toBe(204)
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toMatchObject({ shadowMode: expected })
  })

  it('ignores a mode in the address', async () => {
    const res = await request('wf-1', 'sk_test_key', { lead: 1 }, { query: '?mode=stand_in' })
    expect(res.status).toBe(204)
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toMatchObject({ shadowMode: 'dry_run' })
  })

  // #1708 part B: a shadow run's code runs on a compare bundle in the compare
  // namespace, whose outbound Worker refuses every request. The route deploys it
  // first and hands its name to the run.
  it('deploys the compare bundle for a workflow carrying code, then runs the shadow on it', async () => {
    const definition = definitionWith('transform', 'code')
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded(definition))
    vi.mocked(deployCompareCodeBundle).mockResolvedValue({ bundleName: 'bs-cmp-wf-1-0123abcd' })
    const res = await request('wf-1', 'sk_test_key', { lead: 1 })

    expect(res.status).toBe(204)
    expect(deployCompareCodeBundle).toHaveBeenCalledWith('wf-1', definition, 'acct', 'tok', workflowCache)
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toMatchObject({ shadowMode: 'dry_run', isTest: true, codeBundleName: 'bs-cmp-wf-1-0123abcd' })
  })

  it('refuses with a named 503 and runs nothing when the compare bundle cannot be deployed', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded(definitionWith('code')))
    vi.mocked(deployCompareCodeBundle).mockResolvedValue({ bundleName: null, error: 'namespace not found' })
    const res = await request('wf-1', 'sk_test_key', { lead: 1 })

    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('compare bundle could not be deployed: namespace not found')
    expect(executeWorkflow).not.toHaveBeenCalled()
    expect(mockCtx.waitUntil).not.toHaveBeenCalled()
  })

  it('refuses with a named 503, not an unnamed 500, when the compare deploy throws on the network', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded(definitionWith('code')))
    vi.mocked(deployCompareCodeBundle).mockRejectedValue(new TypeError('Network connection lost.'))
    const res = await request('wf-1', 'sk_test_key', { lead: 1 })

    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('compare bundle could not be deployed: Network connection lost.')
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('refuses with a named 503 when the compare namespace is not bound, deploying and running nothing', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded(definitionWith('code')))
    const unbound = { ...testEnv, COMPARE_CODE_LOADER: undefined } as unknown as Env
    const res = await shadow.request('/wf-1', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'sk_test_key' }, body: '{}' }, unbound, mockCtx)

    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('compare namespace is not bound')
    expect(deployCompareCodeBundle).not.toHaveBeenCalled()
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('deploys nothing for a workflow with no code, and runs it with no bundle', async () => {
    const res = await request('wf-1', 'sk_test_key', { lead: 1 })
    expect(res.status).toBe(204)
    expect(deployCompareCodeBundle).not.toHaveBeenCalled()
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).not.toHaveProperty('codeBundleName')
  })

  it('checks the workflow the run would use, inactive ones included, as a test run does', async () => {
    await request('wf-1', 'sk_test_key', { lead: 1 })
    expect(vi.mocked(loadWorkflowDefinition).mock.calls[0][0]).toBe('wf-1')
    expect(vi.mocked(loadWorkflowDefinition).mock.calls[0][3]).toEqual({ allowInactive: true })
  })

  it('answers 404 for a workflow that does not exist, and starts nothing', async () => {
    vi.mocked(loadWorkflowDefinition).mockRejectedValue(new WorkflowNotFoundError('wf-x', false))
    const res = await request('wf-x', 'sk_test_key', { lead: 1 })
    expect(res.status).toBe(404)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('refuses with 503 when the workflow cannot be read, since whether the run is safe is then unknown', async () => {
    vi.mocked(loadWorkflowDefinition).mockRejectedValue(new Error('Failed to load workflow wf-1: timeout'))
    const res = await request('wf-1', 'sk_test_key', { lead: 1 })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('could not be read')
    expect(executeWorkflow).not.toHaveBeenCalled()
  })
})
