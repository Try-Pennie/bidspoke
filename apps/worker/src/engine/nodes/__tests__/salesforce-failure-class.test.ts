/**
 * One rule for whether a Salesforce answer is worth sending again (#471). The node
 * retries on it and the replay tool leaves a held write pending on it, so the two
 * must never disagree about the same answer.
 */
import { describe, it, expect } from 'vitest'
import { salesforceFailureIsTransient } from '../salesforce'

describe('salesforceFailureIsTransient', () => {
  it('reads a rate limit and a server error as worth sending again', () => {
    expect(salesforceFailureIsTransient(429, '[]')).toBe(true)
    expect(salesforceFailureIsTransient(503, 'unavailable')).toBe(true)
  })

  it('reads a business rejection as final', () => {
    expect(salesforceFailureIsTransient(400, '[{"errorCode":"INVALID_FIELD"}]')).toBe(false)
    expect(salesforceFailureIsTransient(404, '[{"errorCode":"NOT_FOUND"}]')).toBe(false)
  })

  it('reads an edge error page as transient whatever its status, since nothing was processed', () => {
    expect(salesforceFailureIsTransient(400, '<!DOCTYPE html><html><body>Salesforce Edge</body></html>')).toBe(true)
  })
})
