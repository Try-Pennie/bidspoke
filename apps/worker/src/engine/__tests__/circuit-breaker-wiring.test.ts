import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { Env } from '../../index'

// --- Module-scope CB mock state (reassigned each beforeEach) ---
let cbMock: {
  check: ReturnType<typeof vi.fn>
  recordSuccess: ReturnType<typeof vi.fn>
  recordError: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
}

// Spy on constructor calls to verify service name
const cbConstructorSpy = vi.fn()

// --- Mocks (hoisted by Vitest before imports) ---

// Class-based mock: delegate to cbMock at call time (assigned in beforeEach)
type AnyFn = (...args: unknown[]) => unknown

vi.mock('../../lib/circuit-breaker-client', () => ({
  CircuitBreakerClient: class {
    constructor(...args: unknown[]) { cbConstructorSpy(...args) }
    check(...args: unknown[]) { return (cbMock.check as AnyFn)(...args) }
    recordSuccess(...args: unknown[]) { return (cbMock.recordSuccess as AnyFn)(...args) }
    recordError(...args: unknown[]) { return (cbMock.recordError as AnyFn)(...args) }
    reset(...args: unknown[]) { return (cbMock.reset as AnyFn)?.(...args) }
    status(...args: unknown[]) { return (cbMock.status as AnyFn)?.(...args) }
  },
}))

vi.mock('../nodes/index')
vi.mock('../step-logger')

import { executeNode } from '../nodes/index'
import { walkGraph } from '../index'

// --- Helpers ---

function makeCtx(): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf-1', trace_id: 'trace-1' },
    steps: {},
    env: {},
  }
}

const supabase = {} as SupabaseClient
const env = {} as Env

function makeNode(overrides: Partial<NodeDefinition>): NodeDefinition {
  return {
    id: 'n1',
    namespace: 'step1',
    type: 'integration',
    config: {},
    ...overrides,
  }
}

// Build a workflow: service node → response terminal
function makeDefinition(serviceNode: NodeDefinition) {
  const responseNode: NodeDefinition = {
    id: 'response',
    namespace: 'final',
    type: 'response',
    config: { body: { ok: true } },
  }
  return {
    nodes: [serviceNode, responseNode],
    edges: [{ id: 'e1', source: serviceNode.id, target: 'response' }],
  }
}

// --- Tests ---

describe('engine — circuit breaker wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cbMock = {
      check: vi.fn().mockResolvedValue({ allowed: true, state: 'closed' }),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue({ ok: true, state: 'closed', tripped: false }),
      reset: vi.fn(),
      status: vi.fn(),
    }
    vi.mocked(executeNode).mockResolvedValue({ output: { result: 'ok' } })
  })

  it('does not instantiate CircuitBreakerClient for nodes without config.service', async () => {
    const def = makeDefinition(makeNode({ config: {} }))
    await walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
    expect(cbConstructorSpy).not.toHaveBeenCalled()
  })

  it('instantiates CircuitBreakerClient keyed by config.service', async () => {
    const def = makeDefinition(makeNode({ config: { service: 'equifax' } }))
    await walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
    expect(cbConstructorSpy).toHaveBeenCalledWith(env, 'equifax')
  })

  it('checks the circuit before executing the node', async () => {
    const def = makeDefinition(makeNode({ config: { service: 'equifax' } }))
    await walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
    expect(cbMock.check).toHaveBeenCalledOnce()
    expect(vi.mocked(executeNode)).toHaveBeenCalled()
  })

  it('records success after the node completes', async () => {
    const def = makeDefinition(makeNode({ config: { service: 'equifax' } }))
    await walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
    await Promise.resolve()
    expect(cbMock.recordSuccess).toHaveBeenCalledOnce()
  })

  describe('when the circuit is open', () => {
    beforeEach(() => {
      cbMock.check.mockResolvedValue({
        allowed: false,
        state: 'open',
        reason: 'circuit_open',
        opens_at: Date.now() + 60_000,
      })
    })

    it('routes to fallback without executing the service node (on_error: fallback)', async () => {
      const serviceNode = makeNode({
        id: 'equifax',
        namespace: 'equifax_step',
        config: { service: 'equifax', on_error: 'fallback', fallback_node: 'response' },
      })
      const def = makeDefinition(serviceNode)
      vi.mocked(executeNode).mockResolvedValue({ output: { fallback: true } })

      await walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)

      // executeNode called once (for the response/fallback terminal), not for equifax_step
      expect(vi.mocked(executeNode)).toHaveBeenCalledTimes(1)
    })

    it('throws when circuit is open and on_error is fail', async () => {
      const def = makeDefinition(makeNode({ config: { service: 'equifax', on_error: 'fail' } }))
      await expect(
        walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
      ).rejects.toThrow(/circuit is open/)
    })

    it('does not call recordError when circuit is open (no request was attempted)', async () => {
      const def = makeDefinition(makeNode({ config: { service: 'equifax', on_error: 'fail' } }))
      await expect(
        walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
      ).rejects.toThrow()
      await Promise.resolve()
      expect(cbMock.recordError).not.toHaveBeenCalled()
    })
  })

  describe('when the node call fails', () => {
    it('records error for transient failures (network / timeout)', async () => {
      vi.mocked(executeNode).mockRejectedValue(new Error('fetch failed'))
      const def = makeDefinition(
        makeNode({ config: { service: 'equifax', on_error: 'fail', retries: 0 } })
      )
      await expect(
        walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
      ).rejects.toThrow()
      await Promise.resolve()
      expect(cbMock.recordError).toHaveBeenCalledOnce()
    })

    it('does not record error for permanent HTTP failures (4xx)', async () => {
      vi.mocked(executeNode).mockRejectedValue(new Response('Unauthorized', { status: 401 }))
      const def = makeDefinition(
        makeNode({ config: { service: 'equifax', on_error: 'fail', retries: 0 } })
      )
      await expect(
        walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
      ).rejects.toThrow()
      await Promise.resolve()
      expect(cbMock.recordError).not.toHaveBeenCalled()
    })

    it('records error for transient HTTP failures (503)', async () => {
      vi.mocked(executeNode).mockRejectedValue(new Response('Service Unavailable', { status: 503 }))
      const def = makeDefinition(
        makeNode({ config: { service: 'equifax', on_error: 'fail', retries: 0 } })
      )
      await expect(
        walkGraph(makeCtx(), def, 'exec-1', new Date().toISOString(), supabase, env)
      ).rejects.toThrow()
      await Promise.resolve()
      expect(cbMock.recordError).toHaveBeenCalledOnce()
    })
  })
})
