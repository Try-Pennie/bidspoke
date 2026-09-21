import type { ErrorType } from '../types'
import { PartnerApiError } from './partner-bid-error'
import { containsHtmlDocument } from '../lib/html-error-summary'
import { getBodyField, looseEquals, matchSignal, type Signal } from '@bidspoke/buyer-profile'

// Unified classification for an error thrown by a step executor. A
// PartnerApiError already carries an authoritative errorType (set by the
// resolver's response_classification override or the partner-bid catch), so
// honor it first — otherwise it falls through to the transport default and a
// permanent partner 4xx is misread as transient and retried. Falls back to
// HTTP status (thrown Response) and then the transport heuristic.
export function classifyStepError(err: unknown): ErrorType {
  if (err instanceof PartnerApiError) return err.errorType
  // A thrower that attached the response text gets the body rule applied (#756);
  // one that did not keeps the status-only behaviour, so nothing silently
  // becomes transient just by passing through here.
  if (err instanceof Response) {
    return classifyHttpErrorWithBody(err.status, (err as Response & { bodyText?: string }).bodyText)
  }
  return classifyTransportError(err)
}

// A code node that returns an HTTP error response (sentinel failure) carries the
// upstream API's error JSON in its body — the single most useful thing for
// debugging. The body used to be sliced to 300 chars, which chopped the useful
// tail: an Equifax 500 whose `additionalErrorDetails` sat past the cut showed
// "Please refer to additionalErrorDetails" with the details themselves gone.
// Store the FULL body — the execution detail view shows it whole behind a
// "Show more" toggle, and the Slack send path caps for the API's per-block
// limit. No truncation happens here.
export function formatCodeErrorMessage(status: number, body: unknown): string {
  const base = `Code returned error response: HTTP ${status}`
  if (!body) return base
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return `${base} — ${text}`
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

/**
 * The single home of the HTML-error-page rule (#694, extended to every outbound
 * node by #756).
 *
 * When an upstream answers with an HTML document instead of data, the request
 * died at an edge or proxy and was never processed as a business call, so it is
 * transient whatever status came with it. Observed on Salesforce Edge, which
 * returns HTTP 400 with a full error page: status alone made that permanent,
 * retries_used = 0, and the lead was dropped to a blip one retry would have
 * absorbed.
 *
 * Strictly an ADDITION to the status rule. With no body it is exactly
 * classifyHttpError, which is asserted across every status in the tests, so this
 * can never quietly reclassify an ordinary failure.
 *
 * If such a page ever does wrap a genuinely permanent fault, the cost is the
 * retries before it fails anyway, not a wrong answer. Callers log
 * `event=html_error_page_transient` so the frequency stays measurable rather
 * than assumed.
 *
 * Note this does NOT outrank a partner's `response_classification` override:
 * classifyStepError honours PartnerApiError.errorType first, and the resolver
 * sets that from the override before any of this is reached.
 */
export function classifyHttpErrorWithBody(
  status: number,
  bodyText: string | null | undefined,
): ErrorType {
  if (typeof bodyText === 'string' && bodyText.length > 0 && containsHtmlDocument(bodyText)) {
    return 'transient'
  }
  return classifyHttpError(status)
}

export function classifyTransportError(err: unknown): ErrorType {
  // Caller-marked permanent errors (e.g. Branch node's else=error case) skip retry
  if (err && typeof err === 'object' && (err as { permanent?: boolean }).permanent === true) {
    return 'permanent'
  }
  // A deterministic programming error thrown inside a code-node sandbox
  // (TypeError reading an undefined step, ReferenceError, etc.) can never
  // succeed on retry — and retrying re-fires any outbound call the script
  // already made before crashing (observed: duplicate engine lead creation,
  // #458). Classify it permanent so withRetry fails fast. The sandbox reports
  // the thrown error's constructor name as `codeErrorName`.
  if (err && typeof err === 'object') {
    const codeErrorName = (err as { codeErrorName?: string }).codeErrorName
    const message = err instanceof Error ? err.message : ''
    if (isDeterministicCodeError(codeErrorName, message)) return 'permanent'
  }
  // Network failures, timeouts, DNS errors are always transient
  return 'transient'
}

// Native error constructors that signal a deterministic bug in a code-node
// script. These never resolve on retry.
const DETERMINISTIC_CODE_ERROR_NAMES = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']

// fetch() network failures in Workers also reject with a TypeError, so a
// TypeError carrying one of these messages is a transient network blip, not a
// programming bug — keep retrying those. Matched case-insensitively.
const NETWORK_FAILURE_MARKERS = [
  'fetch failed',
  'failed to fetch',
  'network connection lost',
  'the network connection was lost',
  'connection was closed',
  'connection lost',
]

/**
 * True when a code-node sandbox error is a deterministic programming error that
 * will never succeed on retry (#458). Takes the thrown error's constructor name
 * and message. A TypeError whose message looks like a fetch network failure is
 * excluded — those stay transient so genuine network blips still retry.
 */
export function isDeterministicCodeError(errorName: string | undefined, message: string): boolean {
  if (!errorName || !DETERMINISTIC_CODE_ERROR_NAMES.includes(errorName)) return false
  if (errorName === 'TypeError') {
    const lower = message.toLowerCase()
    if (NETWORK_FAILURE_MARKERS.some((m) => lower.includes(m))) return false
  }
  return true
}

// ── PRD Section 11.2 — Per-partner response classification overrides ───────────

/**
 * A rejection signal is one field path plus one operator. The shape and the
 * matching live in @bidspoke/buyer-profile (#1408), so the decline half of a
 * partner's response rules is read identically by Main Flow's bid group here and
 * by the buyer_select node (L89, L370). Dot paths and `[]` array segments are
 * both supported, for example `details[].message`.
 */
export type RejectionSignal = Signal

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

// One implementation of the field matching, shared with the buyer_select node.
const matchRejectionSignal = (sig: RejectionSignal, body: unknown): boolean => matchSignal(sig, body)

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
//
// Deliberately NOT here: the Salesforce bulkhead shed ("Salesforce bulkhead: at
// capacity ..."). It is our OWN gate refusing before any SF call, so retrying it
// re-enters the gate and adds zero SF load, the opposite of REQUEST_LIMIT_EXCEEDED
// (whose retry hits SF). It must stay retryable so a lead rides out a brief SF
// slowdown; do not add it as a saturation marker.
const SATURATION_MARKERS = ['REQUEST_LIMIT_EXCEEDED']

export function isSaturationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as { saturated?: boolean }).saturated === true) return true
  const message = err instanceof Error ? err.message : ''
  return SATURATION_MARKERS.some((m) => message.includes(m))
}
