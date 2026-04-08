import { describe, it, expect } from 'vitest'
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

const env = {} as Env

describe('executeCodeNode', () => {
  it('throws if script is not configured', async () => {
    await expect(executeCodeNode(node({}), ctx(), env)).rejects.toThrow(/no script configured/)
  })

  it('throws if script is empty string', async () => {
    await expect(executeCodeNode(node({ script: '   ' }), ctx(), env)).rejects.toThrow(/no script configured/)
  })

  it('executes inline script and returns its return value', async () => {
    const result = await executeCodeNode(node({ script: 'return { ok: true }' }), ctx(), env)
    expect(result.output).toEqual({ ok: true })
  })

  it('exposes payload, steps, and env to the script', async () => {
    const c = ctx()
    const result = await executeCodeNode(
      node({ script: 'return { leadId: payload.lead_id, score: steps.prev.output.score, key: env.API_KEY }' }),
      c,
      env
    )
    expect(result.output).toEqual({ leadId: 'lead-1', score: 720, key: 'secret' })
  })

  it('supports async scripts', async () => {
    const result = await executeCodeNode(
      node({ script: 'const v = await Promise.resolve(42); return { v }' }),
      ctx(),
      env
    )
    expect(result.output).toEqual({ v: 42 })
  })

  it('throws a syntax error message for invalid JS', async () => {
    await expect(
      executeCodeNode(node({ script: 'return {{{' }), ctx(), env)
    ).rejects.toThrow(/syntax error/)
  })

  it('propagates runtime errors thrown inside the script', async () => {
    await expect(
      executeCodeNode(node({ script: 'throw new Error("intentional")' }), ctx(), env)
    ).rejects.toThrow('intentional')
  })
})
