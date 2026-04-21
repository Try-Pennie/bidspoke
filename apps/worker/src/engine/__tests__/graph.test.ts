import { describe, it, expect } from 'vitest'
import { evaluateEdge, evaluateConditionGroups } from '../graph'
import { executeNode } from '../nodes/index'
import type { ExecutionContext, EdgeDefinition, NodeDefinition, EdgeCondition, ConditionGroup } from '../../types'
import type { Env } from '../../index'

// --- Context helpers ---

function ctx(payload: unknown = {}, steps: Record<string, unknown> = {}, env: Record<string, string> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 'trace' },
    steps: Object.fromEntries(
      Object.entries(steps).map(([k, v]) => [k, { output: v, status: 'completed' as const }])
    ),
    env,
  }
}

function edge(condition?: EdgeDefinition['condition']): EdgeDefinition {
  return { id: 'e1', source: 'n1', target: 'n2', condition }
}

// --- evaluateEdge ---

describe('evaluateEdge', () => {
  it('allows traversal when no condition is set', () => {
    expect(evaluateEdge(edge(), ctx())).toBe(true)
  })

  it('allows traversal when condition evaluates to true', () => {
    const e = edge({
      groups: [{ conditions: [{ field: 'trigger.payload.approved', operator: 'eq', value: true }], logic: 'AND' }],
      logic: 'AND',
    })
    expect(evaluateEdge(e, ctx({ approved: true }))).toBe(true)
  })

  it('blocks traversal when condition evaluates to false', () => {
    const e = edge({
      groups: [{ conditions: [{ field: 'trigger.payload.approved', operator: 'eq', value: true }], logic: 'AND' }],
      logic: 'AND',
    })
    expect(evaluateEdge(e, ctx({ approved: false }))).toBe(false)
  })
})

// --- evaluateConditionGroups — all operators ---

describe('evaluateConditionGroups — all operators', () => {
  function single(field: string, operator: EdgeCondition['operator'], value?: unknown, payload: unknown = {}): boolean {
    return evaluateConditionGroups(
      [{ conditions: [{ field, operator, value }], logic: 'AND' }],
      'AND',
      ctx(payload)
    )
  }

  describe('eq', () => {
    it('true when values match', () => expect(single('trigger.payload.x', 'eq', 42, { x: 42 })).toBe(true))
    it('false when values differ', () => expect(single('trigger.payload.x', 'eq', 42, { x: 43 })).toBe(false))
    it('matches strings', () => expect(single('trigger.payload.s', 'eq', 'hello', { s: 'hello' })).toBe(true))
    it('matches booleans', () => expect(single('trigger.payload.b', 'eq', false, { b: false })).toBe(true))
  })

  describe('neq', () => {
    it('true when values differ', () => expect(single('trigger.payload.x', 'neq', 1, { x: 2 })).toBe(true))
    it('false when values match', () => expect(single('trigger.payload.x', 'neq', 1, { x: 1 })).toBe(false))
  })

  describe('gt', () => {
    it('true when actual > value', () => expect(single('trigger.payload.n', 'gt', 5, { n: 6 })).toBe(true))
    it('false when actual == value', () => expect(single('trigger.payload.n', 'gt', 5, { n: 5 })).toBe(false))
    it('false when actual < value', () => expect(single('trigger.payload.n', 'gt', 5, { n: 4 })).toBe(false))
  })

  describe('gte', () => {
    it('true when actual > value', () => expect(single('trigger.payload.n', 'gte', 5, { n: 6 })).toBe(true))
    it('true when actual == value', () => expect(single('trigger.payload.n', 'gte', 5, { n: 5 })).toBe(true))
    it('false when actual < value', () => expect(single('trigger.payload.n', 'gte', 5, { n: 4 })).toBe(false))
  })

  describe('lt', () => {
    it('true when actual < value', () => expect(single('trigger.payload.n', 'lt', 5, { n: 4 })).toBe(true))
    it('false when actual == value', () => expect(single('trigger.payload.n', 'lt', 5, { n: 5 })).toBe(false))
    it('false when actual > value', () => expect(single('trigger.payload.n', 'lt', 5, { n: 6 })).toBe(false))
  })

  describe('lte', () => {
    it('true when actual < value', () => expect(single('trigger.payload.n', 'lte', 5, { n: 4 })).toBe(true))
    it('true when actual == value', () => expect(single('trigger.payload.n', 'lte', 5, { n: 5 })).toBe(true))
    it('false when actual > value', () => expect(single('trigger.payload.n', 'lte', 5, { n: 6 })).toBe(false))
  })

  describe('contains', () => {
    it('true when string contains value', () => expect(single('trigger.payload.s', 'contains', 'ello', { s: 'hello' })).toBe(true))
    it('false when string does not contain value', () => expect(single('trigger.payload.s', 'contains', 'xyz', { s: 'hello' })).toBe(false))
  })

  describe('not_contains', () => {
    it('true when string does not contain value', () => expect(single('trigger.payload.s', 'not_contains', 'xyz', { s: 'hello' })).toBe(true))
    it('false when string contains value', () => expect(single('trigger.payload.s', 'not_contains', 'ell', { s: 'hello' })).toBe(false))
  })

  describe('exists', () => {
    it('true when field is present and non-null', () => expect(single('trigger.payload.x', 'exists', undefined, { x: 0 })).toBe(true))
    it('true when field value is false', () => expect(single('trigger.payload.x', 'exists', undefined, { x: false })).toBe(true))
    it('false when field is null', () => expect(single('trigger.payload.x', 'exists', undefined, { x: null })).toBe(false))
    it('false when field is missing', () => expect(single('trigger.payload.missing', 'exists', undefined, {})).toBe(false))
  })

  describe('not_exists', () => {
    it('true when field is missing', () => expect(single('trigger.payload.missing', 'not_exists', undefined, {})).toBe(true))
    it('true when field is null', () => expect(single('trigger.payload.x', 'not_exists', undefined, { x: null })).toBe(true))
    it('false when field has a value', () => expect(single('trigger.payload.x', 'not_exists', undefined, { x: 1 })).toBe(false))
  })

  describe('unknown operator', () => {
    it('returns false for unrecognized operators', () => {
      // Cast needed — runtime guard for values outside the known union
      expect(single('trigger.payload.x', 'unknown_op' as EdgeCondition['operator'], 1, { x: 1 })).toBe(false)
    })
  })
})

