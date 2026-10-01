/**
 * The money gate's Supabase double (#1704).
 *
 * Serves the committed config snapshot to the engine and records every write
 * (insert, update, upsert, delete, rpc) in the order it happens. Writes are
 * applied to a private in-memory copy, never to the snapshot and never to any
 * database, so a later read or a zero row check sees the engine's own earlier
 * writes the way PostgREST would: the step logger's UPDATE of the execution row
 * it just inserted must find that row, or it retries for real.
 *
 * It implements the subset of the PostgREST builder the engine uses. A filter it
 * does not know is recorded by name (unsupportedFilters), not silently ignored,
 * so a read the double answered loosely shows in the gate's coverage report.
 */

export type Row = Record<string, unknown>
export type Filter = [op: string, column: string, value: unknown]

export interface RecordedWrite {
  op: 'insert' | 'update' | 'upsert' | 'delete' | 'rpc'
  table: string
  /** Rows for insert and upsert, the patch for update, the arguments for rpc. */
  values?: unknown
  filters?: Filter[]
  options?: unknown
}

export interface DbError {
  code: string
  message: string
  details: string | null
  hint: string | null
}

interface Result {
  data: unknown
  error: DbError | null
  count?: number | null
  status: number
  statusText: string
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return (a as number) < (b as number) ? -1 : 1
}

function getPath(row: Row, column: string): unknown {
  // `definition->nodes` and `a.b` style column references: read the nested value.
  const parts = column.split(/->>?|\./)
  let cur: unknown = row
  for (const p of parts) cur = cur && typeof cur === 'object' ? (cur as Row)[p] : undefined
  return cur
}

