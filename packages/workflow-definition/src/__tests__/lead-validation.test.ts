import { describe, expect, it } from 'vitest'
import {
  LEAD_VALIDATION_ON_MISSING,
  constantsNamespacesOf,
  findLeadValidationProblems,
  isLeadValidationConfigReference,
  leadValidationConfigProblem,
  leadValidationReferences,
  parseLeadValidationConfig,
  parseNodeReference,
} from '../lead-validation'
import { validateWorkflowDef } from '../workflow-validation'
import { LEAD_REJECTION_REASONS } from '../lead-rejection-reasons'

/** A check every rule below accepts, so each test changes exactly one thing. */
const stateCheck = () => ({
  id: 'state',
  label: 'Eligible state',
  condition: {
    logic: 'AND',
    groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.personalInformation.state', operator: 'in_array', value: 'steps.constants.output.states' }] }],
  },
  reason: 'ineligible state',
  on_missing: 'reject',
})

const config = (over: Record<string, unknown> = {}) => ({
  lead_id_field: 'trigger.payload.leadUuid',
  checks: [stateCheck()],
  response_headers: { 'Content-Type': 'application/json' },
  ...over,
})

const withCondition = (cond: Record<string, unknown>) =>
  config({ checks: [{ ...stateCheck(), condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [cond] }] } }] })

