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

/**
 * #1118. On 2026-09-03 the day-one-dead check paged seven times, and five of the
 * seven were fields nothing reads. The watched set is derived by running the
 * chain extractor over raw text, so it harvested paths out of places that never
 * execute. Each mechanism below is measured from the live workflows, and each
 * phantom was reported as "never resolves" on hundreds of thousands of runs.
 *
 * The direction of risk is asymmetric and decides every choice here: an
 * unwatched field is SILENT, which this module calls the dangerous direction, so
 * each test that removes a phantom is paired with one asserting a real reference
 * of the same shape survives. Without that pairing, a fix that watched nothing
 * at all would pass every removal test.
 */
describe('watched fields are not harvested from comments (#1118)', () => {
  const codeNode = (script: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def({ nodes: [{ id: 'n1', namespace: 'c', type: 'code', config: { script } } as any] })

  it('ignores a path in a line comment while watching the real read below it', () => {
    // The exact pair from Engine Bidding's Generate Trades Body. The comment is
    // a migration note recording a translation that was already done; the real
    // code uses .output.body.id, and `create_prospect.id` reported 0/481,959.
    const d = codeNode(
      '// Translates: steps.create_prospect.$return_value.id -> steps.create_prospect.output.body.id\n' +
        'const prospectId = steps.create_prospect.output.body.id;\n',
    )
    expect(deriveWatchedFields(d)).toEqual(['create_prospect.body.id'])
  })

  it('ignores a path in a block comment', () => {
    const d = codeNode('/*\n steps.old.gone\n*/\nconst v = steps.live.here;\n')
    expect(deriveWatchedFields(d)).toEqual(['live.here'])
  })

  it('still watches a reference inside a template literal', () => {
    // Build Response Body:90 really does read the prospect id this way, so a
    // stripper that blanked string contents would unwatch a money-path field.
    const d = codeNode('const c = `${base}/${steps.create_prospect.output.body.id}`;\n')
    expect(deriveWatchedFields(d)).toEqual(['create_prospect.body.id'])
  })

  it('does not treat a double slash inside a string as starting a comment', () => {
    const d = codeNode("const u = 'https://x/y'; const v = steps.live.here;\n")
    expect(deriveWatchedFields(d)).toEqual(['live.here'])
  })

  it('does not treat a regex literal as a comment', () => {
    const d = codeNode('const re = /https?:\\/\\//; const v = steps.live.here;\n')
    expect(deriveWatchedFields(d)).toEqual(['live.here'])
  })
})

describe('watched fields are not harvested from free-text node keys (#1118)', () => {
  it('ignores a path in a node note while watching one in its config', () => {
    // Main Flow's Mutate BES carries a `note` describing a port that was
    // considered and not done. `mutate_bes.value` reported 0/25,198 from it.
    const d = def({
      nodes: [
        {
          id: 'n1',
          namespace: 'send',
          type: 'webhook',
          note: 'downstream would need to be ported as steps.mutate_bes.output.value',
          config: { body: '{{steps.mutate_bes.output}}' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toEqual(['mutate_bes'])
  })
})

describe('an alias does not invent a field from its own declaration (#1118)', () => {
  const codeNode = (script: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def({ nodes: [{ id: 'n1', namespace: 'c', type: 'code', config: { script } } as any] })

  it('does not read the declaration itself as a field access', () => {
    // Lead Economy's Patch Prospect body. `response.body` appears inside the
    // line that declares `response`, so the resolver invented a second `.body`
    // and reported it 0/4,789 while the real path ran at 21,849/21,850.
    const d = codeNode('const response = steps.return_response.output.response.body;\nreturn response.reason;\n')
    expect(deriveWatchedFields(d)).toEqual([
      'return_response.response.body',
      'return_response.response.body.reason',
    ])
  })

  it('handles the optional-chained shape too', () => {
    // Main Flow's Calculate Pull Result No Debt, which invented
    // ...equifaxUSConsumerCreditReport.code the same way.
    // The bracket is load-bearing: it ENDS the literal chain at `consumers`, so
    // what follows is only reachable through the alias. Without it the whole
    // path is one literal chain and there is no phantom to reproduce.
    const d = codeNode('const hitCode = steps.eq.output.report?.consumers?.[0]?.hitCode?.code;\nreturn hitCode;\n')
    expect(deriveWatchedFields(d)).toEqual(['eq.report.consumers'])
  })

  it('still resolves reads that genuinely go through the alias', () => {
    // The pairing that stops a fix passing by resolving nothing at all.
    const d = codeNode('const response = steps.r.output.response.body;\nreturn { a: response.reason, b: response.offers };\n')
    expect(deriveWatchedFields(d)).toEqual([
      'r.response.body',
      'r.response.body.offers',
      'r.response.body.reason',
    ])
  })
})
