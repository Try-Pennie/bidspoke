/**
 * Resume execution (issue #50) — resume re-runs every node from the entry,
 * exactly like a fresh run. No completed steps are pre-loaded and nothing is
 * skipped, so routing always comes from the FRESH output. The old skip-and-
 * reuse path mis-routed past completed multi-output nodes (a bid_group that
 * routed no_winner resumed down the winner arm) and re-fired never-completed
 * wait_for:first parallel children; running everything fresh removes that
 * class of bug. These tests guard against re-introducing any skip behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
vi.mock('../step-logger')

import { executeNode } from '../nodes/index'
import { walkGraph } from '../index'

// ── Helpers ───────────────────────────────────────────────────────────────────

function node(id: string, namespace: string, type: NodeDefinition['type'] = 'code'): NodeDefinition {
  return { id, namespace, type, config: {} }
}

function chain(...nodes: NodeDefinition[]) {
  return {
    nodes,
    edges: nodes.slice(0, -1).map((n, i) => ({
      id: `e${i}`,
      source: n.id,
      target: nodes[i + 1].id,
    })),
  }
}

function makeCtx(preloaded: Record<string, unknown> = {}): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 'tr' },
    steps: Object.fromEntries(
      Object.entries(preloaded).map(([k, v]) => [k, { output: v, status: 'completed' as const }])
    ),
    env: {},
  }
}

const supabase = {} as SupabaseClient
const env = {} as Env

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resume — full re-run, no skip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executeNode).mockResolvedValue({ output: { result: 'fresh' } })
  })

  it('re-executes all steps when no prior context', async () => {
    const def = chain(node('a', 'step_a'), node('b', 'step_b'), node('c', 'step_c', 'response'))
    const ctx = makeCtx()
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env, 'money')
    expect(vi.mocked(executeNode)).toHaveBeenCalledTimes(3)
  })

  it('re-executes a step even when it is pre-loaded as completed', async () => {
    const def = chain(node('a', 'step_a'), node('b', 'step_b'), node('c', 'step_c', 'response'))
    const ctx = makeCtx({ step_a: { prior: true } })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env, 'money')
    expect(vi.mocked(executeNode)).toHaveBeenCalledTimes(3)
    const calledNamespaces = vi.mocked(executeNode).mock.calls.map((c) => (c[0] as NodeDefinition).namespace)
    expect(calledNamespaces).toContain('step_a')
  })

  it('re-runs every node regardless of how many were pre-loaded', async () => {
    const def = chain(
      node('a', 'step_a'),
      node('b', 'step_b'),
      node('c', 'step_c'),
      node('d', 'step_d', 'response')
    )
    // A prior execution that completed a, b but failed at c must still re-run
    // a and b — resume is a fresh run, not a continuation from the failure.
    const ctx = makeCtx({ step_a: { ok: true }, step_b: { ok: true } })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env, 'money')
    const calledNamespaces = vi.mocked(executeNode).mock.calls.map((c) => (c[0] as NodeDefinition).namespace)
    expect(calledNamespaces).toEqual(['step_a', 'step_b', 'step_c', 'step_d'])
  })

  it('logs a step record for every re-executed node, including pre-loaded ones', async () => {
    const def = chain(node('a', 'step_a'), node('b', 'step_b', 'response'))
    const ctx = makeCtx({ step_a: { ok: true } })
    const queue: import('../step-logger').StepLogEntry[] = []
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env, 'money', '', queue)
    const loggedNamespaces = queue.map((e) => e.step_namespace)
    expect(loggedNamespaces).toContain('step_a')
    expect(loggedNamespaces).toContain('step_b')
  })
})

// ── #50 regression: routing comes from the fresh run, never a stale route ─────

describe('resume — routes on fresh output, not a pre-loaded _route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a filter that exited last run but passes this run follows the pass edge', async () => {
    // Fresh execution: the filter passes.
    vi.mocked(executeNode).mockImplementation(async (n: NodeDefinition) =>
      n.type === 'filter'
        ? { output: { passed: true, _route: 'pass' } }
        : { output: { result: 'ok' } }
    )
    const def = {
      nodes: [
        node('f', 'filter_step', 'filter'),
        node('pass', 'pass_step', 'response'),
        node('exit', 'exit_step', 'exit'),
      ],
      edges: [
        { id: 'e1', source: 'f', source_handle: 'pass', target: 'pass' },
        { id: 'e2', source: 'f', source_handle: 'exit', target: 'exit' },
      ],
    }
    // Prior run exited. If resume honored the stale route it would go to exit;
    // it must re-run the filter and follow the FRESH 'pass' route instead.
    const ctx = makeCtx({ filter_step: { passed: false, _route: 'exit' } })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env, 'money')
    const calledNamespaces = vi.mocked(executeNode).mock.calls.map((c) => (c[0] as NodeDefinition).namespace)
    expect(calledNamespaces).toContain('filter_step')
    expect(calledNamespaces).toContain('pass_step')
    expect(calledNamespaces).not.toContain('exit_step')
  })
})

// ── Terminal Response status extraction ───────────────────────────────────────
// The Response node emits its HTTP status under `status`. On resume the node is
// re-executed (not reused), so the status always comes from the fresh output.

describe('terminal response status extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the status from a freshly executed Response node output', async () => {
    vi.mocked(executeNode).mockImplementation(async (n: NodeDefinition) =>
      n.type === 'response'
        ? { output: { status: 502, headers: { 'X-Reason': 'upstream' }, body: { error: 'engine down' } } }
        : { output: { result: 'ok' } }
    )
    const def = chain(node('a', 'step_a'), node('b', 'step_b', 'response'))
    const result = await walkGraph(makeCtx(), def, 'exec', new Date().toISOString(), supabase, env, 'money')
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: 'engine down' })
    expect(result.headers).toEqual({ 'X-Reason': 'upstream' })
  })

  it('resume re-runs the Response node and uses its fresh status, ignoring any pre-loaded output', async () => {
    vi.mocked(executeNode).mockImplementation(async (n: NodeDefinition) =>
      n.type === 'response'
        ? { output: { status: 200, headers: {}, body: { fresh: true } } }
        : { output: { result: 'ok' } }
    )
    const def = chain(node('a', 'step_a'), node('b', 'step_b', 'response'))
    // A stale prior Response output must not be reused.
    const ctx = makeCtx({
      step_a: { ok: true },
      step_b: { status: 503, headers: {}, body: { error: 'old shape' } },
    })
    const result = await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env, 'money')
    expect(vi.mocked(executeNode)).toHaveBeenCalled()
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ fresh: true })
  })
})