describe('parseLeadValidationConfig: the shape a saved node must have', () => {
  it('accepts a complete config and keeps its checks in order', () => {
    const parsed = parseLeadValidationConfig(config({ checks: [stateCheck(), { ...stateCheck(), id: 'name', label: 'Name', reason: 'invalid name' }] }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.checks.map((c) => c.id)).toEqual(['state', 'name'])
  })

  it('refuses zero checks', () => {
    expect(leadValidationConfigProblem(config({ checks: [] }))).toBe('No checks set')
    expect(leadValidationConfigProblem(config({ checks: undefined }))).toBe('No checks set')
  })

  it('refuses an empty lead id field', () => {
    expect(leadValidationConfigProblem(config({ lead_id_field: '' }))).toBe('No lead id field set')
    expect(leadValidationConfigProblem(config({ lead_id_field: '   ' }))).toBe('No lead id field set')
    expect(leadValidationConfigProblem(config({ lead_id_field: undefined }))).toBe('No lead id field set')
  })

  it('refuses a reason not in the list, and names it', () => {
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), reason: 'bad state' }] }))).toBe(
      'Check "Eligible state": "bad state" is not a rejection reason Bidspoke knows',
    )
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), reason: '' }] }))).toBe('Check "Eligible state": no rejection reason chosen')
  })

  it('accepts every listed reason', () => {
    for (const reason of LEAD_REJECTION_REASONS) {
      expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), reason }] })), reason).toBeNull()
    }
  })

  it('refuses a missing value outcome outside the three', () => {
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), on_missing: 'skip' }] }))).toBe(
      'Check "Eligible state": no choice for a lead missing a value (reject, pass or fail the run)',
    )
    for (const outcome of LEAD_VALIDATION_ON_MISSING) {
      expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), on_missing: outcome }] })), outcome).toBeNull()
    }
  })

  it('refuses a check with no label or no id, and two checks sharing an id', () => {
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), label: ' ' }] }))).toBe('Check 1 has no label')
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), id: '' }] }))).toBe('Check "Eligible state" has no id')
    expect(leadValidationConfigProblem(config({ checks: [stateCheck(), { ...stateCheck(), label: 'Again' }] }))).toBe('Check "Again" has the same id as another check')
  })

  it('refuses a check with no conditions, or a group with none', () => {
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), condition: { logic: 'AND', groups: [] } }] }))).toBe('Check "Eligible state" has no conditions')
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [] }] } }] }))).toBe(
      'Check "Eligible state" has a group with no conditions',
    )
  })

  it('refuses a logic other than AND or OR, at either level', () => {
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), condition: { ...stateCheck().condition, logic: 'XOR' } }] }))).toBe(
      'Check "Eligible state" joins its groups by neither AND nor OR',
    )
    const groups = [{ ...stateCheck().condition.groups[0], logic: undefined }]
    expect(leadValidationConfigProblem(config({ checks: [{ ...stateCheck(), condition: { logic: 'AND', groups } }] }))).toBe(
      'Check "Eligible state" joins a group\'s conditions by neither AND nor OR',
    )
  })

  it('refuses a half filled row: a value with no field, a field with no operator, an unknown operator', () => {
    expect(leadValidationConfigProblem(withCondition({ field: '', operator: 'in_array', value: ['NY'] }))).toBe('Check "Eligible state": a condition has no field')
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.state', value: ['NY'] }))).toBe(
      'Check "Eligible state": the condition on trigger.payload.state has no operator',
    )
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.state', operator: 'matches', value: 'x' }))).toBe(
      'Check "Eligible state": "matches" is not a condition Bidspoke knows',
    )
  })

  it('refuses an empty value on every operator that reads one', () => {
    const empty = (operator: string, value: unknown) => leadValidationConfigProblem(withCondition({ field: 'trigger.payload.x', operator, value }))
    const message = 'Check "Eligible state": the condition on trigger.payload.x has no value'
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'in_array', 'not_in_array']) {
      expect(empty(op, undefined), op).toBe(message)
      expect(empty(op, null), op).toBe(message)
      expect(empty(op, ''), op).toBe(message)
      expect(empty(op, '  '), op).toBe(message)
    }
    expect(empty('in_array', [])).toBe(message)
    expect(empty('in_array', ['NY', ''])).toBe('Check "Eligible state": the list on trigger.payload.x has an empty entry')
  })

  it('accepts no value on the operators that read only the field', () => {
    for (const op of ['is_true', 'is_false', 'is_null', 'is_not_null', 'exists', 'not_exists', 'has_letter', 'not_blank']) {
      expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.x', operator: op })), op).toBeNull()
    }
  })

  it('refuses a number comparison against a literal that is not a number', () => {
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.amount', operator: 'lte', value: 'lots' }))).toBe(
      'Check "Eligible state": the condition on trigger.payload.amount compares against "lots", which is not a number',
    )
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.amount', operator: 'lte', value: '50000' }))).toBeNull()
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.amount', operator: 'lte', value: 50000 }))).toBeNull()
  })

  it('refuses a list operator against a literal that is not a list', () => {
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.state', operator: 'in_array', value: 'NY,NJ' }))).toBe(
      'Check "Eligible state": the condition on trigger.payload.state needs a list or a reference to one',
    )
  })

  it('refuses a reference on an operator that compares text, which would never be resolved', () => {
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.state', operator: 'eq', value: 'steps.constants.output.state' }))).toBe(
      'Check "Eligible state": the condition on trigger.payload.state compares against steps.constants.output.state as text; this operator cannot read a value from it',
    )
  })

  it('refuses a field that does not name a value', () => {
    expect(leadValidationConfigProblem(withCondition({ field: 'state', operator: 'not_blank' }))).toBe(
      'Check "Eligible state": state is not a reference (it starts with trigger., steps. or env.)',
    )
    expect(leadValidationConfigProblem(withCondition({ field: 'trigger.payload.a ?? trigger.payload.b', operator: 'not_blank' }))).toBe(
      'Check "Eligible state": trigger.payload.a ?? trigger.payload.b is not a reference (it starts with trigger., steps. or env.)',
    )
    expect(leadValidationConfigProblem(withCondition({ field: 'execution.trace_id', operator: 'not_blank' }))).toBe(
      'Check "Eligible state": execution.trace_id is not a reference (it starts with trigger., steps. or env.)',
    )
  })

  it('refuses a header with a blank name or value', () => {
    expect(leadValidationConfigProblem(config({ response_headers: { 'Content-Type': '' } }))).toBe('Response header Content-Type has no value')
    expect(leadValidationConfigProblem(config({ response_headers: { ' ': 'x' } }))).toBe('A response header has no name')
    expect(leadValidationConfigProblem(config({ response_headers: { 'X-N': 7 } }))).toBe('Response header X-N has no value')
    expect(leadValidationConfigProblem(config({ response_headers: undefined }))).toBeNull()
  })
})

