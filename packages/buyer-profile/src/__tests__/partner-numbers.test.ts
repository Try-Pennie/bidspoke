/**
 * The partner record's numbers (#2328): the partners page lets the save refuse
 * them rather than the browser's own popup, so every refusal is this one rule,
 * which the page applies before any write and the Worker applies again.
 */
import { describe, expect, it } from 'vitest'
import { partnerNumberErrors } from '../partner-numbers'

describe('partnerNumberErrors', () => {
  it('accepts what is stored today and empty values', () => {
    expect(partnerNumberErrors({ daily_cap: null, circuit_error_threshold: 5, confirmation_window_ms: null, external_routing_code: 2 })).toEqual([])
    expect(partnerNumberErrors({})).toEqual([])
    expect(partnerNumberErrors({ external_routing_code: 0, daily_cap: 1, confirmation_window_ms: 1, circuit_error_threshold: 1 })).toEqual([])
  })

  it.each([
    ['daily_cap', 2.5, 'Daily attempt cap is a whole number, 1 or more.'],
    ['daily_cap', 0, 'Daily attempt cap is a whole number, 1 or more.'],
    ['circuit_error_threshold', 0, 'Errors is a whole number, 1 or more.'],
    ['circuit_error_threshold', 2.5, 'Errors is a whole number, 1 or more.'],
    ['confirmation_window_ms', -1, 'Confirmation window is a whole number of milliseconds, 1 or more.'],
    ['external_routing_code', 2.5, 'The routing code is a whole number from 0 to 32,767.'],
    ['external_routing_code', 32768, 'The routing code is a whole number from 0 to 32,767.'],
    ['daily_cap', Number.NaN, 'Daily attempt cap is a whole number, 1 or more.'],
    ['daily_cap', 2147483648, 'Daily attempt cap is a whole number, 1 or more.'],
  ])('refuses %s = %s, naming its field', (field, value, message) => {
    expect(partnerNumberErrors({ [field]: value })).toEqual([{ code: 'partner_number_invalid', path: field, field, message }])
  })

  it('refuses a status rule whose status is not an HTTP status, naming its group', () => {
    expect(partnerNumberErrors({ response_classification: { rejection_signals: [{ status_code: 4.5 }] } })).toEqual([
      { code: 'partner_number_invalid', path: 'response_classification.rejection_signals', field: null, message: 'An HTTP status in a decline rule is a whole number from 100 to 599.' },
    ])
    expect(partnerNumberErrors({ response_classification: { transient_signals: [{ status_code: 99 }, { status_code: 700 }] } })).toEqual([
      { code: 'partner_number_invalid', path: 'response_classification.transient_signals', field: 'response_classification', message: 'An HTTP status in an error rule is a whole number from 100 to 599.' },
    ])
    expect(partnerNumberErrors({ response_classification: { rejection_signals: [{ status_code: 422 }, { body_field: 'x', present: true }] } })).toEqual([])
    expect(partnerNumberErrors({ response_classification: null })).toEqual([])
  })
})
