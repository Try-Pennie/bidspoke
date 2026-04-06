import { describe, it, expect } from 'vitest'
import { executeBranchNode } from '../branch'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(payload: unknown = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf', trace_id: 'trace' },
    steps: {},
    env: {},
  }
}

function node(branches: NodeDefinition['config']['branches']): NodeDefinition {
  return { id: 'n1', namespace: 'branch_step', type: 'branch', config: { branches } }
}

describe('executeBranchNode', () => {
  it('falls through to else with no branches configured', () => {
    const result = executeBranchNode(node(undefined), ctx())
    expect(result.output).toEqual({ matched_branch: null, _route: 'else' })
  })

  it('falls through to else with empty branches array', () => {
    const result = executeBranchNode(node([]), ctx())
    expect(result.output).toEqual({ matched_branch: null, _route: 'else' })
  })

  it('routes to the first matching branch', () => {
    const result = executeBranchNode(
      node([
        { label: 'high', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 700 }], logic: 'AND' }], logic: 'AND' } },
        { label: 'medium', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 500 }], logic: 'AND' }], logic: 'AND' } },
      ]),
      ctx({ score: 750 })
    )
    expect(result.output).toEqual({ matched_branch: 'high', _route: 'high' })
  })

  it('evaluates branches in order — skips non-matching, routes to first match', () => {
    const result = executeBranchNode(
      node([
        { label: 'high', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 700 }], logic: 'AND' }], logic: 'AND' } },
        { label: 'medium', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 500 }], logic: 'AND' }], logic: 'AND' } },
        { label: 'low', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 300 }], logic: 'AND' }], logic: 'AND' } },
      ]),
      ctx({ score: 600 })
    )
    expect(result.output).toEqual({ matched_branch: 'medium', _route: 'medium' })
  })

  it('falls through to else when no branch matches', () => {
    const result = executeBranchNode(
      node([
        { label: 'high', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 700 }], logic: 'AND' }], logic: 'AND' } },
        { label: 'medium', condition: { groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 500 }], logic: 'AND' }], logic: 'AND' } },
      ]),
      ctx({ score: 200 })
    )
    expect(result.output).toEqual({ matched_branch: null, _route: 'else' })
  })

  it('uses OR group logic within a branch condition', () => {
    const result = executeBranchNode(
      node([{
        label: 'qualified',
        condition: {
          groups: [{
            conditions: [
              { field: 'trigger.payload.vip', operator: 'eq', value: true },
              { field: 'trigger.payload.score', operator: 'gte', value: 750 },
            ],
            logic: 'OR',
          }],
          logic: 'AND',
        },
      }]),
      ctx({ vip: false, score: 800 })
    )
    expect((result.output as { matched_branch: string })?.matched_branch).toBe('qualified')
  })

  it('stops at first matching branch — does not evaluate later branches', () => {
    // Both would match, but only first should be reported
    const result = executeBranchNode(
      node([
        { label: 'first', condition: { groups: [{ conditions: [{ field: 'trigger.payload.x', operator: 'eq', value: 1 }], logic: 'AND' }], logic: 'AND' } },
        { label: 'second', condition: { groups: [{ conditions: [{ field: 'trigger.payload.x', operator: 'eq', value: 1 }], logic: 'AND' }], logic: 'AND' } },
      ]),
      ctx({ x: 1 })
    )
    expect((result.output as { matched_branch: string }).matched_branch).toBe('first')
  })
})
