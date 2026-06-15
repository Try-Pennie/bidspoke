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

  // #93: a branch arm whose condition has no actual conditions must not match
  // every lead. An unconfigured arm edge has a condition object with empty
  // groups (or an empty conditions list) — both must fail closed.
  it('blocks traversal for an empty groups array (unconfigured arm)', () => {
    expect(evaluateEdge(edge({ groups: [], logic: 'AND' }), ctx({ anything: 1 }))).toBe(false)
  })

  it('blocks traversal for a group with no conditions (cleared rule builder)', () => {
    const e = edge({ groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' })
    expect(evaluateEdge(e, ctx({ anything: 1 }))).toBe(false)
  })
})

describe('evaluateConditionGroups — empty fails closed (#93)', () => {
  it('returns false for no groups under AND (was true: AND-of-nothing)', () => {
    expect(evaluateConditionGroups([], 'AND', ctx())).toBe(false)
  })

  it('returns false for no groups under OR', () => {
    expect(evaluateConditionGroups([], 'OR', ctx())).toBe(false)
  })

  it('returns false for a single group with no conditions', () => {
    expect(evaluateConditionGroups([{ conditions: [], logic: 'AND' }], 'AND', ctx())).toBe(false)
  })
})

// #93 follow-up: a half-built rule (one real part + one blank part) should
// evaluate on its real parts only — the blank part is ignored, not treated as a
// match that forces (OR) or breaks (AND) the whole rule.
describe('evaluateConditionGroups — unconfigured parts ignored (#93 follow-up)', () => {
  const realGroup: ConditionGroup = {
    conditions: [{ field: 'trigger.payload.score', operator: 'gt', value: '700' }],
    logic: 'AND',
  }
  const emptyGroup: ConditionGroup = { conditions: [], logic: 'AND' }
  const blankRowGroup: ConditionGroup = {
    conditions: [{ field: '', operator: 'eq', value: '' }],
    logic: 'AND',
  }

  it('AND: a blank group is dropped, so the rule equals its one real group', () => {
    const groups = [realGroup, emptyGroup]
    expect(evaluateConditionGroups(groups, 'AND', ctx({ score: 750 }))).toBe(true)
    expect(evaluateConditionGroups(groups, 'AND', ctx({ score: 600 }))).toBe(false)
  })

  it('OR: a blank group does not force the rule true', () => {
    const groups = [realGroup, emptyGroup]
    expect(evaluateConditionGroups(groups, 'OR', ctx({ score: 600 }))).toBe(false)
    expect(evaluateConditionGroups(groups, 'OR', ctx({ score: 750 }))).toBe(true)
  })

  it('a blank condition row inside a group is dropped (AND)', () => {
    const groups: ConditionGroup[] = [{
      conditions: [
        { field: 'trigger.payload.score', operator: 'gt', value: '700' },
        { field: '', operator: 'eq', value: '' },
      ],
      logic: 'AND',
    }]
    expect(evaluateConditionGroups(groups, 'AND', ctx({ score: 750 }))).toBe(true)
    expect(evaluateConditionGroups(groups, 'AND', ctx({ score: 600 }))).toBe(false)
  })

  it('when every group is unconfigured (empty + blank row) it still fails closed', () => {
    expect(evaluateConditionGroups([emptyGroup, blankRowGroup], 'AND', ctx({ score: 750 }))).toBe(false)
    expect(evaluateConditionGroups([emptyGroup, blankRowGroup], 'OR', ctx({ score: 750 }))).toBe(false)
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
    it('throws so a missing engine case surfaces immediately instead of every condition silently evaluating false', () => {
      // Cast needed — runtime guard for values outside the known union
      expect(() => single('trigger.payload.x', 'unknown_op' as EdgeCondition['operator'], 1, { x: 1 }))
        .toThrow(/Unknown condition operator/)
    })
  })
})

// --- String-typed config values (rule-builder reality) ---
// The rule builder stores every condition value as a STRING ("0", "10",
// "true"), while the resolved field keeps its real type (number, boolean). These
// guard the coercion that production depends on — without it, `mutate_bes.output
// (number 0) != "0"` wrongly fired its arm.

