import { ActionFailure } from '../failure'

/**
 * The catalogue's Snowflake SQL API client (#2337): the one way the Snowflake
 * actions, and the ops Worker's verify probe (apps/worker
 * src/ops/connections/snowflake-service.ts), send a statement. Every request
 * goes through the connection bound fetch the caller is handed, which applies
 * the key pair JWT (the ops minter, minters/snowflake.ts), so nothing here ever
 * holds a login, and nothing here writes to the console.
 *
 * Built on the SQL API behaviour the export path relies on in production
 * (apps/worker src/lib/snowflake.ts: a requestId per statement, 202 polled by
 * statement handle, every result partition read, the row count reconciled), but
 * not shared with it: that path is the bidding Worker's export, which stays
 * exactly as it is (#2337), and its resubmits, logging and budgets are its own.
 *
 * WHAT IT DOES NOT DO. It never resubmits. A send that failed is the executor's
 * to judge (failure.ts), and once a statement has run, a failure reading its
 * result is `applied`, so nothing can repeat it. A NULL bind is not offered,
 * because Snowflake's documentation does not say how to send one: an insert
 * writes NULL as a literal instead (snowflake.insert-multiple-rows).
 */

/** The statement timeout sent with every statement, in seconds. */
export const SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS = 120
export const SNOWFLAKE_POLL_INTERVAL_MS = 2_000
/** Past Snowflake's 45 s switch to async, enough polls to outlast the statement timeout. */
export const SNOWFLAKE_MAX_POLLS = 60
/** The most rows a statement's result may carry. Past it the statement fails by name, never truncated. */
export const SNOWFLAKE_MAX_RESULT_ROWS = 10_000
const MESSAGE_LIMIT = 300

/** The first label of <account>.snowflakecomputing.com: a locator with its region, or org-account. The minter's rule. */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface SnowflakeTarget {
  readonly account: string
  readonly user: string
  readonly warehouse?: string
  readonly role?: string
  readonly database?: string
  readonly schema?: string
}

const SESSION_FIELDS = ['warehouse', 'role', 'database', 'schema'] as const

/** The connection's declared target, read: account and user required, the session fields optional strings. */
export function snowflakeTargetOf(target: unknown): SnowflakeTarget {
  const invalid = (why: string) => new ActionFailure('snowflake_target_invalid', `the Snowflake connection's target ${why}`, 'not_applied')
  if (target === null || typeof target !== 'object' || Array.isArray(target)) throw invalid('is not an object')
  const t = target as Record<string, unknown>
  const text = (name: string): string | undefined => {
    const value = Object.hasOwn(t, name) ? t[name] : undefined
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.trim() === '') throw invalid(`gives ${name} as something other than a name`)
    return value
  }
  const account = text('account')
  const user = text('user')
  if (account === undefined || !ACCOUNT.test(account)) throw invalid('declares no account identifier')
  if (user === undefined) throw invalid('declares no user')
  const session = Object.fromEntries(SESSION_FIELDS.map((name) => [name, text(name)]))
  return { account, user, ...session }
}

/** The account's host, as the export path names it (lib/snowflake.ts snowflakeHost). */
export function snowflakeHost(account: string): string {
  return `${account.toLowerCase()}.snowflakecomputing.com`
}

export interface SnowflakeStatementContext {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly signal?: AbortSignal
  readonly sleep: (ms: number) => Promise<void>
}

export interface SnowflakeStatementRequest {
  readonly statement: string
  /** Positional `?` binds, each sent as TEXT, which Snowflake casts to the column's type. */
  readonly bindings?: readonly string[]
}

export interface SnowflakeColumn {
  readonly name: string
  /** Snowflake's type name, lower case: fixed, real, text, boolean, date, time, timestamp_ntz, variant... */
  readonly type: string
  readonly scale: number | null
}

export interface SnowflakeResult {
  readonly columns: readonly SnowflakeColumn[]
  /** Every row of every partition, each value as Snowflake encoded it: a string, or null for NULL. */
  readonly rows: ReadonlyArray<ReadonlyArray<string | null>>
  readonly handle: string | null
}

type Body = Record<string, unknown>

