import { describe, it, expect } from 'vitest'
import {
  extractChains,
  normalizeRefSegments,
  chainToWatchedField,
  collectStructuredRefs,
  collectCodeRefs,
  deriveWatchedFields,
  deriveWatchedFieldMap,
} from '../watched-fields'
import type { WorkflowDefinition } from '../../types'

describe('extractChains', () => {
  it('finds a chain inside a template', () => {
    expect(extractChains('{{steps.x.output.final}}')).toEqual(['steps.x.output.final'])
  })
  it('finds both operands of a coalesce', () => {
    expect(extractChains('steps.a.output.v ?? steps.b.output.v')).toEqual([
      'steps.a.output.v',
      'steps.b.output.v',
    ])
  })
  it('finds the chain in an arithmetic expression and stops at the operator', () => {
    expect(extractChains('steps.x.output.amount * 0.65')).toEqual(['steps.x.output.amount'])
  })
  it('stops a chain at a bracket', () => {
    expect(extractChains('steps.x.output.list[0].field')).toEqual(['steps.x.output.list'])
  })
  it('handles optional chaining and $return_value', () => {
    expect(extractChains('steps.pennie_or_eligibility?.$return_value?.final')).toEqual([
      'steps.pennie_or_eligibility?.$return_value?.final',
    ])
  })
  it('does not match steps inside a larger identifier', () => {
    expect(extractChains('mysteps.x.y')).toEqual([])
  })
  it('matches a namespace-only reference', () => {
    expect(extractChains('{{steps.constants.$return_value}}')).toEqual([
      'steps.constants.$return_value',
    ])
  })
})

describe('normalizeRefSegments', () => {
  it('drops a leading output wrapper', () => {
    expect(normalizeRefSegments(['x', 'output', 'y'])).toEqual(['x', 'y'])
  })
  it('drops a leading $return_value wrapper', () => {
    expect(normalizeRefSegments(['x', '$return_value', 'y'])).toEqual(['x', 'y'])
  })
  it('leaves a plain path untouched', () => {
    expect(normalizeRefSegments(['x', 'y'])).toEqual(['x', 'y'])
  })
  it('keeps a namespace-only path', () => {
    expect(normalizeRefSegments(['x'])).toEqual(['x'])
  })
  it('keeps a namespace whose only segment is the wrapper', () => {
    expect(normalizeRefSegments(['x', '$return_value'])).toEqual(['x'])
  })
})

describe('chainToWatchedField', () => {
  it('normalizes the Scout chain', () => {
    expect(chainToWatchedField('steps.pennie_or_eligibility?.$return_value?.final')).toBe(
      'pennie_or_eligibility.final',
    )
  })
})

describe('collectStructuredRefs', () => {
  it('collects from nested objects and arrays', () => {
    const set = new Set<string>()
    collectStructuredRefs(
      { body: { a: '{{steps.x.output.final}}' }, list: ['steps.y.output.v'] },
      set,
    )
    expect([...set].sort()).toEqual(['x.final', 'y.v'])
  })
  it('skips a script-keyed string', () => {
    const set = new Set<string>()
    collectStructuredRefs({ script: 'steps.x.output.final', source: 'steps.y.output.v' }, set)
    expect([...set].sort()).toEqual(['y.v'])
  })
})

describe('collectCodeRefs', () => {
  it('captures the Scout field from a full literal path', () => {
    const set = new Set<string>()
    const { readable } = collectCodeRefs(
      'const debt = steps.pennie_or_eligibility?.$return_value?.final ?? null',
      set,
    )
    expect(readable).toBe(true)
    expect([...set]).toEqual(['pennie_or_eligibility.final'])
  })
  it('captures multiple fields across a script', () => {
    const set = new Set<string>()
    collectCodeRefs('const a = steps.x.$return_value.v; const b = steps.y.output.w', set)
    expect([...set].sort()).toEqual(['x.v', 'y.w'])
  })
  it('bails open on bracket access and adds nothing', () => {
    const set = new Set<string>()
    const { readable } = collectCodeRefs('const v = steps["foo"].bar', set)
    expect(readable).toBe(false)
    expect(set.size).toBe(0)
  })
  it('bails open on whole-object aliasing', () => {
    const set = new Set<string>()
    const { readable } = collectCodeRefs('const all = steps; return all.x.final', set)
    expect(readable).toBe(false)
    expect(set.size).toBe(0)
  })
})

function def(partial: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id: 'wf',
    name: 'wf',
    trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
    nodes: [],
    edges: [],
    ...partial,
  }
}

describe('deriveWatchedFields', () => {
  it('returns [] for the empty definition', () => {
    expect(deriveWatchedFields(def({}))).toEqual([])
  })

  it('collects structured refs from a node config and an edge condition', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'resp', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any,
      ],
      edges: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'steps.y.output.score', operator: 'gt', value: 600 }] }] },
        } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['x.final', 'y.score'])
  })

  it('scans a code node script and normalizes the Scout field (end to end)', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          id: 'n1',
          namespace: 'pennie_or_eligibility',
          type: 'code',
          config: { script: 'const debt = steps.pennie_or_eligibility?.$return_value?.final ?? null; return { final: debt }' },
        } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['pennie_or_eligibility.final'])
  })

  it('does not pick up structured refs from inside a script and bails the node open', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'c', type: 'code', config: { script: 'const all = steps; return all.x.final' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual([])
  })

  it('skips the script key in the structured walk even when the script bails open', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'c', type: 'code', config: { script: 'const all = steps; const d = steps.x.output.final' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual([])
  })

  it('dedups the same field reached via output and $return_value wrappers', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { a: 'steps.x.output.v', b: 'steps.x.$return_value.v' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['x.v'])
  })
})

