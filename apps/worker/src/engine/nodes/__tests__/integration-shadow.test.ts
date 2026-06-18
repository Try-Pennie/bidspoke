import { describe, it, expect, vi } from 'vitest'
import { executeIntegrationNode } from '../integration'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

const node = { id: 'n1', type: 'webhook', namespace: 'call_x', config: { url: 'https://example.com/hook', method: 'POST' } } as unknown as NodeDefinition

describe('executeIntegrationNode — shadow dry_run', () => {
  it('returns a stub and never calls fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await executeIntegrationNode(node, ctx('dry_run'), {} as never)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toEqual({ status: 200, body: { _shadow: true }, headers: {} })
    vi.unstubAllGlobals()
  })
})
