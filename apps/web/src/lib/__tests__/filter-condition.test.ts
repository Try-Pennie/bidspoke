import { describe, it, expect } from 'vitest'
import { filterConditionSummary, filterHasCondition } from '../filter-condition'

// The engine (apps/worker/src/engine/nodes/filter.ts) evaluates TWO shapes: the
// simple `config.condition`, and the legacy rule-builder `config.rules.groups`
// (only when a group actually carries a field). The card and the validation pass
// knew about the first shape only, so a rule-builder filter rendered as
// "No condition set" AND was flagged unconfigured, while it was in fact gating
// live traffic (#645). These helpers are the single source of truth for both
// surfaces and mirror the engine's precedence exactly.

const RULES = (field: string) => ({ groups: [{ conditions: [{ field, operator: 'eq', value: 'x' }] }] })

describe('filterHasCondition', () => {
  it('is false for an empty config', () => {
    expect(filterHasCondition({})).toBe(false)
  })

  it('is true for the simple condition shape', () => {
    expect(filterHasCondition({ condition: { field: 'credit_score', operator: 'gt', value: 600 } })).toBe(true)
  })

  it('is true for a rule-builder filter, which the engine does evaluate', () => {
    expect(filterHasCondition({ rules: RULES('credit_score') })).toBe(true)
  })

  it('is false for a rule-builder group with no field set, matching the engine', () => {
    // filter.ts requires hasConfiguredCondition(groups); an empty group passes
    // everything, so it is genuinely unconfigured.
    expect(filterHasCondition({ rules: { groups: [{ conditions: [{ field: '' }] }] } })).toBe(false)
    expect(filterHasCondition({ rules: { groups: [] } })).toBe(false)
  })

  it('is false when the simple condition has a blank field', () => {
    expect(filterHasCondition({ condition: { field: '  ' } })).toBe(false)
  })
})

describe('filterConditionSummary', () => {
  it('summarizes the simple condition', () => {
    expect(filterConditionSummary({ condition: { field: 'score', operator: 'gt', value: 600 } })).toBe('score > 600')
  })

  it('summarizes a single-rule rule-builder filter instead of claiming there is none', () => {
    expect(filterConditionSummary({ rules: RULES('state') })).toBe('state = x')
  })

  it('names the operator in the rule builder dropdown\'s own words, one vocabulary (#2590, design round 3)', () => {
    expect(filterConditionSummary({ condition: { field: 'state', operator: 'in_array', value: 'CA,NY' } })).toBe('state in list CA,NY')
    expect(filterConditionSummary({ condition: { field: 'active', operator: 'is_true' } })).toBe('active is true')
    expect(filterConditionSummary({ condition: { field: 'note', operator: 'not_contains', value: 'x' } })).toBe('note not contains x')
    expect(filterConditionSummary({ condition: { field: 'phone', operator: 'not_blank' } })).toBe('phone is not empty')
  })

  it('counts the conditions when a rule-builder filter has several', () => {
    const rules = {
      groups: [
        { conditions: [{ field: 'a', operator: 'eq', value: '1' }, { field: 'b', operator: 'eq', value: '2' }] },
      ],
    }
    expect(filterConditionSummary({ rules })).toBe('2 conditions')
  })

  it('returns null only when the engine would also see no condition', () => {
    expect(filterConditionSummary({})).toBeNull()
    expect(filterConditionSummary({ rules: { groups: [{ conditions: [{ field: '' }] }] } })).toBeNull()
  })

  it('prefers the simple condition when both are present, exactly as the engine does', () => {
    // filter.ts: `if (config.condition?.field) ... else if (config.rules...)`.
    const summary = filterConditionSummary({
      condition: { field: 'simple', operator: 'eq', value: 'yes' },
      rules: RULES('legacy'),
    })
    expect(summary).toBe('simple = yes')
  })
})
