/**
 * A read that came back at the PostgREST row cap without having declared a limit
 * (#1436; decided by Dan on #1437, 2026-10-18).
 *
 * PostgREST answers at most ROW_CAP rows and says nothing about having stopped
 * there, so an unbounded list read of a table that has grown past the cap
 * returns a plausible answer that is simply short. This module notices it at the
 * moment it happens, from the response itself, so it needs no list of tables:
 * it covers a dynamic table name and a set returning rpc as well.
 *
 * HOW A HIT IS READ. From the `Content-Range` header, never the body. PostgREST
 * sends it on every successful read whether or not a count was asked for, as
 * `<first>-<last>/*` (the total is `*` without `Prefer: count`). Measured on the
 * production edge logs over 24 hours to 2026-10-18 22:45 UTC: all 102,861
 * successful GETs on /rest/v1 carried it, and so did every successful rpc POST
 * (`0-0/*` for a scalar); it was absent only on error answers and the OpenAPI
 * root. The body is never read here, so the engine path pays a header parse.
 *
 * WHAT DECLARES A LIMIT (Dan's decision (b)): a top level `limit=` of at most
 * ROW_CAP in the URL, which `.limit(n)` and `.range(a, b)` both write. A limit
 * above the cap declares nothing, since PostgREST cuts it to the cap anyway. An
 * embedded resource's `x.limit=` bounds the embed, not the read, and is ignored.
 * A `.single()` or `.maybeSingle()` read asks for one object
 * (`Accept: application/vnd.pgrst.object+json`) and is exempt. A HEAD (a count
 * with `head: true`) returns no rows and is exempt. Writes are not judged:
 * PostgREST does not apply its row cap to rows a write returns. A count that
 * shows exactly the rows returned exist (`0-999/1000`) is not a hit.
 *
 * WHAT A HIT DOES (Dan's decision (a)): every hit is logged as one JSON line
 * whose `message` is ROW_CAP_LINE, and sent to the Better Stack HTTP log source
 * the alert reads (the worker's own logs do not reach Better Stack: measured
 * 2026-10-18, the Cloudflare Logpush source carries only the three proxy
 * Workers). Inside a scheduled tick the read also FAILS: the client gets a 500
 * answer carrying ROW_CAP_ERROR_CODE, which supabase-js hands the caller as
 * `{ error }` (or throws, for `.throwOnError()`), and does not retry, since it
 * retries only 503 and 520. A thrown fetch error would be retried three times
 * with 7 s of waits, re-reading the same capped rows each time. On the request
 * and engine paths the read answers as before.
 *
 * WHAT IT CARRIES: the table or rpc name and the query's shape, with every
 * filter value replaced by `?` (redactQuery), so no lead's data reaches the log
 * or Better Stack (L482). The whole event is pinned by a test.
 */
import { PAGE_SIZE } from './paginate'
import { inScheduledTick } from './outage-notice'
import { raceDeadline } from './alert-claim'
import { formatErr } from './format-error'

/**
 * The most rows PostgREST answers in one response: the `max_rows` setting of
 * the Supabase project's Data API, set in the Supabase dashboard (API settings),
 * outside this repo. It is the page size the pagination helper asks for, so the
 * two cannot drift apart here; if the dashboard setting changes, change
 * PAGE_SIZE with it.
 */
export const ROW_CAP = PAGE_SIZE

/** The one line the Better Stack alert matches on, sent as the event's `message`. */
export const ROW_CAP_LINE = 'bidspoke read stopped at the PostgREST row cap without a declared limit'

/** The error code a failed read carries inside a scheduled tick. */
export const ROW_CAP_ERROR_CODE = 'BIDSPOKE_ROW_CAP'

/** How long one call site waits before it is sent to Better Stack again (every hit is still logged). */
export const ROW_CAP_REPORT_INTERVAL_MS = 10 * 60_000

/** How long a send to Better Stack may take before it is given up. */
export const ROW_CAP_SEND_DEADLINE_MS = 3_000

export interface RowCapHit {
  /** The table, view or rpc the read named. */
  relation: string
  kind: 'table' | 'rpc'
  /** The query string with every filter value replaced by `?`. */
  query: string
  /** Rows that came back. */
  rows: number
  /** Rows that exist, when the read asked for a count; null otherwise. */
  total: number | null
}

