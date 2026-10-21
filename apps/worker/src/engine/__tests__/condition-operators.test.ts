import { describe, it, expect } from 'vitest'
import { CONDITION_OPERATORS, CONDITION_REFERENCE_ROOTS } from '@bidspoke/workflow-definition'
import { evaluateConditionGroups, resolveField } from '../graph'
import type { ExecutionContext, EdgeCondition } from '../../types'

// #2588: the operators the lead validation scripts need (has_letter, not_blank),
// and numeric comparisons whose value side may be a reference, evaluated by the
// one switch every Filter, Branch, edge and tier gate goes through.

function ctx(payload: unknown = {}, steps: Record<string, unknown> = {}, env: Record<string, string> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 'trace' },
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { output: v, status: 'completed' as const }])),
    env,
  }
}

function check(operator: EdgeCondition['operator'], actual: unknown, value?: unknown, c?: ExecutionContext): boolean {
  const context = c ?? ctx({ x: actual })
  return evaluateConditionGroups([{ conditions: [{ field: 'trigger.payload.x', operator, value }], logic: 'AND' }], 'AND', context)
}

// The scripts' own helper, verbatim from the live RML GigFi and LendSwift
// validate_bidding_and_state steps (2026-10-21). has_letter must agree with
// !isBlank on every string, which is the whole of what those scripts use it for.
function isBlank(name: string): boolean {
  return !name || name.trim() === '' || !/[a-zA-Z]/.test(name)
}

const STRINGS = [
  '', ' ', '   ', '\t\n', ' ', '﻿', 'a', 'Z', ' a ', '123', '1a', '.', '-', "O'Brien",
  'José', 'é', 'Ñ', 'Łukasz', 'Ωmega', '李', 'Müller', 'ß', 'ａ', 'x́', ' b ',
]

describe('has_letter', () => {
  it('agrees with the scripts\' !isBlank on every string, non-ASCII names included', () => {
    for (const s of STRINGS) expect({ s, v: check('has_letter', s) }).toEqual({ s, v: !isBlank(s) })
  })

  it('is ASCII [a-zA-Z] exactly: an accented or non-Latin letter alone is not a letter', () => {
    expect(check('has_letter', 'José')).toBe(true)
    expect(check('has_letter', 'é')).toBe(false)
    expect(check('has_letter', '李')).toBe(false)
    expect(check('has_letter', 'ａ')).toBe(false)
  })

  it('is false for anything that is not a string, rather than reading its text form', () => {
    // /[a-zA-Z]/.test(true) is true because test() stringifies; a boolean is not a name.
    for (const v of [undefined, null, true, false, 0, 12, NaN, ['a'], { a: 'a' }]) {
      expect(check('has_letter', v)).toBe(false)
    }
  })

  it('ignores any stored value', () => {
    expect(check('has_letter', 'a', 'zzz')).toBe(true)
    expect(check('has_letter', '1', 'a')).toBe(false)
  })
})

describe('not_blank', () => {
  it('is true only for a string with something left after JS trim', () => {
    expect(check('not_blank', 'a')).toBe(true)
    expect(check('not_blank', ' 555 ')).toBe(true)
    expect(check('not_blank', '.')).toBe(true)
    expect(check('not_blank', '')).toBe(false)
    expect(check('not_blank', '   ')).toBe(false)
    expect(check('not_blank', '\t\n')).toBe(false)
    // JS trim removes Unicode spaces too, which a `\s` written by hand might not.
    expect(check('not_blank', ' ')).toBe(false)
    expect(check('not_blank', '﻿')).toBe(false)
  })

  it('agrees with Lead Economy\'s `value?.trim().length > 0` on every string and on a missing value', () => {
    for (const s of STRINGS) expect({ s, v: check('not_blank', s) }).toEqual({ s, v: s.trim().length > 0 })
    expect(check('not_blank', undefined)).toBe(false)
    expect(check('not_blank', null)).toBe(false)
  })

  it('treats every non-string as blank: a number, boolean, array or object is not text', () => {
    // The scripts throw on these (`5551234567.trim` is not a function); the
    // operator decides instead, and decides blank, so a check built on it fails
    // closed rather than accepting a value of the wrong shape.
    for (const v of [0, 5551234567, true, false, NaN, [], ['a'], {}, { a: 1 }]) {
      expect(check('not_blank', v)).toBe(false)
    }
  })
})

