import { describe, it, expect, vi } from 'vitest'
import { executeDataStoreNode } from '../data-store'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

function envWithKv(put: ReturnType<typeof vi.fn>, del: ReturnType<typeof vi.fn>) {
  return { SUBMISSIONS: { put, get: vi.fn().mockResolvedValue(null), delete: del } } as never
}

describe('executeDataStoreNode — shadow dry_run', () => {
  it('does not write KV on set, but returns the set output shape', async () => {
    const put = vi.fn(); const del = vi.fn()
    const node = { type: 'data_store', namespace: 'ds', config: { operation: 'set', key: 'k', value: { a: 1 }, ttl_seconds: 120 } } as unknown as NodeDefinition
    const res = await executeDataStoreNode(node, ctx('dry_run'), envWithKv(put, del))
    expect(put).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ store: 'submissions', operation: 'set', key: 'k' })
  })

  it('does not delete KV on delete', async () => {
    const put = vi.fn(); const del = vi.fn()
    const node = { type: 'data_store', namespace: 'ds', config: { operation: 'delete', key: 'k' } } as unknown as NodeDefinition
    const res = await executeDataStoreNode(node, ctx('dry_run'), envWithKv(put, del))
    expect(del).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ store: 'submissions', operation: 'delete', key: 'k' })
  })
})
