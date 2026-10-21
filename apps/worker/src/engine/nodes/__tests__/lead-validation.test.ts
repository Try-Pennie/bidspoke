/**
 * The lead validation node (#2589, part of #934): ordered checks, each judged
 * three ways (pass, fail, or unevaluable with a cause), a per check choice for a
 * lead missing a value, and a missing CONFIGURATION value treated as the
 * workflow's fault rather than the lead's.
 */
import { describe, expect, it, vi } from 'vitest'
import { CONDITION_OPERATORS, type ConditionOperator } from '@bidspoke/workflow-definition'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import { classifyStepError } from '../../error-classifier'
import {
  LeadValidationConfigFault,
  LeadValidationMissingValue,
  executeLeadValidationNode,
  type LeadValidationEvent,
} from '../lead-validation'

const CONSTANTS = { states: ['TX', 'FL'], biddingActive: true, maximumLoanAmount: 50000 }

function makeCtx(payload: Record<string, unknown>, opts: { constants?: Record<string, unknown> | null; env?: Record<string, string>; parsed?: Record<string, unknown>; constantsNamespaces?: Set<string> | null } = {}) {
  const events: LeadValidationEvent[] = []
  const steps: ExecutionContext['steps'] = {}
  if (opts.constants !== null) steps.constants = { output: opts.constants ?? CONSTANTS, status: 'completed' }
  steps.parse_name = { output: opts.parsed ?? { firstName: 'Dana', lastName: 'Reyes' }, status: 'completed' }
  const ctx: ExecutionContext = {
    trigger: { payload, source: 'gigfi', workflow_id: 'wf-1', trace_id: 't-1', org_id: 'org-1' },
    steps,
    env: opts.env ?? {},
    constantsNamespaces: opts.constantsNamespaces === null ? undefined : (opts.constantsNamespaces ?? new Set(['constants'])),
    reportLeadValidation: (e) => events.push(e),
  }
  return { ctx, events }
}

const lead = (over: Record<string, unknown> = {}) => ({
  leadUuid: 'lead-1',
  personalInformation: { state: 'TX' },
  loanInformation: { loanAmount: 10000 },
  financialInformation: { employmentStatus: 'employed' },
  ...over,
})

type Cond = { field: string; operator: ConditionOperator; value?: unknown }
const check = (id: string, reason: string, conditions: Cond[], extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  condition: { logic: 'AND', groups: [{ logic: 'AND', conditions }] },
  reason,
  on_missing: 'reject',
  ...extra,
})

/** The RML GigFi validation, as the node holds it. */
const RML_CHECKS = [
  check('bidding', 'bidding not active', [{ field: 'steps.constants.output.biddingActive', operator: 'is_true' }]),
  check('state', 'ineligible state', [{ field: 'trigger.payload.personalInformation.state', operator: 'in_array', value: 'steps.constants.output.states' }]),
  check('name', 'invalid name', [
    { field: 'steps.parse_name.output.firstName', operator: 'has_letter' },
    { field: 'steps.parse_name.output.lastName', operator: 'has_letter' },
  ]),
  check('amount', 'loan amount exceeds maximum', [{ field: 'trigger.payload.loanInformation.loanAmount', operator: 'lte', value: 'steps.constants.output.maximumLoanAmount' }]),
]

const node = (checks: unknown[], over: Record<string, unknown> = {}): NodeDefinition => ({
  id: 'v',
  namespace: 'validate_bidding_and_state',
  type: 'lead_validation',
  config: { lead_id_field: 'trigger.payload.leadUuid', checks, response_headers: { 'Content-Type': 'application/json' }, ...over },
})

const run = (checks: unknown[], payload: Record<string, unknown>, opts?: Parameters<typeof makeCtx>[1], over?: Record<string, unknown>) => {
  const { ctx, events } = makeCtx(payload, opts)
  return { result: executeLeadValidationNode(node(checks, over), ctx), events }
}

describe('the control: a lead passing every check goes on', () => {
  it('continues with no response, and says it evaluated', () => {
    const { result, events } = run(RML_CHECKS, lead())
    expect(result.earlyResponse).toBeUndefined()
    expect(result.output).toEqual({ valid: true })
    expect(events).toEqual([{ kind: 'evaluated', namespace: 'validate_bidding_and_state' }])
  })
})

