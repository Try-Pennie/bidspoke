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
      { path: 'x.final', source: 'structured', readers: ['r'], gate: ['r'] },
      { path: 'y.v', source: 'code', readers: ['c'], gate: null },
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
    // Structured wins the source, and both nodes are kept as its readers.
    expect(map.fields).toEqual([{ path: 'x.v', source: 'structured', readers: ['c', 'r'], gate: null }])
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

describe('a constant that its own config guarantees is not watched (#1147)', () => {
  // #435 (alias resolution) roughly doubled the watched set, from 17.5 to 34.0
  // keys per execution, and 1,430,834 of the 3,710,468 keys the rollup expanded
  // on 2026-09-03 were `constants.*`. A Constants node merges two sources: the
  // static `config.data` a person typed, and partner copy loaded from the
  // database. A key written in the node's own config carries a value on every
  // run by construction, so its presence measures nothing and only costs the
  // rollup a row per execution. The database-sourced half is the opposite: a
  // missing sell-off title is a real defect, so those stay watched.
  //
  // The discriminator is the config value itself, not the node type, because a
  // config key set to null is present-but-empty on every run, which is exactly
  // what the day-one-dead check exists to report.
  const constantsDef = (data: Record<string, unknown>, script: string) =>
    def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'constants', type: 'constants', config: { data } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script } } as any,
      ],
    })

  it('drops a static config key that is read directly', () => {
    const d = constantsDef({ logoSrc: '/logo.png' }, 'return steps.constants.output.logoSrc;')
    expect(deriveWatchedFields(d)).toEqual([])
  })

  it('drops a static config key read through an alias', () => {
    // The shape #435 added, and the one that produced the bulk of the growth.
    const d = constantsDef(
      { logoSrc: '/logo.png', offerName: 'Pennie' },
      'const k = steps.constants.output;\nreturn [k.logoSrc, k.offerName];\n',
    )
    expect(deriveWatchedFields(d)).toEqual(['constants'])
  })

  it('keeps a database-sourced constant that is absent from the config', () => {
    // partnerFlat: loadPartnerConstants writes SofiSellOffOfferTitle from the
    // partner_configs sell-off columns, so it can genuinely be missing.
    const d = constantsDef(
      { logoSrc: '/logo.png' },
      'return steps.constants.output.SofiSellOffOfferTitle;',
    )
    expect(deriveWatchedFields(d)).toEqual(['constants.SofiSellOffOfferTitle'])
  })

  it('keeps a config key whose value is null, so a dead constant still reports', () => {
    const d = constantsDef({ logoSrc: null }, 'return steps.constants.output.logoSrc;')
    expect(deriveWatchedFields(d)).toEqual(['constants.logoSrc'])
  })

  it('keeps the bare namespace, which measures whether the node ran', () => {
    const d = constantsDef({ logoSrc: '/logo.png' }, 'return steps.constants.$return_value;')
    expect(deriveWatchedFields(d)).toEqual(['constants'])
  })

  it('drops a deeper read into a static config value', () => {
    const d = constantsDef({ states: ['NY'] }, 'return steps.constants.output.states.length;')
    expect(deriveWatchedFields(d)).toEqual([])
  })

  it('leaves a same-named field on a node that is not a Constants node alone', () => {
    // The pairing that stops the filter being written as a blanket path match.
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'enrich', type: 'code', config: { data: { logoSrc: '/l.png' } } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'c', type: 'code', config: { script: 'return steps.enrich.output.logoSrc;' } } as any,
      ],
    })
    expect(deriveWatchedFields(d)).toContain('enrich.logoSrc')
  })

  it('reports a dropped static constant as neither structured nor code', () => {
    // The map is what the coverage manifest renders, so a dropped field must be
    // gone from it too, not merely absent from the projection.
    const d = constantsDef({ logoSrc: '/logo.png' }, 'return steps.constants.output.logoSrc;')
    expect(deriveWatchedFieldMap(d).fields).toEqual([])
  })
})