describe('parseNodeReference', () => {
  it('reads a step reference with or without .output, as the condition resolver does', () => {
    expect(parseNodeReference('steps.constants.output.states')).toEqual({ root: 'steps', namespace: 'constants', key: 'states' })
    expect(parseNodeReference('steps.constants.states')).toEqual({ root: 'steps', namespace: 'constants', key: 'states' })
    expect(parseNodeReference('steps.constants.output.states[0]')).toEqual({ root: 'steps', namespace: 'constants', key: 'states' })
    expect(parseNodeReference('steps.constants.output')).toEqual({ root: 'steps', namespace: 'constants', key: null })
  })

  it('reads trigger and env references, and refuses anything else', () => {
    expect(parseNodeReference('trigger.payload.leadUuid')).toEqual({ root: 'trigger', namespace: null, key: null })
    expect(parseNodeReference('env.MAX_LOAN')).toEqual({ root: 'env', namespace: null, key: 'MAX_LOAN' })
    for (const bad of ['', 'env', 'env.', 'steps', 'steps.', 'steps..x', ' trigger.payload.x', 'payload.x', 'a ?? b', 'execution.trace_id']) {
      expect(parseNodeReference(bad), bad).toBeNull()
    }
  })
})

describe('the node references and which of them are configuration', () => {
  it('lists the lead id field and every field and reference value, by check', () => {
    const parsed = parseLeadValidationConfig(
      config({
        checks: [
          stateCheck(),
          {
            ...stateCheck(),
            id: 'amount',
            label: 'Amount',
            condition: { logic: 'AND', groups: [{ logic: 'OR', conditions: [{ field: 'trigger.payload.loan', operator: 'lte', value: 50000 }, { field: 'steps.parse.output.x', operator: 'gte', value: 'env.MIN' }] }] },
          },
        ],
      }),
    )
    if (!parsed.ok) throw new Error(parsed.problems.join())
    expect(leadValidationReferences(parsed.config)).toEqual([
      { checkId: null, side: 'lead_id', path: 'trigger.payload.leadUuid' },
      { checkId: 'state', side: 'field', path: 'trigger.payload.personalInformation.state' },
      { checkId: 'state', side: 'value', path: 'steps.constants.output.states' },
      { checkId: 'amount', side: 'field', path: 'trigger.payload.loan' },
      { checkId: 'amount', side: 'field', path: 'steps.parse.output.x' },
      { checkId: 'amount', side: 'value', path: 'env.MIN' },
    ])
  })

  it('counts env and a Constants node output as configuration, and the lead as not', () => {
    const constants = new Set(['constants'])
    expect(isLeadValidationConfigReference('env.MAX', constants)).toBe(true)
    expect(isLeadValidationConfigReference('steps.constants.output.states', constants)).toBe(true)
    expect(isLeadValidationConfigReference('steps.constants.biddingActive', constants)).toBe(true)
    expect(isLeadValidationConfigReference('steps.parse_name.output.firstName', constants)).toBe(false)
    expect(isLeadValidationConfigReference('trigger.payload.state', constants)).toBe(false)
  })

  it('names the Constants nodes of a definition', () => {
    expect([...constantsNamespacesOf([{ type: 'constants', namespace: 'constants' }, { type: 'code', namespace: 'parse' }, { type: 'constants', namespace: 'more' }])]).toEqual(['constants', 'more'])
  })
})