// --- Group + top-level logic combinations ---

describe('evaluateConditionGroups — group logic', () => {
  const c = ctx({ a: true, b: false, score: 700 })

  it('AND groups: all must pass', () => {
    const groups: ConditionGroup[] = [
      { conditions: [{ field: 'trigger.payload.a', operator: 'eq', value: true }], logic: 'AND' },
      { conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 600 }], logic: 'AND' },
    ]
    expect(evaluateConditionGroups(groups, 'AND', c)).toBe(true)
    // Make one group fail
    const groups2: ConditionGroup[] = [
      { conditions: [{ field: 'trigger.payload.b', operator: 'eq', value: true }], logic: 'AND' },
      { conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 600 }], logic: 'AND' },
    ]
    expect(evaluateConditionGroups(groups2, 'AND', c)).toBe(false)
  })

  it('OR groups: at least one must pass', () => {
    const groups: ConditionGroup[] = [
      { conditions: [{ field: 'trigger.payload.b', operator: 'eq', value: true }], logic: 'AND' }, // false
      { conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 600 }], logic: 'AND' }, // true
    ]
    expect(evaluateConditionGroups(groups, 'OR', c)).toBe(true)
    const groups2: ConditionGroup[] = [
      { conditions: [{ field: 'trigger.payload.b', operator: 'eq', value: true }], logic: 'AND' }, // false
      { conditions: [{ field: 'trigger.payload.score', operator: 'gte', value: 800 }], logic: 'AND' }, // false
    ]
    expect(evaluateConditionGroups(groups2, 'OR', c)).toBe(false)
  })
})

// --- Exit node (via executeNode) ---

describe('exit node', () => {
  const env = {} as Env

  it('returns config.response as output', async () => {
    const exitNode: NodeDefinition = {
      id: 'n1',
      namespace: 'exit_step',
      type: 'exit',
      config: { response: { reason: 'ineligible' } },
    }
    const result = await executeNode(exitNode, ctx(), env)
    expect(result.output).toEqual({ reason: 'ineligible' })
  })

  it('returns null when config.response is not set', async () => {
    const exitNode: NodeDefinition = {
      id: 'n1',
      namespace: 'exit_step',
      type: 'exit',
      config: {},
    }
    const result = await executeNode(exitNode, ctx(), env)
    expect(result.output).toBeNull()
  })
})
