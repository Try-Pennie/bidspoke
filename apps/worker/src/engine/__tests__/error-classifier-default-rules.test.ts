/**
 * The classifier reads its defaults from DEFAULT_ERROR_RULES (#2143, PM-11).
 *
 * The five default functions used to hold their statuses, markers and names
 * as literals; they now read them from the one constant the partners page
 * lists as Default rows. This file holds the bodies as they were before that
 * change (copied from main at 5a5f0ed9) and checks the new ones decide every
 * case the same way, across every status and every error shape they branch
 * on, so the move changes no classification. The money gate replays the same
 * question through the whole engine, and the web guard
 * error-classifier-reads-default-rules.test.ts fails on a default written back
 * into the classifier as a literal.
 *
 * Seen red by moving 503 from gateway_unavailable to error_status, and by
 * dropping 'connection lost' from code_programming_error's network markers.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_ERROR_RULES as FROM_PACKAGE } from '@bidspoke/buyer-profile'
import {
  DEFAULT_ERROR_RULES,
  classifyHttpError,
  classifyHttpErrorWithBody,
  classifyTransportError,
  isDeterministicCodeError,
  isSaturationError,
} from '../error-classifier'
import { containsHtmlDocument } from '../../lib/html-error-summary'
import type { ErrorType } from '../../types'

// ── The bodies before #2143, frozen ──────────────────────────────────────────
const before = {
  classifyHttpError(status: number): ErrorType {
    if (status === 429 || status === 502 || status === 503 || status === 504) return 'transient'
    if (status >= 400) return 'permanent'
    return 'permanent'
  },
  classifyHttpErrorWithBody(status: number, bodyText: string | null | undefined): ErrorType {
    if (typeof bodyText === 'string' && bodyText.length > 0 && containsHtmlDocument(bodyText)) return 'transient'
    return before.classifyHttpError(status)
  },
  isDeterministicCodeError(errorName: string | undefined, message: string): boolean {
    if (!errorName || !['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(errorName)) return false
    if (errorName === 'TypeError') {
      const lower = message.toLowerCase()
      if (['fetch failed', 'failed to fetch', 'network connection lost', 'the network connection was lost', 'connection was closed', 'connection lost'].some((m) => lower.includes(m))) return false
    }
    return true
  },
  classifyTransportError(err: unknown): ErrorType {
    if (err && typeof err === 'object' && (err as { permanent?: boolean }).permanent === true) return 'permanent'
    if (err && typeof err === 'object') {
      const codeErrorName = (err as { codeErrorName?: string }).codeErrorName
      const message = err instanceof Error ? err.message : ''
      if (before.isDeterministicCodeError(codeErrorName, message)) return 'permanent'
    }
    return 'transient'
  },
  isSaturationError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    if ((err as { saturated?: boolean }).saturated === true) return true
    const message = err instanceof Error ? err.message : ''
    return ['REQUEST_LIMIT_EXCEEDED'].some((m) => message.includes(m))
  },
}

// A status that is not a whole number too: the old body answered permanent for NaN, because every comparison with it is false.
const STATUSES = [-1, 0, ...Array.from({ length: 600 }, (_, i) => i), 600, 999, NaN, Infinity, -Infinity, 429.5]
const BODIES: Array<string | null | undefined> = [undefined, null, '', '{"error":"x"}', 'Expected <number>, got <string>', '<!DOCTYPE html><html><body>Edge</body></html>', '<!doctypehtml><p>x', '<html lang="en">']
const NAMES: Array<string | undefined> = [undefined, '', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'Error', 'AbortError', 'typeerror']
const MESSAGES = ['', 'Cannot read properties of undefined', 'fetch failed', 'Failed to fetch', 'Network connection lost.', 'The network connection was lost', 'Connection was closed', 'connection lost', 'REQUEST_LIMIT_EXCEEDED: ConcurrentRequests', 'x REQUEST_LIMIT_EXCEEDED y', 'request_limit_exceeded']

function errors(): unknown[] {
  const out: unknown[] = [null, undefined, 0, 'fetch failed', 'REQUEST_LIMIT_EXCEEDED', {}, { permanent: false }, { permanent: true }, { permanent: 'true' }, { saturated: true }, { saturated: 1 }]
  for (const name of NAMES) {
    for (const message of MESSAGES) {
      out.push({ codeErrorName: name, message })
      const e = Object.assign(new Error(message), { codeErrorName: name })
      out.push(e)
      out.push(Object.assign(new Error(message), { codeErrorName: name, permanent: true }))
      out.push(Object.assign(new Error(message), { codeErrorName: name, saturated: true }))
    }
  }
  return out
}

describe('the default error rules are the constant the page lists (#2143)', () => {
  it('the classifier exports the package constant itself, not a copy', () => {
    expect(FROM_PACKAGE.length).toBeGreaterThan(5)
    expect(DEFAULT_ERROR_RULES).toBe(FROM_PACKAGE)
  })
})

describe('every function decides every case as it did before (#2143)', () => {
  it('classifyHttpError, across every status', () => {
    const differ = STATUSES.filter((s) => classifyHttpError(s) !== before.classifyHttpError(s))
    expect(differ).toEqual([])
  })

  it('classifyHttpErrorWithBody, across every status and body shape', () => {
    const differ: string[] = []
    for (const s of STATUSES) for (const b of BODIES) if (classifyHttpErrorWithBody(s, b) !== before.classifyHttpErrorWithBody(s, b)) differ.push(`${s} ${JSON.stringify(b)}`)
    expect(differ).toEqual([])
  })

  it('isDeterministicCodeError, across every name and message', () => {
    const differ: string[] = []
    for (const n of NAMES) for (const m of MESSAGES) if (isDeterministicCodeError(n, m) !== before.isDeterministicCodeError(n, m)) differ.push(`${n} ${m}`)
    expect(differ).toEqual([])
  })

  it('classifyTransportError and isSaturationError, across every error shape', () => {
    const all = errors()
    expect(all.length).toBeGreaterThan(300)
    const differ = all.filter((e) => classifyTransportError(e) !== before.classifyTransportError(e) || isSaturationError(e) !== before.isSaturationError(e))
    expect(differ).toEqual([])
  })
})
