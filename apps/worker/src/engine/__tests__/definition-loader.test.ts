/**
 * Definition loader / KV cache — PRD Section 2.6
 * Cache hit skips Supabase, cache miss fetches and stores, invalidate removes key.
 */
import { describe, it, expect, vi } from 'vitest'
import { loadWorkflowDefinition, invalidateWorkflowCache, WorkflowNotFoundError } from '../definition-loader'

const WF_ID = 'wf-abc'
const CACHE_KEY = `workflow-def-${WF_ID}`

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKv(cached: unknown = null) {
  return {
    get: vi.fn().mockResolvedValue(cached),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace
}

const workflowRow = {
  id: WF_ID,
  name: 'Test Workflow',
  organization_id: 'org-1',
  slack_channel: '#alerts',
  definition: { nodes: [], edges: [] },
  is_active: true,
  lane: 'money',
  workflow_versions: [{ id: 'ver-1', version_number: 1 }],
}

function makeSupabaseRaw(result: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(result)
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'single') return single
      return () => chain
    },
  })
  return { from: vi.fn().mockReturnValue(chain), _single: single }
}

function makeSupabase(row: typeof workflowRow | null = workflowRow) {
  // Real `.single()` reports no-rows as PGRST116 (not a generic error).
  return makeSupabaseRaw(
    row ? { data: row, error: null } : { data: null, error: { message: 'not found', code: 'PGRST116' } }
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadWorkflowDefinition', () => {
  it('returns cached value and skips Supabase on cache hit', async () => {
    const cached = {
      definition: { nodes: [], edges: [] },
      workflow_version_id: 'ver-cached',
      workflow_name: 'Cached Workflow',
      org_id: 'org-1',
      slack_channel: null,
      lane: 'money',
    }
    const kv = makeKv(cached)
    const sb = makeSupabase()

    const result = await loadWorkflowDefinition(WF_ID, kv, sb as never)

    expect(result).toEqual(cached)
    expect(kv.get).toHaveBeenCalledWith(CACHE_KEY, 'json')
    expect(sb.from).not.toHaveBeenCalled()
  })

  it('fetches from Supabase on cache miss and returns correct shape', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase()

    const result = await loadWorkflowDefinition(WF_ID, kv, sb as never)

    expect(result.workflow_version_id).toBe('ver-1')
    expect(result.workflow_name).toBe('Test Workflow')
    expect(result.org_id).toBe('org-1')
    expect(result.slack_channel).toBe('#alerts')
    expect(sb.from).toHaveBeenCalledWith('workflows')
  })

  it('stores result in KV after cache miss', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase()

    await loadWorkflowDefinition(WF_ID, kv, sb as never)

    expect(kv.put).toHaveBeenCalledWith(
      CACHE_KEY,
      expect.any(String),
      { expirationTtl: expect.any(Number) }
    )
    const [, stored] = vi.mocked(kv.put).mock.calls[0]
    const parsed = JSON.parse(stored as string)
    expect(parsed.workflow_version_id).toBe('ver-1')
  })

  it('throws a typed WorkflowNotFoundError when not found or inactive (#107)', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase(null)

    await expect(loadWorkflowDefinition(WF_ID, kv, sb as never)).rejects.toBeInstanceOf(WorkflowNotFoundError)
  })

  it('throws a generic (retryable) error, NOT WorkflowNotFoundError, on a real DB error (#303)', async () => {
    // A real DB error mapped to WorkflowNotFoundError would 404 the lead source
    // (treated as "gone" → stops retrying). Only PGRST116 is a genuine not-found.
    const kv = makeKv(null)
    const sb = makeSupabaseRaw({ data: null, error: { message: 'db connection lost', code: '57P01' } })

    const promise = loadWorkflowDefinition(WF_ID, kv, sb as never)
    await expect(promise).rejects.toThrow(/Failed to load workflow/)
    await expect(promise).rejects.not.toBeInstanceOf(WorkflowNotFoundError)
  })

  it('throws when workflow has no versions', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase({ ...workflowRow, workflow_versions: [] })

    await expect(loadWorkflowDefinition(WF_ID, kv, sb as never)).rejects.toThrow('no versions')
  })
})

describe('invalidateWorkflowCache', () => {
  it('deletes the correct KV key', async () => {
    const kv = makeKv()

    await invalidateWorkflowCache(WF_ID, kv)

    expect(kv.delete).toHaveBeenCalledWith(CACHE_KEY)
  })
})

// #1707 (plan 0.C): the workflow's stored lane rides on the loaded workflow, so
// every entry point that runs a workflow reads it through this one loader.
describe('loadWorkflowDefinition: the stored lane', () => {
  it('reads the lane from the workflow row', async () => {
    const sb = makeSupabase({ ...workflowRow, lane: 'ops' } as typeof workflowRow)
    const loaded = await loadWorkflowDefinition(WF_ID, makeKv(), sb as never)
    expect(loaded.lane).toBe('ops')
  })

  it('treats a cached entry written before the lane existed as a miss and reads the row', async () => {
    const stale = { definition: { nodes: [], edges: [] }, workflow_version_id: 'ver-old', workflow_name: 'Old', org_id: 'org-1', slack_channel: null }
    const sb = makeSupabase({ ...workflowRow, lane: 'money' } as typeof workflowRow)
    const loaded = await loadWorkflowDefinition(WF_ID, makeKv(stale), sb as never)
    expect(sb.from).toHaveBeenCalledWith('workflows')
    expect(loaded.lane).toBe('money')
    expect(loaded.workflow_version_id).toBe('ver-1')
  })

  it('refuses a row whose lane is not one the engine knows, rather than guessing one', async () => {
    const sb = makeSupabase({ ...workflowRow, lane: 'sideways' } as typeof workflowRow)
    await expect(loadWorkflowDefinition(WF_ID, makeKv(), sb as never)).rejects.toThrow(
      `Workflow ${WF_ID} has unknown lane "sideways"`,
    )
  })
})
