/**
 * Definition loader / KV cache — PRD Section 2.6
 * Cache hit skips Supabase, cache miss fetches and stores, invalidate removes key.
 */
import { describe, it, expect, vi } from 'vitest'
import { loadWorkflowDefinition, invalidateWorkflowCache } from '../definition-loader'

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
  workflow_versions: [{ id: 'ver-1', version_number: 1 }],
}

function makeSupabase(row: typeof workflowRow | null = workflowRow) {
  const single = vi.fn().mockResolvedValue(
    row ? { data: row, error: null } : { data: null, error: { message: 'not found' } }
  )
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'single') return single
      return () => chain
    },
  })
  return { from: vi.fn().mockReturnValue(chain), _single: single }
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

  it('throws when workflow not found or inactive', async () => {
    const kv = makeKv(null)
    const sb = makeSupabase(null)

    await expect(loadWorkflowDefinition(WF_ID, kv, sb as never)).rejects.toThrow(WF_ID)
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
