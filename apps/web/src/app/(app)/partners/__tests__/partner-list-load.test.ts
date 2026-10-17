/**
 * Why the partner list could not be loaded, as the page says it (#2321, PM-18,
 * design frame 4): the cause in words, then that nothing has changed. Never the
 * server's raw error code (L10, L11).
 */
import { describe, expect, it } from 'vitest'
import { loadFailureSentence } from '../partner-list'

describe('loadFailureSentence', () => {
  it('names a timeout by its ceiling', () => {
    const err = Object.assign(new Error('Timed out after 30s.'), { timedOut: true, timeoutMs: 30_000 })
    expect(loadFailureSentence(err)).toBe('The server did not answer within 30 seconds. Nothing has changed.')
  })

  it('names a server error by its status, never its body text', () => {
    const err = Object.assign(new Error('Internal error'), { status: 500 })
    expect(loadFailureSentence(err)).toBe('The server answered with an error (HTTP 500). Nothing has changed.')
  })

  it('says the server could not be reached when the request never got an answer', () => {
    expect(loadFailureSentence(new TypeError('Failed to fetch'))).toBe('The server could not be reached. Nothing has changed.')
  })

  it('falls back to a plain sentence for anything else', () => {
    expect(loadFailureSentence('odd')).toBe('The list could not be read. Nothing has changed.')
  })
})
