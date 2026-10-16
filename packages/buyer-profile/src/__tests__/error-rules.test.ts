/**
 * DEFAULT_ERROR_RULES (#2143, PM-11): the defaults the engine classifies a
 * failed call by, as the rows the partners page lists under a partner's own
 * rules. The engine side (error-classifier-default-rules.test.ts) proves the
 * classifier decides every case from this constant exactly as it did before.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ERROR_RULES,
  ERROR_RULE_SCOPES,
  PARTNER_PAGE_ERROR_SCOPES,
  defaultErrorRowsFor,
  defaultErrorRule,
  statusDecision,
  type DefaultErrorRule,
} from '../error-rules'

const rules = DEFAULT_ERROR_RULES as readonly DefaultErrorRule[]

describe('DEFAULT_ERROR_RULES', () => {
  it('names each rule once, applies each somewhere real, and gives every rule it cannot show a reason', () => {
    const ids = rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of rules) {
      expect(r.appliesTo.length, r.id).toBeGreaterThan(0)
      for (const s of r.appliesTo) expect(ERROR_RULE_SCOPES, r.id).toContain(s)
      expect(r.label.trim(), r.id).not.toBe('')
      if (r.notShownBecause !== null) expect(r.notShownBecause.trim(), r.id).not.toBe('')
    }
  })

  it('decides every status as the PRD 11.1 defaults do', () => {
    expect([429, 502, 503, 504].map(statusDecision)).toEqual(['transient', 'transient', 'transient', 'transient'])
    expect([400, 401, 403, 404, 409, 422, 499, 500, 501, 505, 599, 600].map(statusDecision)).toEqual(Array(12).fill('permanent'))
    expect([-1, 0, 200, 302, 399].map(statusDecision)).toEqual(Array(5).fill('permanent'))
    // A status that is not a number still has a decision, the unrecognized one (L50).
    expect([NaN, Infinity, -Infinity].map(statusDecision)).toEqual(Array(3).fill('permanent'))
  })

  it('refuses an id or kind that names no rule, so a rename fails where the rule is read', () => {
    expect(defaultErrorRule('saturated', 'saturated').match.markers).toEqual(['REQUEST_LIMIT_EXCEEDED'])
    expect(() => defaultErrorRule('saturated', 'status')).toThrow(/no default error rule saturated of kind status/)
  })

  it('no default classifies a call to a buyer: those answers are judged by the sale outcome rules', () => {
    expect(rules.filter((r) => r.appliesTo.includes('buyer_call'))).toEqual([])
  })
})

describe('the rows the partners page lists for a partner (PM-11)', () => {
  const rows = defaultErrorRowsFor(PARTNER_PAGE_ERROR_SCOPES)

  it('shows the defaults that apply to its calls, in the order the classifier applies them', () => {
    expect(rows.shown.map((r) => r.id)).toEqual(['html_error_page', 'rate_limited', 'gateway_unavailable', 'error_status', 'unrecognized_status', 'no_response'])
  })

  it('names the one that applies but cannot be a row, and shows no Code node only row at all', () => {
    expect(rows.notShown.map((r) => r.id)).toEqual(['saturated'])
    const listed = [...rows.shown, ...rows.notShown]
    expect(listed.filter((r) => r.appliesTo.every((s) => s === 'code_node'))).toEqual([])
    expect(listed.map((r) => r.id)).not.toContain('code_programming_error')
  })

  it('a code node scope alone lists nothing on the page', () => {
    expect(defaultErrorRowsFor(['code_node'])).toEqual({ shown: [], notShown: [] })
  })
})
