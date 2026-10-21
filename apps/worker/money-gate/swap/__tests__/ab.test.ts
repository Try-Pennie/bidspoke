/**
 * The money gate's definition A/B mode (#2591, ab.ts): which definitions the
 * replay runs, what is set aside as the replaced step's own record, and the
 * verdict, including that it names a difference and the check behind it.
 */
import { describe, it, expect } from 'vitest'
import { abDefinitions, abModeOf, findCandidate, setAsideReplacedStep, swapVerdict } from '../ab'
import type { FixtureRecord, Transcript } from '../../lib/compare'
import type { SwapCandidate } from '../candidate'
import { EXTRA_RUN_KINDS } from '../../lib/run-kinds'
import lendswift from '../candidates/rml-lendswift.json'
import lendswiftDef from '../../fixtures/definitions/e1b810da-16c0-49eb-bf12-ba1c9b67c914.json'
import gigfiDef from '../../fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'

const files = { '../swap/candidates/rml-lendswift.json': lendswift }
type Def = Parameters<typeof abDefinitions>[0][number]
const defs = [lendswiftDef, gigfiDef] as unknown as Def[]
const candidate = lendswift as unknown as SwapCandidate
const NS = 'validate_bidding_and_state'

describe('abModeOf', () => {
  it('is off unless a candidate is named, and refuses a half set mode by name', () => {
    expect(abModeOf({})).toBeNull()
    expect(abModeOf({ candidate: 'rml-lendswift', side: 'candidate', seed: 'military:lenient' })).toEqual({ candidate: 'rml-lendswift', side: 'candidate', seed: 'military:lenient' })
    expect(() => abModeOf({ side: 'current' })).toThrow(/without MONEY_GATE_CANDIDATE/)
    expect(() => abModeOf({ candidate: 'x', side: 'both' })).toThrow(/current or candidate/)
    expect(() => abModeOf({ candidate: 'x', side: 'current', seed: 'military:strict' })).toThrow(/candidate side only/)
  })
})

describe('abDefinitions', () => {
  it('replays every definition as committed outside A/B mode', () => {
    expect(abDefinitions(defs, files, null)).toBe(defs)
  })

  it('replays only the candidate\'s workflow, swapped on the candidate side, seeded when asked', () => {
    const current = abDefinitions(defs, files, { candidate: 'rml-lendswift', side: 'current' })
    expect(current.map((d) => d.id)).toEqual([candidate.workflow_id])
    expect(current[0].definition.nodes.find((n) => n.namespace === NS)?.type).toBe('code')
    const swapped = abDefinitions(defs, files, { candidate: 'rml-lendswift.json', side: 'candidate' })
    expect(swapped[0].definition.nodes.find((n) => n.namespace === NS)?.type).toBe('lead_validation')
    const seeded = abDefinitions(defs, files, { candidate: 'rml-lendswift', side: 'candidate', seed: 'military:lenient' })
    const military = (seeded[0].definition.nodes.find((n) => n.namespace === NS)?.config as { checks: Array<{ id: string; condition: { logic: string } }> }).checks.find((c) => c.id === 'military')
    expect(military?.condition.logic).toBe('OR')
  })

  it('refuses a candidate that is not there, naming the ones that are', () => {
    expect(() => findCandidate(files, 'nope')).toThrow(/no swap candidate named nope\.json \(candidates: rml-lendswift\.json\)/)
  })
})

function fixture(variant: string, over: Partial<FixtureRecord> = {}): FixtureRecord {
  return {
    id: `${candidate.workflow_name}/${variant}`,
    workflow_id: candidate.workflow_id,
    workflow_name: candidate.workflow_name,
    variant,
    run_kind: 'live',
    trigger: {},
    routes: [],
    nodes_executed: ['constants', 'parse_name', NS],
    final_node: NS,
    response: { status: 200, body: { lead_id: 'l', status: 'rejected', reason: 'military status ineligible' }, headers: { 'Content-Type': 'application/json' } },
    outbound: [],
    code_dispatch: [{ binding: 'DYNAMIC_WORKER_LOADER', dispatch_namespace: 'ns', name: 'bundle-a', path: '/run', namespaces: ['parse_name', NS] }],
    supabase_writes: [
      { op: 'insert', table: 'execution_steps', values: [{ step_namespace: NS, step_order: 3, status: 'completed', output: { response: { status: 200, body: { reason: 'military status ineligible' } } } }] },
      { op: 'update', table: 'workflow_executions', values: { outcome: 'completed', cost_usd: 0.00005 } },
    ],
    do_state: {},
    kv_state: { WORKFLOW_CACHE: { [`workflow-def-${candidate.workflow_id}`]: '{"definition":"current"}' } },
    ...over,
  }
}

