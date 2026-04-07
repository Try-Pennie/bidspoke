import { describe, it, expect } from 'vitest'
import { executeNode } from '../index'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf', trace_id: 'trace' },
    steps: {},
    env: {},
  }
}

function exitNode(config: NodeDefinition['config'] = {}): NodeDefinition {
  return { id: 'n1', namespace: 'exit_1', type: 'exit', config }
}

const env = {} as never

describe('exit node', () => {
  describe('output', () => {
    it('returns null output when no response config is set', async () => {
      const result = await executeNode(exitNode({}), ctx(), env)
      expect(result.output).toBeNull()
    })

    it('returns the response config as output', async () => {
      const response = { status: 422, body: { error: 'validation failed' } }
      const result = await executeNode(exitNode({ response }), ctx(), env)
      expect(result.output).toEqual(response)
    })

    it('returns a plain string response config', async () => {
      const result = await executeNode(exitNode({ response: 'early exit' }), ctx(), env)
      expect(result.output).toBe('early exit')
    })

    it('returns a numeric response config', async () => {
      const result = await executeNode(exitNode({ response: 0 }), ctx(), env)
      expect(result.output).toBe(0)
    })
  })

  describe('unimplemented Phase 2 node types', () => {
    const unimplemented: NodeDefinition['type'][] = [
      'parallel', 'partner_bid', 'integration', 'transform', 'bid_evaluation',
    ]

    for (const type of unimplemented) {
      it(`${type} node throws a not-implemented error`, async () => {
        const node: NodeDefinition = { id: 'n1', namespace: `${type}_1`, type, config: {} }
        await expect(executeNode(node, ctx(), env)).rejects.toThrow(/not yet implemented/i)
      })
    }
  })
})