describe('numeric operators resolve a reference on the value side', () => {
  const steps = { constants: { maximumLoanAmount: 5000, asText: '5000', blank: '', spaces: '  ', unset: null, flag: true } }

  it('reads a steps. reference, as in_array already does', () => {
    const c = (amount: unknown) => ctx({ x: amount }, steps)
    expect(check('lte', 4999, 'steps.constants.output.maximumLoanAmount', c(4999))).toBe(true)
    expect(check('lte', 5000, 'steps.constants.output.maximumLoanAmount', c(5000))).toBe(true)
    expect(check('lte', 5001, 'steps.constants.output.maximumLoanAmount', c(5001))).toBe(false)
    expect(check('lt', 5000, 'steps.constants.output.maximumLoanAmount', c(5000))).toBe(false)
    expect(check('gt', 5001, 'steps.constants.maximumLoanAmount', c(5001))).toBe(true)
    expect(check('gte', 5000, 'steps.constants.output.asText', c(5000))).toBe(true)
  })

  it('reads trigger. and env. references', () => {
    expect(check('gt', 10, 'trigger.payload.floor', ctx({ x: 10, floor: 9 }))).toBe(true)
    expect(check('gt', 10, 'env.FLOOR', ctx({ x: 10 }, {}, { FLOOR: '11' }))).toBe(false)
    expect(check('gte', 11, 'env.FLOOR', ctx({ x: 11 }, {}, { FLOOR: '11' }))).toBe(true)
  })

  it('is false when the reference resolves to nothing, as a non-numeric literal always was', () => {
    expect(check('lte', 1, 'steps.constants.output.missing', ctx({ x: 1 }, steps))).toBe(false)
    expect(check('gte', 1, 'steps.absent.output.n', ctx({ x: 1 }, steps))).toBe(false)
  })

  it('is false, in every direction, when the reference resolves to null, blank or a non-number', () => {
    // Number(null), Number('') and Number(true) are 0, 0 and 1, so without this
    // an unset Constants floor would read as a limit of 0 and `gte` would pass
    // every lead. A limit that is not a number is no limit, exactly as a missing
    // one is. (A literal value keeps the evaluator's older reading.)
    for (const ref of ['blank', 'spaces', 'unset', 'flag']) {
      for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
        for (const amount of [-1, 0, 1, 5000]) {
          expect({ ref, op, amount, v: check(op, amount, `steps.constants.output.${ref}`, ctx({ x: amount }, steps)) })
            .toEqual({ ref, op, amount, v: false })
        }
      }
    }
  })

  it('compares literals exactly as before', () => {
    expect(check('gt', 11, 10)).toBe(true)
    expect(check('gt', 11, '10')).toBe(true)
    expect(check('gt', 9, '10')).toBe(false)
    expect(check('lte', 5, 'abc')).toBe(false)
    expect(check('gt', 5, 'payload.x', ctx({ x: 5 }))).toBe(false)
  })
})

describe('reference roots a condition value may name', () => {
  it('resolveField reads every root the shared list offers conditions', () => {
    const c = ctx({ v: 1 }, { s: { v: 1 } }, { V: '1' })
    const sample: Record<string, string> = { env: 'env.V', steps: 'steps.s.output.v', trigger: 'trigger.payload.v' }
    for (const root of CONDITION_REFERENCE_ROOTS) {
      expect({ root, resolved: resolveField(sample[root] ?? `${root}.missing_sample`, c) }).not.toEqual({ root, resolved: undefined })
    }
  })

  it('resolveField does not read execution., which is why the shared list leaves it out', () => {
    // Teaching resolveField `execution` should fail here, as the cue to add it to
    // CONDITION_REFERENCE_ROOTS in packages/workflow-definition.
    expect(resolveField('execution.trace_id', ctx())).toBeUndefined()
  })
})

describe('every listed operator evaluates', () => {
  it('none throws "Unknown condition operator" for a plain value', () => {
    for (const op of CONDITION_OPERATORS) {
      expect(() => check(op, 1, op === 'in_array' || op === 'not_in_array' ? [1] : 1)).not.toThrow()
    }
  })

  it('an operator outside the list still throws, since stored config is untrusted', () => {
    expect(() => check('approx' as EdgeCondition['operator'], 1, 1)).toThrow(/Unknown condition operator: "approx"/)
    expect(() => check('constructor' as EdgeCondition['operator'], 1, 1)).toThrow(/Unknown condition operator/)
  })
})