describe('deriveWatchedFieldMap', () => {
  it('tags structured refs and code refs with their source', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script: 'const v = steps.y.output.v' } } as any,
      ],
    })
    const map = deriveWatchedFieldMap(d)
    expect(map.fields).toEqual([
      { path: 'x.final', source: 'structured' },
      { path: 'y.v', source: 'code' },
    ])
    expect(map.unreadableNodes).toEqual([])
  })

  it('records a code node that bails open as unreadable and contributes no code fields', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'dyn', type: 'code', config: { script: 'const all = steps; return all.x.final' } } as any,
      ],
    })
    const map = deriveWatchedFieldMap(d)
    expect(map.fields).toEqual([])
    expect(map.unreadableNodes).toEqual(['dyn'])
  })

  it('dedups a path reached both structurally and via code, structured wins', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.v}}' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script: 'const v = steps.x.output.v' } } as any,
      ],
    })
    const map = deriveWatchedFieldMap(d)
    expect(map.fields).toEqual([{ path: 'x.v', source: 'structured' }])
  })

  it('deriveWatchedFields still returns the same sorted path list', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script: 'const v = steps.y.output.v' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['x.final', 'y.v'])
  })
})

// Alias resolution (#435).
//
// Measured 2026-09-01 across all 10 active workflows: zero code nodes are
// dynamically unreadable, but 108 deep fields across 19 nodes are read only
// through a local, so they were never watched. That is the real blind spot, and
// most of it is resolvable rather than merely reportable: both the alias base
// and the field read are statically visible, so the field is watched rather
// than flagged (L272). What genuinely cannot be resolved is still reported, so
// the coverage manifest says "may be incomplete" instead of looking clean.
describe('alias resolution', () => {
  const codeNode = (script: string, namespace = 'c') =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def({ nodes: [{ id: 'n1', namespace, type: 'code', config: { script } } as any] })

  it('resolves a one-level alias into the full field path', () => {
    // The Scout shape: the field is never written as a full literal path.
    const d = codeNode('const r = steps.scout.$return_value; return r.final')
    expect(deriveWatchedFields(d)).toEqual(['scout', 'scout.final'])
  })

  it('resolves several reads through the same alias', () => {
    const d = codeNode('const b = steps.ping.data.data; return { s: b.status, a: b.bid_amount }')
    expect(deriveWatchedFields(d)).toEqual([
      'ping.data.data',
      'ping.data.data.bid_amount',
      'ping.data.data.status',
    ])
  })

  it('resolves an optional-chained read through an alias', () => {
    const d = codeNode('const w = steps.race.winner; return w?.bid')
    expect(deriveWatchedFields(d)).toEqual(['race.winner', 'race.winner.bid'])
  })

  it('does NOT watch a method call through an alias', () => {
    // `name.trim()` is a call, not a field. Watching it would invent a field
    // that can never resolve, and the day-one-dead check would then page about
    // a field that does not exist.
    const d = codeNode('const name = steps.parse.firstName; return name.trim()')
    expect(deriveWatchedFields(d)).toEqual(['parse.firstName'])
  })

  it('does NOT resolve an alias that is reassigned', () => {
    // After a reassignment the local no longer stands for the same path, so
    // resolving it would attribute reads to the wrong field.
    const d = codeNode('let r = steps.a.x; r = somethingElse; return r.final')
    const fields = deriveWatchedFields(d)
    expect(fields).toContain('a.x')
    expect(fields).not.toContain('a.x.final')
  })

  it('reports an unresolvable alias so the coverage view can flag the node', () => {
    const d = codeNode('let r = steps.a.x; r = somethingElse; return r.final', 'build_response')
    expect(deriveWatchedFieldMap(d).aliasOnlyNodes).toEqual(['build_response'])
  })

  it('reports no alias gap for a node whose aliases all resolved', () => {
    const d = codeNode('const r = steps.scout.$return_value; return r.final')
    expect(deriveWatchedFieldMap(d).aliasOnlyNodes).toEqual([])
  })

  it('still bails the whole node open on dynamic access, resolving nothing', () => {
    const d = codeNode('const k = key; const r = steps[k]; return r.final')
    expect(deriveWatchedFields(d)).toEqual([])
    expect(deriveWatchedFieldMap(d).unreadableNodes).toEqual(['c'])
  })

  it('marks an alias-resolved field as code-sourced', () => {
    const d = codeNode('const r = steps.scout.$return_value; return r.final')
    const map = deriveWatchedFieldMap(d)
    expect(map.fields.find((f) => f.path === 'scout.final')?.source).toBe('code')
  })
})
