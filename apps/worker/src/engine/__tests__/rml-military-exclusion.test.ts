/**
 * The RML military exclusion, exercised against the real script text (#926).
 *
 * The check read `payload.personalInformation.militaryStatus === true` on both
 * RML bidding workflows. That field has never been sent, so a strict comparison
 * against `true` was always false and the rejection was unreachable: zero
 * rejections in 150,110 runs across 7 days. Measured over the same retained
 * window, 157 LendSwift leads arrived carrying `employmentStatus: 'military'`
 * and 114 of them were sold (72.6%, against the workflow's overall 74.5%). So
 * the population the control exists to exclude was passing straight through it
 * at the ordinary rate. Dan chose to repair rather than remove, on 2026-08-21.
 *
 * The scripts live in the database, not the repo, so this suite loads the
 * fixture files verbatim and runs them under the same
 * `(payload, steps, env, execution, console, props)` contract
 * `buildBundledWorkerScript` gives a code node, with `trigger` and `process`
 * synthesized the same way. Running the real text rather than a reimplementation
 * is the point: a paraphrase would only prove this file agrees with itself,
 * which is exactly how the original defect survived (L52). See the fixture
 * README for what this still cannot check, and #934 for the consolidation that
 * removes the copy.
 *
 * GigFi's step is a lead validation node since 2026-10-22 (#2592): its block
 * runs the node as saved, and only LendSwift's script is still held here.
 */
import { describe, it, expect } from 'vitest'
import { constantsNamespacesOf } from '@bidspoke/workflow-definition'
import fixture from './fixtures/rml-validate-scripts.json'
import gigfiLive from '../../../money-gate/fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'
import { executeLeadValidationNode } from '../nodes/lead-validation'
import type { ExecutionContext, NodeDefinition } from '../../types'

type Which = keyof typeof fixture.scripts

interface Rejection {
  response?: { status: number; body: { reason: string; status: string; lead_id: string } }
  valid?: boolean
}

const sourceOf = (which: Which) => fixture.scripts[which].script

/**
 * Compiles one script the way the sandbox does. `props` is unused by these
 * scripts but is part of the contract, so it is threaded rather than dropped.
 */
function compile(which: Which) {
  const script = sourceOf(which)
  const body = `
    const trigger = { payload }
    const process = { env }
    props = props || {}
${script}
  `
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('payload', 'steps', 'env', 'execution', 'console', 'props', body) as (
    payload: unknown,
    steps: unknown,
    env: unknown,
    execution: unknown,
    console: unknown,
    props: unknown,
  ) => Rejection
  return (payload: unknown, steps: unknown) =>
    fn(payload, steps, {}, {}, { log: () => undefined, error: () => undefined }, {})
}

// The real constants, read off the deployed constants node's vocabulary. States
// is only as long as it needs to be for these cases: the state check is not what
// is under test and every payload below uses an allowed one.
const constants = { states: ['TX', 'FL'], biddingActive: true, maximumLoanAmount: 50000 }

const lead = (over: { employmentStatus?: unknown; militaryStatus?: unknown } = {}) => {
  const financial: Record<string, unknown> = {}
  if ('employmentStatus' in over) financial.employmentStatus = over.employmentStatus
  else financial.employmentStatus = 'employed'

  const personal: Record<string, unknown> = { state: 'TX', firstName: 'Dana', lastName: 'Reyes' }
  if ('militaryStatus' in over) personal.militaryStatus = over.militaryStatus

  return {
    leadUuid: 'lead-1',
    personalInformation: personal,
    financialInformation: financial,
    loanInformation: { loanAmount: 10000 },
  }
}

const steps = (ns: string) => ({
  constants: { output: constants },
  [ns]: { output: { firstName: 'Dana', lastName: 'Reyes' } },
})

const reasonOf = (r: Rejection) => r.response?.body.reason

