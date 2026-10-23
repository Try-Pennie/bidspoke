import { describe, expect, it } from 'vitest'
import {
  DEFINITION_RULES,
  DEFINITION_SCHEMA_VERSION,
  blockingProblems,
  definitionShapeProblems,
  judgeDefinition,
  validateDefinition,
  type DefinitionProblem,
  type DefinitionRule,
  type DefinitionVerdict,
} from '../index'

// validateDefinition (#1947): one pure function composing the validators both
// apps already share, plus the trigger union, judged by the rules in force at
// the definition's own schema stamp. The Worker's write paths call it report
// only (lib/definition-report.ts), so it refuses nothing yet.

type Node = { id: string; type: string; namespace: string; config?: Record<string, unknown>; label?: string }
type Edge = { source: string; target: string; source_handle?: string; condition?: unknown }

const trigger = { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } }
const code = (id: string, script = 'return 1'): Node => ({ id, type: 'code', namespace: id, config: { script } })
const response = (id: string): Node => ({ id, type: 'response', namespace: id, config: {} })
const def = (nodes: Node[], edges: Edge[], t: unknown = trigger) => ({ trigger: t, nodes, edges })
const clean = () => def([code('a'), response('done')], [{ source: 'trigger', target: 'a' }, { source: 'a', target: 'done' }])

function judged(verdict: DefinitionVerdict): DefinitionProblem[] {
  if (verdict.kind !== 'judged') throw new Error(`expected a judged verdict, got ${verdict.kind}`)
  return verdict.problems
}
const rulesOf = (verdict: DefinitionVerdict) => judged(verdict).map((p) => p.rule)

describe('validateDefinition: the schema stamp', () => {
  it('judges an unstamped definition as the oldest version and says it was unstamped', () => {
    expect(validateDefinition(clean(), { lane: 'money' })).toEqual({ kind: 'judged', schemaVersion: 1, stamped: false, problems: [] })
  })

  it('judges a stamped definition at its own stamp', () => {
    expect(validateDefinition(clean(), { lane: 'money', schemaVersion: DEFINITION_SCHEMA_VERSION })).toEqual({
      kind: 'judged',
      schemaVersion: DEFINITION_SCHEMA_VERSION,
      stamped: true,
      problems: [],
    })
  })

  it('returns a named result for a stamp newer than this code knows, and judges nothing, so it can never read as a clean pass', () => {
    const broken = def([code('a'), code('b')], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }])
    const verdict = validateDefinition(broken, { lane: 'money', schemaVersion: DEFINITION_SCHEMA_VERSION + 1 })
    expect(verdict).toEqual({ kind: 'unknown_schema_version', stamp: DEFINITION_SCHEMA_VERSION + 1, known: DEFINITION_SCHEMA_VERSION })
    expect('problems' in verdict).toBe(false)
  })

  it('returns a named result for a stamp that is not a version at all', () => {
    expect(validateDefinition(clean(), { lane: 'money', schemaVersion: '1' })).toEqual({ kind: 'invalid_schema_version', stamp: '1' })
  })
})

describe('judgeDefinition: rules are gated by the version they took effect at', () => {
  const rule = (id: string, since: number): DefinitionRule => ({
    id: id as DefinitionRule['id'],
    since,
    enforce: 'every_save',
    check: () => [{ reason: `${id}_found`, severity: 'error', message: `${id} found` }],
  })
  const rules = [rule('trigger', 1), rule('cycle', 2)]

  it('judges a version 1 stamp by version 1 rules only', () => {
    expect(rulesOf(judgeDefinition(clean(), { lane: 'money', schemaVersion: 1 }, rules, 2))).toEqual(['trigger'])
  })

  it('judges a version 2 stamp by every rule in force at 2', () => {
    expect(rulesOf(judgeDefinition(clean(), { lane: 'money', schemaVersion: 2 }, rules, 2))).toEqual(['trigger', 'cycle'])
  })

  it('judges an unstamped definition by the oldest rules, never by a rule added since', () => {
    expect(rulesOf(judgeDefinition(clean(), { lane: 'money' }, rules, 2))).toEqual(['trigger'])
  })

  it('refuses a stamp past the version the rules were written for', () => {
    expect(judgeDefinition(clean(), { lane: 'money', schemaVersion: 3 }, rules, 2)).toEqual({ kind: 'unknown_schema_version', stamp: 3, known: 2 })
  })
})

describe('the rule registry', () => {
  it('has one entry per rule id, each in force from a version this code knows', () => {
    const ids = DEFINITION_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of DEFINITION_RULES) {
      expect(r.since).toBeGreaterThanOrEqual(1)
      expect(r.since).toBeLessThanOrEqual(DEFINITION_SCHEMA_VERSION)
    }
  })
})

