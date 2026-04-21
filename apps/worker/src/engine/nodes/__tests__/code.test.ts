import { describe, it, expect, vi } from 'vitest'
import { executeCodeNode } from '../code'
import { codeWorkerName } from '../../../lib/code-node-deployer'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'

function ctx(): ExecutionContext {
  return {
    trigger: { payload: { lead_id: 'lead-1' }, source: 'test', workflow_id: 'wf-abc123', trace_id: 'trace' },
    steps: { prev: { output: { score: 720 }, status: 'completed' } },
    env: { API_KEY: 'secret' },
  }
}

function node(config: NodeDefinition['config']): NodeDefinition {
  return { id: 'n1', namespace: 'code_step', type: 'code', config }
}

function makeEnv(workerFetch: ReturnType<typeof vi.fn>): Env {
  return {
    DYNAMIC_WORKER_LOADER: {
      get: vi.fn().mockReturnValue({ fetch: workerFetch }),
    } as unknown as DispatchNamespace,
  } as unknown as Env
}

describe('executeCodeNode', () => {
  it('throws if script is not configured', async () => {
    const env = makeEnv(vi.fn())
    await expect(executeCodeNode(node({}), ctx(), env)).rejects.toThrow(/no script configured/)
  })

  it('throws if script is empty string', async () => {
    const env = makeEnv(vi.fn())
    await expect(executeCodeNode(node({ script: '   ' }), ctx(), env)).rejects.toThrow(/no script configured/)
  })

  it('dispatches to the correct worker name', async () => {
    const workerFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(workerFetch)
    await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    const expectedName = codeWorkerName('wf-abc123', 'code_step')
    expect((env.DYNAMIC_WORKER_LOADER.get as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(expectedName)
  })

  it('sends payload, steps, env, and execution to the worker', async () => {
    const workerFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(workerFetch)
    const c = ctx()
    await executeCodeNode(node({ script: 'return {}' }), c, env)
    const body = JSON.parse(workerFetch.mock.calls[0][1].body as string) as unknown
    expect(body).toMatchObject({ payload: c.trigger.payload, steps: c.steps, env: c.env, execution: { trace_id: 'trace' } })
  })

  it('returns the JSON output from the worker', async () => {
    const output = { credit_score: 720, approved: true }
    const env = makeEnv(vi.fn().mockResolvedValue(new Response(JSON.stringify(output), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.output).toEqual(output)
  })

  it('throws with status and body on non-OK worker response', async () => {
    const env = makeEnv(vi.fn().mockResolvedValue(new Response('ReferenceError: x is not defined', { status: 500 })))
    await expect(executeCodeNode(node({ script: 'return {}' }), ctx(), env)).rejects.toThrow(/HTTP 500/)
  })

  it('returns earlyResponse when script returns { response: { status, body } }', async () => {
    const sentinel = { response: { status: 200, body: { status: 'rejected', reason: 'ineligible state' } } }
    const env = makeEnv(vi.fn().mockResolvedValue(new Response(JSON.stringify(sentinel), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.earlyResponse).toEqual({ status: 200, body: { status: 'rejected', reason: 'ineligible state' }, headers: undefined })
  })

  it('returns earlyExit when script returns { exit: true }', async () => {
    const sentinel = { exit: true, reason: 'bidding not active' }
    const env = makeEnv(vi.fn().mockResolvedValue(new Response(JSON.stringify(sentinel), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.earlyExit).toBe(true)
  })

  it('does not set earlyResponse for objects with a response field that is not an object', async () => {
    const output = { response: 'some string value', other: 123 }
    const env = makeEnv(vi.fn().mockResolvedValue(new Response(JSON.stringify(output), { status: 200 })))
    const result = await executeCodeNode(node({ script: 'return {}' }), ctx(), env)
    expect(result.earlyResponse).toBeUndefined()
    expect(result.output).toEqual(output)
  })
})

describe('codeWorkerName', () => {
  it('produces a deterministic name from workflow id and namespace', () => {
    expect(codeWorkerName('abc12345-xxxx', 'validate')).toBe('bs-abc12345-validate')
  })

  it('truncates to 64 chars', () => {
    const name = codeWorkerName('a'.repeat(36), 'n'.repeat(40))
    expect(name.length).toBeLessThanOrEqual(64)
  })
})