const isObject = (value: unknown): value is Body => value !== null && typeof value === 'object' && !Array.isArray(value)
const clip = (text: string) => (text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}...` : text)

async function bodyOf(res: Response, outcome: 'unknown' | 'applied'): Promise<Body> {
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new ActionFailure('snowflake_answer_unreadable', `Snowflake answered HTTP ${res.status} with something that is not JSON`, outcome)
  }
  if (!isObject(parsed)) throw new ActionFailure('snowflake_answer_unreadable', `Snowflake answered HTTP ${res.status} with JSON that is not an object`, outcome)
  return parsed
}

/** A statement Snowflake answered with an error. A 4xx is Snowflake refusing it; a 5xx may have come after it ran. */
async function statementFailed(res: Response, when: string): Promise<ActionFailure> {
  const text = await res.text().catch(() => '')
  let code: string | null = null
  let message = clip(text)
  try {
    const parsed = JSON.parse(text) as unknown
    if (isObject(parsed)) {
      if (typeof parsed.code === 'string') code = parsed.code
      if (typeof parsed.message === 'string') message = clip(parsed.message)
    }
  } catch {
    // Not JSON: the clipped text is the message.
  }
  if (res.status === 429) {
    const after = res.headers.get('retry-after')
    return new ActionFailure('snowflake_rate_limited', `Snowflake answered HTTP 429 ${when}${after ? `, asking to wait ${after} s` : ''}, so the statement was not run`, 'not_applied')
  }
  return new ActionFailure(
    'snowflake_statement_failed',
    `Snowflake answered HTTP ${res.status} ${when}${code ? ` with code ${code}` : ''}${message ? `: ${message}` : ''}`,
    res.status >= 500 ? 'unknown' : 'not_applied',
  )
}

function columnsOf(body: Body): SnowflakeColumn[] {
  const meta = body.resultSetMetaData
  const rowType = isObject(meta) ? meta.rowType : undefined
  if (!Array.isArray(rowType)) throw new ActionFailure('snowflake_answer_unreadable', 'Snowflake answered a completed statement with no column list', 'applied')
  return rowType.map((column: unknown, index) => {
    if (!isObject(column) || typeof column.name !== 'string' || typeof column.type !== 'string') {
      throw new ActionFailure('snowflake_answer_unreadable', `Snowflake described column ${index + 1} without a name and type`, 'applied')
    }
    return { name: column.name, type: column.type.toLowerCase(), scale: typeof column.scale === 'number' ? column.scale : null }
  })
}

function rowsOf(data: unknown, width: number, where: string): Array<Array<string | null>> {
  if (!Array.isArray(data)) throw new ActionFailure('snowflake_answer_unreadable', `Snowflake's ${where} carries no rows`, 'applied')
  return data.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== width || !row.every((v) => v === null || typeof v === 'string')) {
      throw new ActionFailure('snowflake_answer_unreadable', `a row in Snowflake's ${where} is not ${width} values`, 'applied')
    }
    return row as Array<string | null>
  })
}

async function read(ctx: SnowflakeStatementContext, url: string, what: string): Promise<Response> {
  try {
    return await ctx.fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ctx.signal })
  } catch (err) {
    // The statement was sent and may have run: a requeue or a lost connection here must never repeat it.
    throw new ActionFailure('snowflake_result_unread', `reading ${what} failed (${err instanceof Error ? err.name : 'error'}) after the statement was sent`, 'unknown')
  }
}

