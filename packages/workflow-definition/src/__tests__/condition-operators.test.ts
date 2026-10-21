import { describe, it, expect } from 'vitest'
import { ROOT_NAMESPACES } from '@bidspoke/references'
import {
  CONDITION_OPERATORS,
  CONDITION_OPERATOR_SPECS,
  CONDITION_REFERENCE_ROOTS,
  RULE_BUILDER_OPERATORS,
  SIMPLE_FILTER_OPERATORS,
  VALUE_LESS_OPERATORS,
  isConditionOperator,
  isConditionValueReference,
  operatorTakesValue,
} from '../condition-operators'

// #2588: the one list of condition operators both apps read. Both apps'
// EdgeCondition types and the worker's switch derive from it, and the derived
// dropdown views below are what the canvas moves onto in #2588's second half, so
// these tests pin the list itself and what each derived view may contain.

describe('CONDITION_OPERATORS', () => {
  it('holds every operator the engine evaluated before #2588, plus the two the validation scripts need', () => {
    // The sixteen were the hand-kept union in apps/web/src/types/workflow.ts and
    // apps/worker/src/types.ts on 2026-10-21. Every live definition stores one of
    // these spellings, so none may be renamed or dropped.
    const before2588 = [
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains',
      'is_true', 'is_false', 'exists', 'not_exists', 'is_null', 'is_not_null',
      'in_array', 'not_in_array',
    ]
    for (const op of before2588) expect(CONDITION_OPERATORS).toContain(op)
    expect(CONDITION_OPERATORS).toContain('has_letter')
    expect(CONDITION_OPERATORS).toContain('not_blank')
    expect(CONDITION_OPERATORS).toHaveLength(18)
  })

  it('has no duplicates', () => {
    expect(new Set(CONDITION_OPERATORS).size).toBe(CONDITION_OPERATORS.length)
  })

  it('isConditionOperator accepts every listed operator and refuses anything else, inherited names included', () => {
    for (const op of CONDITION_OPERATORS) expect(isConditionOperator(op)).toBe(true)
    for (const bad of ['', 'equals', 'constructor', 'toString', 'GT', undefined, null, 1]) {
      expect(isConditionOperator(bad)).toBe(false)
    }
  })
})

describe('derived operator views', () => {
  it('the rule builder offers every operator, in the list order, each with a label', () => {
    expect(RULE_BUILDER_OPERATORS.map((o) => o.value)).toEqual([...CONDITION_OPERATORS])
    for (const o of RULE_BUILDER_OPERATORS) expect(o.label.trim()).not.toBe('')
  })

  it('keeps the rule builder labels the canvas showed before #2588', () => {
    const label = (op: string) => RULE_BUILDER_OPERATORS.find((o) => o.value === op)?.label
    expect(label('eq')).toBe('=')
    expect(label('neq')).toBe('≠')
    expect(label('gte')).toBe('≥')
    expect(label('not_contains')).toBe('not contains')
    expect(label('in_array')).toBe('in list')
    expect(label('not_exists')).toBe('not exists')
  })

  it('names the two lead validation operators as Dan settled them (#2590, design round 4)', () => {
    // docs/design/lead-validation-node.html, decision D4: worded like the existing
    // choices (contains, is null), so the dropdown reads as one family.
    expect(CONDITION_OPERATOR_SPECS.has_letter.label).toBe('contains a letter')
    expect(CONDITION_OPERATOR_SPECS.has_letter.words).toBe('contains a letter')
    expect(CONDITION_OPERATOR_SPECS.not_blank.label).toBe('is not empty')
    expect(CONDITION_OPERATOR_SPECS.not_blank.words).toBe('is not empty')
  })

  it('the simple Filter dropdown offers exactly the ten it offered before, with its spelled out labels', () => {
    expect(SIMPLE_FILTER_OPERATORS.map((o) => o.value)).toEqual([
      'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'exists', 'not_exists',
    ])
    const label = (op: string) => SIMPLE_FILTER_OPERATORS.find((o) => o.value === op)?.label
    expect(label('eq')).toBe('equals')
    expect(label('gte')).toBe('greater than or equal')
    expect(label('not_exists')).toBe('does not exist')
  })

  it('value-less operators are exactly the ones whose value the engine ignores', () => {
    expect([...VALUE_LESS_OPERATORS].sort()).toEqual(
      ['exists', 'has_letter', 'is_false', 'is_not_null', 'is_null', 'is_true', 'not_blank', 'not_exists'],
    )
    for (const op of CONDITION_OPERATORS) {
      expect(operatorTakesValue(op)).toBe(!VALUE_LESS_OPERATORS.has(op))
    }
  })

  it('every operator states its value kind', () => {
    for (const op of CONDITION_OPERATORS) {
      expect(['none', 'scalar', 'number', 'text', 'list']).toContain(CONDITION_OPERATOR_SPECS[op].valueKind)
    }
    expect(CONDITION_OPERATOR_SPECS.gt.valueKind).toBe('number')
    expect(CONDITION_OPERATOR_SPECS.lte.valueKind).toBe('number')
    expect(CONDITION_OPERATOR_SPECS.eq.valueKind).toBe('scalar')
    expect(CONDITION_OPERATOR_SPECS.in_array.valueKind).toBe('list')
  })
})

describe('condition value references', () => {
  it('the roots a condition value may name are the shared reference roots the condition resolver reads', () => {
    // Drawn from ROOT_NAMESPACES rather than a second prefix list. `execution` is
    // left out only because the worker's resolveField has no branch for it, which
    // the worker's own graph test pins.
    for (const root of CONDITION_REFERENCE_ROOTS) expect(ROOT_NAMESPACES).toContain(root)
    expect([...CONDITION_REFERENCE_ROOTS].sort()).toEqual(['env', 'steps', 'trigger'])
  })

  it('recognises a reference by its root and a dot, and nothing else', () => {
    expect(isConditionValueReference('steps.constants.output.maximumLoanAmount')).toBe(true)
    expect(isConditionValueReference('trigger.payload.amount')).toBe(true)
    expect(isConditionValueReference('env.MAX')).toBe(true)
    expect(isConditionValueReference('steps.a ?? steps.b')).toBe(true)
    for (const literal of ['1000', '', 'steps', 'stepsx.a', ' steps.a', 'execution.trace_id', 'Steps.a', 'payload.amount']) {
      expect(isConditionValueReference(literal)).toBe(false)
    }
    for (const nonString of [1000, null, undefined, ['steps.a'], { steps: 1 }]) {
      expect(isConditionValueReference(nonString)).toBe(false)
    }
  })
})
