/**
 * Why a request failed, in words a person can read (#2322, PM-19): the route's
 * own sentence when it sent one, otherwise the cause the client measured, and
 * never the server's bare code ("Service unavailable", "Internal error"), which
 * names no reason (L11).
 */
import { describe, expect, it } from 'vitest'
import { requestFailureCause } from '../error-sentence'

describe('requestFailureCause', () => {
  it('uses the route\'s own sentence when it sent one', () => {
    const err = Object.assign(new Error('click_count_unavailable'), { status: 503, body: { error: 'click_count_unavailable', message: 'The click counter did not answer.' } })
    expect(requestFailureCause(err)).toBe('The click counter did not answer.')
  })

  it('names a timeout by its ceiling', () => {
    expect(requestFailureCause(Object.assign(new Error('Timed out'), { timedOut: true, timeoutMs: 30_000 }))).toBe('the server did not answer within 30 seconds')
  })

  it('names a server error by its status, never by its code text', () => {
    expect(requestFailureCause(Object.assign(new Error('Service unavailable'), { status: 503, body: { error: 'Service unavailable' } }))).toBe('the server answered with an error (HTTP 503)')
  })

  it('says the server could not be reached when no answer came back', () => {
    expect(requestFailureCause(new TypeError('Failed to fetch'))).toBe('the server could not be reached')
  })

  it('falls back to the caller\'s words for anything else', () => {
    expect(requestFailureCause('odd', 'the save failed')).toBe('the save failed')
  })
})
