/**
 * Test doubles for the schema lookups' injected fetch (#2335, PR 7 of phase 5).
 *
 * Real Response objects, so a malformed body fails exactly as it would in the
 * Worker. The double records every call, so a test can assert what was sent and
 * that the global fetch was never used.
 */
import { vi } from 'vitest'
import type { SchemaFetch } from '../types'
import { SchemaLookupError } from '../errors'

export type Answer = Response | Error | (() => Response | Error)

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export function text(status: number, body: string): Response {
  return new Response(body, { status })
}

/** A DOMException the way AbortSignal.timeout rejects a fetch. */
export function timeoutError(message = 'The operation was aborted due to timeout'): Error {
  return new DOMException(message, 'TimeoutError')
}

/** Answers each call with the next answer in order, repeating the last. */
export function fetchSequence(...answers: Answer[]) {
  let i = 0
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = vi.fn<SchemaFetch>(async (url, init) => {
    calls.push({ url, init })
    const raw = answers[Math.min(i++, answers.length - 1)]
    const answer = typeof raw === 'function' ? raw() : raw
    if (answer instanceof Error) throw answer
    return answer
  })
  return { fetch: fn, calls }
}

export function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries())
}

/** Fails the test if anything reaches the global fetch instead of the injected one. */
export function forbidGlobalFetch() {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('the global fetch was called; the lookups must use the injected fetch') }))
}

/** The SchemaLookupError a lookup failed with; fails the test on any other outcome. */
export async function caught(promise: Promise<unknown>): Promise<SchemaLookupError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof SchemaLookupError) return err
    throw new Error(`expected a SchemaLookupError, got ${err instanceof Error ? err.name : typeof err}`, { cause: err })
  }
  throw new Error('expected the lookup to fail, and it answered')
}
