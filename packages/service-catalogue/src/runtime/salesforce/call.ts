import {
  containsHtmlDocument, extractSalesforceErrorCode, extractSalesforceErrorFields, parseSalesforceResponse, salesforceDataUrl, salesforceInstanceUrl,
  salesforceNextPageUrl, salesforceRejectedTheWrite,
} from '@bidspoke/salesforce-api'
import { ActionFailure, type ActionOutcome } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'

/**
 * How a catalogue Salesforce action talks to Salesforce (#2337): REST requests
 * to the connection's declared instance through the step's connection bound
 * fetch, which takes the ops pool's lease, puts the client credentials token on
 * the request and refuses any host but the declared instance, so an action
 * never holds a login. The URLs, the API version and the rules that read an
 * answer are the money path's own (@bidspoke/salesforce-api, moved out of the
 * Salesforce node by #2393 and into a package by this change), never a copy:
 * every data call is on SALESFORCE_API_VERSION, v60.0, which is also what the
 * ops lookups and the sf_limits read use. (Pipedream's Salesforce app called
 * v50.0, its code steps v58.0 to v66.0.)
 *
 * A failure is read once, here:
 *  - what the connection bound fetch throws for a request not yet answered (an
 *    expired or revoked login, a 429 turned into a requeue, a timeout) is passed
 *    on unchanged, for the executor to judge (runtime/failure.ts);
 *  - a refusal is `salesforce_<Salesforce's error code>` (MALFORMED_QUERY,
 *    INSUFFICIENT_ACCESS_OR_READONLY, REQUEST_LIMIT_EXCEEDED, NOT_FOUND, ...),
 *    else `salesforce_edge_page` for the Salesforce Edge error page (#694), else
 *    `salesforce_http_<status>`. Its message names the status, the code and the
 *    fields Salesforce blamed, never Salesforce's own message, which can quote a
 *    value that was sent;
 *  - whether a failed write was applied is the money path's own judgement
 *    (salesforceRejectedTheWrite): a rejection, a login or permission refusal
 *    (401, 403) and a rate limit were not; a server error or the edge page may
 *    have been, so a write's outcome is unknown. A read changed nothing either way.
 */

/** Pages salesforce.query reads before it fails by name: 25 x 2,000 rows at Salesforce's default batch. */
export const SALESFORCE_QUERY_MAX_PAGES = 25
/** The sObject Collections limit on records in one request. */
export const SALESFORCE_COLLECTION_MAX_RECORDS = 200
/** The largest CSV salesforce.bulk-ingest uploads (Salesforce takes 150 MB; a Worker holds the whole body). */
export const SALESFORCE_BULK_MAX_BYTES = 10 * 1024 * 1024
/** Result rows salesforce.get-ingest-job reads before it fails by name. */
export const SALESFORCE_RESULTS_MAX_ROWS = 10_000

/**
 * What a request does if Salesforce may have run it:
 *  - `read` changes nothing;
 *  - `write` may have been applied when its answer is a server error;
 *  - `opens` opens a bulk job, which runs nothing until it is closed.
 */
export type SalesforceEffect = 'read' | 'write' | 'opens'

export interface SalesforceRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly url: string
  /** JSON for an object or list, the text as it is for a string (a CSV upload). */
  readonly body?: JsonValue
  readonly contentType?: string
  readonly accept?: string
  /** `<METHOD> <what>`, for a message: never a value of the request. */
  readonly what: string
  readonly effect: SalesforceEffect
  /** Failed statuses whose answer the caller reads itself (a collection's per record results). */
  readonly answers?: readonly number[]
}

export interface SalesforceAnswer {
  readonly status: number
  readonly text: string
  /** The body: null when empty, its JSON, or the text itself when it is not JSON (parseSalesforceResponse). */
  readonly body: unknown
}

export const invalid = (message: string) => new ActionFailure('salesforce_argument_invalid', message, 'not_applied')

const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/
const FIELD_NAME = /^[A-Za-z0-9_.]{1,80}$/

/** The declared instance's origin, from the connection's target, or a refusal before anything is sent. */
export function salesforceInstanceOf(target: JsonValue): string {
  const raw = typeof target === 'object' && target !== null && !Array.isArray(target) ? (target as Record<string, JsonValue>).instance_url : undefined
  let url: URL | null
  try {
    url = typeof raw === 'string' ? new URL(raw.trim()) : null
  } catch {
    url = null
  }
  if (url === null || url.protocol !== 'https:') {
    throw new ActionFailure('salesforce_target_invalid', 'the connection\'s target declares no https Salesforce instance_url', 'not_applied')
  }
  return salesforceInstanceUrl(url.origin)
}

/** A data API URL on the declared instance, on SALESFORCE_API_VERSION. */
export function dataUrl(instance: string, path: string): string {
  return salesforceDataUrl(instance, path)
}

function wording(status: number, errorCode: string | null, fields: string[]): string {
  const named = errorCode === null ? `HTTP ${status}` : `HTTP ${status} (${errorCode})`
  const blamed = fields.filter((f) => FIELD_NAME.test(f))
  return blamed.length > 0 ? `${named}, blaming ${blamed.join(', ')}` : named
}

