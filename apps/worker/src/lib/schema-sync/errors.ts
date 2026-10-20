/**
 * How a schema lookup fails (#2335, PR 7 of phase 5).
 *
 * Every failure is a SchemaLookupError with one code per cause (L11), and never
 * an empty list standing in for one (L10): a describe that failed used to come
 * back as the object with `fields: []`, which the canvas showed as an object with
 * no fields and cached over the last good copy.
 *
 * The message is shown to a person (the lookup route answers it) and is
 * what Workers Logs and the tail trace record of an uncaught error, so it is
 * built from names alone: the service, the step, an object or table name that
 * is a plain identifier, an HTTP status, a refusal code. Never a provider's
 * response text, a thrown error's message, a URL or a login, and no `cause`
 * (finding F120).
 */
import type { SchemaService } from './types'

export const SCHEMA_LOOKUP_CODES = [
  /** The legacy route's stored login is not readable JSON, or lacks a field. */
  'schema_credentials_malformed',
  /** The source names an address or database the lookup will not use. */
  'schema_source_invalid',
  /** A key, or a parent name, the service does not answer. Nothing was sent. */
  'schema_key_invalid',
  /** 401 or 403: the login or token was refused, or lacks access. */
  'schema_auth_refused',
  /** 404, or the object or table is not in the answer. */
  'schema_not_found',
  /** 429. */
  'schema_rate_limited',
  /** Any other status that is not success, a 5xx included. */
  'schema_service_error',
  /** The request timed out before the service answered. */
  'schema_request_timeout',
  /** The request failed before the service answered, for any other reason. */
  'schema_request_failed',
  /** An answer that is not JSON, or not the shape the lookup reads. */
  'schema_response_malformed',
  /** A Snowflake query still running when the poll's wait ended. */
  'schema_query_still_running',
] as const
export type SchemaLookupCode = (typeof SCHEMA_LOOKUP_CODES)[number]

/** Which request failed. */
export type SchemaStep =
  | 'credentials'
  | 'key'
  | 'object_list'
  | 'object_describe'
  | 'openapi'
  | 'statement'
  | 'statement_poll'
  | 'statement_partition'

const SERVICE_LABELS: Record<SchemaService, string> = { salesforce: 'Salesforce', supabase: 'Supabase', snowflake: 'Snowflake' }

/** A name safe to repeat in a message: an API name, a schema.table, a partition number. */
const PLAIN_NAME = /^[A-Za-z0-9_$.-]{1,255}$/

export function isPlainName(value: string): boolean {
  return PLAIN_NAME.test(value)
}

export interface SchemaLookupFailure {
  readonly code: SchemaLookupCode
  readonly service: SchemaService
  readonly step: SchemaStep
  /** The object, table or partition the request was about, when it is a plain name. */
  readonly subject?: string | null
  readonly status?: number | null
  /** A refusal the injected fetch threw, by its code (on ops, a ConnectionRefusal's). */
  readonly upstreamCode?: string | null
  /** A name-only detail: which field is missing, which rule refused. */
  readonly detail?: string
}

function stepText(step: SchemaStep, subject: string | null): string {
  switch (step) {
    case 'credentials': return 'read the stored connection login'
    case 'key': return subject ? `look up ${subject}` : 'look up'
    case 'object_list': return 'list its objects'
    case 'object_describe': return subject ? `describe ${subject}` : 'describe an object'
    case 'openapi': return 'list its tables'
    case 'statement': return 'run the schema query'
    case 'statement_poll': return 'check on the schema query'
    case 'statement_partition': return subject ? `fetch result part ${subject}` : 'fetch a result part'
  }
}

function messageOf(f: SchemaLookupFailure, subject: string | null): string {
  const service = SERVICE_LABELS[f.service]
  const what = stepText(f.step, subject)
  const upstream = f.upstreamCode ? ` (${f.upstreamCode})` : ''
  const detail = f.detail ? `: ${f.detail}` : ''
  switch (f.code) {
    case 'schema_credentials_malformed':
      return `the stored ${service} connection login could not be read${detail}`
    case 'schema_source_invalid':
      return `the ${service} connection names an address the lookup will not use${detail}`
    case 'schema_key_invalid':
      return `${service} lookups do not answer that${detail}`
    case 'schema_auth_refused':
      return `${service} refused the request to ${what} (HTTP ${f.status ?? 'unknown'})`
    case 'schema_not_found':
      return f.status ? `${service} answered HTTP ${f.status} to the request to ${what}` : `${service} has no ${subject ?? 'such object'}`
    case 'schema_rate_limited':
    case 'schema_service_error':
      return `${service} answered HTTP ${f.status ?? 'unknown'} to the request to ${what}`
    case 'schema_request_timeout':
      return `the request to ${service} to ${what} timed out${upstream}`
    case 'schema_request_failed':
      return `the request to ${service} to ${what} failed before ${service} answered${upstream}`
    case 'schema_response_malformed':
      return `${service} answered the request to ${what} with a body that is not the expected shape`
    case 'schema_query_still_running':
      return `the ${service} schema query was still running when the wait ended; try Sync again in a moment`
  }
}

export class SchemaLookupError extends Error {
  readonly code: SchemaLookupCode
  readonly service: SchemaService
  readonly step: SchemaStep
  readonly subject: string | null
  readonly status: number | null
  readonly upstreamCode: string | null

  constructor(failure: SchemaLookupFailure) {
    const subject = failure.subject && isPlainName(failure.subject) ? failure.subject : null
    super(`${failure.code}: ${messageOf(failure, subject)}`)
    this.name = 'SchemaLookupError'
    this.code = failure.code
    this.service = failure.service
    this.step = failure.step
    this.subject = subject
    this.status = failure.status ?? null
    this.upstreamCode = failure.upstreamCode ?? null
  }
}