describe('validateDefinition: the shape every rule reads', () => {
  it.each([
    ['a definition that is not an object', null],
    ['nodes that are not a list', { trigger, nodes: {}, edges: [] }],
    ['edges that are not a list', { trigger, nodes: [], edges: 'none' }],
    ['a node with no namespace', { trigger, nodes: [{ id: 'a', type: 'code' }], edges: [] }],
    ['a node that is not an object', { trigger, nodes: [5], edges: [] }],
    ['an edge with no target', { trigger, nodes: [], edges: [{ source: 'a' }] }],
  ])('refuses %s as a shape problem and runs no other rule', (_, definition) => {
    const problems = judged(validateDefinition(definition, { lane: 'money' }))
    expect(problems.length).toBeGreaterThan(0)
    expect(new Set(problems.map((p) => p.rule))).toEqual(new Set(['definition_shape']))
  })
})

describe('validateDefinition: the validators it composes', () => {
  it('names a loop', () => {
    const verdict = validateDefinition(def([code('a'), code('b')], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]), { lane: 'money' })
    const cycle = judged(verdict).filter((p) => p.rule === 'cycle')
    expect(cycle).toHaveLength(1)
    expect(cycle[0].message).toContain('a')
  })

  it('names the trigger problem with its trigger reason', () => {
    const schedule = { type: 'schedule', config: { interval_seconds: 300, timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 } }
    const problems = judged(validateDefinition({ ...clean(), trigger: schedule }, { lane: 'money' }))
    expect(problems.map((p) => [p.rule, p.reason])).toEqual([['trigger', 'trigger_not_on_lane']])
  })

  it('names a step id used twice', () => {
    const problems = judged(validateDefinition(def([code('a'), { ...code('b'), namespace: 'a' }], [{ source: 'a', target: 'b' }]), { lane: 'money' }))
    expect(problems.map((p) => p.rule)).toEqual(['namespace_unique'])
  })

  it('names a node type this build does not know, and a known one the lane cannot run', () => {
    const nodes = [{ id: 'i', type: 'integration', namespace: 'i', config: {} }, { id: 's', type: 'salesforce', namespace: 's', config: { operation: 'create', object: 'Lead' } }]
    const problems = judged(validateDefinition(def(nodes, [{ source: 'i', target: 's' }]), { lane: 'ops' }))
    expect(problems.filter((p) => p.rule === 'node_type').map((p) => p.nodeId)).toEqual(['i'])
    expect(problems.filter((p) => p.rule === 'node_lane').map((p) => p.nodeId)).toEqual(['s'])
    expect(judged(validateDefinition(def(nodes, [{ source: 'i', target: 's' }]), { lane: 'money' })).filter((p) => p.rule === 'node_lane')).toEqual([])
  })

  it('names duplicate branch arm labels', () => {
    const branch: Node = { id: 'b', type: 'branch', namespace: 'b', config: { branches: [{ label: 'x', condition: { groups: [{ conditions: [{ field: 'f' }] }] } }, { label: 'x', condition: { groups: [{ conditions: [{ field: 'g' }] }] } }] } }
    const problems = judged(validateDefinition(def([branch], []), { lane: 'money' }))
    expect(problems.map((p) => p.rule)).toEqual(['branch_labels'])
  })

  it('names two edges leaving one output for different targets', () => {
    const problems = judged(validateDefinition(def([code('a'), response('b'), response('c')], [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]), { lane: 'money' }))
    expect(problems.map((p) => [p.rule, p.enforce])).toEqual([['duplicate_out_edges', 'live_save']])
  })

  it('names an attached node with no configuration, enforced only for a live save as the canvas does', () => {
    const problems = judged(validateDefinition(def([code('a', ''), response('b')], [{ source: 'a', target: 'b' }]), { lane: 'money' }))
    expect(problems.map((p) => [p.rule, p.enforce, p.nodeId])).toEqual([['node_config', 'live_save', 'a']])
  })

  it('reports a reference to a step that does not run before it, as advice the canvas shows', () => {
    const early: Node = { id: 'a', type: 'response', namespace: 'a', config: { body: '{{steps.later.output.x}}' } }
    const problems = judged(validateDefinition(def([early, code('later')], [{ source: 'a', target: 'later' }]), { lane: 'money' }))
    expect(problems.map((p) => [p.rule, p.enforce])).toEqual([['references', 'advisory']])
  })

  it('names a Salesforce step whose write options its executor would refuse', () => {
    const sf: Node = { id: 's', type: 'salesforce', namespace: 's', config: { operation: 'update', object: 'Submission__c', omit_fields: 'x' } }
    const problems = judged(validateDefinition(def([sf], []), { lane: 'money' }))
    expect(problems.map((p) => p.rule)).toEqual(['salesforce_options'])
  })

  it('names a lead validation step inside a parallel block on every save', () => {
    const node = (id: string, type: string): Node => ({ id, type, namespace: id, config: {} })
    const nodes = [node('par', 'parallel'), node('v', 'lead_validation'), node('end', 'parallel_end')]
    const edges = [{ source: 'par', target: 'v', source_handle: 'child-0' }, { source: 'v', target: 'end' }]
    const problems = judged(validateDefinition(def(nodes, edges), { lane: 'money' }))
    expect(problems.filter((p) => p.rule === 'lead_validation_placement').map((p) => [p.nodeId, p.enforce])).toEqual([['v', 'every_save']])
  })
})