describe('LendSwift validate_bidding_and_state', () => {
  const run = compile('lendswift')
  const go = (over?: Parameters<typeof lead>[0]) => run(lead(over), steps('parse_name'))

  // The bug. This is the assertion that could not have passed before the repair.
  it('rejects a military applicant, the case that has never once fired in production', () => {
    const r = go({ employmentStatus: 'military' })

    expect(reasonOf(r)).toBe('military status ineligible')
    expect(r.response?.status).toBe(200)
    expect(r.response?.body.status).toBe('rejected')
    // The lead id has to survive onto the rejection, which is what #926 was
    // found while adding.
    expect(r.response?.body.lead_id).toBe('lead-1')
  })

  it('no longer decides anything from the field the partner never sends', () => {
    // Both directions. The old key being present must not reject, and its
    // absence must not excuse a military applicant.
    expect(go({ militaryStatus: true }).valid ?? false).toBe(true)
    expect(reasonOf(go({ employmentStatus: 'military', militaryStatus: false }))).toBe(
      'military status ineligible',
    )
  })

  // Every other value the partner sends. Named individually rather than as a
  // blanket "not military" so a future vocabulary change has to come past here.
  for (const status of ['employed', 'employed_full_time', 'employed_part_time', 'not_employed', 'other', 'retired']) {
    it(`still admits ${status}`, () => {
      const r = go({ employmentStatus: status })
      expect(r).toEqual({ valid: true })
    })
  }

  // Fails closed, and says which cause it is. Measured absent on 0 of 27,809
  // leads, so this is expected never to fire; if it does, the partner payload
  // changed, and the alternative is silently readmitting the excluded
  // population (L42, L11).
  it('rejects rather than admits when employment status is missing, with its own reason', () => {
    for (const missing of [undefined, null, '']) {
      const r = go({ employmentStatus: missing })
      expect(reasonOf(r), String(missing)).toBe('employment status missing')
    }
  })

  it('keeps the other rejections working and distinguishable', () => {
    const payload = lead()
    payload.loanInformation.loanAmount = 999999
    expect(reasonOf(run(payload, steps('parse_name')))).toBe('loan amount exceeds maximum')

    const badState = lead()
    badState.personalInformation.state = 'NY'
    expect(reasonOf(run(badState, steps('parse_name')))).toBe('ineligible state')
  })
})

// GigFi's step became a lead validation node on 2026-10-22 (version 25, #2592),
// so its script copy is retired and the same four behaviours are held against
// the node as saved, read from the money gate's definition of the workflow. The
// script's own text still runs, against the node, in the swap grid
// (money-gate/swap/__tests__/grid.test.ts, from swap/replaced/rml-gigfi-v24.json).
describe('GigFi validate_bidding_and_state, a lead validation step since version 25', () => {
  const definition = (gigfiLive as unknown as { definition: { nodes: NodeDefinition[] } }).definition
  const node = definition.nodes.find((n) => n.namespace === 'validate_bidding_and_state')!
  const constantsNamespaces = constantsNamespacesOf(definition.nodes)

  const go = (over?: Parameters<typeof lead>[0]): Rejection => {
    const ctx = {
      trigger: { payload: lead(over), source: 'gigfi', workflow_id: 'wf', trace_id: 't', org_id: 'org' },
      steps: steps('parsed_name'),
      env: {},
      execution: { workflow_id: 'wf', trace_id: 't' },
      constantsNamespaces,
    } as unknown as ExecutionContext
    const result = executeLeadValidationNode(node, ctx)
    return result.earlyResponse
      ? { response: result.earlyResponse as Rejection['response'] }
      : { valid: true }
  }

  it('is the lead validation node, reading employment status and never militaryStatus', () => {
    expect(node.type).toBe('lead_validation')
    expect(JSON.stringify(node.config)).not.toMatch(/militaryStatus/)
    expect(JSON.stringify(node.config)).toMatch(/employmentStatus/)
  })

  // GigFi requires self_employed, so a military lead is turned away either way.
  // The repair is about the reason being true: the military check comes before
  // the self employed one, so it wins.
  it('rejects a military applicant as military rather than as unqualified', () => {
    const r = go({ employmentStatus: 'military' })
    expect(reasonOf(r)).toBe('military status ineligible')
    expect(r.response?.body.status).toBe('rejected')
    expect(r.response?.body.lead_id).toBe('lead-1')
  })

  it('still rejects other non-self-employed applicants as unqualified', () => {
    expect(reasonOf(go({ employmentStatus: 'employed' }))).toBe('unqualified')
    expect(reasonOf(go({ employmentStatus: 'retired' }))).toBe('unqualified')
  })

  it('admits a self-employed applicant, which is 100% of real GigFi traffic', () => {
    expect(go({ employmentStatus: 'self_employed' })).toEqual({ valid: true })
  })

  it('does not decide anything from the field the partner never sends', () => {
    expect(go({ employmentStatus: 'self_employed', militaryStatus: true })).toEqual({ valid: true })
  })
})

describe('the LendSwift script', () => {
  // The defect in one sentence: the old key is gone from the source text. A
  // grep-shaped assertion rather than a behavioural one, because the behaviour
  // of reading an absent field is indistinguishable from not reading it, so
  // behaviour alone cannot prove the dead reference was actually removed.
  for (const which of ['lendswift'] as Which[]) {
    it(`${which} no longer reads militaryStatus outside a comment`, () => {
      const code = sourceOf(which)
        .split('\n')
        .filter((l: string) => !l.trim().startsWith('//'))
        .join('\n')

      expect(code).not.toMatch(/militaryStatus/)
      expect(code).toMatch(/employmentStatus === 'military'/)
    })
  }
})
