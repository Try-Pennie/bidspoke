import { describe, it, expect } from 'vitest'
import {
  classifyHttpError,
  classifyTransportError,
  classifyStepError,
  evaluateResponseClassification,
  shouldSuppressAlert,
  isSaturationError,
} from '../error-classifier'
import { PartnerApiError } from '../partner-bid-error'
import type { ResponseClassificationConfig, AlertConfig } from '../error-classifier'

// ── classifyStepError (issue #53) ─────────────────────────────────────────────

describe('classifyStepError', () => {
  it('honors a PartnerApiError errorType of permanent (so the retry logic does not retry it)', () => {
    expect(classifyStepError(new PartnerApiError('declined', 'permanent', false))).toBe('permanent')
  })

  it('honors a PartnerApiError errorType of transient', () => {
    expect(classifyStepError(new PartnerApiError('blip', 'transient', false))).toBe('transient')
  })

  it('passes through a PartnerApiError business-rejection (null) — not transient, so not retried', () => {
    expect(classifyStepError(new PartnerApiError('rejected', null, false))).toBeNull()
  })

  it('classifies a thrown Response by its HTTP status', () => {
    expect(classifyStepError(new Response(null, { status: 400 }))).toBe('permanent')
    expect(classifyStepError(new Response(null, { status: 503 }))).toBe('transient')
  })

  it('falls back to the transport heuristic for a generic error', () => {
    expect(classifyStepError(new Error('fetch failed'))).toBe('transient')
    expect(classifyStepError(Object.assign(new Error('x'), { permanent: true }))).toBe('permanent')
  })
})

// ── classifyHttpError ─────────────────────────────────────────────────────────

describe('classifyHttpError', () => {
  describe('transient (should retry)', () => {
    it('429 Too Many Requests', () => expect(classifyHttpError(429)).toBe('transient'))
    it('502 Bad Gateway', () => expect(classifyHttpError(502)).toBe('transient'))
    it('503 Service Unavailable', () => expect(classifyHttpError(503)).toBe('transient'))
    it('504 Gateway Timeout', () => expect(classifyHttpError(504)).toBe('transient'))
  })

  describe('permanent (do not retry)', () => {
    it('400 Bad Request', () => expect(classifyHttpError(400)).toBe('permanent'))
    it('401 Unauthorized', () => expect(classifyHttpError(401)).toBe('permanent'))
    it('403 Forbidden', () => expect(classifyHttpError(403)).toBe('permanent'))
    it('404 Not Found', () => expect(classifyHttpError(404)).toBe('permanent'))
    it('422 Unprocessable Entity', () => expect(classifyHttpError(422)).toBe('permanent'))
    it('500 Internal Server Error', () => expect(classifyHttpError(500)).toBe('permanent'))
    it('501 Not Implemented', () => expect(classifyHttpError(501)).toBe('permanent'))
  })
})

describe('classifyTransportError', () => {
  it('network failures are transient', () => {
    expect(classifyTransportError(new Error('fetch failed'))).toBe('transient')
  })

  it('timeout errors are transient', () => {
    expect(classifyTransportError(new Error('Step timed out after 30000ms'))).toBe('transient')
  })

  it('unknown errors are transient', () => {
    expect(classifyTransportError('some string error')).toBe('transient')
  })
})

// ── evaluateResponseClassification ───────────────────────────────────────────

const noHeaders: Record<string, string> = {}