/** Keys whose values are the query's shape (columns, ordering, paging), never data. */
const SHAPE_KEYS: ReadonlySet<string> = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'])
/** Keys whose value is a whole filter expression. */
const LOGIC_KEYS: ReadonlySet<string> = new Set(['or', 'and', 'not.or', 'not.and'])
const OPERATOR = /^((?:not\.)?[a-z]+(?:\([a-z]+\))?)\./

/** The query string with every filter value replaced by `?`, keeping its operators and shape. */
export function redactQuery(params: URLSearchParams): string {
  const parts: string[] = []
  params.forEach((value, key) => {
    const last = key.split('.').pop() ?? key
    if (SHAPE_KEYS.has(last)) {
      parts.push(`${key}=${value}`)
    } else if (LOGIC_KEYS.has(key) || LOGIC_KEYS.has(last)) {
      parts.push(`${key}=?`)
    } else {
      const op = OPERATOR.exec(value)
      parts.push(`${key}=${op ? `${op[1]}.?` : '?'}`)
    }
  })
  return parts.join('&')
}

const CONTENT_RANGE = /^(\d+)-(\d+)\/(\d+|\*)$/

/** The top level limit the read declared, or null when it declared none (or one above the cap). */
function declaredLimit(params: URLSearchParams): number | null {
  let declared: number | null = null
  for (const v of params.getAll('limit')) {
    const n = Number(v)
    if (Number.isInteger(n) && n >= 0 && n <= ROW_CAP) declared = n
  }
  return declared
}

/** A read that came back at the cap without a declared limit, or null. */
export function detectRowCapHit(req: { url: string; method: string; accept: string | null; contentRange: string | null }): RowCapHit | null {
  if (req.contentRange === null) return null
  const range = CONTENT_RANGE.exec(req.contentRange.trim())
  if (!range) return null
  const first = Number(range[1])
  const last = Number(range[2])
  const rows = last - first + 1
  if (rows < ROW_CAP) return null
  const total = range[3] === '*' ? null : Number(range[3])
  if (total !== null && total <= last + 1) return null

  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return null
  }
  const at = url.pathname.indexOf('/rest/v1/')
  if (at === -1) return null
  const segments = url.pathname.slice(at + '/rest/v1/'.length).split('/').filter(Boolean).map(decodeURIComponent)
  if (segments.length === 0) return null
  const kind: RowCapHit['kind'] = segments[0] === 'rpc' && segments.length > 1 ? 'rpc' : 'table'
  const relation = kind === 'rpc' ? segments[1] : segments[0]

  const method = req.method.toUpperCase()
  if (kind === 'table' && method !== 'GET') return null
  if (kind === 'rpc' && method !== 'GET' && method !== 'POST') return null
  if (req.accept !== null && req.accept.toLowerCase().includes('application/vnd.pgrst.object')) return null
  if (declaredLimit(url.searchParams) !== null) return null

  return { relation, kind, query: redactQuery(url.searchParams), rows, total }
}

/** The only fields a report carries. */
export interface RowCapEvent {
  message: typeof ROW_CAP_LINE
  relation: string
  kind: RowCapHit['kind']
  query: string
  rows: number
  total: number | null
  /** True when the read failed because it ran in a scheduled tick. */
  in_scheduled_tick: boolean
  /** When it happened, RFC 3339; Better Stack reads `dt` as the event time. */
  dt: string
}

/** The one place a report's body is built. */
export function rowCapEvent(hit: RowCapHit, scheduled: boolean, nowMs: number): RowCapEvent {
  return {
    message: ROW_CAP_LINE,
    relation: hit.relation,
    kind: hit.kind,
    query: hit.query,
    rows: hit.rows,
    total: hit.total,
    in_scheduled_tick: scheduled,
    dt: new Date(nowMs).toISOString(),
  }
}

/** The sentence a failed read carries. */
export function rowCapMessage(hit: RowCapHit): string {
  const what = hit.kind === 'rpc' ? `rpc ${hit.relation}` : hit.relation
  const query = hit.query === '' ? 'no query string' : hit.query
  return `Supabase read of ${what} came back at the ${ROW_CAP.toLocaleString('en-US')} row cap without a declared limit (${query}), so it may be missing rows`
}