/** Each lead as a live run and as the test and shadow runs every workflow must be replayed as. */
const allKinds = (fixtures: FixtureRecord[]): FixtureRecord[] => fixtures.flatMap((f) => [
  f,
  ...EXTRA_RUN_KINDS.map((kind) => ({ ...f, id: `${f.id} as ${kind}`, run_kind: kind })),
])

const transcript = (side: 'base' | 'head', fixtures: FixtureRecord[]): Transcript => ({
  version: 1,
  side,
  fixtures: allKinds(fixtures),
  workflows: [{ workflow_id: candidate.workflow_id, workflow_name: candidate.workflow_name, nodes: ['constants', 'parse_name', NS], arms: [] }],
  unstubbed_hosts: [],
  unknown_tables: [],
})

/** The candidate side of the same run: the node's own row, its own bundle name, a cheaper run and its own cached definition. */
function swappedFixture(variant: string, over: Partial<FixtureRecord> = {}): FixtureRecord {
  return fixture(variant, {
    code_dispatch: [{ binding: 'DYNAMIC_WORKER_LOADER', dispatch_namespace: 'ns', name: 'bundle-b', path: '/run', namespaces: ['parse_name'] }],
    supabase_writes: [
      { op: 'insert', table: 'execution_steps', values: [{ step_namespace: NS, step_order: 3, status: 'completed', output: { valid: false, check_id: 'military', reason: 'military status ineligible' } }] },
      { op: 'update', table: 'workflow_executions', values: { outcome: 'completed', cost_usd: 0.00004 } },
    ],
    kv_state: { WORKFLOW_CACHE: { [`workflow-def-${candidate.workflow_id}`]: '{"definition":"candidate"}' } },
    ...over,
  })
}

const noAccepted = { ...candidate, gate_accepted: [] }

describe('setAsideReplacedStep', () => {
  it('sets aside the replaced step\'s row, its bundle and the cost, and keeps every other row', () => {
    const { transcript: t, setAside } = setAsideReplacedStep(transcript('base', [fixture('military')]), NS)
    expect(setAside[0]).toEqual({ fixture: `${candidate.workflow_name}/military`, rows: 1, dispatches: 1 })
    expect(t.fixtures[0].supabase_writes).toEqual([{ op: 'update', table: 'workflow_executions', values: { outcome: 'completed', cost_usd: '(set aside)' } }])
    expect(t.fixtures[0].code_dispatch).toEqual([{ binding: 'DYNAMIC_WORKER_LOADER', dispatch_namespace: 'ns', name: '(bundle)', path: '(bundle)', namespaces: ['parse_name'] }])
  })
})

describe('swapVerdict', () => {
  it('passes a swap that changes nothing but the replaced step\'s own record', () => {
    const v = swapVerdict(transcript('base', [fixture('military')]), transcript('head', [swappedFixture('military')]), noAccepted)
    expect(v.output).toContain('no difference between the current definition and the candidate outside the replaced step')
    expect(v.exitCode, v.output).toBe(0)
  })

  it('names a difference by fixture, check and the validation decision on each side', () => {
    const letThrough = swappedFixture('military', {
      final_node: 'patch_applicant_bid',
      response: { status: 200, body: { offers: [] } },
      supabase_writes: [
        { op: 'insert', table: 'execution_steps', values: [{ step_namespace: NS, step_order: 3, status: 'completed', output: { valid: true } }] },
        { op: 'update', table: 'workflow_executions', values: { outcome: 'successful', cost_usd: 0.00004 } },
      ],
    })
    const v = swapVerdict(transcript('base', [fixture('military')]), transcript('head', [letThrough]), noAccepted, 'military:lenient')
    expect(v.exitCode).toBe(1)
    expect(v.output).toContain('seeded with military:lenient')
    expect(v.output).toContain(`${candidate.workflow_name}/military: current rejected (military status ineligible), the reason of check military; candidate let through`)
    expect(v.output).toMatch(/checks that fired: final_node \(3\), response \(\d+\), supabase_write \(3\)/)
  })

  it('fails an accepted difference that no longer happens, and a replay that ran nothing', () => {
    const v = swapVerdict(transcript('base', [fixture('military')]), transcript('head', [swappedFixture('military')]), candidate)
    expect(v.exitCode).toBe(1)
    expect(v.output).toMatch(/gate_accepted entry for .* matched no difference/)
    const empty = swapVerdict(transcript('base', []), transcript('head', []), noAccepted)
    expect(empty.output).toContain('the current transcript holds no fixture')
    expect(empty.exitCode).toBe(1)
  })
})
