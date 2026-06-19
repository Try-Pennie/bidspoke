import type { ErrorType } from '../types'
import { PartnerApiError } from './partner-bid-error'

// Unified classification for an error thrown by a step executor. A
// PartnerApiError already carries an authoritative errorType (set by the
// resolver's response_classification override or the partner-bid catch), so
// honor it first — otherwise it falls through to the transport default and a
// permanent partner 4xx is misread as transient and retried. Falls back to
// HTTP status (thrown Response) and then the transport heuristic.
export function classifyStepError(err: unknown): ErrorType {
  if (err instanceof PartnerApiError) return err.errorType
  if (err instanceof Response) return classifyHttpError(err.status)
  return classifyTransportError(err)
}

// A code node that returns an HTTP error response (sentinel failure) carries the
// upstream API's error JSON in its body — the single most useful thing in the
// failure alert. The body was previously sliced to 300 chars, which chopped the
// useful tail: an Equifax 500 whose `additionalErrorDetails` sat past the cut
// showed "Please refer to additionalErrorDetails" with the details themselves
// gone. Allow up to the Slack section limit (2000) so the whole body reaches
// both the failure alert and the execution detail view.
export const CODE_ERROR_BODY_MAX = 2000

export function formatCodeErrorMessage(status: number, body: unknown): string {
  const base = `Code returned error response: HTTP ${status}`
  if (!body) return base
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const shown = text.length > CODE_ERROR_BODY_MAX ? `${text.slice(0, CODE_ERROR_BODY_MAX)}…` : text
  return `${base} — ${shown}`
}

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
  field: string         // body field to check (dot-path supported: e.g. `data.createLead.resultCode`)
  equals?: unknown      // exact value match (loose equality)
  contains?: string     // string contains check
  in?: unknown[]        // loose membership: value is in this list
  not_in?: unknown[]    // loose non-membership: value is NOT in this list
  present?: boolean     // field is/isn't present
}

export interface StatusSignal {
  status_code?: number  // HTTP status code to match (if omitted, matches any)
  body_field?: string   // body field to inspect (dot-path supported)
  equals?: unknown      // exact value match
  contains?: string     // string contains
  in?: unknown[]        // loose membership
  not_in?: unknown[]    // loose non-membership
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
  if (Array.isArray(sig.in)) {
    return sig.in.some((m) => looseEquals(value, m))
  }
  if (Array.isArray(sig.not_in)) {
    if (value === undefined) return false   // missing field shouldn't match not_in
    return !sig.not_in.some((m) => looseEquals(value, m))
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
    if (Array.isArray(sig.in)) {
      return sig.in.some((m) => looseEquals(value, m))
    }
    if (Array.isArray(sig.not_in)) {
      if (value === undefined) return false
      return !sig.not_in.some((m) => looseEquals(value, m))
    }
  }

  // Only status_code was specified, and it matched
  return sig.status_code !== undefined
}

function getBodyField(body: unknown, field: string): unknown {
  if (!field) return undefined
  if (typeof body !== 'object' || body === null) return undefined
  const parts = field.split('.').filter(Boolean)
  let cur: unknown = body
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

// Equality across the partner response value (`a`, typed from the partner's
// JSON) and the configured signal value (`b`, author-entered). Coerce in BOTH
// directions: the previous version only handled b=number/a=string, so a numeric
// response field (e.g. resultCode 1000) vs a string config ("1000") silently
// failed to match — the same class of bug as the branch condition operators.
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // boolean ↔ its string form ("true"/"false"), either side
  if (typeof a === 'boolean' && typeof b === 'string') return String(a) === b
  if (typeof b === 'boolean' && typeof a === 'string') return String(b) === a
  // number ↔ numeric string, either side
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '') return a === Number(b)
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '') return b === Number(a)
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

// ── Saturation signals — transient for classification, never retried in-execution ──
//
// During the 2026-06-10 create_prospect incident, Salesforce 403
// REQUEST_LIMIT_EXCEEDED (the ConcurrentRequests governor) was opted into a
// node's transient_errors and retried immediately. Each Bidspoke-side timeout
// had ALSO abandoned a call that kept running server-side (~74s each), so
// every retry stacked another request onto the saturated 25-slot long-running
// pool — retries actively deepened the outage. A saturation signal means "the
// upstream has no capacity right now": the transient classification stays
// (alerting and circuit breakers should see it), but withRetry skips further
// in-execution attempts instead of amplifying. Executors can also mark an
// error explicitly via `err.saturated = true` for partner-specific signals.
const SATURATION_MARKERS = ['REQUEST_LIMIT_EXCEEDED']

export function isSaturationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as { saturated?: boolean }).saturated === true) return true
  const message = err instanceof Error ? err.message : ''
  return SATURATION_MARKERS.some((m) => message.includes(m))
}