/** The failure a refused or failed answer is, by name; never Salesforce's message. */
export function salesforceFailure(request: Pick<SalesforceRequest, 'what' | 'effect'>, status: number, text: string, body: unknown): ActionFailure {
  const raw = extractSalesforceErrorCode(body)
  // Salesforce's codes are fixed names (INVALID_FIELD); anything else is never repeated.
  const errorCode = raw !== null && ERROR_CODE.test(raw) ? raw : null
  const said = wording(status, errorCode, extractSalesforceErrorFields(body))
  if (status === 300) {
    return new ActionFailure('salesforce_external_id_ambiguous', `Salesforce found several records for ${request.what}: HTTP 300; not applied`, 'not_applied')
  }
  const code = errorCode !== null
    ? `salesforce_${errorCode.toLowerCase()}`
    : containsHtmlDocument(text) ? 'salesforce_edge_page' : `salesforce_http_${status}`
  if (status === 429) {
    return new ActionFailure(code, `Salesforce rate limited ${request.what} (${said}); not applied`, 'not_applied')
  }
  const notApplied = request.effect !== 'write' || status === 401 || status === 403 || salesforceRejectedTheWrite(status, text)
  const outcome: ActionOutcome = notApplied ? 'not_applied' : 'unknown'
  return new ActionFailure(code, notApplied
    ? `Salesforce refused ${request.what}: ${said}`
    : `Salesforce answered ${request.what} with ${said}, so whether it was applied is unknown`, outcome)
}

/** The outcome of a 2xx answer that cannot be read: a write was applied, a read and a job opening changed nothing. */
export function unreadableOutcome(effect: SalesforceEffect): ActionOutcome {
  return effect === 'write' ? 'applied' : 'not_applied'
}

export function unreadable(request: Pick<SalesforceRequest, 'what' | 'effect'>, why: string): ActionFailure {
  return new ActionFailure('salesforce_answer_unreadable', `Salesforce's answer to ${request.what} ${why}`, unreadableOutcome(request.effect))
}

/** Sends one request and answers its status and body, or throws the failure by name. */
export async function salesforceSend(ctx: ActionContext, request: SalesforceRequest): Promise<SalesforceAnswer> {
  const headers: Record<string, string> = { accept: request.accept ?? 'application/json' }
  let body: string | undefined
  if (request.body !== undefined) {
    body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
    headers['content-type'] = request.contentType ?? 'application/json'
  }
  // Anything the connection bound fetch throws passes through unchanged.
  const response = await ctx.fetch(request.url, { method: request.method, headers, body, signal: ctx.signal })
  let text: string
  try {
    text = await response.text()
  } catch {
    if (response.ok) throw unreadable(request, 'could not be read')
    throw salesforceFailure(request, response.status, '', null)
  }
  const parsed = parseSalesforceResponse(text)
  if (response.ok || (request.answers ?? []).includes(response.status)) return { status: response.status, text, body: parsed }
  const failure = salesforceFailure(request, response.status, text, parsed)
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const wait = retryAfter === null ? 'no Retry-After' : `Retry-After ${retryAfter.slice(0, 32)} s`
    throw new ActionFailure(failure.code, `${failure.message}; ${wait}`, failure.outcome)
  }
  throw failure
}

export function isObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sends one request whose 2xx answer is a JSON object, and answers it. */
export async function salesforceObject(ctx: ActionContext, request: SalesforceRequest): Promise<Readonly<Record<string, JsonValue>>> {
  const answer = await salesforceSend(ctx, request)
  if (!isObject(answer.body)) throw unreadable(request, 'was not a JSON object')
  return answer.body
}

// ── arguments ───────────────────────────────────────────────────────────────

const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/
/** A field's API name, or a relationship's (Account.External_Id__c), as a bulk column may be. */
export const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}(?:\.[A-Za-z][A-Za-z0-9_]{0,79})?$/
/** A record or job id: 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/

export function text(args: ActionArgs, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${key} is required and must be text`)
  return value
}

export function objectName(args: ActionArgs, key = 'object'): string {
  const value = text(args, key).trim()
  if (!OBJECT_NAME.test(value)) throw invalid(`${key} must be one object or field API name, such as Lead or Prospect__c`)
  return value
}

export function recordId(args: ActionArgs, key: string): string {
  const value = text(args, key).trim()
  if (!RECORD_ID.test(value)) throw invalid(`${key} must be a 15 or 18 character Salesforce id`)
  return value
}

export function fieldsOf(args: ActionArgs, key = 'fields'): Readonly<Record<string, JsonValue>> {
  const value = args[key]
  if (!isObject(value)) throw invalid(`${key} must be an object of field API names and values`)
  return value
}

export function optionalBoolean(args: ActionArgs, key: string): boolean {
  const value = args[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw invalid(`${key} must be true or false`)
  return value
}

// ── query pages ─────────────────────────────────────────────────────────────

export interface QueryPage {
  readonly totalSize: number
  readonly done: boolean
  readonly records: readonly JsonValue[]
  readonly nextRecordsUrl: string | null
  readonly raw: Readonly<Record<string, JsonValue>>
}

/** One page of a query, read as one, or unreadable by name. */
export async function queryPage(ctx: ActionContext, url: string, what: string): Promise<QueryPage> {
  const request: SalesforceRequest = { method: 'GET', url, what, effect: 'read' }
  const page = await salesforceObject(ctx, request)
  const { totalSize, done, records, nextRecordsUrl } = page
  if (typeof totalSize !== 'number' || typeof done !== 'boolean' || !Array.isArray(records)) throw unreadable(request, 'was not a query result')
  if (nextRecordsUrl !== undefined && nextRecordsUrl !== null && typeof nextRecordsUrl !== 'string') throw unreadable(request, 'named a next page that is not a path')
  return { totalSize, done, records, nextRecordsUrl: typeof nextRecordsUrl === 'string' ? nextRecordsUrl : null, raw: page }
}

/** A query's next page URL on the declared instance (connectionFetch refuses any other host). */
export function nextPageUrl(instance: string, next: string): string {
  return salesforceNextPageUrl(instance, next)
}
