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

// Execute fn with retries. Only retries transient errors.
export async function withRetry<T>(
  fn: () => Promise<T>,
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
      return await withTimeout(fn(), config.timeout_ms)
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        // The race abandons the work client-side but cannot cancel it: an
        // in-flight upstream call keeps running on the server. Say so in the
        // surfaced error so operators understand the amplification during
        // saturation incidents (each retry-after-timeout stacks another
        // still-running request onto the upstream).
        () => reject(new Error(`Step timed out after ${ms}ms (any in-flight upstream call was abandoned, not canceled; it may still be running server-side)`)),
        ms
      )
    ),
  ])
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
