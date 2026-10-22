/**
 * The RML military exclusion (#926), held against the lead validation steps both
 * RML bidding workflows now run.
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
 * Until the swaps, this suite ran a verbatim copy of each workflow's
 * `validate_bidding_and_state` script. Both steps are lead validation nodes now
 * (GigFi since version 25, #2592; LendSwift since version 26, #2593), so each
 * block runs the node as saved, under the engine's own executor, read from the
 * money gate's definition of the workflow, which the export refreshes from
 * production and refuses unless it equals what production runs. The scripts'
 * own text still runs, against the node, in the swap grid
 * (money-gate/swap/__tests__/grid.test.ts, from the versions kept in
 * money-gate/swap/replaced/).
 */
import { describe, it, expect } from 'vitest'
import { constantsNamespacesOf } from '@bidspoke/workflow-definition'
import gigfiLive from '../../../money-gate/fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'
import lendswiftLive from '../../../money-gate/fixtures/definitions/e1b810da-16c0-49eb-bf12-ba1c9b67c914.json'
import { executeLeadValidationNode } from '../nodes/lead-validation'
import type { ExecutionContext, NodeDefinition } from '../../types'

interface Rejection {
  response?: { status: number; body: { reason: string; status: string; lead_id: string } }
  valid?: boolean
}

// The real constants, read off the deployed constants node's vocabulary. States
// is only as long as it needs to be for these cases: the state check is not what
// is under test and every payload below uses an allowed one unless it says so.
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

type Lead = ReturnType<typeof lead>

const steps = (ns: string) => ({
  constants: { output: constants },
  [ns]: { output: { firstName: 'Dana', lastName: 'Reyes' } },
})

const reasonOf = (r: Rejection) => r.response?.body.reason

type Saved = { definition: { nodes: NodeDefinition[] } }

/**
 * A workflow's saved `validate_bidding_and_state` step, and a runner for it under
 * the engine's own executor. The runner takes the lead's overrides and, for the
 * fields `lead` does not cover, a change to the payload.
 */
function savedStep(saved: Saved, parsedNameStep: string, source: string) {
  const definition = saved.definition
  const node = definition.nodes.find((n) => n.namespace === 'validate_bidding_and_state')!
  const constantsNamespaces = constantsNamespacesOf(definition.nodes)
  const go = (over?: Parameters<typeof lead>[0], change: (p: Lead) => void = () => {}): Rejection => {
    const payload = lead(over)
    change(payload)
    const ctx = {
      trigger: { payload, source, workflow_id: 'wf', trace_id: 't', org_id: 'org' },
      steps: steps(parsedNameStep),
      env: {},
      execution: { workflow_id: 'wf', trace_id: 't' },
      constantsNamespaces,
    } as unknown as ExecutionContext
    const result = executeLeadValidationNode(node, ctx)
    return result.earlyResponse
      ? { response: result.earlyResponse as Rejection['response'] }
      : { valid: true }
  }
  return { node, go }
}

// The defect in one sentence: the old key is gone. A config shaped assertion
// rather than a behavioural one, because the behaviour of reading an absent
// field is indistinguishable from not reading it, so behaviour alone cannot
// prove the dead reference was actually removed.
function expectReadsEmploymentStatusNeverMilitaryStatus(node: NodeDefinition) {
  expect(node.type).toBe('lead_validation')
  expect(JSON.stringify(node.config)).not.toMatch(/militaryStatus/)
  expect(JSON.stringify(node.config)).toMatch(/employmentStatus/)
}

// LendSwift's step became a lead validation node on 2026-10-22 (version 26,
// #2593), so its script copy is retired and the same behaviours are held
// against the node as saved.
describe('LendSwift validate_bidding_and_state, a lead validation step since version 26', () => {
  const { node, go } = savedStep(lendswiftLive as unknown as Saved, 'parse_name', 'lendswift')

  it('is the lead validation node, reading employment status and never militaryStatus', () => {
    expectReadsEmploymentStatusNeverMilitaryStatus(node)
  })

  // The bug. This is the assertion that could not have passed before the repair.
  it('rejects a military applicant, the case that never once fired in production before the repair', () => {
    const r = go({ employmentStatus: 'military' })

    expect(reasonOf(r)).toBe('military status ineligible')
    expect(r.response?.status).toBe(200)
    expect(r.response?.body.status).toBe('rejected')
    // The lead id has to survive onto the rejection, which is what #926 was
    // found while adding.
    expect(r.response?.body.lead_id).toBe('lead-1')
  })

  it('does not decide anything from the field the partner never sends', () => {
    // Both directions. The old key being present must not reject, and its
    // absence must not excuse a military applicant.
    expect(go({ militaryStatus: true })).toEqual({ valid: true })
    expect(reasonOf(go({ employmentStatus: 'military', militaryStatus: false }))).toBe(
      'military status ineligible',
    )
  })

  // Every other value the partner sends. Named individually rather than as a
  // blanket "not military" so a future vocabulary change has to come past here.
  for (const status of ['employed', 'employed_full_time', 'employed_part_time', 'not_employed', 'other', 'retired']) {
    it(`still admits ${status}`, () => {
      expect(go({ employmentStatus: status })).toEqual({ valid: true })
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
    expect(reasonOf(go({}, (p) => { p.loanInformation.loanAmount = 999999 }))).toBe('loan amount exceeds maximum')
    expect(reasonOf(go({}, (p) => { p.personalInformation.state = 'NY' }))).toBe('ineligible state')
  })
})

// GigFi's step became a lead validation node on 2026-10-22 (version 25, #2592).
describe('GigFi validate_bidding_and_state, a lead validation step since version 25', () => {
  const { node, go } = savedStep(gigfiLive as unknown as Saved, 'parsed_name', 'gigfi')

  it('is the lead validation node, reading employment status and never militaryStatus', () => {
    expectReadsEmploymentStatusNeverMilitaryStatus(node)
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