describe('a rejection answers exactly as the validate script does', () => {
  it('returns 200, the configured headers and { lead_id, status, reason }, and ends the walk', () => {
    const { result } = run(RML_CHECKS, lead({ personalInformation: { state: 'NY' } }))
    expect(result.earlyResponse).toEqual({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { lead_id: 'lead-1', status: 'rejected', reason: 'ineligible state' },
    })
    expect(result.continueAfterResponse).toBeUndefined()
  })

  it('records the check and the field, never the values compared', () => {
    const { result } = run(RML_CHECKS, lead({ personalInformation: { state: 'NY' } }))
    expect(result.output).toEqual({ valid: false, check_id: 'state', field: 'trigger.payload.personalInformation.state', reason: 'ineligible state' })
    const recorded = JSON.stringify({ output: result.output, resolvedInput: result.resolvedInput?.resolved })
    expect(recorded).not.toContain('NY')
    expect(recorded).not.toContain('lead-1')
  })

  it('sends no headers when none are configured', () => {
    const { result } = run(RML_CHECKS, lead({ personalInformation: { state: 'NY' } }), {}, { response_headers: undefined })
    expect(result.earlyResponse?.headers).toBeUndefined()
  })
})

describe('order: the first check a lead does not pass names the reason', () => {
  it('rejects on the earlier check when two fail', () => {
    const { result } = run(RML_CHECKS, lead({ personalInformation: { state: 'NY' }, loanInformation: { loanAmount: 90000 } }))
    expect((result.earlyResponse?.body as { reason: string }).reason).toBe('ineligible state')
  })

  it('rejects on a later check when the earlier ones pass', () => {
    const { result } = run(RML_CHECKS, lead({ loanInformation: { loanAmount: 90000 } }))
    expect((result.earlyResponse?.body as { reason: string }).reason).toBe('loan amount exceeds maximum')
  })

  it('swapping the order swaps the reason', () => {
    const payload = lead({ personalInformation: { state: 'NY' }, loanInformation: { loanAmount: 90000 } })
    const { result } = run([RML_CHECKS[3], RML_CHECKS[1]], payload)
    expect((result.earlyResponse?.body as { reason: string }).reason).toBe('loan amount exceeds maximum')
  })
})

/**
 * Every operator through the node: a lead value that passes and one that fails.
 * The value side is literal here; references are covered below.
 */
const OPERATOR_CASES: Record<ConditionOperator, { value?: unknown; pass: unknown; fail: unknown }> = {
  eq: { value: 'TX', pass: 'TX', fail: 'FL' },
  neq: { value: 'TX', pass: 'FL', fail: 'TX' },
  gt: { value: 100, pass: 101, fail: 100 },
  gte: { value: 100, pass: 100, fail: 99 },
  lt: { value: 100, pass: 99, fail: 100 },
  lte: { value: 100, pass: 100, fail: 101 },
  contains: { value: 'gig', pass: 'gigfi', fail: 'lend' },
  not_contains: { value: 'gig', pass: 'lend', fail: 'gigfi' },
  in_array: { value: ['TX', 'FL'], pass: 'FL', fail: 'NY' },
  not_in_array: { value: ['TX', 'FL'], pass: 'NY', fail: 'FL' },
  is_true: { pass: true, fail: 'true' },
  is_false: { pass: false, fail: 0 },
  is_null: { pass: null, fail: 'x' },
  is_not_null: { pass: 'x', fail: null },
  exists: { pass: 0, fail: null },
  not_exists: { pass: null, fail: '' },
  has_letter: { pass: 'Dana', fail: '1234' },
  not_blank: { pass: 'x', fail: '  ' },
}

