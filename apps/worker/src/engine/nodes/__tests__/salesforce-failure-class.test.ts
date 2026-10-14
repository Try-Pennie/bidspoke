/**
 * One rule for whether a Salesforce answer is worth sending again (#471). The node
 * retries on it and the replay tool leaves a held write pending on it, so the two
 * must never disagree about the same answer.
 */
import { describe, it, expect } from 'vitest'
import { salesforceFailureIsTransient, salesforceRejectedTheWrite } from '../salesforce'

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

// The replay asks a different question from the retry: not "is it worth sending
// again now" but "did Salesforce reject this write itself". A login or permission
// refusal is a fault on our side, so a held write survives it (#471).
describe('salesforceRejectedTheWrite', () => {
  it('is true only for a business rejection of the write', () => {
    expect(salesforceRejectedTheWrite(400, '[{"errorCode":"INVALID_FIELD"}]')).toBe(true)
    expect(salesforceRejectedTheWrite(404, '[{"errorCode":"NOT_FOUND"}]')).toBe(true)
  })

  it('is false for a login or permission refusal, and for anything worth sending again', () => {
    expect(salesforceRejectedTheWrite(401, '[{"errorCode":"INVALID_SESSION_ID"}]')).toBe(false)
    expect(salesforceRejectedTheWrite(403, '[{"errorCode":"INSUFFICIENT_ACCESS"}]')).toBe(false)
    expect(salesforceRejectedTheWrite(503, 'unavailable')).toBe(false)
    expect(salesforceRejectedTheWrite(400, '<!DOCTYPE html><html></html>')).toBe(false)
  })
})
