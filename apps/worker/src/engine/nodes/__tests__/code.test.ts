import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeCodeNode } from '../code'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'

function ctx(): ExecutionContext {
  return {
    trigger: { payload: { lead_id: 'lead-1' }, source: 'test', workflow_id: 'wf', trace_id: 'trace' },
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
  let workerFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    workerFetch = vi.fn()
  })

  it('throws if worker_name is not configured', async () => {
    const env = makeEnv(workerFetch)
    await expect(executeCodeNode(node({}), ctx(), env)).rejects.toThrow(/missing worker_name/)
  })

  it('calls the dynamic worker with the execution context', async () => {
    workerFetch.mockResolvedValue(
      new Response(JSON.stringify({ approved: true }), { status: 200 })
    )
    const env = makeEnv(workerFetch)
    const c = ctx()

    await executeCodeNode(node({ worker_name: 'validate-lead' }), c, env)

    expect(workerFetch).toHaveBeenCalledOnce()
    const [url, init] = workerFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://worker/execute')
    expect(init.method).toBe('POST')

    const body = JSON.parse(init.body as string) as unknown
    expect(body).toMatchObject({
      payload: c.trigger.payload,
      steps: c.steps,
      env: c.env,
    })
  })

  it('returns the JSON output from the worker on success', async () => {
    const output = { credit_score: 720, approved: true }
    workerFetch.mockResolvedValue(new Response(JSON.stringify(output), { status: 200 }))
    const env = makeEnv(workerFetch)

    const result = await executeCodeNode(node({ worker_name: 'validate-lead' }), ctx(), env)
    expect(result.output).toEqual(output)
  })

  it('throws with status and body on non-OK worker response', async () => {
    workerFetch.mockResolvedValue(new Response('ReferenceError: x is not defined', { status: 500 }))
    const env = makeEnv(workerFetch)

    await expect(
      executeCodeNode(node({ worker_name: 'validate-lead' }), ctx(), env)
    ).rejects.toThrow(/HTTP 500/)
  })

  it('gets the correct worker from the dispatch namespace', async () => {
    workerFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const env = makeEnv(workerFetch)

    await executeCodeNode(node({ worker_name: 'my-worker' }), ctx(), env)

    const getCall = (env.DYNAMIC_WORKER_LOADER.get as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(getCall[0]).toBe('my-worker')
  })
})
