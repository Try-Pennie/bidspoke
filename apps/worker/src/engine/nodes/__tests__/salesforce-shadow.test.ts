import { describe, it, expect, vi } from 'vitest'
import { executeSalesforceNode } from '../salesforce'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

const node = { id: 'n1', type: 'salesforce', namespace: 'sf_create', config: { operation: 'create', object: 'Lead', body: {} } } as unknown as NodeDefinition

describe('executeSalesforceNode — shadow dry_run', () => {
  it('returns a stub and never calls fetch (so no token request, no write)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // Env intentionally lacks SALESFORCE_* — the dry-run guard returns before the
    // env check, proving it short-circuits the entire outbound path.
    const res = await executeSalesforceNode(node, ctx('dry_run'), {} as never)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toEqual({ status: 200, body: { _shadow: true } })
    vi.unstubAllGlobals()
  })
})
