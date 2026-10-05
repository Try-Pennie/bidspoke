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

import { executeWorkflow } from '../../engine/index'
import { createSupabaseClient } from '../../lib/supabase'
import { loadWorkflowDefinition, WorkflowNotFoundError } from '../../engine/definition-loader'
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
const testEnv = {
  API_KEY_MAP: KEY_MAP,
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_ANON_KEY: 'fake-anon-key',
} as unknown as Env

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

function request(workflowId: string, apiKey: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey !== undefined) headers['X-API-Key'] = apiKey
  return shadow.request(`/${workflowId}`, { method: 'POST', headers, body: JSON.stringify(body) }, testEnv, mockCtx)
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

  // #1780: a shadow run must send nothing, and a code node's scripts make their
  // real calls, so the request is refused by name before anything starts.
  it('refuses a workflow carrying a code node with a named 422 and starts nothing', async () => {
    vi.mocked(loadWorkflowDefinition).mockResolvedValue(loaded(definitionWith('transform', 'code')))
    const res = await request('wf-1', 'sk_test_key', { lead: 1 })

    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string; refused_nodes: Array<{ namespace: string; type: string }> }
    expect(body.error).toContain('code_1 is a code node')
    expect(body.refused_nodes).toEqual([{ namespace: 'code_1', type: 'code' }])
    expect(executeWorkflow).not.toHaveBeenCalled()
    expect(mockCtx.waitUntil).not.toHaveBeenCalled()
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