function likeToRegex(pattern: string, flags: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${esc}$`, flags)
}

function matches(row: Row, f: Filter): boolean {
  const [op, col, val] = f
  const v = getPath(row, col)
  switch (op) {
    case 'eq': return v === val || (v !== null && v !== undefined && val !== null && String(v) === String(val) && typeof v !== 'object')
    case 'neq': return !(v === val)
    case 'is': return (v ?? null) === val
    case 'in': return (val as unknown[]).some((x) => x === v || String(x) === String(v))
    case 'gt': return v !== null && v !== undefined && cmp(v, val) > 0
    case 'gte': return v !== null && v !== undefined && cmp(v, val) >= 0
    case 'lt': return v !== null && v !== undefined && cmp(v, val) < 0
    case 'lte': return v !== null && v !== undefined && cmp(v, val) <= 0
    case 'like': return typeof v === 'string' && likeToRegex(String(val), '').test(v)
    case 'ilike': return typeof v === 'string' && likeToRegex(String(val), 'i').test(v)
    case 'contains': {
      if (Array.isArray(v) && Array.isArray(val)) return val.every((x) => v.includes(x))
      if (v && typeof v === 'object' && val && typeof val === 'object') return Object.entries(val).every(([k, x]) => JSON.stringify((v as Row)[k]) === JSON.stringify(x))
      return false
    }
    case 'not': {
      const [innerOp, innerVal] = val as [string, unknown]
      return !matches(row, [innerOp, col, innerVal])
    }
    default: return true
  }
}

/** Embedded resources named in a select string, e.g. `partner_configs!inner(id, slug)`. */
function embeddedTables(select: string): Array<{ table: string; inner: boolean }> {
  return [...select.matchAll(/([a-z_][a-z0-9_]*)\s*(?:!([a-z_]+))?\s*\(/gi)].map((m) => ({ table: m[1], inner: m[2] === 'inner' }))
}

/**
 * The foreign keys PostgREST would infer, declared for the embeds the engine uses.
 * `one` is a many to one embed (an object); otherwise one to many (an array).
 */
const RELATIONS: Record<string, { local: string; foreign: string; one: boolean }> = {
  'workflows>workflow_versions': { local: 'id', foreign: 'workflow_id', one: false },
  'buyer_profiles>partner_configs': { local: 'partner_id', foreign: 'id', one: true },
  'buyer_profiles>buyer_operating_windows': { local: 'partner_id', foreign: 'partner_id', one: false },
  'buyer_profiles>buyer_blackout_dates': { local: 'partner_id', foreign: 'partner_id', one: false },
  'buyer_profiles>buyer_pricing_tiers': { local: 'partner_id', foreign: 'partner_id', one: false },
}

export function createSupabaseDouble(snapshot: Record<string, Row[]>) {
  const store: Record<string, Row[]> = clone(snapshot)
  const writes: RecordedWrite[] = []
  const unknown = new Set<string>()
  const unsupported: string[] = []

  function rowsOf(table: string): Row[] {
    if (!(table in store)) {
      unknown.add(table)
      store[table] = []
    }
    return store[table]
  }

  function builder(table: string) {
    const filters: Filter[] = []
    let mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let selectCols = '*'
    let returning = false
    let payload: unknown
    let options: Record<string, unknown> | undefined
    const order: Array<{ col: string; asc: boolean; nullsFirst?: boolean }> = []
    const childOrder: Record<string, { col: string; asc: boolean }> = {}
    const childLimit: Record<string, number> = {}
    let limitN: number | undefined
    let range: [number, number] | undefined
    let single: 'single' | 'maybe' | null = null
    let head = false
    let countMode: string | undefined

    function run(): Result {
      const base = rowsOf(table)
      if (mode === 'insert' || mode === 'upsert') {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[]
        writes.push({ op: mode, table, values: clone(list), options: clone(options) })
        const out: Row[] = []
        const conflict = mode === 'upsert' ? String(options?.onConflict ?? 'id').split(',').map((s) => s.trim()) : null
        for (const r of list) {
          const copy = clone(r)
          const existing = conflict ? base.find((b) => conflict.every((c) => b[c] !== undefined && b[c] === copy[c])) : undefined
          if (existing) {
            // An ignored duplicate is neither written nor returned (ON CONFLICT DO NOTHING).
            if (options?.ignoreDuplicates) continue
            Object.assign(existing, copy)
            out.push(existing)
          } else {
            base.push(copy)
            out.push(copy)
          }
        }
        return finish(out)
      }
      const matched = base.filter((r) => filters.every((f) => matches(r, f)))
      if (mode === 'update') {
        writes.push({ op: 'update', table, values: clone(payload), filters: clone(filters) })
        for (const r of matched) Object.assign(r, clone(payload as Row))
        return finish(matched)
      }
      if (mode === 'delete') {
        writes.push({ op: 'delete', table, filters: clone(filters) })
        store[table] = base.filter((r) => !matched.includes(r))
        return finish(matched)
      }
      let rows = matched
      for (const o of [...order].reverse()) {
        rows = [...rows].sort((a, b) => {
          const c = cmp(getPath(a, o.col), getPath(b, o.col))
          return o.asc ? c : -c
        })
      }
      if (range) rows = rows.slice(range[0], range[1] + 1)
      if (limitN !== undefined) rows = rows.slice(0, limitN)
      const embeds = embeddedTables(selectCols)
      for (const e of embeds) if (!RELATIONS[`${table}>${e.table}`]) unsupported.push(`${table} embeds ${e.table} with no declared relation`)
      const shaped: Row[] = []
      for (const r of rows) {
        const out = clone(r)
        let keep = true
        for (const e of embeds) {
          const rel = RELATIONS[`${table}>${e.table}`]
          if (!rel) continue
          let kids = rowsOf(e.table).filter((k) => k[rel.foreign] === r[rel.local] && (k.organization_id === undefined || r.organization_id === undefined || k.organization_id === r.organization_id))
          const co = childOrder[e.table]
          if (co) kids = [...kids].sort((a, b) => (co.asc ? 1 : -1) * cmp(a[co.col], b[co.col]))
          if (childLimit[e.table] !== undefined) kids = kids.slice(0, childLimit[e.table])
          if (e.inner && kids.length === 0) keep = false
          out[e.table] = rel.one ? clone(kids[0] ?? null) : clone(kids)
        }
        if (keep) shaped.push(out)
      }
      return finish(shaped, shaped.length)
    }

    function finish(rows: Row[], total?: number): Result {
      const count = countMode ? (total ?? rows.length) : null
      if (mode !== 'select' && !returning && !single) return { data: null, error: null, count, status: 201, statusText: 'Created' }
      const data = clone(rows)
      if (head) return { data: null, error: null, count, status: 200, statusText: 'OK' }
      if (single === 'single') {
        if (data.length !== 1) {
          return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${data.length} rows`, hint: null }, count, status: 406, statusText: 'Not Acceptable' }
        }
        return { data: data[0], error: null, count, status: 200, statusText: 'OK' }
      }
      if (single === 'maybe') {
        if (data.length > 1) {
          return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${data.length} rows`, hint: null }, count, status: 406, statusText: 'Not Acceptable' }
        }
        return { data: data[0] ?? null, error: null, count, status: 200, statusText: 'OK' }
      }
      return { data, error: null, count, status: 200, statusText: 'OK' }
    }

    const b: Record<string, unknown> = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        if (mode === 'select') selectCols = cols ?? '*'
        else returning = true
        if (opts?.count) countMode = opts.count
        if (opts?.head) head = true
        return b
      },
      insert(v: unknown, opts?: Record<string, unknown>) { mode = 'insert'; payload = v; options = opts; return b },
      upsert(v: unknown, opts?: Record<string, unknown>) { mode = 'upsert'; payload = v; options = opts; return b },
      update(v: unknown) { mode = 'update'; payload = v; return b },
      delete() { mode = 'delete'; return b },
      eq(c: string, v: unknown) { filters.push(['eq', c, v]); return b },
      neq(c: string, v: unknown) { filters.push(['neq', c, v]); return b },
      is(c: string, v: unknown) { filters.push(['is', c, v]); return b },
      in(c: string, v: unknown[]) { filters.push(['in', c, v]); return b },
      gt(c: string, v: unknown) { filters.push(['gt', c, v]); return b },
      gte(c: string, v: unknown) { filters.push(['gte', c, v]); return b },
      lt(c: string, v: unknown) { filters.push(['lt', c, v]); return b },
      lte(c: string, v: unknown) { filters.push(['lte', c, v]); return b },
      like(c: string, v: unknown) { filters.push(['like', c, v]); return b },
      ilike(c: string, v: unknown) { filters.push(['ilike', c, v]); return b },
      contains(c: string, v: unknown) { filters.push(['contains', c, v]); return b },
      not(c: string, op: string, v: unknown) { filters.push(['not', c, [op, v]]); return b },
      match(obj: Row) { for (const [k, v] of Object.entries(obj)) filters.push(['eq', k, v]); return b },
      filter(c: string, op: string, v: unknown) { filters.push([op, c, v]); return b },
      or(expr: string) { unsupported.push(`${table}.or(${expr})`); return b },
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string }) {
        const ref = opts?.referencedTable ?? opts?.foreignTable
        if (ref) childOrder[ref] = { col, asc: opts?.ascending !== false }
        else order.push({ col, asc: opts?.ascending !== false, nullsFirst: opts?.nullsFirst })
        return b
      },
      limit(n: number, opts?: { referencedTable?: string; foreignTable?: string }) {
        const ref = opts?.referencedTable ?? opts?.foreignTable
        if (ref) childLimit[ref] = n
        else limitN = n
        return b
      },
      range(from: number, to: number) { range = [from, to]; return b },
      single() { single = 'single'; return b },
      maybeSingle() { single = 'maybe'; return b },
      returns() { return b },
      abortSignal() { return b },
      throwOnError() { return b },
      csv() { unsupported.push(`${table}.csv`); return b },
      then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(resolve, reject)
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e)
        }
      },
    }
    return b
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: (name: string, args?: unknown) => {
      writes.push({ op: 'rpc', table: name, values: clone(args) })
      const result: Result = { data: null, error: null, status: 200, statusText: 'OK' }
      const p = Promise.resolve(result)
      return Object.assign(p, { single: () => p, maybeSingle: () => p, select: () => p, abortSignal: () => p, throwOnError: () => p })
    },
    schema: () => client,
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => Promise.resolve(),
  }

  return {
    // The engine types its parameter as SupabaseClient; this is the subset it calls.
    client: client as unknown as {
      from: (t: string) => any // eslint-disable-line @typescript-eslint/no-explicit-any
      rpc: (n: string, a?: unknown) => Promise<Result>
    },
    writes: () => writes,
    unknownTables: () => [...unknown].sort(),
    unsupportedFilters: () => [...unsupported],
  }
}
