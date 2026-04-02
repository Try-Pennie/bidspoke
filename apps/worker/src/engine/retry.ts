import type { ErrorType } from '../types'

export interface RetryConfig {
  retries: number
  backoff: 'linear' | 'exponential'
  timeout_ms: number
}

// Execute fn with retries. Only retries transient errors.
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  classifyError: (err: unknown) => ErrorType
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      return await withTimeout(fn(), config.timeout_ms)
    } catch (err) {
      lastError = err
      const errorType = classifyError(err)
      if (errorType !== 'transient' || attempt === config.retries) {
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
      setTimeout(() => reject(new Error(`Step timed out after ${ms}ms`)), ms)
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