describe('every condition operator, judged by the node', () => {
  for (const op of CONDITION_OPERATORS) {
    const c = OPERATOR_CASES[op]
    it(`${op}: passes a matching lead and rejects one that does not`, () => {
      const one = [check('only', 'unqualified', [{ field: 'trigger.payload.v', operator: op, ...('value' in c ? { value: c.value } : {}) }])]
      expect(run(one, { leadUuid: 'l', v: c.pass }).result.output, 'pass').toEqual({ valid: true })
      const failed = run(one, { leadUuid: 'l', v: c.fail }).result
      expect(failed.output, 'fail').toMatchObject({ valid: false, check_id: 'only', reason: 'unqualified' })
      expect((failed.output as { cause?: string }).cause, 'a plain fail has no cause').toBeUndefined()
    })
  }

  it('has a case for every operator in the shared list', () => {
    expect(Object.keys(OPERATOR_CASES).sort()).toEqual([...CONDITION_OPERATORS].sort())
  })

  it('compares numbers written as text as numbers, never as words', () => {
    const one = [check('amount', 'loan amount exceeds maximum', [{ field: 'trigger.payload.v', operator: 'lte', value: '50000' }])]
    expect(run(one, { v: '9' }).result.output).toEqual({ valid: true })
    expect(run(one, { v: '60000' }).result.output).toMatchObject({ valid: false })
  })

  it('reads the limit and the list from Constants and env', () => {
    const fromEnv = [check('amount', 'loan amount exceeds maximum', [{ field: 'trigger.payload.v', operator: 'lte', value: 'env.MAX' }])]
    expect(run(fromEnv, { v: 10 }, { env: { MAX: '50' } }).result.output).toEqual({ valid: true })
    expect(run(fromEnv, { v: 60 }, { env: { MAX: '50' } }).result.output).toMatchObject({ valid: false })
  })
})

describe('AND and OR, with a value that cannot be judged', () => {
  const groups = (logic: 'AND' | 'OR', conditions: Cond[]) => [
    { ...check('g', 'unqualified', []), condition: { logic: 'AND', groups: [{ logic, conditions }] } },
  ]

  it('AND: a fail beats a missing value, so the reason is the plain one with no cause', () => {
    const out = run(groups('AND', [{ field: 'trigger.payload.a', operator: 'not_blank' }, { field: 'trigger.payload.b', operator: 'eq', value: 'x' }]), { b: 'y' }).result.output
    expect(out).toEqual({ valid: false, check_id: 'g', field: 'trigger.payload.b', reason: 'unqualified' })
  })

  it('OR: one condition passing passes the check, whatever the others are', () => {
    expect(run(groups('OR', [{ field: 'trigger.payload.a', operator: 'not_blank' }, { field: 'trigger.payload.b', operator: 'eq', value: 'x' }]), { b: 'x' }).result.output).toEqual({ valid: true })
  })

  it('OR: none passing and one missing is unevaluable, which the check decides', () => {
    const out = run(groups('OR', [{ field: 'trigger.payload.a', operator: 'not_blank' }, { field: 'trigger.payload.b', operator: 'eq', value: 'x' }]), { b: 'y' }).result.output
    expect(out).toEqual({ valid: false, check_id: 'g', field: 'trigger.payload.a', reason: 'unqualified', cause: 'missing' })
  })

  it('joins groups by the check\'s own logic', () => {
    const two = [{
      ...check('g', 'unqualified', []),
      condition: {
        logic: 'OR',
        groups: [
          { logic: 'AND', conditions: [{ field: 'trigger.payload.a', operator: 'eq', value: 'x' }] },
          { logic: 'AND', conditions: [{ field: 'trigger.payload.b', operator: 'eq', value: 'x' }] },
        ],
      },
    }]
    expect(run(two, { a: 'n', b: 'x' }).result.output).toEqual({ valid: true })
    expect(run(two, { a: 'n', b: 'n' }).result.output).toMatchObject({ valid: false })
  })
})