describe('evaluateResponseClassification — rejection signals', () => {
  it('matches field equals string', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'status', equals: 'rejected' }],
    }
    expect(evaluateResponseClassification(config, 200, { status: 'rejected' }, noHeaders)).toBe('rejection')
  })

  it('matches field equals boolean false', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'accepted', equals: false }],
    }
    expect(evaluateResponseClassification(config, 200, { accepted: false }, noHeaders)).toBe('rejection')
  })

  it('matches string "false" loosely equal to boolean false', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'accepted', equals: false }],
    }
    expect(evaluateResponseClassification(config, 200, { accepted: 'false' }, noHeaders)).toBe('rejection')
  })

  it('matches field contains substring', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'reason', contains: 'duplicate' }],
    }
    expect(evaluateResponseClassification(config, 200, { reason: 'duplicate lead' }, noHeaders)).toBe('rejection')
  })

  it('matches field present=true', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'error_code', present: true }],
    }
    expect(evaluateResponseClassification(config, 200, { error_code: 'ERR_001' }, noHeaders)).toBe('rejection')
  })

  it('matches field present=false (field absent)', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'bid', present: false }],
    }
    expect(evaluateResponseClassification(config, 200, { status: 'ok' }, noHeaders)).toBe('rejection')
  })

  it('does not match when value differs', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'status', equals: 'rejected' }],
    }
    expect(evaluateResponseClassification(config, 200, { status: 'accepted' }, noHeaders)).toBe(null)
  })

  it('does not match absent field against equals check', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'missing', equals: 'value' }],
    }
    expect(evaluateResponseClassification(config, 200, {}, noHeaders)).toBe(null)
  })

  it('returns null when no signals configured', () => {
    const config: ResponseClassificationConfig = {}
    expect(evaluateResponseClassification(config, 400, { error: 'bad' }, noHeaders)).toBe(null)
  })

  it('matches dot-path field — data.createLead.resultCode', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'data.createLead.resultCode', equals: 9999 }],
    }
    expect(
      evaluateResponseClassification(config, 200, { data: { createLead: { resultCode: 9999 } } }, noHeaders)
    ).toBe('rejection')
  })

  it('does not match dot-path when intermediate level is missing', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'data.createLead.resultCode', equals: 9999 }],
    }
    expect(evaluateResponseClassification(config, 200, { data: {} }, noHeaders)).toBe(null)
  })

  it('in operator: value in list -> rejection', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'status', in: ['failed', 'declined', 'frozen'] }],
    }
    expect(evaluateResponseClassification(config, 200, { status: 'declined' }, noHeaders)).toBe('rejection')
  })

  it('in operator: value not in list -> null', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'status', in: ['failed', 'declined'] }],
    }
    expect(evaluateResponseClassification(config, 200, { status: 'ok' }, noHeaders)).toBe(null)
  })

  it('not_in operator: value NOT in accepted list -> rejection (Tripoint pattern)', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [
        { field: 'data.createLead.resultCode', not_in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] },
      ],
    }
    expect(
      evaluateResponseClassification(config, 200, { data: { createLead: { resultCode: 2019 } } }, noHeaders)
    ).toBe('rejection')
  })

  it('not_in operator: accepted value -> null', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [
        { field: 'data.createLead.resultCode', not_in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] },
      ],
    }
    expect(
      evaluateResponseClassification(config, 200, { data: { createLead: { resultCode: 1013 } } }, noHeaders)
    ).toBe(null)
  })

  // Symmetric number/string coercion — config value and response field can be
  // either type. The previous looseEquals only coerced number-config/string-
  // response, so a STRING config against a NUMERIC response field silently
  // failed to match (same class as the branch operator bug).
  it('equals: string config "9999" matches numeric response 9999 (previously missed)', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'data.createLead.resultCode', equals: '9999' }],
    }
    expect(
      evaluateResponseClassification(config, 200, { data: { createLead: { resultCode: 9999 } } }, noHeaders)
    ).toBe('rejection')
  })

  it('not_in: string-config accepted list still matches numeric response', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'data.createLead.resultCode', not_in: ['1000', '1013'] }],
    }
    // 1013 is accepted -> not a rejection
    expect(
      evaluateResponseClassification(config, 200, { data: { createLead: { resultCode: 1013 } } }, noHeaders)
    ).toBe(null)
    // 2019 is not accepted -> rejection
    expect(
      evaluateResponseClassification(config, 200, { data: { createLead: { resultCode: 2019 } } }, noHeaders)
    ).toBe('rejection')
  })

  it('not_in operator: missing field returns null (does not falsely match)', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'data.createLead.resultCode', not_in: [1013] }],
    }
    // Missing field shouldn't be treated as "not in [1013]" → must not trigger rejection
    expect(evaluateResponseClassification(config, 200, { data: {} }, noHeaders)).toBe(null)
  })

  it('in operator: loose equality across string/number ("1013" matches 1013)', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'code', in: [1013, 1014] }],
    }
    expect(evaluateResponseClassification(config, 200, { code: '1013' }, noHeaders)).toBe('rejection')
  })
})

