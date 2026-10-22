/**
 * The record of Worker queries Postgres cancelled before they finished (#2651, L800).
 *
 * WHY THIS EXISTS. The query timeout watch (query-timeout-watch.ts, #1043) judges each
 * statement by `max_exec_time` in `pg_stat_statements`, and Postgres writes a statement
 * there only when it FINISHES. One cancelled at its role's statement_timeout (SQLSTATE
 * 57014) never finishes, so it never counts: on 2026-10-22 the rejection watch's LendSwift
 * counts were cancelled at 30.04 to 30.09 s at 04:00 and 09:00 UTC while pg_stat_statements
 * said 28.5 to 28.7 s, and the 06:00 page said "close to being cancelled". A statement
 * cancelled on EVERY run would never appear at all, which is the outage the watch exists for.
 *
 * WHY THIS SOURCE. Three sources see a cancellation, measured 2026-10-22:
 *  - Postgres's own log ("canceling statement due to statement timeout", sql_state_code
 *    57014) and the PostgREST 500s in Supabase's edge logs both carry every one, for every
 *    role. But they are read only through the Supabase Management API, with an account
 *    access token the Worker does not hold (it lives only in CI), so reading them from here
 *    needs a new, account wide secret on the Worker.
 *  - A database side record is not possible on the hosted platform: a cancelled statement's
 *    transaction is rolled back, so it cannot write about itself, and `pg_stat_monitor`
 *    (which does record errors) is available but not in `shared_preload_libraries`.
 *  - The Worker itself: PostgREST answers every cancelled request with a 500 carrying
 *    `Proxy-Status: PostgREST; error=57014` (measured on a live answer, and on all twelve
 *    cancellations in the 2026-10-22 edge logs, which were HEAD counts with no body, so the
 *    header is the ONLY place the code appears).
 * The third needs nothing new, so the Supabase client's fetch records each cancellation as
 * it arrives. It sees the Worker's queries only: the browser's (authenticated, 8 s) and
 * anon's are cancelled where the Worker never hears of it, and stay with the near limit
 * watch until the log route is chosen.
 *
 * WHERE IT IS RECORDED. One KV key per cancellation, in the Worker's IDEMPOTENCY namespace,
 * never in Postgres: the moment queries are being cancelled is the moment Postgres is least
 * able to take a write, and the record must not share the fate of what it records (L345).
 * One key each, rather than a counter, so concurrent cancellations never overwrite one
 * another's count. The statement and the time ride in the key's metadata, so the hourly
 * watch reads them all with list calls alone.
 *
 * WHAT IT CARRIES. The method, the table or rpc, and the query's shape with every filter
 * value replaced by `?` (row-cap's redactQuery), so no lead's data reaches KV, the log or
 * Slack (L482).
 */
import { describeRequest, redactQuery, restTarget } from './row-cap'
import { raceDeadline } from './alert-claim'
import { formatErr } from './format-error'

/** Every cancellation record's key starts with this; the watch lists by it. */
export const CANCELLATION_KEY_PREFIX = 'query-timeout:cancelled:'
/** Long enough that the hourly watch reads each record many times over, short enough to need no sweep. */
export const CANCELLATION_TTL_SECONDS = 48 * 60 * 60
/** How long a record may take to write before the caller is handed its answer anyway. */
export const CANCELLATION_RECORD_DEADLINE_MS = 2_000
/** The most list pages one watch run reads (1,000 keys each); past it the count is a floor. */
export const CANCELLATION_LIST_PAGE_CAP = 50
/** The statement a record is counted under when its metadata cannot be read. */
export const UNREADABLE_STATEMENT = 'a statement whose record could not be read'

/** SQLSTATE query_canceled: a statement timeout, or a cancel request. */
const CANCELLED = '57014'
/** KV refuses metadata over 1024 bytes serialised; this leaves room for the time and the JSON. */
const STATEMENT_MAX_BYTES = 900

/** The two calls this module makes on the KV namespace. */
export interface CancellationStore {
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>
}

/** One recorded cancellation. */
export interface CancellationEvent {
  statement: string
  atMs: number
}

/** The proxy status header names the error code as `error=<code>`. */
function headerCode(res: Response): string | null {
  const status = res.headers.get('proxy-status')
  if (status === null) return null
  const m = /\berror=([A-Za-z0-9]+)/.exec(status)
  return m ? m[1] : null
}

/** Cut a statement to fit the metadata limit, on a character boundary. */
function fitStatement(s: string): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= STATEMENT_MAX_BYTES) return s
  let cut = s.slice(0, STATEMENT_MAX_BYTES)
  while (enc.encode(cut).length > STATEMENT_MAX_BYTES - 3) cut = cut.slice(0, -1)
  return `${cut}...`
}

