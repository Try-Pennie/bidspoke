/**
 * Graph-walk safety bound (#260) — walkGraph must not loop forever on a cyclic
 * workflow definition (which would repeat paid outbound calls and DB writes
 * until the Worker CPU limit kills it). A hard step ceiling aborts the walk
 * with a permanent error instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { Env } from '../../index'

vi.mock('../../lib/circuit-breaker-client', () => ({
  CircuitBreakerClient: class {
    check() { return Promise.resolve({ allowed: true, state: 'closed' }) }
    recordSuccess() { return Promise.resolve() }
    recordError() { return Promise.resolve({ ok: true, state: 'closed', tripped: false }) }
  },
}))
vi.mock('../nodes/index')

import { executeNode } from '../nodes/index'
import { walkGraph, MAX_WALK_STEPS } from '../index'

function node(id: string, namespace: string, type: NodeDefinition['type'] = 'code'): NodeDefinition {
  return { id, namespace, type, config: {} }
}
function makeCtx(): ExecutionContext {
  return { trigger: { payload: {}, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 't' }, steps: {}, env: {} }
}
const supabase = {} as SupabaseClient
const env = {} as Env

describe('walkGraph step ceiling (#260)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executeNode).mockResolvedValue({ output: { ok: true } })
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => consoleSpy.mockRestore())

  it('aborts a cyclic graph with a max-steps error instead of looping forever', async () => {
    // a -> b -> c -> b: an unbreakable cycle between b and c.
    const def = {
      nodes: [node('a', 'a'), node('b', 'b'), node('c', 'c')],
      edges: [
        { id: 'e0', source: 'a', target: 'b' },
        { id: 'e1', source: 'b', target: 'c' },
        { id: 'e2', source: 'c', target: 'b' },
      ],
    }
    await expect(
      walkGraph(makeCtx(), def, 'exec-cycle', new Date().toISOString(), supabase, env, 'money', 'v1'),
    ).rejects.toThrow(/maximum step count/i)
    // It bounded the walk rather than running unbounded.
    expect(vi.mocked(executeNode).mock.calls.length).toBeLessThanOrEqual(MAX_WALK_STEPS + 1)
  })

  it('does not abort a legitimate linear graph well under the ceiling', async () => {
    const nodes = Array.from({ length: 50 }, (_, i) => node(`n${i}`, `n${i}`, i === 49 ? 'response' : 'code'))
    const edges = nodes.slice(0, -1).map((n, i) => ({ id: `e${i}`, source: n.id, target: nodes[i + 1].id }))
    await expect(
      walkGraph(makeCtx(), { nodes, edges }, 'exec-linear', new Date().toISOString(), supabase, env, 'money', 'v1'),
    ).resolves.toBeTruthy()
    expect(MAX_WALK_STEPS).toBeGreaterThan(100)
  })
})