describe('findLeadValidationProblems: references judged against the workflow', () => {
  const nodes = (validationConfig: Record<string, unknown>) => [
    { id: 'c', type: 'constants', namespace: 'constants', config: { data: { states: ['NY'], maximumLoanAmount: 50000, biddingActive: true } } },
    { id: 'p', type: 'code', namespace: 'parse_name', config: { script: 'return {}' } },
    { id: 'v', type: 'lead_validation', namespace: 'validate_bidding_and_state', label: 'Validate', config: validationConfig },
    { id: 'later', type: 'code', namespace: 'later', config: { script: 'return {}' } },
  ]
  const edges = [
    { source: 'trigger', target: 'c' },
    { source: 'c', target: 'p' },
    { source: 'p', target: 'v' },
    { source: 'v', target: 'later' },
  ]
  const messages = (cfg: Record<string, unknown>) => findLeadValidationProblems(nodes(cfg), edges).map((p) => p.message)

  it('passes a config whose every reference runs before it and names a real Constants key', () => {
    expect(messages(config())).toEqual([])
    expect(messages(withCondition({ field: 'steps.parse_name.output.firstName', operator: 'has_letter' }))).toEqual([])
    expect(messages(withCondition({ field: 'steps.constants.biddingActive', operator: 'is_true' }))).toEqual([])
    expect(messages(withCondition({ field: 'trigger.payload.amount', operator: 'lte', value: 'env.MAX_LOAN' }))).toEqual([])
  })

  it('refuses a step that does not run before the node', () => {
    expect(messages(withCondition({ field: 'steps.later.output.x', operator: 'not_blank' }))).toEqual([
      'Check "Eligible state": steps.later.output.x reads later, which does not run before this step',
    ])
    expect(messages(withCondition({ field: 'steps.ghost.output.x', operator: 'not_blank' }))).toEqual([
      'Check "Eligible state": steps.ghost.output.x reads ghost, which does not run before this step',
    ])
    expect(messages(withCondition({ field: 'steps.validate_bidding_and_state.output.x', operator: 'not_blank' }))).toEqual([
      'Check "Eligible state": steps.validate_bidding_and_state.output.x reads validate_bidding_and_state, which does not run before this step',
    ])
  })

  it('refuses a Constants key the Constants node does not hold, on the field side and the value side', () => {
    expect(messages(withCondition({ field: 'trigger.payload.state', operator: 'in_array', value: 'steps.constants.output.stateList' }))).toEqual([
      'Check "Eligible state": steps.constants.output.stateList names stateList, which the constants step does not hold',
    ])
    expect(messages(withCondition({ field: 'steps.constants.output.biddingOn', operator: 'is_true' }))).toEqual([
      'Check "Eligible state": steps.constants.output.biddingOn names biddingOn, which the constants step does not hold',
    ])
    expect(messages(withCondition({ field: 'steps.constants.output', operator: 'exists' }))).toEqual([
      'Check "Eligible state": steps.constants.output names no key of the constants step',
    ])
  })

  it('refuses a lead id field that does not run before the node', () => {
    expect(messages(config({ lead_id_field: 'steps.later.output.id' }))).toEqual(['The lead id field steps.later.output.id reads later, which does not run before this step'])
  })

  it('reports the shape problems too, so the save route needs one call', () => {
    expect(messages(config({ checks: [] }))).toEqual(['No checks set'])
  })

  it('judges only attached nodes, as every other save time rule does', () => {
    const detached = nodes(config({ checks: [] }))
    expect(findLeadValidationProblems(detached, [])).toEqual([])
  })

  it('agrees with validateWorkflowDef on the shape, which the canvas and the enable check read', () => {
    expect(validateWorkflowDef(nodes(config({ checks: [] })), edges).map((e) => e.message)).toEqual(['No checks set'])
    expect(validateWorkflowDef(nodes(config()), edges)).toEqual([])
  })
})