/**
 * The statement a cancelled answer belongs to, or null when the answer is not a
 * cancellation. Reads the Proxy-Status header first (a HEAD has no body), and only for a
 * 5xx without one reads a CLONE of the body, so the caller still gets the whole answer.
 */
export async function cancelledStatement(req: { url: string; method: string }, res: Response): Promise<string | null> {
  if (res.status < 500) return null
  let code = headerCode(res)
  const method = req.method.toUpperCase()
  if (code === null && method !== 'HEAD') {
    try {
      const body: unknown = await res.clone().json()
      const found = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined
      code = typeof found === 'string' ? found : null
    } catch {
      code = null
    }
  }
  if (code !== CANCELLED) return null
  const target = restTarget(req.url)
  if (target === null) return fitStatement(`${method} (not a Data API address)`)
  const name = target.kind === 'rpc' ? `rpc/${target.relation}` : target.relation
  const query = redactQuery(target.params)
  return fitStatement(query === '' ? `${method} ${name}` : `${method} ${name}?${query}`)
}

export interface CancellationRecordOptions {
  /** The IDEMPOTENCY KV namespace; undefined only where none is bound (some tests). */
  store: CancellationStore | undefined
  now?: () => number
  log?: (line: string) => void
  /** The timer seam for the record's deadline (L524). */
  delay?: (ms: number) => Promise<void>
}

let counter = 0

/**
 * Wrap the Supabase client's fetch so every answer that is a cancelled statement is
 * logged and recorded before the caller gets it. The record is raced against a deadline
 * and never throws, so a failing store costs the caller nothing but the log line.
 */
export function withCancellationRecord(baseFetch: typeof fetch, options: CancellationRecordOptions): typeof fetch {
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.error(line))
  return async (input, init) => {
    const res = await baseFetch(input, init)
    if (res.status < 500) return res
    let statement: string | null
    try {
      statement = await cancelledStatement(describeRequest(input, init), res)
    } catch {
      return res
    }
    if (statement === null) return res

    const atMs = now()
    log(`[query-cancellations] event=query_cancelled at=${new Date(atMs).toISOString()} statement=${JSON.stringify(statement)}`)
    if (!options.store) {
      log('[query-cancellations] no store is bound, so this cancellation could not be recorded and the hourly watch will not count it')
      return res
    }
    const store = options.store
    // The time first, so keys list in order; a counter and a random tail so two in the same
    // millisecond, in this isolate or another, never share a key.
    counter = (counter + 1) % 1_000_000
    const key = `${CANCELLATION_KEY_PREFIX}${String(atMs).padStart(14, '0')}:${counter}:${Math.random().toString(36).slice(2, 10)}`
    const raced = await raceDeadline(
      () => store.put(key, '', { expirationTtl: CANCELLATION_TTL_SECONDS, metadata: { s: statement, at: atMs } }),
      CANCELLATION_RECORD_DEADLINE_MS,
      options.delay,
    )
    if (raced.kind === 'threw') {
      log(`[query-cancellations] a cancellation could not be recorded: ${formatErr(raced.error)}`)
    } else if (raced.kind === 'timed_out') {
      log(`[query-cancellations] a cancellation could not be recorded: the store did not answer in ${CANCELLATION_RECORD_DEADLINE_MS} ms`)
    }
    return res
  }
}

/**
 * Every recorded cancellation still held. THROWS when the record cannot be listed, so an
 * unreadable record is never read as no cancellations (L98); `truncated` says the count
 * stopped at the page cap and is a floor.
 */
export async function readCancellations(store: CancellationStore): Promise<{ events: CancellationEvent[]; truncated: boolean }> {
  const events: CancellationEvent[] = []
  let cursor: string | undefined
  for (let page = 0; page < CANCELLATION_LIST_PAGE_CAP; page++) {
    const res = await store.list({ prefix: CANCELLATION_KEY_PREFIX, ...(cursor ? { cursor } : {}) })
    for (const k of res.keys) {
      const m = k.metadata as { s?: unknown; at?: unknown } | null | undefined
      const at = m ? Number(m.at) : NaN
      if (m && typeof m.s === 'string' && Number.isFinite(at)) {
        events.push({ statement: m.s, atMs: at })
      } else {
        // A record with no readable metadata is still a cancellation: count it, under a name
        // that says so, and date it by its key so it is new exactly once.
        const keyAt = Number(k.name.slice(CANCELLATION_KEY_PREFIX.length).split(':')[0])
        events.push({ statement: UNREADABLE_STATEMENT, atMs: Number.isFinite(keyAt) ? keyAt : 0 })
      }
    }
    if (res.list_complete || !res.cursor) return { events, truncated: false }
    cursor = res.cursor
  }
  return { events, truncated: true }
}
