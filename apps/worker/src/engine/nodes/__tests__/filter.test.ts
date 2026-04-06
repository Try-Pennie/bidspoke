import { describe, it, expect } from 'vitest'
import { executeFilterNode } from '../filter'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(payload: unknown = {}, steps: Record<string, unknown> = {}, env: Record<string, string> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf', trace_id: 'trace' },
    steps: Object.fromEntries(
      Object.entries(steps).map(([k, v]) => [k, { output: v, status: 'completed' as const }])
    ),
    env,
  }
}

function node(config: NodeDefinition['config']): NodeDefinition {
  return { id: 'n1', namespace: 'filter_step', type: 'filter', config }
}

describe('executeFilterNode', () => {
  describe('no rules configured', () => {
    it('passes with no rules', () => {
      const result = executeFilterNode(node({}), ctx())
      expect(result.output).toEqual({ passed: true, _route: 'pass' })
    })

    it('passes with empty groups array', () => {
      const result = executeFilterNode(node({ rules: { groups: [], logic: 'AND' } }), ctx())
      expect(result.output).toEqual({ passed: true, _route: 'pass' })
    })
  })

  describe('single condition group', () => {
    it('passes when condition matches (eq)', () => {
      const result = executeFilterNode(
        node({
          rules: {
            groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 600 }], logic: 'AND' }],
            logic: 'AND',
          },
        }),
        ctx({ score: 700 })
      )
      expect(result.output).toEqual({ passed: true, _route: 'pass' })
    })

    it('exits when condition does not match', () => {
      const result = executeFilterNode(
        node({
          rules: {
            groups: [{ conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 600 }], logic: 'AND' }],
            logic: 'AND',
          },
        }),
        ctx({ score: 500 })
      )
      expect(result.output).toEqual({ passed: false, _route: 'exit' })
    })
  })

  describe('AND group logic', () => {
    const rules = {
      groups: [{
        conditions: [
          { field: 'trigger.payload.age', operator: 'gte' as const, value: 18 },
          { field: 'trigger.payload.score', operator: 'gte' as const, value: 600 },
        ],
        logic: 'AND' as const,
      }],
      logic: 'AND' as const,
    }

    it('passes when all conditions true', () => {
      const result = executeFilterNode(node({ rules }), ctx({ age: 25, score: 700 }))
      expect((result.output as { passed: boolean }).passed).toBe(true)
    })

    it('exits when one condition is false', () => {
      const result = executeFilterNode(node({ rules }), ctx({ age: 25, score: 500 }))
      expect((result.output as { passed: boolean }).passed).toBe(false)
    })

    it('exits when all conditions are false', () => {
      const result = executeFilterNode(node({ rules }), ctx({ age: 16, score: 500 }))
      expect((result.output as { passed: boolean }).passed).toBe(false)
    })
  })

  describe('OR group logic', () => {
    const rules = {
      groups: [{
        conditions: [
          { field: 'trigger.payload.vip', operator: 'eq' as const, value: true },
          { field: 'trigger.payload.score', operator: 'gte' as const, value: 750 },
        ],
        logic: 'OR' as const,
      }],
      logic: 'AND' as const,
    }

    it('passes when one condition is true', () => {
      const result = executeFilterNode(node({ rules }), ctx({ vip: false, score: 800 }))
      expect((result.output as { passed: boolean }).passed).toBe(true)
    })

    it('passes when both conditions are true', () => {
      const result = executeFilterNode(node({ rules }), ctx({ vip: true, score: 800 }))
      expect((result.output as { passed: boolean }).passed).toBe(true)
    })

    it('exits when all conditions are false', () => {
      const result = executeFilterNode(node({ rules }), ctx({ vip: false, score: 600 }))
      expect((result.output as { passed: boolean }).passed).toBe(false)
    })
  })

  describe('multiple groups', () => {
    it('passes only when all groups pass (group-level AND)', () => {
      const rules = {
        groups: [
          { conditions: [{ field: 'trigger.payload.age', operator: 'gte' as const, value: 18 }], logic: 'AND' as const },
          { conditions: [{ field: 'trigger.payload.score', operator: 'gte' as const, value: 600 }], logic: 'AND' as const },
        ],
        logic: 'AND' as const,
      }
      expect((executeFilterNode(node({ rules }), ctx({ age: 25, score: 700 })).output as { passed: boolean }).passed).toBe(true)
      expect((executeFilterNode(node({ rules }), ctx({ age: 25, score: 400 })).output as { passed: boolean }).passed).toBe(false)
    })

    it('passes when any group passes (group-level OR)', () => {
      const rules = {
        groups: [
          { conditions: [{ field: 'trigger.payload.vip', operator: 'eq' as const, value: true }], logic: 'AND' as const },
          { conditions: [{ field: 'trigger.payload.score', operator: 'gte' as const, value: 750 }], logic: 'AND' as const },
        ],
        logic: 'OR' as const,
      }
      expect((executeFilterNode(node({ rules }), ctx({ vip: false, score: 800 })).output as { passed: boolean }).passed).toBe(true)
      expect((executeFilterNode(node({ rules }), ctx({ vip: false, score: 400 })).output as { passed: boolean }).passed).toBe(false)
    })
  })

  describe('field sources', () => {
    it('resolves trigger.payload fields', () => {
      const result = executeFilterNode(
        node({ rules: { groups: [{ conditions: [{ field: 'trigger.payload.x', operator: 'eq', value: 42 }], logic: 'AND' }], logic: 'AND' } }),
        ctx({ x: 42 })
      )
      expect((result.output as { passed: boolean }).passed).toBe(true)
    })

    it('resolves steps.* output fields', () => {
      const result = executeFilterNode(
        node({ rules: { groups: [{ conditions: [{ field: 'steps.prev.status', operator: 'eq', value: 'ok' }], logic: 'AND' }], logic: 'AND' } }),
        ctx({}, { prev: { status: 'ok' } })
      )
      expect((result.output as { passed: boolean }).passed).toBe(true)
    })

    it('resolves env fields', () => {
      const result = executeFilterNode(
        node({ rules: { groups: [{ conditions: [{ field: 'env.ENABLED', operator: 'eq', value: 'true' }], logic: 'AND' }], logic: 'AND' } }),
        ctx({}, {}, { ENABLED: 'true' })
      )
      expect((result.output as { passed: boolean }).passed).toBe(true)
    })
  })
})
