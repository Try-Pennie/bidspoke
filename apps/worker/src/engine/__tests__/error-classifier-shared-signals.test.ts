/**
 * The classifier's rejection signals are matched by the shared matchSignal in
 * @bidspoke/buyer-profile (#1408, L89, L370). These prove the delegation: the
 * two array operators the node needs for Tripoint's 502 shapes now work in the
 * Main Flow bid group's decline rules too, and the behaviour the classifier had
 * before the move is kept.
 */
import { describe, expect, it } from 'vitest'
import { evaluateResponseClassification, type ResponseClassificationConfig } from '../error-classifier'
import invalid502 from '../../../../../packages/buyer-profile/fixtures/tripoint/invalid-502.json'

const noHeaders = {}

describe('rejection signals through the shared matcher', () => {
  it('declines Tripoint\'s invalid lead 502 through any_item_word_prefix_ci on details[].message', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'details[].message', any_item_word_prefix_ci: 'invalid' }],
    }
    expect(evaluateResponseClassification(config, invalid502.httpStatus, invalid502.body, noHeaders)).toBe('rejection')
  })
  it('declines the null id fault shape through any_item_contains (synthetic body, the shape was not observed in the window)', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [
        { field: 'details[].message', any_item_contains: 'Cannot return null for non-nullable field CreateLeadResponse.id' },
      ],
    }
    const body = { ok: false, details: [{ message: 'Cannot return null for non-nullable field CreateLeadResponse.id within CreateLeadResponse' }] }
    expect(evaluateResponseClassification(config, 502, body, noHeaders)).toBe('rejection')
  })
  it('does not fire an array operator when the field is a plain string', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'details[].message', any_item_word_prefix_ci: 'invalid' }],
    }
    expect(evaluateResponseClassification(config, 502, { details: 'invalid' }, noHeaders)).toBe(null)
  })
  it('keeps the rule that a missing field never matches not_in', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'data.createLead.resultCode', not_in: [1013] }],
    }
    expect(evaluateResponseClassification(config, 200, { data: {} }, noHeaders)).toBe(null)
  })
  it('keeps loose equality across a numeric response and a string config', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'data.createLead.resultCode', equals: '1003' }],
    }
    expect(evaluateResponseClassification(config, 200, { data: { createLead: { resultCode: 1003 } } }, noHeaders)).toBe('rejection')
  })
})
