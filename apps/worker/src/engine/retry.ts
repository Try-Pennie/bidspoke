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
  stats?: RetryStats
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    // `attempt` is exactly the retry count: 0 on the first try, then 1, 2, …
    // Recorded before each attempt so the value is correct whether this attempt
    // returns (success) or throws (permanent error / retries exhausted).
    if (stats) stats.retries = attempt
    try {
      return await withTimeout(fn, config.timeout_ms)
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
      await sleep(backoffMs(attempt, config.backoff))
    }
  }
  throw lastError
}

function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  // Own the deadline: on timeout we both reject (so withRetry can react) AND
  // abort the signal handed to fn, so the in-flight outbound call is actually
  // canceled before any retry — no orphaned request, no double-fire (#66).
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Step timed out after ${ms}ms (in-flight upstream call canceled via abort signal)`))
    }, ms)
  })
  return Promise.race([fn(controller.signal), timeout]).finally(() => clearTimeout(timer))
}

function backoffMs(attempt: number, strategy: 'linear' | 'exponential'): number {
  const base = 500
  return strategy === 'exponential'
    ? base * Math.pow(2, attempt)
    : base * (attempt + 1)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
