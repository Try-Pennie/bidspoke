import { describe, it, expect, vi } from 'vitest'
import { executeLatencyGateNode } from '../latency-gate'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

function envWithKv(put: ReturnType<typeof vi.fn>) {
  return { SUBMISSIONS: { put, get: vi.fn().mockResolvedValue(null), delete: vi.fn() } } as never
}

const markNode = { type: 'latency_gate', namespace: 'lg', config: { operation: 'mark', correlation_key: 'cid-1', ttl_seconds: 120 } } as unknown as NodeDefinition

describe('executeLatencyGateNode — shadow dry_run', () => {
  it('does not write KV on mark, but returns the mark output shape', async () => {
    const put = vi.fn()
    const res = await executeLatencyGateNode(markNode, ctx('dry_run'), envWithKv(put))
    expect(put).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ operation: 'mark', key: 'latency:cid-1' })
  })
})
