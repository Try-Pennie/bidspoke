/**
 * A small in memory PostgREST, served to the REAL supabase-js client through
 * its `fetch` option (#2332).
 *
 * A chainable mock answers whatever was asked of it, so a test built on one
 * cannot tell a read that filters an ops Slack row out from a read that never
 * asked to. This double instead evaluates the query string the client actually
 * sends (`col=eq.v`, `col=is.null`, `col=neq.v`, `col=in.(a,b)` and
 * `or=(...)` over those), so a reader whose filter is wrong reads the wrong
 * row here exactly as it would in production. It also answers as PostgREST
 * does where the client depends on it: a JSON array for a read (supabase-js
 * itself turns more than one row under `.maybeSingle()` into PGRST116), one
 * object or a 406 under `Accept: application/vnd.pgrst.object+json`
 * (`.single()`), PATCH as an update of the matching rows, POST with
 * `on_conflict` as an upsert, and `rpc/<name>` from the handlers given.
 *
 * Not a PostgREST: anything it does not understand throws, so a test cannot
 * pass on a filter this double silently ignored.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type Row = Record<string, unknown>

export interface RecordedRequest {
  method: string
  /** The table, or `rpc/<name>`. */
  path: string
  params: URLSearchParams
  body: unknown
}

export type RpcHandler = (args: Record<string, unknown>, tables: Record<string, Row[]>) => { data: unknown; status?: number } | { error: Row; status: number }

export interface FakePostgrest {
  /** The rows, by table. Tests read them after a write. */
  tables: Record<string, Row[]>
  requests: RecordedRequest[]
  client: SupabaseClient
}

const RESERVED = new Set(['select', 'limit', 'order', 'offset', 'on_conflict', 'columns'])

function matchOne(row: Row, column: string, opValue: string): boolean {
  const dot = opValue.indexOf('.')
  if (dot < 0) throw new Error(`postgrest-fake: no operator in ${column}=${opValue}`)
  const op = opValue.slice(0, dot)
  const value = opValue.slice(dot + 1)
  const cell = row[column]
  switch (op) {
    case 'eq':
      return cell !== null && cell !== undefined && String(cell) === value
    case 'neq':
      return cell !== null && cell !== undefined && String(cell) !== value
    case 'is':
      if (value === 'null') return cell === null || cell === undefined
      if (value === 'true') return cell === true
      if (value === 'false') return cell === false
      throw new Error(`postgrest-fake: unsupported is.${value}`)
    case 'in': {
      const list = value.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''))
      return cell !== null && cell !== undefined && list.includes(String(cell))
    }
    default:
      throw new Error(`postgrest-fake: unsupported operator ${op}`)
  }
}

function matchOr(row: Row, expr: string): boolean {
  const inner = expr.replace(/^\(/, '').replace(/\)$/, '')
  return inner.split(',').some((term) => {
    const dot = term.indexOf('.')
    return matchOne(row, term.slice(0, dot), term.slice(dot + 1))
  })
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (RESERVED.has(key)) continue
    if (key === 'or') {
      if (!matchOr(row, value)) return false
    } else if (key.includes('.')) {
      // A filter on an embedded resource (`organizations.is_synthetic=eq.false`),
      // read as an !inner embed: a row whose embed does not match is left out.
      const dot = key.indexOf('.')
      const nested = row[key.slice(0, dot)]
      if (!nested || typeof nested !== 'object' || !matchOne(nested as Row, key.slice(dot + 1), value)) return false
    } else if (!matchOne(row, key, value)) return false
  }
  return true
}

/** Split a select list on its top level commas, leaving an embed's own list whole. */
function selectTerms(select: string): string[] {
  const terms: string[] = []
  let depth = 0
  let current = ''
  for (const ch of select) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      terms.push(current)
      current = ''
    } else current += ch
  }
  terms.push(current)
  return terms.map((t) => t.trim()).filter(Boolean)
}