describe('an alias taken through a list index watches the element, not the list (#1799)', () => {
  const codeNode = (script: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def({ nodes: [{ id: 'n1', namespace: 'c', type: 'code', config: { script } } as any] })

  it('watches the first record for the Liberty1 pick_record shape', () => {
    // The exact line from pick_click_record.js. Its reads were watched as
    // `query_record.body.records.Id`, a key on an ARRAY, and paged as never
    // resolving on 216 of 216 runs while the row carried an Id on every one.
    const d = codeNode(
      'const row = steps.query_record?.output?.body?.records?.[0] ?? null;\n' +
        'if (!row || !row.Id) return null;\n' +
        'return { lead: row.Lead__c, status: row.External_Exchange_Status__c };\n',
    )
    expect(deriveWatchedFields(d)).toEqual([
      'query_record.body.records',
      'query_record.body.records.0.External_Exchange_Status__c',
      'query_record.body.records.0.Id',
      'query_record.body.records.0.Lead__c',
    ])
  })

  it('follows a plain bracket index and the path after it', () => {
    const d = codeNode('const first = steps.q.output.list[0].inner;\nreturn first.value;\n')
    expect(deriveWatchedFields(d)).toEqual(['q.list', 'q.list.0.inner.value'])
  })

  it('follows a quoted key the same way as a numeric one', () => {
    const d = codeNode("const m = steps.q.output.map['ny'];\nreturn m.rate;\n")
    expect(deriveWatchedFields(d)).toEqual(['q.map', 'q.map.ny.rate'])
  })

  it('reports a dynamic index as a gap rather than guessing which element', () => {
    const set = new Set<string>()
    const { aliasGap } = collectCodeRefs('const s = steps.q.output.map[source];\nreturn s.name;\n', set)
    expect(aliasGap).toBe(true)
    expect([...set]).toEqual(['q.map'])
  })

  it('does not report a gap for a dynamic index nothing reads through', () => {
    // Engine Bidding's validate_bidding_and_state: `subAccountIdsMap[source] || ""`
    // with no later `sourceName.x`, so there is nothing unwatched to report.
    const set = new Set<string>()
    const { aliasGap } = collectCodeRefs(
      'const sourceName = steps.constants.output.subAccountIdsMap[source] || "";\nreturn sourceName;\n',
      set,
    )
    expect(aliasGap).toBe(false)
    expect([...set]).toEqual(['constants.subAccountIdsMap'])
  })

  it('reports a method call on the chain as a gap rather than a field of its result', () => {
    // `find` returns an element, so `x.name` is not `q.list.find.name`.
    const set = new Set<string>()
    const { aliasGap } = collectCodeRefs('const x = steps.q.output.list.find((r) => r.ok);\nreturn x.name;\n', set)
    expect(aliasGap).toBe(true)
    expect([...set]).not.toContain('q.list.find.name')
  })

  it('still treats a fallback as the same value', () => {
    const d = codeNode('const r = steps.q.output.body || {};\nreturn r.reason;\n')
    expect(deriveWatchedFields(d)).toEqual(['q.body', 'q.body.reason'])
  })

  it('follows an index carried onto the next line without reading the tail as a use', () => {
    const d = codeNode('const hit = steps.a.output.b\n  ?.[0]?.hit?.code\nreturn hit.x;\n')
    expect(deriveWatchedFields(d)).toEqual(['a.b', 'a.b.0.hit.code.x'])
  })

  it('treats a comma declaration as the end of the initialiser', () => {
    const d = codeNode('const row = steps.q.output.list[0], other = 1;\nreturn row.id;\n')
    expect(deriveWatchedFields(d)).toEqual(['q.list', 'q.list.0.id'])
  })

  it('reports a quoted key that is not a plain name as a gap, since a dotted path cannot hold it', () => {
    for (const key of ["'a.b'", "''", "'ny city'"]) {
      const set = new Set<string>()
      const { aliasGap } = collectCodeRefs(`const m = steps.q.output.map[${key}];\nreturn m.rate;\n`, set)
      expect(aliasGap).toBe(true)
      expect([...set]).toEqual(['q.map'])
    }
  })
})

describe('each watched field names the nodes that read it', () => {
  const readersOf = (d: WorkflowDefinition, path: string) =>
    deriveWatchedFieldMap(d).fields.find((f) => f.path === path)?.readers

  it('names the node whose config templates the field', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'respond_bad', type: 'response', config: { body: '{{steps.x.output.reason}}' } } as any,
      ],
    })
    expect(readersOf(d, 'x.reason')).toEqual(['respond_bad'])
  })

  it('names the code node whose script reads the field', () => {
    const d = def({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: [{ id: 'n1', namespace: 'c', type: 'code', config: { script: 'return steps.x.output.v;' } } as any],
    })
    expect(readersOf(d, 'x.v')).toEqual(['c'])
  })

  it('names the source node of an edge whose condition reads the field', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'f1', namespace: 'check', type: 'filter', config: {} } as any,
      ],
      edges: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'e1', source: 'f1', target: 'b', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'steps.y.output.ok', operator: 'is_true' }] }] } } as any,
      ],
    })
    expect(readersOf(d, 'y.ok')).toEqual(['check'])
  })

  it('merges every reader of one field', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'b', type: 'response', config: { body: '{{steps.x.output.v}}' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'a', type: 'code', config: { script: 'return steps.x.output.v;' } } as any,
      ],
    })
    expect(readersOf(d, 'x.v')).toEqual(['a', 'b'])
  })

  it('cannot name a reader for an edge whose source is not a node, so it is null', () => {
    const d = def({
      edges: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'e1', source: 'missing', target: 'b', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'steps.y.output.ok', operator: 'is_true' }] }] } } as any,
      ],
    })
    expect(readersOf(d, 'y.ok')).toBeNull()
  })
})