describe('blockingProblems', () => {
  const problem = (enforce: DefinitionProblem['enforce'], severity: DefinitionProblem['severity']): DefinitionProblem => ({
    rule: 'cycle',
    reason: 'cycle',
    enforce,
    severity,
    message: `${enforce} ${severity}`,
  })
  const all = [problem('every_save', 'error'), problem('live_save', 'error'), problem('advisory', 'error'), problem('every_save', 'warning')]

  it('blocks a draft save only on errors enforced on every save', () => {
    expect(blockingProblems(all, { live: false }).map((p) => p.message)).toEqual(['every_save error'])
  })

  it('blocks a live save on the live rules too, never on advice or a warning', () => {
    expect(blockingProblems(all, { live: true }).map((p) => p.message)).toEqual(['every_save error', 'live_save error'])
  })
})

// The shape check is the one parse every rule reads, and the save routes refuse
// a definition that fails it with a named 400 (#2190), so a null step reaches
// no rule and no route answers 500 for it.
describe('definitionShapeProblems', () => {
  it.each([
    ['a definition that is not an object', 'x'],
    ['a null step', { trigger, nodes: [null], edges: [] }],
    ['a step that is a number', { trigger, nodes: [5], edges: [] }],
    ['nodes that are an object', { trigger, nodes: {}, edges: [] }],
    ['no edges at all', { trigger, nodes: [] }],
    ['a null edge', { trigger, nodes: [], edges: [null] }],
  ])('names %s, exactly as validateDefinition does', (_, definition) => {
    const problems = definitionShapeProblems(definition)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems).toEqual(judged(validateDefinition(definition, { lane: 'money' })))
  })

  it('finds nothing in a definition every rule can read', () => {
    expect(definitionShapeProblems(clean())).toEqual([])
  })
})

// The five saved shapes the #1947 calibration named (2026-10-22), each decided.
describe('saved shapes measured in production (#1947)', () => {
  it('a step of the retired integration type is refused by name on every save, never mapped to another type', () => {
    // One saved version holds one, in a soft deleted workflow, so restoring it is a 404 today.
    const nodes = [{ id: 'f', type: 'integration', namespace: 'fail_test', config: {} }, response('done')]
    const problems = judged(validateDefinition(def(nodes, [{ source: 'f', target: 'done' }]), { lane: 'money' }))
    const blocking = blockingProblems(problems, { live: false })
    expect(blocking.map((p) => [p.rule, p.reason, p.namespace])).toEqual([['node_type', 'node_type_unknown', 'fail_test']])
    expect(blocking[0].message).toContain('integration')
  })

  it('the old webhook spelling is a warning that refuses no save, live or not', () => {
    const problems = judged(validateDefinition({ ...clean(), trigger: { type: 'webhook', config: { method: 'POST', auth_method: 'api_key' } } }, { lane: 'money' }))
    expect(problems.map((p) => [p.reason, p.severity])).toEqual([['trigger_legacy_spelling', 'warning']])
    expect(blockingProblems(problems, { live: true })).toEqual([])
  })

  it.each([['a string', 'yes'], ['a number', 3], ['an object', { body: 1 }], ['true', true]])(
    'custom_response holding %s is not judged, because nothing reads it',
    (_, value) => {
      const t = { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key', custom_response: value } }
      expect(judged(validateDefinition({ ...clean(), trigger: t }, { lane: 'money' }))).toEqual([])
    },
  )

  it('a money workflow whose stored trigger no money entry point fires is refused on every save, so a run cannot disagree with it', () => {
    const schedule = { type: 'schedule', config: { interval_seconds: 300, timezone: 'UTC', overlap: 'skip', catch_up: 'none', jitter_max_seconds: 0 } }
    const problems = judged(validateDefinition({ ...clean(), trigger: schedule }, { lane: 'money' }))
    expect(blockingProblems(problems, { live: false }).map((p) => p.reason)).toEqual(['trigger_not_on_lane'])
  })
})