export interface RowCapOptions {
  /** BETTERSTACK_OUTAGE_TOKEN and BETTERSTACK_OUTAGE_URL: the source the alert reads. */
  betterStack?: { token: string | undefined; url: string | undefined }
  /** The fetch the Better Stack send goes through. */
  sendFetch?: typeof fetch
  now?: () => number
  /** The timer seam for the send's deadline (L524). */
  delay?: (ms: number) => Promise<void>
  /** Whether the read runs in a scheduled tick; outage-notice's tick by default. */
  inScheduledTick?: () => boolean
}

/** When each call site was last sent to Better Stack, per isolate. */
const lastSent = new Map<string, number>()
let saidUnconfigured = false

/** Forget what this isolate has sent (the tests and the money gate's outage drill, #1305). */
export function forgetRowCapReports(): void {
  lastSent.clear()
  saidUnconfigured = false
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Send one event to Better Stack. Resolves in every case, within ROW_CAP_SEND_DEADLINE_MS. */
async function sendToBetterStack(event: RowCapEvent, options: RowCapOptions, nowMs: number): Promise<void> {
  try {
    const token = options.betterStack?.token?.trim() ?? ''
    const url = options.betterStack?.url?.trim() ?? ''
    if (!token || !url) {
      if (!saidUnconfigured) {
        saidUnconfigured = true
        console.error('[row-cap] BETTERSTACK_OUTAGE_TOKEN or BETTERSTACK_OUTAGE_URL is unset, so a row cap hit reaches no alert')
      }
      return
    }
    const key = `${event.kind}:${event.relation}?${event.query}`
    const prior = lastSent.get(key)
    if (prior !== undefined && nowMs - prior < ROW_CAP_REPORT_INTERVAL_MS) return
    lastSent.set(key, nowMs)
    const sendFetch = options.sendFetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
    const stop = new AbortController()
    const raced = await raceDeadline(
      async () => {
        const res = await sendFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
          signal: stop.signal,
        })
        return res.status
      },
      ROW_CAP_SEND_DEADLINE_MS,
      options.delay ?? realDelay,
    )
    if (raced.kind === 'ok' && raced.value >= 200 && raced.value < 300) return
    // Not sent: let the next hit try again rather than wait out the interval.
    lastSent.delete(key)
    if (raced.kind === 'timed_out') {
      stop.abort()
      console.error(`[row-cap] the report for ${event.relation} got no answer from Better Stack in ${ROW_CAP_SEND_DEADLINE_MS} ms`)
    } else if (raced.kind === 'threw') {
      console.error(`[row-cap] the report for ${event.relation} could not be sent to Better Stack: ${formatErr(raced.error)}`)
    } else {
      console.error(`[row-cap] Better Stack refused the report for ${event.relation} with ${raced.value}`)
    }
  } catch (e) {
    console.error(`[row-cap] the report could not be sent: ${formatErr(e)}`)
  }
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string; accept: string | null } {
  if (typeof input === 'string' || input instanceof URL) {
    return { url: typeof input === 'string' ? input : input.href, method: init?.method ?? 'GET', accept: new Headers(init?.headers).get('Accept') }
  }
  const headers = new Headers(init?.headers ?? input.headers)
  return { url: input.url, method: init?.method ?? input.method, accept: headers.get('Accept') }
}

/**
 * Wrap the Supabase client's fetch so every read that came back at the cap
 * without a declared limit is reported, and inside a scheduled tick fails.
 */
export function withRowCapCheck(baseFetch: typeof fetch, options: RowCapOptions = {}): typeof fetch {
  const now = options.now ?? Date.now
  const scheduledNow = options.inScheduledTick ?? inScheduledTick
  return async (input, init) => {
    const res = await baseFetch(input, init)
    if (!res.ok) return res
    const hit = detectRowCapHit({ ...describeRequest(input, init), contentRange: res.headers.get('Content-Range') })
    if (hit === null) return res

    const scheduled = scheduledNow()
    const nowMs = now()
    const event = rowCapEvent(hit, scheduled, nowMs)
    console.error(JSON.stringify(event))
    const sending = sendToBetterStack(event, options, nowMs)
    if (!scheduled) {
      // The read answers at once; the send never delays a lead.
      void sending
      return res
    }
    // A failing tick may end as soon as the read fails, so the report goes first.
    await sending
    try {
      await res.body?.cancel()
    } catch {
      // The rows are discarded either way.
    }
    return new Response(
      JSON.stringify({
        code: ROW_CAP_ERROR_CODE,
        message: rowCapMessage(hit),
        details: null,
        hint: 'Declare a limit with .limit() or .range(), or read every row with fetchAllPaged',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    )
  }
}