describe('a field is gated on its readers only when every reader is an ending step', () => {
  const gateOf = (d: WorkflowDefinition, path: string) =>
    deriveWatchedFieldMap(d).fields.find((f) => f.path === path)?.gate

  it('gates a refusal reason that only a Response node reads', () => {
    // Liberty1's resolve_input.reason: read only by respond_bad_input.
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'respond_bad', type: 'response', config: { body: { reason: '{{steps.input.output.reason}}' } } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'stop', type: 'exit', config: { body: '{{steps.input.output.code}}' } } as any,
      ],
    })
    expect(gateOf(d, 'input.reason')).toEqual(['respond_bad'])
    expect(gateOf(d, 'input.code')).toEqual(['stop'])
  })

  it('does not gate a field a code node reads, because its absence can stop that node running', () => {
    // Engine Bidding's create_prospect.body.id: the nodes that read it run only
    // when Salesforce returned an id, so gating on them would turn a total
    // collapse into silence instead of a page.
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'trades', type: 'code', config: { script: 'return steps.create_prospect.output.body.id;' } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n2', namespace: 'reply', type: 'response', config: { body: '{{steps.create_prospect.output.body.id}}' } } as any,
      ],
    })
    expect(gateOf(d, 'create_prospect.body.id')).toBeNull()
  })

  it('does not gate a field an edge condition routes on', () => {
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'f1', namespace: 'check', type: 'filter', config: {} } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'reply', type: 'response', config: { body: '{{steps.y.output.ok}}' } } as any,
      ],
      edges: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'e1', source: 'f1', target: 'n1', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'steps.y.output.ok', operator: 'is_true' }] }] } } as any,
      ],
    })
    expect(gateOf(d, 'y.ok')).toBeNull()
  })

  it('does not gate a field one of whose readers cannot be named', () => {
    // Nodes are walked before code scripts, so a nameless edge reader seen first
    // must not be overwritten by a Response reader seen later.
    const d = def({
      nodes: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'n1', namespace: 'reply', type: 'response', config: { body: '{{steps.y.output.ok}}' } } as any,
      ],
      edges: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'e1', source: 'missing', target: 'n1', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'steps.y.output.ok', operator: 'is_true' }] }] } } as any,
      ],
    })
    expect(gateOf(d, 'y.ok')).toBeNull()
  })
})