describe('evaluateConditionGroups — string config vs typed field', () => {
  function single(field: string, operator: EdgeCondition['operator'], value: unknown, payload: unknown): boolean {
    return evaluateConditionGroups([{ conditions: [{ field, operator, value }], logic: 'AND' }], 'AND', ctx(payload))
  }

  describe('eq / neq across number↔string', () => {
    it('eq: number 0 matches "0"', () => expect(single('trigger.payload.x', 'eq', '0', { x: 0 })).toBe(true))
    it('neq: number 0 does NOT differ from "0" (the reported bug)', () =>
      expect(single('trigger.payload.x', 'neq', '0', { x: 0 })).toBe(false))
    it('neq: number 1 differs from "0"', () => expect(single('trigger.payload.x', 'neq', '0', { x: 1 })).toBe(true))
    it('eq: number 9999 matches "9999"', () => expect(single('trigger.payload.x', 'eq', '9999', { x: 9999 })).toBe(true))
    it('eq: boolean true matches "true"', () => expect(single('trigger.payload.b', 'eq', 'true', { b: true })).toBe(true))
    it('neq: boolean false differs from "true"', () => expect(single('trigger.payload.b', 'neq', 'true', { b: false })).toBe(true))
    it('eq: null does not match "0"', () => expect(single('trigger.payload.x', 'eq', '0', { x: null })).toBe(false))
  })

  describe('gt / lt are numeric, not lexicographic', () => {
    it('gt: numeric-string "9" is NOT > "10" (lexicographic would say true)', () =>
      expect(single('trigger.payload.n', 'gt', '10', { n: '9' })).toBe(false))
    it('lt: numeric-string "9" < "10"', () => expect(single('trigger.payload.n', 'lt', '10', { n: '9' })).toBe(true))
    it('gte: number 720 >= "720"', () => expect(single('trigger.payload.n', 'gte', '720', { n: 720 })).toBe(true))
    it('gt: number 11 > "10"', () => expect(single('trigger.payload.n', 'gt', '10', { n: 11 })).toBe(true))
    it('gt: non-numeric field is false, not a throw', () =>
      expect(single('trigger.payload.n', 'gt', '10', { n: 'abc' })).toBe(false))
  })

  describe('in_array / not_in_array coerce element types', () => {
    it('in_array: number 1 is in ["1","2"]', () =>
      expect(single('trigger.payload.x', 'in_array', ['1', '2'], { x: 1 })).toBe(true))
    it('in_array: string "1" is in [1,2]', () =>
      expect(single('trigger.payload.x', 'in_array', [1, 2], { x: '1' })).toBe(true))
    it('not_in_array: number 3 is not in ["1","2"]', () =>
      expect(single('trigger.payload.x', 'not_in_array', ['1', '2'], { x: 3 })).toBe(true))
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

// --- resolveField — tolerate explicit .output in step paths ---

describe('resolveField — .output tolerance', () => {
  function single(field: string, operator: EdgeCondition['operator'], value: unknown, steps: Record<string, unknown>): boolean {
    return evaluateConditionGroups(
      [{ conditions: [{ field, operator, value }], logic: 'AND' }],
      'AND',
      ctx({}, steps)
    )
  }

  it('resolves steps.X.Y (no .output)', () => {
    expect(single('steps.foo.name', 'eq', 'bar', { foo: { name: 'bar' } })).toBe(true)
  })

  it('resolves steps.X.output.Y (explicit .output — copy-path format)', () => {
    expect(single('steps.foo.output.name', 'eq', 'bar', { foo: { name: 'bar' } })).toBe(true)
  })

  it('steps.X and steps.X.output resolve identically', () => {
    expect(single('steps.foo', 'eq', 42, { foo: 42 })).toBe(true)
    expect(single('steps.foo.output', 'eq', 42, { foo: 42 })).toBe(true)
  })
})

// --- missing operator defaults to equality (matches the config UI default,
// which shows 'equals' but historically didn't persist it) ---

describe('condition with no operator defaults to eq', () => {
  function single(field: string, value: unknown, steps: Record<string, unknown>): boolean {
    return evaluateConditionGroups(
      // operator intentionally omitted — mirrors a saved filter config where the
      // user never touched the operator dropdown.
      [{ conditions: [{ field, value } as unknown as EdgeCondition], logic: 'AND' }],
      'AND',
      ctx({}, steps)
    )
  }

  it('behaves as equals instead of throwing', () => {
    expect(single('steps.foo.output.x', 0, { foo: { x: 0 } })).toBe(true)
    expect(single('steps.foo.output.x', 0, { foo: { x: 5 } })).toBe(false)
  })
})

// --- ?? coalesce in a condition field — reads whichever of two steps ran ---

describe('condition field ?? coalesce', () => {
  function isFalse(field: string, steps: Record<string, unknown>): boolean {
    return evaluateConditionGroups(
      [{ conditions: [{ field, operator: 'is_false' }], logic: 'AND' }],
      'AND',
      ctx({}, steps)
    )
  }
  it('falls back to the second step and keeps a real false', () => {
    // only the fallback ran, ok=false → is_false true (false is kept, not skipped)
    expect(isFalse('steps.a.output.ok ?? steps.b.output.ok', { b: { ok: false } })).toBe(true)
    // first ran, ok=true → is_false false
    expect(isFalse('steps.a.output.ok ?? steps.b.output.ok', { a: { ok: true } })).toBe(false)
  })
})
