import { describe, it, expect, vi } from 'vitest'
import { executeAchieveOffersNode } from '../achieve-offers'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

const node = { id: 'n1', type: 'achieve_offers', namespace: 'achieve', config: { products: ['fdr'] } } as unknown as NodeDefinition

describe('executeAchieveOffersNode — shadow dry_run', () => {
  it('returns a stub with no _achieve_evaluation marker and no fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await executeAchieveOffersNode(node, ctx('dry_run'))
    expect(fetchMock).not.toHaveBeenCalled()
    const out = res.output as Record<string, unknown>
    expect(out._shadow).toBe(true)
    expect(out._achieve_evaluation).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
