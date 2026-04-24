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

export function classifyTransportError(err: unknown): ErrorType {
  // Caller-marked permanent errors (e.g. Branch node's else=error case) skip retry
  if (err && typeof err === 'object' && (err as { permanent?: boolean }).permanent === true) {
    return 'permanent'
  }
  // Network failures, timeouts, DNS errors are always transient
  return 'transient'
}

// ── PRD Section 11.2 — Per-partner response classification overrides ───────────

export interface RejectionSignal {
  field: string         // body field to check
  equals?: unknown      // exact value match (loose equality)
  contains?: string     // string contains check
  present?: boolean     // field is/isn't present
}

export interface StatusSignal {
  status_code?: number  // HTTP status code to match (if omitted, matches any)
  body_field?: string   // body field to inspect
  equals?: unknown      // exact value match
  contains?: string     // string contains
  header?: string       // response header to check
  present?: boolean     // whether field/header is present
}

export interface ResponseClassificationConfig {
  rejection_signals?: RejectionSignal[]
  transient_signals?: StatusSignal[]
  permanent_signals?: StatusSignal[]
}

/**
 * Evaluate per-partner signal overrides against the actual response.
 * Returns 'rejection' | 'transient' | 'permanent' | null (null = use defaults).
 * Rejection signals are checked first, then transient, then permanent.
 */
export function evaluateResponseClassification(
  config: ResponseClassificationConfig,
  status: number,
  body: unknown,
  headers: Record<string, string>
): 'rejection' | 'transient' | 'permanent' | null {
  // Rejection signals: body-only checks (status code irrelevant)
  for (const sig of config.rejection_signals ?? []) {
    if (matchRejectionSignal(sig, body)) return 'rejection'
  }

  // Transient overrides
  for (const sig of config.transient_signals ?? []) {
    if (matchStatusSignal(sig, status, body, headers)) return 'transient'
  }

  // Permanent overrides
  for (const sig of config.permanent_signals ?? []) {
    if (matchStatusSignal(sig, status, body, headers)) return 'permanent'
  }

  return null
}

function matchRejectionSignal(sig: RejectionSignal, body: unknown): boolean {
  const value = getBodyField(body, sig.field)

  if (sig.present !== undefined) {
    const exists = value !== undefined && value !== null
    return sig.present ? exists : !exists
  }
  if (sig.equals !== undefined) {
    // Loose equality: handle string "true"/"false" ↔ boolean
    return looseEquals(value, sig.equals)
  }
  if (sig.contains !== undefined) {
    return typeof value === 'string' && value.includes(sig.contains)
  }
  return false
}

function matchStatusSignal(
  sig: StatusSignal,
  status: number,
  body: unknown,
  headers: Record<string, string>
): boolean {
  // Status code filter — must match if specified
  if (sig.status_code !== undefined && sig.status_code !== status) return false

  // Header check
  if (sig.header !== undefined) {
    const headerValue = headers[sig.header.toLowerCase()]
    if (sig.present !== undefined) {
      const exists = headerValue !== undefined
      return sig.present ? exists : !exists
    }
    return headerValue !== undefined
  }

  // Body field check
  if (sig.body_field !== undefined) {
    const value = getBodyField(body, sig.body_field)
    if (sig.present !== undefined) {
      const exists = value !== undefined && value !== null
      return sig.present ? exists : !exists
    }
    if (sig.equals !== undefined) {
      return looseEquals(value, sig.equals)
    }
    if (sig.contains !== undefined) {
      return typeof value === 'string' && value.includes(sig.contains)
    }
  }

  // Only status_code was specified, and it matched
  return sig.status_code !== undefined
}

function getBodyField(body: unknown, field: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  return (body as Record<string, unknown>)[field]
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // String/boolean coercion: "false" == false, "true" == true
  if (typeof b === 'boolean') {
    if (a === String(b)) return true
  }
  if (typeof b === 'number' && typeof a === 'string') {
    return parseFloat(a) === b
  }
  return false
}

// ── PRD Section 11.5 — Alert configuration ────────────────────────────────────

export interface AlertConfig {
  transient_errors?: {
    alert?: boolean   // default true
  }
  permanent_errors?: {
    alert?: boolean   // default true
  }
}

/**
 * Returns true if the alert should be suppressed based on alert_config.
 * Default behavior (no config) is to alert on everything.
 */
export function shouldSuppressAlert(
  config: AlertConfig | null | undefined,
  errorType: ErrorType
): boolean {
  if (!config || errorType === null) return false

  if (errorType === 'transient') {
    return config.transient_errors?.alert === false
  }
  if (errorType === 'permanent') {
    return config.permanent_errors?.alert === false
  }
  return false
}
