/**
 * Issue #62: consecutive code nodes were batched into one dispatch that bypasses
 * withTimeout / withRetry / on_error. A node with custom retry/error/timeout must
 * therefore NOT be batched — it has to run on the single-node path that honors
 * those. collectCodeChain now excludes such nodes (including the chain start).
 */
import { describe, it, expect, vi } from 'vitest'
import { collectCodeChain, isChainableCodeNode, executeCodeChain } from '../index'
import { codeBundleName } from '../../lib/code-node-deployer'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition, EdgeDefinition } from '../../types'

function code(id: string, config: Record<string, unknown> = {}): NodeDefinition {
  return { id, namespace: id, type: 'code', config }
}
function edge(source: string, target: string, extra: Partial<EdgeDefinition> = {}): EdgeDefinition {
  return { id: `${source}-${target}`, source, target, ...extra }
}
const ids = (chain: NodeDefinition[]) => chain.map((n) => n.id)

describe('isChainableCodeNode (#62)', () => {
  it('is true for a default-config code node', () => {
    expect(isChainableCodeNode(code('a'))).toBe(true)
  })
  it('is false for custom retries / on_error / timeout / service', () => {
    expect(isChainableCodeNode(code('a', { retries: 2 }))).toBe(false)
    expect(isChainableCodeNode(code('a', { on_error: 'skip' }))).toBe(false)
    expect(isChainableCodeNode(code('a', { timeout_ms: 150 }))).toBe(false)
    expect(isChainableCodeNode(code('a', { service: 'gmail' }))).toBe(false)
  })
  it('is true for on_error explicitly set to the default "fail"', () => {
    expect(isChainableCodeNode(code('a', { on_error: 'fail' }))).toBe(true)
  })
  it('is false for a non-code node', () => {
    expect(isChainableCodeNode({ id: 'x', namespace: 'x', type: 'filter', config: {} })).toBe(false)
  })
})

describe('collectCodeChain (#62)', () => {
  it('batches a run of default-config code nodes', () => {
    const nodes = [code('a'), code('b'), code('c')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    expect(ids(collectCodeChain(nodes[0], { nodes, edges }))).toEqual(['a', 'b', 'c'])
  })

  it('stops before a successor that has a custom timeout (it runs solo)', () => {
    const nodes = [code('a'), code('b', { timeout_ms: 150 }), code('c')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    expect(ids(collectCodeChain(nodes[0], { nodes, edges }))).toEqual(['a'])
  })

  it('stops before a successor that has retries or custom on_error', () => {
    const retried = [code('a'), code('b', { retries: 2 })]
    expect(ids(collectCodeChain(retried[0], { nodes: retried, edges: [edge('a', 'b')] }))).toEqual(['a'])
    const skipped = [code('a'), code('b', { on_error: 'skip' })]
    expect(ids(collectCodeChain(skipped[0], { nodes: skipped, edges: [edge('a', 'b')] }))).toEqual(['a'])
  })

  it('returns the start alone when the START itself has custom config (#62 gap)', () => {
    const nodes = [code('a', { timeout_ms: 150 }), code('b'), code('c')]
    const edges = [edge('a', 'b'), edge('b', 'c')]
    expect(ids(collectCodeChain(nodes[0], { nodes, edges }))).toEqual(['a'])
  })

  it('stops at a conditional edge and at a non-code successor', () => {
    const cond = [code('a'), code('b')]
    expect(ids(collectCodeChain(cond[0], { nodes: cond, edges: [edge('a', 'b', { condition: { groups: [], logic: 'AND' } })] }))).toEqual(['a'])
    const nonCode = [code('a'), { id: 'b', namespace: 'b', type: 'salesforce', config: {} } as NodeDefinition]
    expect(ids(collectCodeChain(nonCode[0], { nodes: nonCode, edges: [edge('a', 'b')] }))).toEqual(['a'])
  })
})

describe('executeCodeChain steps scoping (#190)', () => {
  function envCapturing(captured: { body?: string }) {
    const bundleFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured.body = init.body as string
      return Promise.resolve(
        new Response(JSON.stringify({ results: [{ namespace: 'a', status: 'completed', output: {} }] }), { status: 200 }),
      )
    })
    return { DYNAMIC_WORKER_LOADER: { get: () => ({ fetch: bundleFetch }) } } as unknown as Env
  }

  const ctxWith = () => ({
    trigger: { payload: { lead_id: 'L1' }, source: 't', workflow_id: 'wf', org_id: '', trace_id: 'tr' },
    steps: {
      alpha:  { output: { score: 720 }, status: 'completed' },
      secret: { output: { ssn: '000-00-0000' }, status: 'completed' },
    },
    env: {},
  }) as unknown as ExecutionContext

  it('sends only the steps the chain references, withholding unreferenced PII', async () => {
    const captured: { body?: string } = {}
    const env = envCapturing(captured)
    const chain = [code('a'), code('b')]
    chain[0].config = { script: 'return steps.alpha.output.score' }
    chain[1].config = { script: 'return steps.alpha.output.score + 1' }

    await executeCodeChain(chain, ctxWith(), env)

    const sent = JSON.parse(captured.body!) as { steps: Record<string, unknown> }
    expect(Object.keys(sent.steps).sort()).toEqual(['alpha', 'trigger'])
    expect(sent.steps.secret).toBeUndefined()
  })

  it('falls back to sending all steps when any chain node uses dynamic access', async () => {
    const captured: { body?: string } = {}
    const env = envCapturing(captured)
    const chain = [code('a'), code('b')]
    chain[0].config = { script: 'return steps.alpha.output.score' }
    chain[1].config = { script: 'return Object.keys(steps).length' }

    await executeCodeChain(chain, ctxWith(), env)

    const sent = JSON.parse(captured.body!) as { steps: Record<string, unknown> }
    expect(sent.steps.secret).toBeDefined()
    expect(sent.steps.alpha).toBeDefined()
  })
})

