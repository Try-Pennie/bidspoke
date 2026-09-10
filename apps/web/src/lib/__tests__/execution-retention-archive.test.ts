/**
 * Telling "the archive could not be reached" apart from "this never ran" on the
 * client (#874).
 *
 * WHY THIS FIXTURE IS BUILT THE WAY IT IS. The first version of these tests
 * built the rejection as `new Error('API 503: {json}')`, which is the shape the
 * old comment in execution-retention.ts described. `req()` does not produce
 * that: it surfaces the server's `error` field as the message and puts the
 * status and the parsed body on the Error. The tests passed against the
 * imagined shape while the real page fell through to the generic error box, and
 * that only surfaced on a screenshot (L52).
 *
 * So `rejection()` below is built to match `api.ts` exactly, and the guard at
 * the end of this file fails if `api.ts` stops producing it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveUnavailableFrom, isNotFoundError } from '../execution-retention'

/** Exactly what `req()` throws: the body's `error` as the message, plus status and body. */
function rejection(status: number, body: Record<string, unknown>): Error {
  const err = new Error(String(body.error ?? `API ${status}`)) as Error & {
    status?: number
    body?: unknown
  }
  err.status = status
  err.body = body
  return err
}

const UNAVAILABLE = {
  error: 'Archive temporarily unavailable',
  waiting_for: 'the execution archive',
  detail: 'the archive did not answer within 20 seconds',
}
const NOT_FOUND = { error: 'Execution not found' }

describe('archiveUnavailableFrom', () => {
  it('reads what the archive was waiting for out of a 503', () => {
    expect(archiveUnavailableFrom(rejection(503, UNAVAILABLE))).toEqual({
      waitingFor: 'the execution archive',
      detail: 'the archive did not answer within 20 seconds',
    })
  })

  it('is not satisfied by a 404, which means the execution genuinely never existed', () => {
    expect(archiveUnavailableFrom(rejection(404, NOT_FOUND))).toBeNull()
    // The two readers stay mutually exclusive, so no state can claim both.
    expect(isNotFoundError(rejection(404, NOT_FOUND))).toBe(true)
    expect(isNotFoundError(rejection(503, UNAVAILABLE))).toBe(false)
  })

  it('still reports a 503 carrying no usable body, rather than dropping it', () => {
    // A 503 from a proxy carries HTML, so `req()` attaches no body at all.
    // Returning null here would route it into "never existed", which is the
    // exact lie this state exists to prevent.
    const err = new Error('API 503') as Error & { status?: number }
    err.status = 503
    const result = archiveUnavailableFrom(err)
    expect(result).not.toBeNull()
    expect(result?.waitingFor).toBe('the execution archive')
  })

  it('ignores anything that is not an API rejection', () => {
    expect(archiveUnavailableFrom(new Error('network down'))).toBeNull()
    expect(archiveUnavailableFrom('not an error')).toBeNull()
  })
})

describe('isNotFoundError, against the shape api.ts really throws', () => {
  // The regression this exists to stop coming back: a 404 whose body carries an
  // `error` field has a message of "Execution not found", which starts with no
  // "API 404" prefix, so a reader matching the prefix answered false for every
  // 404 the app actually returns and the not-found screen was unreachable.
  it('recognises a 404 whose message is the server’s own sentence', () => {
    expect(isNotFoundError(rejection(404, NOT_FOUND))).toBe(true)
  })

  it('still recognises the prefix form, for a body carrying no error field', () => {
    expect(isNotFoundError(new Error('API 404: {}'))).toBe(true)
  })

  it('does not treat a 500 or a network failure as not-found', () => {
    expect(isNotFoundError(rejection(500, { error: 'boom' }))).toBe(false)
    expect(isNotFoundError(new Error('Failed to fetch'))).toBe(false)
  })
})

describe('the contract these readers depend on', () => {
  // A reader keyed on a property api.ts stops setting is a silent regression:
  // every state below it simply stops rendering, with no error anywhere. This
  // is the cheapest thing that fails when that happens.
  const api = readFileSync(join(__dirname, '../api.ts'), 'utf8')

  it('api.ts still puts the status and the parsed body on the rejection', () => {
    expect(api).toContain('err.status = res.status')
    expect(api).toContain('err.body = JSON.parse(body)')
  })
})