describe('evaluateResponseClassification — transient signals', () => {
  it('matches status_code + body_field contains', () => {
    const config: ResponseClassificationConfig = {
      transient_signals: [
        { status_code: 200, body_field: 'error', contains: 'service unavailable' },
      ],
    }
    expect(
      evaluateResponseClassification(config, 200, { error: 'service unavailable right now' }, noHeaders)
    ).toBe('transient')
  })

  it('does not match when status code differs', () => {
    const config: ResponseClassificationConfig = {
      transient_signals: [{ status_code: 200, body_field: 'error', contains: 'unavailable' }],
    }
    expect(
      evaluateResponseClassification(config, 503, { error: 'service unavailable' }, noHeaders)
    ).toBe(null)
  })

  it('matches header present', () => {
    const config: ResponseClassificationConfig = {
      transient_signals: [{ status_code: 403, header: 'retry-after', present: true }],
    }
    expect(
      evaluateResponseClassification(config, 403, {}, { 'retry-after': '30' })
    ).toBe('transient')
  })

  it('does not match when header absent', () => {
    const config: ResponseClassificationConfig = {
      transient_signals: [{ status_code: 403, header: 'retry-after', present: true }],
    }
    expect(evaluateResponseClassification(config, 403, {}, noHeaders)).toBe(null)
  })

  it('matches on status code alone', () => {
    const config: ResponseClassificationConfig = {
      transient_signals: [{ status_code: 500 }],
    }
    expect(evaluateResponseClassification(config, 500, {}, noHeaders)).toBe('transient')
  })
})

describe('evaluateResponseClassification — permanent signals', () => {
  it('matches permanent override', () => {
    const config: ResponseClassificationConfig = {
      permanent_signals: [
        { status_code: 503, body_field: 'error', contains: 'account suspended' },
      ],
    }
    expect(
      evaluateResponseClassification(config, 503, { error: 'account suspended' }, noHeaders)
    ).toBe('permanent')
  })
})

describe('evaluateResponseClassification — signal priority', () => {
  it('rejection is checked before transient', () => {
    const config: ResponseClassificationConfig = {
      rejection_signals: [{ field: 'status', equals: 'no' }],
      transient_signals: [{ status_code: 200 }],
    }
    expect(
      evaluateResponseClassification(config, 200, { status: 'no' }, noHeaders)
    ).toBe('rejection')
  })
})

// ── shouldSuppressAlert ───────────────────────────────────────────────────────

describe('shouldSuppressAlert', () => {
  it('returns false when no config (alert everything by default)', () => {
    expect(shouldSuppressAlert(null, 'transient')).toBe(false)
    expect(shouldSuppressAlert(undefined, 'permanent')).toBe(false)
  })

  it('returns false when alert is explicitly true', () => {
    const config: AlertConfig = {
      transient_errors: { alert: true },
      permanent_errors: { alert: true },
    }
    expect(shouldSuppressAlert(config, 'transient')).toBe(false)
    expect(shouldSuppressAlert(config, 'permanent')).toBe(false)
  })

  it('suppresses transient alerts when configured off', () => {
    const config: AlertConfig = { transient_errors: { alert: false } }
    expect(shouldSuppressAlert(config, 'transient')).toBe(true)
  })

  it('does not suppress permanent when only transient is off', () => {
    const config: AlertConfig = { transient_errors: { alert: false } }
    expect(shouldSuppressAlert(config, 'permanent')).toBe(false)
  })

  it('suppresses permanent alerts when configured off', () => {
    const config: AlertConfig = { permanent_errors: { alert: false } }
    expect(shouldSuppressAlert(config, 'permanent')).toBe(true)
  })

  it('returns false for null errorType regardless of config', () => {
    const config: AlertConfig = {
      transient_errors: { alert: false },
      permanent_errors: { alert: false },
    }
    expect(shouldSuppressAlert(config, null)).toBe(false)
  })
})

describe('isSaturationError', () => {
  it('matches the SF REQUEST_LIMIT_EXCEEDED body text wherever it appears in the message', () => {
    expect(isSaturationError(new Error('Salesforce API error (403): REQUEST_LIMIT_EXCEEDED ConcurrentRequests'))).toBe(true)
  })

  it('matches errors explicitly marked saturated by an executor', () => {
    expect(isSaturationError(Object.assign(new Error('x'), { saturated: true }))).toBe(true)
  })

  it('does not match ordinary transient or permanent errors', () => {
    expect(isSaturationError(new Error('fetch failed'))).toBe(false)
    expect(isSaturationError(new Error('Salesforce API error (400): REQUIRED_FIELD_MISSING'))).toBe(false)
    expect(isSaturationError(null)).toBe(false)
    expect(isSaturationError('REQUEST_LIMIT_EXCEEDED')).toBe(false)
  })
})
