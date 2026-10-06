/**
 * Structured JSON logger — PRD Section 10.3
 *
 * Every Worker invocation emits structured JSON lines via console.log().
 * Cloudflare captures these automatically and they are exportable via Logpush (Phase 3).
 *
 * All log lines share a consistent shape so they are filterable and aggregatable
 * without custom parsing. Search by trace_id to trace a single lead end-to-end.
 */

import { stripUrlQueriesInText } from './url-redact'

export type LogEvent =
  | 'execution_start'
  | 'execution_complete'
  | 'execution_failed'
  | 'step_start'
  | 'step_complete'
  | 'step_error'
  | 'step_skipped'
  | 'partner_bid'
  | 'circuit_open'
  | 'cap_check'
  | 'dedup_check_failed'
  | 'cap_check_failed'
  | 'circuit_breaker_record_failed'
  | 'idempotency_hit'
  | 'idempotency_derive_empty'
  // Two code nodes both quoted a rate back to the source, so the value was refused
  // rather than guessed by insertion order (#1162). A money field: the refusal has
  // to be visible, or it is indistinguishable from a run that quoted nothing.
  | 'quoted_rate_ambiguous'
  // buyer_select (#1411). The flag event fires when sell_off_when resolved to
  // something other than a boolean and was treated as false, because a silent
  // coercion here would hide a broken template as a quiet day. The latency event
  // is stamped decide_only so nobody reads it as the cost of a live sale.
  | 'sell_off_flag_not_boolean'
  | 'buyer_select_decide_only_latency'
  | 'buyer_select_reason'
  | 'buyer_select_mirror_failed'
  | 'buyer_select_rehearsal_caps_unset'

export interface LogFields {
  event: LogEvent
  trace_id: string
  workflow_id?: string
  workflow_version_id?: string
  execution_id?: string
  step_namespace?: string
  step_type?: string
  duration_ms?: number
  error_type?: string | null
  error_message?: string
  partner_id?: string
  [key: string]: unknown
}

/**
 * Every address in the line loses its query string and fragment before it is
 * written (L741, #1740): an error text such as a fetch failure names the full
 * address it called, and a query string can carry lead data no scrub can read.
 */
export function log(fields: LogFields): void {
  console.log(stripUrlQueriesInText(JSON.stringify(fields)))
}
