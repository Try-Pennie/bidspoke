/**
 * The buyer_click_send over cap percent rule (#1553): one rule, read by the
 * executor (which fails every run on a bad value) and by save validation (which
 * must refuse the same value before it is saved), so the two cannot drift.
 */
import { describe, expect, it } from 'vitest'
import { ALERT_OVER_PERCENT_MAX, ALERT_OVER_PERCENT_MIN, DEFAULT_ALERT_OVER_PERCENT, alertOverPercentOf } from '../click-send'

describe('alertOverPercentOf', () => {
  it('an absent value takes the default of 120', () => {
    expect(DEFAULT_ALERT_OVER_PERCENT).toBe(120)
    expect(alertOverPercentOf(undefined)).toEqual({ ok: true, percent: 120 })
    expect(alertOverPercentOf(null)).toEqual({ ok: true, percent: 120 })
  })

  it('accepts a whole number from 1 to 1000, both ends included', () => {
    expect(ALERT_OVER_PERCENT_MIN).toBe(1)
    expect(ALERT_OVER_PERCENT_MAX).toBe(1000)
    for (const n of [1, 100, 120, 1000]) expect(alertOverPercentOf(n)).toEqual({ ok: true, percent: n })
  })

  const refused: Array<[string, unknown]> = [
    ['zero', 0],
    ['one past the top', 1001],
    ['a negative', -5],
    ['a fraction', 1.5],
    ['NaN, what a cleared number input yields through Number()', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '120'],
    ['an empty string', ''],
    ['a boolean', true],
    ['an object', { percent: 120 }],
  ]
  for (const [name, value] of refused) {
    it(`refuses ${name}`, () => {
      const r = alertOverPercentOf(value)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/whole number from 1 to 1000/)
    })
  }
})
