/**
 * What the canvas reads of a lead validation step (#2590): the short form of
 * each check's condition its settings list shows, the words for what a check
 * does with a lead missing a value, and the save rule that keeps the step out
 * of a parallel block.
 */
import { describe, expect, it } from 'vitest'
import {
  LEAD_VALIDATION_ON_MISSING,
  LEAD_VALIDATION_ON_MISSING_LABELS,
  findLeadValidationPlacementProblems,
  leadValidationCheckSummary,
} from '../lead-validation'
// The settled design's own fixture, so the summary is held to the rows Dan
// chose, not to a copy of them.
import designFixture from '../../../../docs/design/lead-validation-node.fixture.json'

interface FixtureRow { field: string; operator: string; value: string }
interface FixtureCheck { label: string; match: string; rows: FixtureRow[] }
interface Fixture { checks: FixtureCheck[]; missing: { value: string; label: string }[] }

const fixture: Fixture = designFixture

const asCheck = (c: FixtureCheck) => ({
  label: c.label,
  condition: { logic: 'AND', groups: [{ logic: c.match, conditions: c.rows.map((r) => ({ field: r.field, operator: r.operator, value: r.value })) }] },
})

describe('leadValidationCheckSummary: the short form a list row shows (D2)', () => {
  it('reads the settled rows exactly, in the rule builder dropdown words', () => {
    expect(fixture.checks.map((c) => leadValidationCheckSummary(asCheck(c)))).toEqual([
      'biddingActive is true',
      'state in list states',
      'firstName contains a letter and 1 more',
      'loanAmount ≤ maximumLoanAmount',
      'employmentStatus ≠ military',
      'employmentStatus = self_employed',
      'primaryPhone is not empty',
    ])
  })

  it('counts conditions in every group for "and N more"', () => {
    const check = {
      condition: {
        logic: 'OR',
        groups: [
          { logic: 'AND', conditions: [{ field: 'trigger.payload.a', operator: 'exists' }] },
          { logic: 'AND', conditions: [{ field: 'trigger.payload.b', operator: 'exists' }, { field: 'trigger.payload.c', operator: 'exists' }] },
        ],
      },
    }
    expect(leadValidationCheckSummary(check)).toBe('a exists and 2 more')
  })

  it('shows a literal list as written and a literal number as a number', () => {
    expect(leadValidationCheckSummary({ condition: { groups: [{ conditions: [{ field: 'trigger.payload.state', operator: 'in_array', value: ['CA', 'NY'] }] }] } })).toBe('state in list CA, NY')
    expect(leadValidationCheckSummary({ condition: { groups: [{ conditions: [{ field: 'trigger.payload.amount', operator: 'gte', value: 2000 }] }] } })).toBe('amount ≥ 2000')
  })

  it('is null for a check with no condition yet, and skips a row with no field', () => {
    expect(leadValidationCheckSummary({})).toBeNull()
    expect(leadValidationCheckSummary({ condition: { groups: [] } })).toBeNull()
    expect(leadValidationCheckSummary({ condition: { groups: [{ conditions: [{ field: '', operator: 'eq', value: '' }] }] } })).toBeNull()
  })

  it('never shows an inherited name for an operator from stored config', () => {
    expect(leadValidationCheckSummary({ condition: { groups: [{ conditions: [{ field: 'trigger.payload.a', operator: 'constructor' }] }] } })).toBe('a')
  })
})

describe('LEAD_VALIDATION_ON_MISSING_LABELS: the words for a lead missing a value (D14)', () => {
  it('names every choice the engine supports, in its order, in the settled words', () => {
    expect(LEAD_VALIDATION_ON_MISSING.map((v) => LEAD_VALIDATION_ON_MISSING_LABELS[v])).toEqual(fixture.missing.map((m) => m.label))
  })
})

describe('findLeadValidationPlacementProblems: never inside a parallel block', () => {
  const MESSAGE = 'A lead validation step cannot run inside a parallel block: a lead it rejects there cannot be answered. Move it before the parallel block.'
  const node = (id: string, type: string) => ({ id, type, namespace: id, config: {} })

  it('refuses the step as a parallel slot, naming it', () => {
    const nodes = [node('par', 'parallel'), node('v', 'lead_validation'), node('other', 'code'), node('end', 'parallel_end')]
    const edges = [
      { source: 'trigger', target: 'par' },
      { source: 'par', target: 'v', source_handle: 'child-0' },
      { source: 'par', target: 'other', source_handle: 'child-1' },
      { source: 'v', target: 'end' },
      { source: 'other', target: 'end' },
    ]
    expect(findLeadValidationPlacementProblems(nodes, edges)).toEqual([{ nodeId: 'v', namespace: 'v', message: MESSAGE }])
  })

  it('refuses the step further down a slot, before the join', () => {
    const nodes = [node('par', 'parallel'), node('first', 'code'), node('v', 'lead_validation'), node('end', 'parallel_end')]
    const edges = [
      { source: 'par', target: 'first', source_handle: 'child-0' },
      { source: 'first', target: 'v' },
      { source: 'v', target: 'end' },
    ]
    expect(findLeadValidationPlacementProblems(nodes, edges).map((p) => p.nodeId)).toEqual(['v'])
  })

  it('passes the step before the parallel block and after its join', () => {
    const nodes = [node('before', 'lead_validation'), node('par', 'parallel'), node('a', 'code'), node('end', 'parallel_end'), node('after', 'lead_validation')]
    const edges = [
      { source: 'trigger', target: 'before' },
      { source: 'before', target: 'par' },
      { source: 'par', target: 'a', source_handle: 'child-0' },
      { source: 'a', target: 'end' },
      { source: 'end', target: 'after' },
    ]
    expect(findLeadValidationPlacementProblems(nodes, edges)).toEqual([])
  })

  it('reads a legacy parallel by its children list, where only the child itself runs in the block', () => {
    const nodes = [{ ...node('par', 'parallel'), children: ['v'] }, node('v', 'lead_validation'), node('next', 'lead_validation')]
    const edges = [{ source: 'par', target: 'v' }, { source: 'v', target: 'next' }]
    expect(findLeadValidationPlacementProblems(nodes, edges).map((p) => p.nodeId)).toEqual(['v'])
  })
})