describe('executeCodeChain dispatch timeout (#62)', () => {
  it('fails the chain (does not hang or fall back) when the dispatch exceeds its budget', async () => {
    // Binding fetch that hangs until aborted — simulates a hung code node.
    const bundleFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      })
    )
    const env = { DYNAMIC_WORKER_LOADER: { get: () => ({ fetch: bundleFetch }) } } as unknown as Env
    const ctx = {
      trigger: { payload: {}, source: 't', workflow_id: 'wf', org_id: '', trace_id: 'tr' },
      steps: {}, env: {},
    } as ExecutionContext
    // timeout_ms drives the chain budget here: 50 + 50 = 100ms total.
    const chain = [code('a', { timeout_ms: 50 }), code('b', { timeout_ms: 50 })]

    const { results } = await executeCodeChain(chain, ctx, env)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toMatch(/Code chain timed out after 100ms/)
  })
})

describe('executeCodeChain binding-throw fallback discrimination (#475)', () => {
  const chainCtx = () => ({
    trigger: { payload: {}, source: 't', workflow_id: 'wf', org_id: '', trace_id: 'tr' },
    steps: {}, env: {},
  }) as ExecutionContext

  // Routes the bundle name to `bundleFetch` and any per-node name to `perNodeFetch`.
  function makeEnv(bundleFetch: ReturnType<typeof vi.fn>, perNodeFetch: ReturnType<typeof vi.fn>): Env {
    const bundle = codeBundleName('wf')
    return {
      DYNAMIC_WORKER_LOADER: {
        get: (name: string) => ({ fetch: name === bundle ? bundleFetch : perNodeFetch }),
      },
    } as unknown as Env
  }

  it('fails the chain on a transient binding throw instead of re-running it on stale per-node workers', async () => {
    const bundleFetch = vi.fn().mockRejectedValue(new Error('binding resolve failed'))
    const perNodeFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const env = makeEnv(bundleFetch, perNodeFetch)
    const chain = [code('a'), code('b')]

    const { results } = await executeCodeChain(chain, chainCtx(), env)
    expect(perNodeFetch).not.toHaveBeenCalled()
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toMatch(/binding resolve failed/)
  })

  it('falls back to per-node workers when the binding throws "Worker not found" (migration case)', async () => {
    const bundleFetch = vi.fn().mockRejectedValue(new Error('Worker not found: ' + codeBundleName('wf')))
    const perNodeFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const env = makeEnv(bundleFetch, perNodeFetch)
    const chain = [code('a'), code('b')]

    const { results } = await executeCodeChain(chain, chainCtx(), env)
    expect(perNodeFetch).toHaveBeenCalled()
    expect(perNodeFetch.mock.calls[0][0]).toBe('https://worker/execute')
    expect(results[0].status).toBe('completed')
    expect(results[0].output).toEqual({ ok: true })
  })
})