describe('a lead missing a value: the check decides', () => {
  const amount = (on_missing: string) => [check('amount', 'loan amount exceeds maximum', [{ field: 'trigger.payload.loanInformation.loanAmount', operator: 'lte', value: 'steps.constants.output.maximumLoanAmount' }], { on_missing })]

  it('reject: the check\'s own reason, with the cause recorded', () => {
    const { result } = run(amount('reject'), lead({ loanInformation: {} }))
    expect(result.earlyResponse?.body).toEqual({ lead_id: 'lead-1', status: 'rejected', reason: 'loan amount exceeds maximum' })
    expect(result.output).toEqual({ valid: false, check_id: 'amount', field: 'trigger.payload.loanInformation.loanAmount', reason: 'loan amount exceeds maximum', cause: 'missing' })
  })

  it('pass: the lead goes on, and the output says which check it passed unjudged', () => {
    const { result } = run(amount('pass'), lead({ loanInformation: {} }))
    expect(result.earlyResponse).toBeUndefined()
    expect(result.output).toEqual({ valid: true, passed_unjudged: [{ check_id: 'amount', field: 'trigger.payload.loanInformation.loanAmount', cause: 'missing' }] })
  })

  it('pass still lets a later check reject', () => {
    const checks = [...amount('pass'), check('state', 'ineligible state', [{ field: 'trigger.payload.personalInformation.state', operator: 'eq', value: 'TX' }])]
    const { result } = run(checks, lead({ loanInformation: {}, personalInformation: { state: 'NY' } }))
    expect((result.earlyResponse?.body as { reason: string }).reason).toBe('ineligible state')
  })

  it('fail the run: a named, permanent failure that is not a configuration fault', () => {
    const { ctx, events } = makeCtx(lead({ loanInformation: {} }))
    let thrown: unknown
    try {
      executeLeadValidationNode(node(amount('fail_run')), ctx)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(LeadValidationMissingValue)
    expect((thrown as Error).message).toBe('Lead validation check amount could not be judged: trigger.payload.loanInformation.loanAmount is missing')
    expect(classifyStepError(thrown)).toBe('permanent')
    expect((thrown as { suppressAlert?: boolean }).suppressAlert).toBeUndefined()
    // The configuration was read and is whole, so the incident it might hold is over.
    expect(events).toEqual([{ kind: 'evaluated', namespace: 'validate_bidding_and_state' }])
  })

  it('a value that is there but is not a number is unevaluable too, never read as 0', () => {
    for (const notANumber of ['', '  ', 'ten', true, null]) {
      const { result } = run(amount('reject'), lead({ loanInformation: { loanAmount: notANumber } }))
      const expected = notANumber === null ? 'missing' : 'not_a_number'
      expect(result.output, JSON.stringify(notANumber)).toMatchObject({ valid: false, cause: expected })
    }
  })

  it('the presence operators judge a missing value themselves', () => {
    const exists = [check('phone', 'missing phone', [{ field: 'trigger.payload.phone', operator: 'exists' }], { on_missing: 'pass' })]
    expect(run(exists, lead()).result.output).toMatchObject({ valid: false, reason: 'missing phone' })
    expect((run(exists, lead()).result.output as { cause?: string }).cause).toBeUndefined()
  })

  it('a missing lead id is left out of the answer, as the script left it out', () => {
    const { result } = run(RML_CHECKS, { personalInformation: { state: 'NY' }, loanInformation: { loanAmount: 1 } })
    expect(JSON.parse(JSON.stringify(result.earlyResponse?.body))).toEqual({ status: 'rejected', reason: 'ineligible state' })
  })
})

describe('a missing configuration value is the workflow\'s fault, not the lead\'s', () => {
  const fault = (fn: () => unknown): LeadValidationConfigFault => {
    try {
      fn()
    } catch (e) {
      if (e instanceof LeadValidationConfigFault) return e
      throw e
    }
    throw new Error('no fault thrown')
  }

  it('a Constants key that is not there fails the run once, named, alerted per incident and never per lead', () => {
    const { ctx, events } = makeCtx(lead(), { constants: { states: ['TX'], biddingActive: true } })
    const e = fault(() => executeLeadValidationNode(node(RML_CHECKS), ctx))
    expect(e.message).toBe('Lead validation setting missing: check amount reads steps.constants.output.maximumLoanAmount, which is missing')
    expect(e.faults).toEqual([{ check_id: 'amount', reference: 'steps.constants.output.maximumLoanAmount', problem: 'missing' }])
    expect(e.suppressAlert).toBe(true)
    expect(classifyStepError(e)).toBe('permanent')
    expect(events).toEqual([{ kind: 'config_fault', namespace: 'validate_bidding_and_state', faults: e.faults }])
  })

  it('is found before any check runs, so a lead an earlier check rejects still reports it', () => {
    const { ctx } = makeCtx(lead({ personalInformation: { state: 'NY' } }), { constants: { states: ['TX'], biddingActive: true } })
    expect(fault(() => executeLeadValidationNode(node(RML_CHECKS), ctx)).faults.map((f) => f.check_id)).toEqual(['amount'])
  })

  it('names a field side setting, an env value, a limit that is not a number and a list that is not a list', () => {
    const checks = [
      check('bidding', 'bidding not active', [{ field: 'steps.constants.output.biddingActive', operator: 'is_true' }]),
      check('env', 'unqualified', [{ field: 'trigger.payload.v', operator: 'gte', value: 'env.MIN' }]),
      check('amount', 'loan amount exceeds maximum', [{ field: 'trigger.payload.v', operator: 'lte', value: 'steps.constants.output.maximumLoanAmount' }]),
      check('state', 'ineligible state', [{ field: 'trigger.payload.s', operator: 'in_array', value: 'steps.constants.output.states' }]),
    ]
    const { ctx } = makeCtx({ v: 1, s: 'TX' }, { constants: { biddingActive: null, maximumLoanAmount: '', states: 'TX' } })
    expect(fault(() => executeLeadValidationNode(node(checks), ctx)).faults).toEqual([
      { check_id: 'bidding', reference: 'steps.constants.output.biddingActive', problem: 'missing' },
      { check_id: 'env', reference: 'env.MIN', problem: 'missing' },
      { check_id: 'amount', reference: 'steps.constants.output.maximumLoanAmount', problem: 'not_a_number' },
      { check_id: 'state', reference: 'steps.constants.output.states', problem: 'not_a_list' },
    ])
  })

  it('a Constants step that never ran is a fault, not a missing lead value', () => {
    const { ctx } = makeCtx(lead(), { constants: null })
    expect(fault(() => executeLeadValidationNode(node(RML_CHECKS), ctx)).faults.map((f) => f.problem)).toEqual(['missing', 'missing', 'missing'])
  })

  it('a stored config the parser refuses is a fault too, with the parser\'s words', () => {
    const { ctx, events } = makeCtx(lead())
    const e = fault(() => executeLeadValidationNode(node([]), ctx))
    expect(e.faults).toEqual([{ check_id: null, reference: null, problem: 'config_invalid', detail: 'No checks set' }])
    expect(e.message).toBe('Lead validation setting missing: the node config is not runnable: No checks set')
    expect(events[0]?.kind).toBe('config_fault')
  })

  it('never puts a configuration value in the message', () => {
    const { ctx } = makeCtx(lead(), { constants: { biddingActive: true, states: ['TX'], maximumLoanAmount: 'secret-ish' } })
    expect(fault(() => executeLeadValidationNode(node(RML_CHECKS), ctx)).message).not.toContain('secret-ish')
  })

  it('refuses to run without the walk\'s Constants namespaces rather than mistaking a setting for the lead', () => {
    const { ctx } = makeCtx(lead(), { constantsNamespaces: null })
    expect(() => executeLeadValidationNode(node(RML_CHECKS), ctx)).toThrow('Lead validation needs the workflow\'s Constants steps, which this run did not provide')
  })

  it('a run without a reporter still fails loud', () => {
    const { ctx } = makeCtx(lead(), { constants: { states: ['TX'] } })
    ctx.reportLeadValidation = undefined
    expect(() => executeLeadValidationNode(node(RML_CHECKS), ctx)).toThrow(LeadValidationConfigFault)
  })
})

describe('the reporter is told once per run', () => {
  it('a rejection reports one evaluated event', () => {
    const report = vi.fn()
    const { ctx } = makeCtx(lead({ personalInformation: { state: 'NY' } }))
    ctx.reportLeadValidation = report
    executeLeadValidationNode(node(RML_CHECKS), ctx)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith({ kind: 'evaluated', namespace: 'validate_bidding_and_state' })
  })
})
