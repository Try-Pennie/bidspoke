import type { ErrorType } from '../types'

// PRD Section 11.1 — default classification by HTTP status
export function classifyHttpError(status: number): ErrorType {
  // Transient: likely to succeed on retry
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return 'transient'
  }
  // Permanent: 4xx (except 429) and unrecognized errors
  if (status >= 400) {
    return 'permanent'
  }
  // Default safe fallback — don't waste retries on unknowns
  return 'permanent'
}

export function classifyTransportError(_err: unknown): ErrorType {
  // Network failures, timeouts, DNS errors are always transient
  return 'transient'
}
