/**
 * The one reading of a rate limit's "come back at" headers on the ops Worker
 * (#1693 7.4). connectionFetch reads a step's or a lookup's 429 (or 503 with
 * Retry-After) through it, and the minters' token endpoint
 * (minters/token-endpoint.ts) reads a token request's 429 through it, so both
 * wait the same time for the same answer and count the same unreadable header.
 * No other ops module reads these headers (the guard
 * apps/web/src/lib/__guards__/worker/rate-limit-headers-one-reader.test.ts).
 *
 * The rule:
 *  - Retry-After first: delta seconds or an HTTP date. It is the standard
 *    header, and the one connectionFetch honoured first.
 *  - Else the x-ratelimit-reset style headers, in RATE_LIMIT_RESET_HEADERS
 *    order (from Trigger.dev's calculateResetAt in
 *    packages/core/src/v3/retry.ts), each a plain number read by its size.
 *  - The time is held between RETRY_AFTER_MIN_MS and RETRY_AFTER_MAX_MS, so a
 *    wrong or hostile header cannot park a run for days, nor make it spin.
 *  - A header present that cannot be read is never taken as now: it is handed
 *    to the caller's `unreadable` by its NAME, never its value, so the caller
 *    counts it (rate_limit_header_unparseable), and the next header decides.
 *  - Nothing readable is null: the caller decides what no time means
 *    (connectionFetch waits RATE_LIMIT_DEFAULT_MS; the token endpoint answers
 *    a rate limit with no time, which connectionFetch then waits the same).
 *
 * Read against the Worker's clock (the caller's now). Reading reset times
 * against the database clock (plan L736) is left to the backoff slice.
 */

/** A Retry-After, or a reset header, is held between these, so a wrong or hostile one cannot park a run for days. */
export const RETRY_AFTER_MIN_MS = 1_000
export const RETRY_AFTER_MAX_MS = 60 * 60_000

/** The standard header, read before any reset header. */
export const RETRY_AFTER_HEADER = 'retry-after'

/**
 * The x-ratelimit-reset style headers, read in this order when a rate limit
 * carries no Retry-After that can be read. Retry-After wins over all of them.
 */
export const RATE_LIMIT_RESET_HEADERS = ['x-ratelimit-reset', 'x-rate-limit-reset', 'ratelimit-reset'] as const

/**
 * A reset header's number is read by its size, each range a named rule:
 * epoch_ms from 1e12 (September 2001 in milliseconds), epoch_seconds from 1e9
 * (September 2001 in seconds; 1e12 seconds is 30,000 years away), and
 * seconds_from_now below that (1e9 seconds is 31 years, so no real wait is read
 * as an epoch).
 */
export const RESET_EPOCH_MS_FROM = 1e12
export const RESET_EPOCH_SECONDS_FROM = 1e9
export type RateLimitResetRule = 'epoch_ms' | 'epoch_seconds' | 'seconds_from_now'

/** A header that could not be read, by name: Retry-After or one of RATE_LIMIT_RESET_HEADERS. */
export type RateLimitHeader = typeof RETRY_AFTER_HEADER | (typeof RATE_LIMIT_RESET_HEADERS)[number]

/** Every name a RateLimitHeader can be, for a reader that must refuse any other. */
export const RATE_LIMIT_HEADERS: readonly RateLimitHeader[] = [RETRY_AFTER_HEADER, ...RATE_LIMIT_RESET_HEADERS]

/** at, held between RETRY_AFTER_MIN_MS and RETRY_AFTER_MAX_MS from now. */
export function clampedRetry(now: number, at: number): Date {
  return new Date(Math.min(Math.max(at, now + RETRY_AFTER_MIN_MS), now + RETRY_AFTER_MAX_MS))
}

/** A Retry-After header as epoch ms: delta seconds or an HTTP date. Null when it is neither. */
export function retryAfterAt(header: string, now: number): number | null {
  const trimmed = header.trim()
  const at = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed)
  return Number.isFinite(at) ? at : null
}

/**
 * An x-ratelimit-reset style header as epoch ms, with the rule that read it
 * (RESET_EPOCH_MS_FROM, RESET_EPOCH_SECONDS_FROM). Only a plain non negative
 * decimal number is one; anything else (a date, a sign, an exponent, a unit,
 * a number too large to hold) is null, never a time and never now.
 */
export function rateLimitResetAt(header: string, now: number): { at: number; rule: RateLimitResetRule } | null {
  const trimmed = header.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return null
  if (n >= RESET_EPOCH_MS_FROM) return { at: n, rule: 'epoch_ms' }
  if (n >= RESET_EPOCH_SECONDS_FROM) return { at: n * 1000, rule: 'epoch_seconds' }
  return { at: now + n * 1000, rule: 'seconds_from_now' }
}

/**
 * When a rate limit asked to come back: its Retry-After, else the first reset
 * header that can be read, held between the bounds; else null. Each header
 * present that cannot be read is handed to unreadable by name.
 */
export function rateLimitRetryAt(headers: Headers, now: number, unreadable: (header: RateLimitHeader) => void): Date | null {
  const retryAfter = headers.get(RETRY_AFTER_HEADER)
  if (retryAfter !== null) {
    const at = retryAfterAt(retryAfter, now)
    if (at !== null) return clampedRetry(now, at)
    unreadable(RETRY_AFTER_HEADER)
  }
  for (const name of RATE_LIMIT_RESET_HEADERS) {
    const value = headers.get(name)
    if (value === null) continue
    const reset = rateLimitResetAt(value, now)
    if (reset !== null) return clampedRetry(now, reset.at)
    unreadable(name)
  }
  return null
}
