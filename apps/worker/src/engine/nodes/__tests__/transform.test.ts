/**
 * Transform node — PRD Section 5.7
 * Tests: field rename, nested extraction, static literals, arithmetic expressions,
 * array indexing, array [*] map, dot-path targets, empty mappings, missing sources
 *
 * Path convention: steps.{namespace}.{field} — matches graph.ts / context.ts.
 * The resolver dereferences step.output before walking the remaining path segments,
 * so 'output' is NOT part of the path (i.e. use steps.ns.score, not steps.ns.output.score).
 */
import { describe, it, expect } from 'vitest'
import { executeTransformNode, resolveSource, setNestedPath } from '../transform'
import type { NodeDefinition, ExecutionContext } from '../../../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(mappings: Array<{ source: string; target: string }>): NodeDefinition {
  return {
    id: 'tx_1',
    namespace: 'normalize',
    type: 'transform',
    config: { mappings },
  }
}

function makeCtx(steps: Record<string, unknown> = {}, payload: unknown = {}): ExecutionContext {
  const stepMap: ExecutionContext['steps'] = {}
  for (const [ns, output] of Object.entries(steps)) {
    stepMap[ns] = { output, status: 'completed' }
  }
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf-1', trace_id: 'tr-1' },
    steps: stepMap,
    env: { API_VERSION: 'v2' },
  } as unknown as ExecutionContext
}

// ── executeTransformNode ──────────────────────────────────────────────────────

describe('executeTransformNode', () => {
  it('renames a field from a prior step', () => {
    const ctx = makeCtx({ equifax: { score: 720, tradelines: [] } })
    const node = makeNode([{ source: 'steps.equifax.score', target: 'credit_score' }])
    const { output } = executeTransformNode(node, ctx)
    expect(output).toEqual({ credit_score: 720 })
  })

  it('produces only mapped fields — other fields are dropped', () => {
    const ctx = makeCtx({ lead: { first_name: 'Alice', last_name: 'Smith', ssn: '***' } })
    const node = makeNode([
      { source: 'steps.lead.first_name', target: 'first_name' },
      { source: 'steps.lead.last_name', target: 'last_name' },
    ])
    const { output } = executeTransformNode(node, ctx)
    expect(output).toEqual({ first_name: 'Alice', last_name: 'Smith' })
    expect((output as Record<string, unknown>).ssn).toBeUndefined()
  })

  it('creates nested output from dot-path target', () => {
    const ctx = makeCtx({ lead: { first_name: 'Bob' } })
    const node = makeNode([{ source: 'steps.lead.first_name', target: 'applicant.name' }])
    const { output } = executeTransformNode(node, ctx)
    expect(output).toEqual({ applicant: { name: 'Bob' } })
  })

  it('injects static double-quoted string literal', () => {
    const ctx = makeCtx()
    const node = makeNode([{ source: '"pending"', target: 'status' }])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).status).toBe('pending')
  })

  it('injects static number literal', () => {
    const ctx = makeCtx()
    const node = makeNode([{ source: '42', target: 'version' }])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).version).toBe(42)
  })

  it('injects static boolean literals', () => {
    const ctx = makeCtx()
    const node = makeNode([
      { source: 'true', target: 'active' },
      { source: 'false', target: 'deleted' },
    ])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).active).toBe(true)
    expect((output as Record<string, unknown>).deleted).toBe(false)
  })

  it('applies arithmetic expression against step output', () => {
    const ctx = makeCtx({ bid: { amount: 1000 } })
    const node = makeNode([{ source: 'steps.bid.amount * 0.85', target: 'adjusted_bid' }])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).adjusted_bid).toBeCloseTo(850)
  })

  it('maps [*] array to extract a field from each element', () => {
    const ctx = makeCtx({ credit: { tradelines: [{ balance: 500 }, { balance: 1200 }, { balance: 300 }] } })
    const node = makeNode([
      { source: 'steps.credit.tradelines[*].balance', target: 'balances' },
    ])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).balances).toEqual([500, 1200, 300])
  })

  it('accesses array element by index', () => {
    const ctx = makeCtx({ data: { items: ['a', 'b', 'c'] } })
    const node = makeNode([{ source: 'steps.data.items[1]', target: 'second' }])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).second).toBe('b')
  })

  it('reads from trigger payload', () => {
    const ctx = makeCtx({}, { applicant: { firstName: 'Carol' } })
    const node = makeNode([{ source: 'trigger.payload.applicant.firstName', target: 'first_name' }])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).first_name).toBe('Carol')
  })

  it('reads from env vars', () => {
    const ctx = makeCtx()
    const node = makeNode([{ source: 'env.API_VERSION', target: 'api_version' }])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).api_version).toBe('v2')
  })

  it('sets undefined for a missing source path', () => {
    const ctx = makeCtx({ step: {} })
    const node = makeNode([{ source: 'steps.step.nonexistent', target: 'x' }])
    const { output } = executeTransformNode(node, ctx)
    expect((output as Record<string, unknown>).x).toBeUndefined()
  })

  it('returns empty object when mappings is empty', () => {
    const ctx = makeCtx()
    const node = makeNode([])
    const { output } = executeTransformNode(node, ctx)
    expect(output).toEqual({})
  })

  it('skips rows with empty source or target', () => {
    const ctx = makeCtx({ s: { v: 1 } })
    const node = makeNode([
      { source: '', target: 'a' },
      { source: 'steps.s.v', target: '' },
      { source: 'steps.s.v', target: 'good' },
    ])
    const { output } = executeTransformNode(node, ctx)
    expect(output).toEqual({ good: 1 })
  })
})

