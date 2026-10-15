import type { ErrorType } from '../types'
import { isSaturationError } from './error-classifier'

export interface RetryConfig {
  retries: number
  backoff: 'linear' | 'exponential'
  timeout_ms: number
}

// Optional out-param. withRetry writes the number of retries it consumed here on
// BOTH the success and the throw path, so callers can log/alert on it without
// changing withRetry's return type (still T) or the error it throws.
// 0 = succeeded on the first attempt; N = first attempt + N retries.
export interface RetryStats {
  retries: number
}

/**
 * How withRetry waits out a backoff (#1063).
 *
 * A hard-coded setTimeout makes every end-to-end test that crosses a retry wait
 * for the real 1.5s of default backoff, and such a test can only assert that it
 * SURVIVED the wait: a wrong sequence and a right one are indistinguishable from
 * outside (L524). Injecting the sleep lets a test record what the code asked for.
 *
 * Omitting it means the real timer. The seam exists for tests to pass a
 * recorder, never for production to skip its own backoff, and nothing in the
 * Worker sets it.
 */
export type Sleep = (ms: number) => Promise<void>

/**
 * How withTimeout watches each attempt's deadline (#2163): resolves after `ms`,
 * or at once when `signal` aborts, which withTimeout does as soon as the attempt
 * answers. The same shape as `RetryClock.timer`.
 *
 * The same seam as `Sleep`, for the same reason: a test drives a timed out
 * retry ladder on a clock it controls instead of living through it. Omitting it
 * means the real timer, and nothing in the Worker sets it.
 */
export type Deadline = (ms: number, signal: AbortSignal) => Promise<void>

// Abort `controller` whenever `parent` aborts, so an executor's own fetch (which
// already has a local timeout controller) is ALSO canceled when the step-level
// timeout fires (#66). No-op when there's no parent signal.
export function linkAbort(controller: AbortController, parent?: AbortSignal): void {
  if (!parent) return
  if (parent.aborted) { controller.abort(); return }
  parent.addEventListener('abort', () => controller.abort(), { once: true })
}

// Execute fn with retries. Only retries transient errors. `fn` receives an
// AbortSignal that fires when the per-attempt timeout elapses, so a slow outbound
// call is actually canceled before the retry goes out (#66) — otherwise the
// abandoned call keeps running server-side and a non-idempotent partner/SF
// request can be submitted twice.
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  config: RetryConfig,
  classifyError: (err: unknown) => ErrorType,
  stats?: RetryStats,
  sleepFn: Sleep = sleep,
  deadline: Deadline = realDeadline
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    // `attempt` is exactly the retry count: 0 on the first try, then 1, 2, …
    // Recorded before each attempt so the value is correct whether this attempt
    // returns (success) or throws (permanent error / retries exhausted).
    if (stats) stats.retries = attempt
    try {
      return await withTimeout(fn, config.timeout_ms, deadline)
    } catch (err) {
      lastError = err
      const errorType = classifyError(err)
      if (errorType !== 'transient' || attempt === config.retries) {
        throw err
      }
      // Saturated upstream (e.g. SF REQUEST_LIMIT_EXCEEDED): retrying within
      // the same execution stacks more load onto a pool that has no capacity
      // and slows its recovery — and any timeout-abandoned call is still
      // running server-side. Stay transient for alerting/breakers, but stop
      // here; on_error/fallback_node handles routing.
      if (isSaturationError(err)) {
        throw err
      }
      await sleepFn(backoffMs(attempt, config.backoff))
    }
  }
  throw lastError
}

function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, deadline: Deadline): Promise<T> {
  // Own the deadline: on timeout we both reject (so withRetry can react) AND
  // abort the signal handed to fn, so the in-flight outbound call is actually
  // canceled before any retry, with no orphaned request and no double fire (#66).
  const controller = new AbortController()
  // Aborted once the attempt answers, which stops the deadline watch, so a timer
  // never outlives the attempt it watched.
  const answered = new AbortController()
  const timeout = new Promise<never>((_, reject) => {
    void deadline(ms, answered.signal).then(() => {
      if (answered.signal.aborted) return
      controller.abort()
      reject(new Error(`Step timed out after ${ms}ms (in-flight upstream call canceled via abort signal)`))
    })
  })
  return Promise.race([fn(controller.signal), timeout]).finally(() => answered.abort())
}

/** The real per attempt deadline: a timer cleared the moment the attempt answers. */
const realDeadline: Deadline = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(handle)
      resolve()
    }
    const handle = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

function backoffMs(attempt: number, strategy: 'linear' | 'exponential'): number {
  const base = 500
  return strategy === 'exponential'
    ? base * Math.pow(2, attempt)
    : base * (attempt + 1)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
