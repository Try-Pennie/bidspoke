/**
 * Structured JSON logger — PRD Section 10.3
 *
 * Every Worker invocation emits structured JSON lines via console.log().
 * Cloudflare captures these automatically and they are exportable via Logpush (Phase 3).
 *
 * All log lines share a consistent shape so they are filterable and aggregatable
 * without custom parsing. Search by trace_id to trace a single lead end-to-end.
 */

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

export function log(fields: LogFields): void {
  console.log(JSON.stringify(fields))
}