// ── resolveSource unit tests ──────────────────────────────────────────────────

describe('resolveSource', () => {
  const ctx = makeCtx(
    { step: { nested: { value: 99, list: [10, 20, 30] } } },
    { amount: 500 }
  )

  it('resolves double-quoted string literal', () => {
    expect(resolveSource('"hello"', ctx)).toBe('hello')
  })

  it('resolves single-quoted string literal', () => {
    expect(resolveSource("'world'", ctx)).toBe('world')
  })

  it('resolves integer literal', () => {
    expect(resolveSource('0', ctx)).toBe(0)
    expect(resolveSource('100', ctx)).toBe(100)
  })

  it('resolves float literal', () => {
    expect(resolveSource('3.14', ctx)).toBeCloseTo(3.14)
  })

  it('resolves negative number literal', () => {
    expect(resolveSource('-5', ctx)).toBe(-5)
  })

  it('resolves null literal', () => {
    expect(resolveSource('null', ctx)).toBeNull()
  })

  it('resolves nested step path', () => {
    expect(resolveSource('steps.step.nested.value', ctx)).toBe(99)
  })

  it('resolves array index', () => {
    expect(resolveSource('steps.step.nested.list[2]', ctx)).toBe(30)
  })

  it('returns undefined for missing path', () => {
    expect(resolveSource('steps.step.nope', ctx)).toBeUndefined()
  })

  it('returns undefined for unknown step', () => {
    expect(resolveSource('steps.unknown.x', ctx)).toBeUndefined()
  })
})

// ── setNestedPath unit tests ──────────────────────────────────────────────────

describe('setNestedPath', () => {
  it('sets a top-level key', () => {
    const obj: Record<string, unknown> = {}
    setNestedPath(obj, 'foo', 42)
    expect(obj).toEqual({ foo: 42 })
  })

  it('sets a nested key', () => {
    const obj: Record<string, unknown> = {}
    setNestedPath(obj, 'a.b.c', 'deep')
    expect(obj).toEqual({ a: { b: { c: 'deep' } } })
  })

  it('merges with existing siblings', () => {
    const obj: Record<string, unknown> = { a: { x: 1 } }
    setNestedPath(obj, 'a.y', 2)
    expect(obj).toEqual({ a: { x: 1, y: 2 } })
  })

  it('overwrites non-object intermediate values', () => {
    const obj: Record<string, unknown> = { a: 'not-object' }
    setNestedPath(obj, 'a.b', 'v')
    expect((obj.a as Record<string, unknown>).b).toBe('v')
  })

  it('ignores empty path gracefully', () => {
    const obj: Record<string, unknown> = {}
    setNestedPath(obj, '', 'x')
    expect(obj).toEqual({})
  })
})
