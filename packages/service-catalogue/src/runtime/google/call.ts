import { ActionFailure, type ActionOutcome } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'

/**
 * How a catalogue Google action talks to Google (#2337): one REST request
 * through the step's connection bound fetch, which mints the delegated token for
 * the connection's mailbox (minters/google.ts: the organization's list checked
 * first, the catalogue's scopes only), puts it on the request and refuses any
 * host but the Google entry's declared ones, so an action never holds a token.
 * Re-implemented over the REST APIs Pipedream's apps call through the googleapis
 * SDK (components/google_sheets, gmail and google_calendar, at commit b7d67916),
 * since a Worker carries no SDK.
 *
 * A failure is read once, here:
 *  - what the connection bound fetch throws for a request not yet answered (an
 *    expired or revoked login, a mailbox taken off the list, a 429 turned into a
 *    requeue, a timeout) is passed on unchanged, for the executor to judge
 *    (runtime/failure.ts);
 *  - a refusal is `google_<Google's status>` (PERMISSION_DENIED, NOT_FOUND,
 *    INVALID_ARGUMENT, RESOURCE_EXHAUSTED, ...), else `google_http_<status>`; its
 *    message names the status and Google's reason, never Google's message, which
 *    can quote what was sent;
 *  - a refusal (4xx, a 429 included) was not applied; a 5xx may have been, so a
 *    write's outcome is unknown; a read changed nothing either way; a 2xx a
 *    write cannot read was applied.
 */

export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

export type GoogleEffect = 'read' | 'write'

export interface GoogleRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly url: string
  readonly body?: JsonValue
  /** `<METHOD> <what>`, for a message: never a value of the request. */
  readonly what: string
  readonly effect: GoogleEffect
  /** Failed statuses whose answer the caller reads itself (a calendar event already gone). */
  readonly answers?: readonly number[]
}

export interface GoogleAnswer {
  readonly status: number
  readonly response: Response
}

export type GoogleObject = Readonly<Record<string, JsonValue>>

const NAME = /^[A-Za-z0-9_]{1,64}$/

export const invalid = (message: string) => new ActionFailure('google_argument_invalid', message, 'not_applied')

export function isObject(value: unknown): value is GoogleObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function unreadable(request: Pick<GoogleRequest, 'what' | 'effect'>, why: string): ActionFailure {
  const outcome: ActionOutcome = request.effect === 'write' ? 'applied' : 'not_applied'
  return new ActionFailure('google_answer_unreadable', `Google's answer to ${request.what} ${why}`, outcome)
}

/** The failure a refused or failed answer is, by name; never Google's message. */
export async function googleFailure(request: Pick<GoogleRequest, 'what' | 'effect'>, response: Response): Promise<ActionFailure> {
  const status = response.status
  let googleStatus: string | null = null
  let reason: string | null = null
  try {
    const parsed: unknown = await response.json()
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null
    if (error !== null && typeof error.status === 'string' && NAME.test(error.status)) googleStatus = error.status
    const first: JsonValue | undefined = error !== null && Array.isArray(error.errors) ? (error.errors as readonly JsonValue[])[0] : undefined
    if (isObject(first) && typeof first.reason === 'string' && NAME.test(first.reason)) reason = first.reason
  } catch {
    // Not JSON: named by its status below.
  }
  const code = googleStatus === null ? `google_http_${status}` : `google_${googleStatus.toLowerCase()}`
  const said = [`HTTP ${status}`, googleStatus, reason].filter((x) => x !== null).join(', ')
  if (status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const wait = retryAfter === null ? 'no Retry-After' : `Retry-After ${retryAfter.slice(0, 32)} s`
    return new ActionFailure(code, `Google rate limited ${request.what} (${said}; ${wait}); not applied`, 'not_applied')
  }
  if (status >= 500 && request.effect === 'write') {
    return new ActionFailure(code, `Google answered ${request.what} with ${said}, so whether it was applied is unknown`, 'unknown')
  }
  return new ActionFailure(code, `Google refused ${request.what}: ${said}`, 'not_applied')
}

/** Sends one request and answers the response when it succeeded (or is one the caller reads), or throws the failure by name. */
export async function googleSend(ctx: ActionContext, request: GoogleRequest, headers: Record<string, string> = {}): Promise<GoogleAnswer> {
  const sent: Record<string, string> = { accept: 'application/json', ...headers }
  let body: string | undefined
  if (request.body !== undefined) {
    body = JSON.stringify(request.body)
    sent['content-type'] = 'application/json'
  }
  // Anything the connection bound fetch throws passes through unchanged.
  const response = await ctx.fetch(request.url, { method: request.method, headers: sent, body, signal: ctx.signal })
  if (response.ok || (request.answers ?? []).includes(response.status)) return { status: response.status, response }
  throw await googleFailure(request, response)
}

/** Sends one request whose answer is a JSON object, and answers it. A 204 answers an empty object. */
export async function googleJson(ctx: ActionContext, request: GoogleRequest): Promise<GoogleObject> {
  const { response } = await googleSend(ctx, request)
  if (response.status === 204) return {}
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw unreadable(request, 'was not JSON')
  }
  if (!isObject(parsed)) throw unreadable(request, 'was not a JSON object')
  return parsed
}

// ── arguments ───────────────────────────────────────────────────────────────

export function text(args: ActionArgs, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${key} is required and must be text`)
  return value
}

export function optionalText(args: ActionArgs, key: string): string | null {
  const value = args[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalid(`${key} must be text`)
  return value
}

export function optionalBoolean(args: ActionArgs, key: string): boolean {
  const value = args[key]
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw invalid(`${key} must be true or false`)
  return value
}

/** One of the choices given, or the first when the step leaves it out. */
export function choice<T extends string>(args: ActionArgs, key: string, choices: readonly T[]): T {
  const value = args[key]
  if (value === undefined || value === null || value === '') return choices[0]
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) throw invalid(`${key} must be one of ${choices.join(', ')}`)
  return value as T
}

/** A whole number at least `min`, given as a number or as its digits. */
export function wholeNumber(args: ActionArgs, key: string, min: number, required: boolean): number | null {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw invalid(`${key} is required`)
    return null
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN
  if (!Number.isSafeInteger(n) || n < min) throw invalid(`${key} must be a whole number of at least ${min}`)
  return n
}

/** The declared mailbox and drives, from the connection's target. */
export function googleTargetOf(target: JsonValue): { subject: string; drives: readonly string[] } {
  const t = isObject(target) ? target : {}
  const subject = typeof t.subject === 'string' ? t.subject.trim().toLowerCase() : ''
  if (subject === '') throw new ActionFailure('google_target_invalid', 'the connection\'s target declares no mailbox to act as', 'not_applied')
  const drives = Array.isArray(t.drives) ? t.drives.filter((d): d is string => typeof d === 'string') : []
  return { subject, drives }
}