function project(row: Row, select: string | null): Row {
  if (!select || select.trim() === '*') return { ...row }
  const out: Row = {}
  for (const col of selectTerms(select)) {
    const embed = /^([a-z_]+)(![a-z_]+)?\(.*\)$/.exec(col)
    if (embed) {
      // An embedded resource comes back as the row holds it, whole: the test
      // states the embed it expects rather than this double joining tables.
      out[embed[1]] = row[embed[1]] ?? null
      continue
    }
    if (/[()!:]/.test(col)) throw new Error(`postgrest-fake: unsupported select ${col}`)
    out[col] = row[col] ?? null
  }
  return out
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let nextId = 1

/**
 * Answer list reads as PostgREST's row cap does (#1437): sorted by the `order`
 * the client sent, then `offset` and `limit` applied, then cut at `rowCap` rows
 * whatever was asked. Rows that tie on the order come back in a different
 * order on every request, as Postgres is free to return them, so a reader
 * paging on an order that is not unique skips and repeats rows here exactly
 * as it can in production. Applies to rpc answers too.
 */
export interface FakePaging {
  rowCap: number
}

function compareCells(a: unknown, b: unknown, nullsFirst: boolean): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) {
    if (aNull && bNull) return 0
    return aNull === nullsFirst ? -1 : 1
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

/** A seeded shuffle, so ties land differently per request but each run repeats. */
function shuffled<T>(rows: T[], seed: number): T[] {
  const out = [...rows]
  let s = (seed * 2654435761) >>> 0 || 1
  for (let i = out.length - 1; i > 0; i--) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function pageAsPostgrest(found: Row[], params: URLSearchParams, paging: FakePaging, seed: number): Row[] {
  let out = shuffled(found, seed)
  const order = params.get('order')
  if (order) {
    const keys = order.split(',').map((term) => {
      const [column, ...mods] = term.split('.')
      const desc = mods.includes('desc')
      // PostgREST's default puts nulls last ascending and first descending.
      const nullsFirst = mods.includes('nullsfirst') ? true : mods.includes('nullslast') ? false : desc
      return { column, desc, nullsFirst }
    })
    out.sort((a, b) => {
      for (const k of keys) {
        const c = compareCells(a[k.column], b[k.column], k.nullsFirst)
        if (c !== 0) return k.desc ? -c : c
      }
      return 0
    })
  }
  const offset = Number(params.get('offset') ?? 0)
  const limit = params.get('limit')
  out = out.slice(offset, limit === null ? undefined : offset + Number(limit))
  return out.slice(0, paging.rowCap)
}

export function fakePostgrest(tables: Record<string, Row[]>, rpcs: Record<string, RpcHandler> = {}, paging?: FakePaging): FakePostgrest {
  const requests: RecordedRequest[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const path = url.pathname.replace(/^\/rest\/v1\//, '')
    const body = typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined
    requests.push({ method, path, params: url.searchParams, body })

    if (path.startsWith('rpc/')) {
      const handler = rpcs[path.slice('rpc/'.length)]
      if (!handler) throw new Error(`postgrest-fake: no handler for ${path}`)
      const out = handler((body ?? {}) as Record<string, unknown>, tables)
      if ('error' in out) return json(out.error, out.status)
      const data = paging && Array.isArray(out.data) ? pageAsPostgrest(out.data as Row[], url.searchParams, paging, requests.length) : out.data
      return json(data, out.status ?? 200)
    }

    const rows = (tables[path] ??= [])
    const select = url.searchParams.get('select')
    const wantsObject = (headers.get('Accept') ?? '').includes('application/vnd.pgrst.object+json')
    const answer = (found: Row[]): Response => {
      const shaped = found.map((r) => project(r, select))
      if (!wantsObject) return json(shaped)
      if (shaped.length === 1) return json(shaped[0])
      return json({ code: 'PGRST116', details: `The result contains ${shaped.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' }, 406)
    }

    if (method === 'GET' || method === 'HEAD') {
      let found = rows.filter((r) => matches(r, url.searchParams))
      if (paging) return answer(pageAsPostgrest(found, url.searchParams, paging, requests.length))
      const limit = url.searchParams.get('limit')
      if (limit !== null) found = found.slice(0, Number(limit))
      return answer(found)
    }
    if (method === 'PATCH') {
      const found = rows.filter((r) => matches(r, url.searchParams))
      for (const r of found) Object.assign(r, body as Row)
      return answer(found)
    }
    if (method === 'DELETE') {
      const found = rows.filter((r) => matches(r, url.searchParams))
      tables[path] = rows.filter((r) => !found.includes(r))
      return answer(found)
    }
    if (method === 'POST') {
      const conflict = url.searchParams.get('on_conflict')?.split(',')
      const incoming = (Array.isArray(body) ? body : [body]) as Row[]
      const written: Row[] = []
      for (const item of incoming) {
        const existing = conflict ? rows.find((r) => conflict.every((c) => r[c] === item[c])) : undefined
        if (existing) {
          Object.assign(existing, item)
          written.push(existing)
        } else {
          const row = { id: `row-${nextId++}`, ...item }
          rows.push(row)
          written.push(row)
        }
      }
      return answer(written)
    }
    throw new Error(`postgrest-fake: unsupported method ${method}`)
  }
  const client = createClient('http://postgrest.fake', 'sb_secret_fake', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl as typeof fetch },
  })
  return { tables, requests, client }
}
