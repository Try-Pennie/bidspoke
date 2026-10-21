/**
 * The swap candidate's own rules (#2591): what a candidate file must say, how it
 * is put in place, and the defects seeded to see each instrument name a check.
 */
import { describe, it, expect } from 'vitest'
import { applyCandidate, candidateProblems, parseCandidate, parseSeed, seedDefect, type SwapCandidate } from '../candidate'
import { compareOutcomes, runNode, type ValidationOutcome } from '../outcomes'
import lendswift from '../candidates/rml-lendswift.json'
import leadEconomy from '../candidates/lead-economy.json'
import leadEconomyDef from '../../fixtures/definitions/89b1a6af-7e0f-43de-bc66-1e888184551f.json'

const candidate = () => structuredClone(lendswift) as unknown as SwapCandidate

describe('candidateProblems', () => {
  it('accepts every committed candidate', () => {
    expect(candidateProblems(lendswift)).toEqual([])
    expect(candidateProblems(leadEconomy)).toEqual([])
  })

  it('refuses a node that would not take the replaced step\'s place, by name', () => {
    const c = candidate()
    c.node.id = 'another-id'
    c.node.namespace = 'renamed'
    expect(candidateProblems(c).join('; ')).toMatch(/is not the id of the node it replaces.*is not validate_bidding_and_state/)
  })

  it('refuses a config the node could not run, a missing pin and an accepted difference with no reason', () => {
    const c = candidate()
    c.node.config.checks[0].reason = 'not a reason' as never
    c.replaces.script_md5 = 'abc'
    c.grid_accepted = [{ arm: 'x', check: 'y', kind: 'node_rejects', reason: '' }]
    const problems = candidateProblems(c).join('; ')
    expect(problems).toContain('node config: Check "Bidding is on": "not a reason" is not a rejection reason')
    expect(problems).toContain('the 32 character md5')
    expect(problems).toContain('grid_accepted 0 has no written reason')
    expect(() => parseCandidate(c, 'broken.json')).toThrow(/^swap candidate broken\.json: /)
  })
})

describe('applyCandidate', () => {
  const def = leadEconomyDef as unknown as Parameters<typeof applyCandidate>[0]
  const le = leadEconomy as unknown as SwapCandidate

  it('swaps the code step for the node in place and sets the Constants data, leaving the committed definition alone', () => {
    const swapped = applyCandidate(def, le)
    const node = swapped.definition.nodes.find((n) => n.id === le.replaces.node_id)
    expect(node?.type).toBe('lead_validation')
    expect(node?.config).toEqual(le.node.config)
    const constants = (n: typeof swapped) => (n.definition.nodes.find((x) => x.type === 'constants')?.config as { data: Record<string, unknown> }).data
    expect(constants(swapped).minimumLoanAmount).toBe(2000)
    expect(constants(def).minimumLoanAmount).toBe(1000)
    expect(swapped.definition.edges).toEqual(def.definition.edges)
  })

  it('refuses another workflow, or a node that is not the code step it replaces', () => {
    expect(() => applyCandidate({ ...def, id: 'other' }, le)).toThrow(/applied to/)
    const once = applyCandidate(def, le)
    expect(() => applyCandidate(once, le)).toThrow(/is the lead_validation step validate_bidding_and_state, not the code step/)
  })
})

describe('seedDefect', () => {
  const c = candidate()
  const constants = new Set(['constants'])
  const lead = (employmentStatus: unknown): Parameters<typeof runNode>[3] => ({
    trace_id: 't',
    payload: { leadUuid: 'l', personalInformation: { state: 'TX' }, loanInformation: { loanAmount: 100 }, financialInformation: { employmentStatus } },
    steps: { constants: { output: { biddingActive: true, states: ['TX'], maximumLoanAmount: 5001 } }, parse_name: { output: { firstName: 'Dana', lastName: 'Reyes' } } },
  })
  const run = (cand: SwapCandidate, status: unknown): ValidationOutcome => runNode(cand.node.config, 'validate_bidding_and_state', constants, lead(status))

  it('lenient lets through what the check rejected, strict rejects what it let through, and each is a config the parser takes', () => {
    expect(run(c, 'military')).toMatchObject({ kind: 'reject', check_id: 'military' })
    expect(run(seedDefect(c, 'military', 'lenient'), 'military')).toEqual({ kind: 'pass' })
    expect(run(c, 'employed')).toEqual({ kind: 'pass' })
    expect(run(seedDefect(c, 'military', 'strict'), 'employed')).toMatchObject({ kind: 'reject', check_id: 'military' })
    expect(candidateProblems(seedDefect(c, 'military', 'strict'))).toEqual([])
  })

  it('refuses a check that is not there', () => {
    expect(() => seedDefect(c, 'nope', 'strict')).toThrow(/has no check nope/)
  })

  it('parses the seed form and refuses any other', () => {
    expect(parseSeed('military:lenient')).toEqual({ checkId: 'military', direction: 'lenient' })
    expect(parseSeed(undefined)).toBeNull()
    expect(() => parseSeed('military')).toThrow(/lenient or <check id>:strict/)
  })
})

