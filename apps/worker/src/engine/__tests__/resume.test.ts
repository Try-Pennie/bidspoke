/**
 * Resume execution — tests that walkGraph skips already-completed steps
 * and re-runs only incomplete steps from the failed position.
 * PRD Section 2.4: resume_from_execution_id, skip completed steps
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
    trigger: { payload: {}, source: 'test', workflow_id: 'wf', trace_id: 'tr' },
    steps: Object.fromEntries(
      Object.entries(preloaded).map(([k, v]) => [k, { output: v, status: 'completed' as const }])
    ),
    env: {},
  }
}

const supabase = {} as SupabaseClient
const env = {} as Env

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resume — skip completed steps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executeNode).mockResolvedValue({ output: { result: 'fresh' } })
  })

  it('re-executes all steps when no prior context', async () => {
    const def = chain(node('a', 'step_a'), node('b', 'step_b'), node('c', 'step_c', 'response'))
    const ctx = makeCtx()
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env)
    expect(vi.mocked(executeNode)).toHaveBeenCalledTimes(3)
  })

  it('skips step_a when it is pre-loaded as completed', async () => {
    const def = chain(node('a', 'step_a'), node('b', 'step_b'), node('c', 'step_c', 'response'))
    const ctx = makeCtx({ step_a: { prior: true } })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env)
    // step_a skipped, step_b and step_c (response) executed
    expect(vi.mocked(executeNode)).toHaveBeenCalledTimes(2)
    const calledNamespaces = vi.mocked(executeNode).mock.calls.map((c) => (c[0] as NodeDefinition).namespace)
    expect(calledNamespaces).not.toContain('step_a')
    expect(calledNamespaces).toContain('step_b')
  })

  it('skips all completed steps and only runs incomplete ones', async () => {
    const def = chain(
      node('a', 'step_a'),
      node('b', 'step_b'),
      node('c', 'step_c'),
      node('d', 'step_d', 'response')
    )
    // Simulate a prior execution that completed a, b but failed at c
    const ctx = makeCtx({ step_a: { ok: true }, step_b: { ok: true } })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env)
    // Only step_c and step_d should have been executed
    expect(vi.mocked(executeNode)).toHaveBeenCalledTimes(2)
    const calledNamespaces = vi.mocked(executeNode).mock.calls.map((c) => (c[0] as NodeDefinition).namespace)
    expect(calledNamespaces).toEqual(['step_c', 'step_d'])
  })

  it('uses the pre-loaded output for data references in subsequent steps', async () => {
    const def = chain(node('a', 'step_a'), node('b', 'step_b', 'response'))
    const priorOutput = { score: 720, approved: true }
    const ctx = makeCtx({ step_a: priorOutput })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env)
    // step_a was preloaded — its output should be in ctx.steps
    expect(ctx.steps['step_a']?.output).toEqual(priorOutput)
    // step_b executed with access to step_a's data
    expect(vi.mocked(executeNode)).toHaveBeenCalledOnce()
  })

  it('returns the last output (from last node, even if prior steps were skipped)', async () => {
    vi.mocked(executeNode).mockResolvedValue({ output: { response: 'done' } })
    const def = chain(node('a', 'step_a'), node('b', 'step_b', 'response'))
    const ctx = makeCtx({ step_a: { score: 700 } })
    const result = await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env)
    expect(result).toEqual({ response: 'done' })
  })

  it('skipping a node does not log a new step record', async () => {
    const { writeStepLog } = await import('../step-logger')
    vi.mocked(writeStepLog).mockResolvedValue(undefined)
    const def = chain(node('a', 'step_a'), node('b', 'step_b', 'response'))
    const ctx = makeCtx({ step_a: { ok: true } })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env)
    // writeStepLog should only be called for step_b (not step_a which was skipped)
    const loggedNamespaces = vi.mocked(writeStepLog).mock.calls
      .map((c) => (c[1] as { step_namespace: string }).step_namespace)
    expect(loggedNamespaces).not.toContain('step_a')
    expect(loggedNamespaces).toContain('step_b')
  })
})

// ── Resume with filter node routing ──────────────────────────────────────────

describe('resume — filter node routing preserved', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(executeNode).mockResolvedValue({ output: { result: 'ok' } })
  })

  it('follows the correct edge from a pre-loaded filter node output', async () => {
    const filterNode = node('f', 'filter_step', 'filter')
    const passNode = node('pass', 'pass_step', 'response')
    const exitNode = node('exit', 'exit_step', 'exit')
    const def = {
      nodes: [filterNode, passNode, exitNode],
      edges: [
        { id: 'e1', source: 'f', source_handle: 'pass', target: 'pass' },
        { id: 'e2', source: 'f', source_handle: 'exit', target: 'exit' },
      ],
    }
    // Prior execution: filter passed
    const ctx = makeCtx({ filter_step: { _route: 'pass' } })
    await walkGraph(ctx, def, 'exec', new Date().toISOString(), supabase, env)
    const calledNamespaces = vi.mocked(executeNode).mock.calls.map((c) => (c[0] as NodeDefinition).namespace)
    expect(calledNamespaces).toContain('pass_step')
    expect(calledNamespaces).not.toContain('exit_step')
  })
})
