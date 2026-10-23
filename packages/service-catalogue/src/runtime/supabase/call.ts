import { supabaseProjectHost, supabaseProjectRefOf } from '../../schema/supabase-project'
import { ActionFailure } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'

/**
 * How a catalogue Supabase action talks to a project (#2337): one PostgREST
 * request to https://<ref>.supabase.co/rest/v1 through the step's connection
 * bound fetch, which puts the service key on it (apikey and a bearer token)
 * and refuses any other host, so an action never holds the key. Request
 * building follows what Pipedream's supabase-js calls sent (PipedreamHQ/pipedream
 * components/supabase/supabase.app.mjs, at commit b7d67916): select=* and
 * Prefer: return=representation on a write, so the rows come back, and the
 * answer shaped as supabase-js answered, { error, data, count, status, statusText }.
 * Pipedream's own retry of a failed select (three tries, 1 and 2 s apart) is
 * not kept: a read the executor may repeat is the executor's to repeat.
 *
 * A failure is read once, here:
 *  - what the connection bound fetch throws for a request not yet answered (a
 *    refused key after its one renewal, a 429 turned into a requeue, a timeout)
 *    passes on unchanged, for the executor to judge (runtime/failure.ts);
 *  - a refusal is `supabase_<PostgREST's or Postgres's code>` (PGRST116,
 *    23505), or `supabase_http_<status>` when it names none, never quoting the
 *    message, which can quote the row. A 4xx is not applied (a 429 that reached
 *    the action names its wait); a 5xx or a 3xx is unknown for a write and not
 *    applied for a read;
 *  - a 2xx that is not a JSON list of rows was applied for a write and not for a read.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const CODE = /^[A-Za-z0-9]{1,16}$/
const CONTENT_RANGE = /^(?:\d+-\d+|\*)\/(\d+|\*)$/

export const invalid = (message: string) => new ActionFailure('supabase_argument_invalid', message, 'not_applied')

const blank = (value: JsonValue | undefined) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

function isObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The declared project's REST base, or a refusal by name: a target naming no project sends nothing. */
export function restBaseOf(ctx: ActionContext): string {
  const ref = supabaseProjectRefOf(isObject(ctx.target) ? ctx.target.project_url : undefined)
  if (ref === null) throw new ActionFailure('supabase_target_invalid', 'the connection names no Supabase project', 'not_applied')
  return `https://${supabaseProjectHost(ref)}/rest/v1`
}

/** A table or column name: letters, digits and underscores, so it can never carry an operator or a second parameter. */
export function identifierOf(args: ActionArgs, key: string, missing: string | null): string | undefined {
  const raw = args[key]
  if (blank(raw)) {
    if (missing !== null) throw new ActionFailure(missing, `the step names no ${key.replace('_', ' ')}`, 'not_applied')
    return undefined
  }
  if (typeof raw !== 'string' || !IDENTIFIER.test(raw.trim())) throw invalid(`${key} must be a name of letters, digits and underscores`)
  return raw.trim()
}

/** A text value to filter on: a string, a number or true or false, as text. */
export function filterValueOf(args: ActionArgs, key: string, missing: string | null): string | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') {
    if (missing !== null) throw new ActionFailure(missing, `the step names no ${key}`, 'not_applied')
    return undefined
  }
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') throw invalid(`${key} must be text, a number, or true or false`)
  return String(raw)
}

export interface SupabaseRequest {
  readonly method: 'GET' | 'POST' | 'PATCH'
  readonly table: string
  readonly query: ReadonlyArray<readonly [string, string]>
  readonly body?: JsonValue
  readonly prefer: string
  /** Whether the request writes, which decides an uncertain outcome. */
  readonly writes: boolean
}

export interface SupabaseAnswer {
  readonly rows: readonly JsonValue[]
  /** The match count Content-Range named, or null where it named none. */
  readonly count: number | null
  readonly status: number
  readonly statusText: string
}

/** Sends one request and answers its rows, or throws the failure by name. */
export async function supabaseRequest(ctx: ActionContext, request: SupabaseRequest): Promise<SupabaseAnswer> {
  const url = new URL(`${restBaseOf(ctx)}/${request.table}`)
  url.searchParams.set('select', '*')
  for (const [k, v] of request.query) url.searchParams.append(k, v)
  const what = `${request.method} ${request.table}`
  const uncertain = request.writes ? 'unknown' : 'not_applied'
  const answered = request.writes ? 'applied' : 'not_applied'
  const headers: Record<string, string> = { prefer: request.prefer }
  const init: RequestInit = { method: request.method, signal: ctx.signal, headers }
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(request.body)
  }
  // Anything the connection bound fetch throws passes through unchanged.
  const response = await ctx.fetch(url.toString(), init)
  const status = response.status

  if (status < 200 || status >= 300) {
    let code: string | null = null
    try {
      const body: unknown = await response.json()
      if (isObject(body) && typeof body.code === 'string' && CODE.test(body.code)) code = body.code
    } catch {
      // Not JSON: named by its status below.
    }
    const named = `supabase_${code ?? `http_${status}`}`
    const said = code === null ? `HTTP ${status}` : `HTTP ${status} (${code})`
    if (status === 429) {
      const retryAfter = response.headers.get('retry-after')
      const wait = retryAfter === null ? 'no Retry-After' : `Retry-After ${retryAfter} s`
      throw new ActionFailure(named, `Supabase rate limited ${what} (${wait}); not sent`, 'not_applied')
    }
    if (status >= 500 || status < 400) throw new ActionFailure(named, `Supabase answered ${what} with ${said}`, uncertain)
    throw new ActionFailure(named, `Supabase refused ${what}: ${said}`, 'not_applied')
  }

  let rows: unknown
  try {
    rows = await response.json()
  } catch {
    throw new ActionFailure('supabase_answer_unreadable', `Supabase's answer to ${what} was not JSON`, answered)
  }
  if (!Array.isArray(rows)) throw new ActionFailure('supabase_answer_unreadable', `Supabase's answer to ${what} was not a list of rows`, answered)
  const range = CONTENT_RANGE.exec(response.headers.get('content-range')?.trim() ?? '')
  const count = range === null || range[1] === '*' ? null : Number(range[1])
  return { rows: rows as JsonValue[], count, status, statusText: response.statusText }
}

/** The answer as supabase-js gave it to Pipedream's step: a failure throws, so error is always null. */
export function asSupabaseJs(answer: SupabaseAnswer, count: number | null): JsonValue {
  return { error: null, data: answer.rows, count, status: answer.status, statusText: answer.statusText }
}

/** A row's data: a JSON object of at least one column. */
export function rowOf(value: JsonValue | undefined, key: string): Readonly<Record<string, JsonValue>> {
  if (!isObject(value) || Object.keys(value).length === 0) throw invalid(`${key} must be a JSON object of at least one column`)
  return value
}

export { blank }