describe('compareOutcomes', () => {
  const config = candidate().node.config
  const reject = (reason: string, check_id: string | null = null, extra: Record<string, unknown> = {}): ValidationOutcome => ({ kind: 'reject', status: 200, headers: { 'Content-Type': 'application/json' }, body: { lead_id: 'l', status: 'rejected', reason, ...extra }, check_id })

  it('puts each pair in one bucket and names the check', () => {
    expect(compareOutcomes({ kind: 'pass' }, { kind: 'pass' }, config)).toEqual({ bucket: 'agree', difference: null })
    expect(compareOutcomes(reject('ineligible state'), reject('ineligible state', 'state'), config)).toEqual({ bucket: 'agree', difference: null })
    expect(compareOutcomes({ kind: 'pass' }, reject('ineligible state', 'state'), config).difference).toMatchObject({ kind: 'node_rejects', node_check: 'state' })
    expect(compareOutcomes(reject('ineligible state'), { kind: 'pass' }, config).difference).toMatchObject({ kind: 'node_passes', script_check: 'state' })
    expect(compareOutcomes(reject('ineligible state'), reject('invalid name', 'name'), config).difference).toMatchObject({ kind: 'other_reason', script_check: 'state', node_check: 'name' })
    expect(compareOutcomes(reject('invalid name', null, { requestId: 'x' }), reject('invalid name', 'name'), config).difference).toMatchObject({ kind: 'answer', fields: ['body.requestId'] })
    expect(compareOutcomes({ kind: 'threw', error: 'TypeError' }, reject('invalid name', 'name'), config)).toEqual({ bucket: 'script_threw', difference: null })
    expect(compareOutcomes({ kind: 'threw', error: 'TypeError' }, { kind: 'pass' }, config).difference?.kind).toBe('passes_after_throw')
    expect(compareOutcomes(reject('invalid name'), { kind: 'threw', error: 'x' }, config).bucket).toBe('node_threw')
  })

  it('compares the body as the JSON text the source reads, so the same keys in another order differ (#2594)', () => {
    const reordered: ValidationOutcome = { kind: 'reject', status: 200, headers: { 'Content-Type': 'application/json' }, body: { status: 'rejected', lead_id: 'l', reason: 'invalid name' }, check_id: 'name' }
    expect(compareOutcomes(reject('invalid name'), reordered, config)).toEqual({
      bucket: 'response_differs',
      difference: { kind: 'answer', script_check: 'name', node_check: 'name', fields: ['body key order'] },
    })
    expect(compareOutcomes(reject('invalid name', null, { requestId: 'x' }), reject('invalid name', 'name', { requestId: 'x' }), config)).toEqual({ bucket: 'agree', difference: null })
  })

  it('sets key order aside when the script\'s answer was read back from a store that does not keep it', () => {
    const reordered: ValidationOutcome = { kind: 'reject', status: 200, headers: { 'Content-Type': 'application/json' }, body: { status: 'rejected', lead_id: 'l', reason: 'invalid name' }, check_id: 'name' }
    expect(compareOutcomes(reject('invalid name'), reordered, config, { keyOrder: false })).toEqual({ bucket: 'agree', difference: null })
    expect(compareOutcomes(reject('invalid name', null, { requestId: 'x' }), reordered, config, { keyOrder: false }).difference).toMatchObject({ kind: 'answer', fields: ['body.requestId'] })
  })
})