/** Polls an async statement to its end. A 202, or a 429, is Snowflake saying it is still running. */
async function poll(ctx: SnowflakeStatementContext, base: string, handle: string): Promise<Response> {
  const url = `${base}/${encodeURIComponent(handle)}`
  for (let attempt = 1; attempt <= SNOWFLAKE_MAX_POLLS; attempt++) {
    if (ctx.signal?.aborted) break
    await ctx.sleep(SNOWFLAKE_POLL_INTERVAL_MS)
    if (ctx.signal?.aborted) break
    const res = await read(ctx, url, `the status of statement ${handle}`)
    if (res.status === 202 || res.status === 429) {
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    return res
  }
  throw new ActionFailure(
    'snowflake_statement_unfinished',
    `statement ${handle} had not finished when polling stopped (at most ${SNOWFLAKE_MAX_POLLS} polls, ${SNOWFLAKE_POLL_INTERVAL_MS / 1000} s apart, within the step's deadline); it may still complete`,
    'unknown',
  )
}

/** Sends one statement and returns its whole result, or fails by name (failure.ts). */
export async function runSnowflakeStatement(
  ctx: SnowflakeStatementContext,
  target: SnowflakeTarget,
  request: SnowflakeStatementRequest,
): Promise<SnowflakeResult> {
  const base = `https://${snowflakeHost(target.account)}/api/v2/statements`
  const body: Body = { statement: request.statement, timeout: SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS }
  for (const name of SESSION_FIELDS) {
    // Snowflake stores unquoted identifiers upper case; sent as the export path sends them.
    const value = target[name]
    if (value !== undefined) body[name] = value.toUpperCase()
  }
  if (request.bindings && request.bindings.length > 0) {
    body.bindings = Object.fromEntries(request.bindings.map((value, i) => [String(i + 1), { type: 'TEXT', value }]))
  }

  // Whatever the connection bound fetch throws here is passed on unchanged (failure.ts).
  let res = await ctx.fetch(`${base}?requestId=${crypto.randomUUID()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal,
  })
  if (res.status === 202) {
    const pending = await bodyOf(res, 'unknown')
    if (typeof pending.statementHandle !== 'string' || pending.statementHandle === '') {
      throw new ActionFailure('snowflake_answer_unreadable', 'Snowflake answered 202 without a statement handle to poll', 'unknown')
    }
    res = await poll(ctx, base, pending.statementHandle)
  }
  if (res.status !== 200) throw await statementFailed(res, 'to the statement')

  // A 200 that is not JSON may not be Snowflake's answer at all, so it says nothing either way.
  const answer = await bodyOf(res, 'unknown')
  const columns = columnsOf(answer)
  const handle = typeof answer.statementHandle === 'string' && answer.statementHandle !== '' ? answer.statementHandle : null
  const meta = answer.resultSetMetaData as Body
  const declared = typeof meta.numRows === 'number' ? meta.numRows : null
  if (declared !== null && declared > SNOWFLAKE_MAX_RESULT_ROWS) {
    throw new ActionFailure(
      'snowflake_result_over_cap',
      `the statement ran and returned ${declared} rows, more than the ${SNOWFLAKE_MAX_RESULT_ROWS} a step may carry; narrow the query or page it`,
      'applied',
    )
  }
  const rows = rowsOf(answer.data, columns.length, 'result')
  const partitions = Array.isArray(meta.partitionInfo) ? meta.partitionInfo.length : 1
  if (partitions > 1 && handle === null) {
    throw new ActionFailure('snowflake_result_unread', `Snowflake declared ${partitions} result partitions with no handle to read them by`, 'applied')
  }
  for (let index = 1; index < partitions; index++) {
    const part = await read(ctx, `${base}/${encodeURIComponent(handle!)}?partition=${index}`, `partition ${index} of ${partitions}`).catch((err: unknown) => {
      throw err instanceof ActionFailure ? new ActionFailure(err.code, err.message, 'applied') : err
    })
    if (part.status !== 200) {
      await part.body?.cancel().catch(() => undefined)
      throw new ActionFailure('snowflake_result_unread', `Snowflake answered HTTP ${part.status} for partition ${index} of ${partitions}, so the result is incomplete`, 'applied')
    }
    rows.push(...rowsOf((await bodyOf(part, 'applied')).data, columns.length, `partition ${index} of ${partitions}`))
  }
  if (declared !== null && rows.length < declared) {
    throw new ActionFailure('snowflake_result_incomplete', `Snowflake returned ${rows.length} of the ${declared} rows it declared`, 'applied')
  }
  return { columns, rows, handle }
}

/**
 * A step's value as the text one bind carries, or null for a JSON null, which
 * no bind can carry (the top of this file). A string is sent as written, a
 * finite number and a boolean as their JSON text, and an object or list as its
 * JSON, as the Pipedream driver bound them. Anything else is refused.
 */
export function bindText(value: unknown, where: string): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ActionFailure('snowflake_bind_invalid', `${where} is a number Snowflake cannot hold`, 'not_applied')
    return String(value)
  }
  if (typeof value === 'object') return JSON.stringify(value)
  throw new ActionFailure('snowflake_bind_invalid', `${where} is not a value a bind can carry`, 'not_applied')
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** An epoch seconds string (`1600000000.123000000`, a TIMESTAMP_TZ with its offset after a space) as an ISO instant. */
function instant(raw: string): string {
  const seconds = Number(raw.split(' ')[0])
  return Number.isFinite(seconds) ? new Date(Math.round(seconds * 1000)).toISOString() : raw
}

/** One value from its SQL API encoding to what the Pipedream action's driver returned, once serialised as JSON. */
function valueOf(column: SnowflakeColumn, raw: string | null): unknown {
  if (raw === null) return null
  switch (column.type) {
    case 'fixed': {
      const n = Number(raw)
      if (!Number.isFinite(n)) return raw
      // An integer past 2^53 keeps its digits as text rather than losing them.
      return (column.scale ?? 0) === 0 && !Number.isSafeInteger(n) ? raw : n
    }
    case 'real':
    case 'float': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : raw
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw
    case 'date': {
      const days = Number(raw)
      return Number.isInteger(days) ? new Date(days * 86_400_000).toISOString() : raw
    }
    case 'timestamp_ntz':
    case 'timestamp_ltz':
    case 'timestamp_tz':
      return instant(raw)
    case 'time': {
      const seconds = Number(raw)
      if (!Number.isFinite(seconds)) return raw
      const ms = Math.round(seconds * 1000)
      return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
    }
    case 'variant':
    case 'object':
    case 'array':
      try {
        return JSON.parse(raw) as unknown
      } catch {
        return raw
      }
    default:
      return raw
  }
}

/** The result as one object per row keyed by column name, as the Pipedream Snowflake actions returned it. */
export function rowObjects(result: SnowflakeResult): Array<Record<string, unknown>> {
  const names = new Set<string>()
  for (const column of result.columns) {
    if (names.has(column.name)) {
      throw new ActionFailure(
        'snowflake_duplicate_column',
        `the result has two columns named ${column.name}, so one would replace the other; give them distinct aliases`,
        'applied',
      )
    }
    names.add(column.name)
  }
  return result.rows.map((row) => Object.fromEntries(result.columns.map((column, i) => [column.name, valueOf(column, row[i])])))
}
