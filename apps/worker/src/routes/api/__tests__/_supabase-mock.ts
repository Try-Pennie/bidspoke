/**
 * Shared fake-Supabase client for worker route tests (#330).
 *
 * The same chainable-Proxy mock was copy-pasted across ~12 route test files; a
 * change to it (e.g. the `user_allowlist` default that jwtAuth requires after
 * #326) had to be applied in every copy. This is the single source.
 *
 * Per-table behavior is configured by `TableConfig` (see fields below). Pass an
 * ARRAY of configs for a table to give successive `.from(table)` calls different
 * results (call N uses configs[N], clamped to the last). Reads default to a
 * PGRST116 not-found on `.single()` and `[]` on a bare await; writes default to
 * a generic error unless a result/error is configured.
 *
 * jwtAuth's allowlist check (`user_allowlist.maybeSingle()`) defaults to an
 * allowlisted user so route handlers run; override per-test by configuring the
 * `user_allowlist` table.
 *
 * NOT used by workflows.test.ts / stats.test.ts — those wire `rpc` with their
 * own bespoke conventions and keep local mocks (#330).
 */

interface QueryError {
  message: string
  code?: string
}

export interface TableConfig {
  /** `.single()` result. A row → that row; `null` → PGRST116 not-found;
   *  unset → PGRST116 not-found. */
  single?: Record<string, unknown> | null
  /** `.single()` returns this error instead (e.g. a real DB error, not no-rows). */
  singleError?: QueryError
  /** Bare-await / list result (`.select()....` then awaited). */
  list?: Record<string, unknown>[]
  /** `.maybeSingle()` result. Falls back to `single`, then null. */
  maybeSingle?: Record<string, unknown> | null
  insertResult?: Record<string, unknown> | null
  insertError?: QueryError
  updateResult?: Record<string, unknown> | null
  updateError?: QueryError
  upsertResult?: Record<string, unknown> | null
  upsertError?: QueryError
  deleteError?: QueryError
}

export interface MockSupabaseOptions {
  /** Email returned by the default `user_allowlist.maybeSingle()` allowlist check. */
  allowlistEmail?: string
}

const NOT_FOUND: QueryError = { message: 'not found', code: 'PGRST116' }

type Outcome = { data: unknown; error: unknown }

// A write builder (insert/update/upsert/delete): chainable, resolving to
// `{ data, error }` on a bare await and on a terminal `.single()`. When the
// write-specific result/error is configured it wins; otherwise it falls back to
// the table's read behavior — preserving the older mocks where a write was a
// passthrough and a configured `singleError` surfaced on the write's `.single()`.
function writeChain(result: unknown, error: unknown, readSingle: () => Outcome, readList: () => Outcome): unknown {
  const onSingle = (): Outcome =>
    error ? { data: null, error } : result !== undefined ? { data: result, error: null } : readSingle()
  const onAwait = (): Outcome =>
    error ? { data: null, error } : result !== undefined ? { data: result, error: null } : readList()
  const c: unknown = new Proxy(
    {},
    {
      get(_t, p) {
        if (typeof p === 'symbol') return undefined
        if (p === 'single') return () => Promise.resolve(onSingle())
        if (p === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(onAwait()).then(resolve)
        return () => c
      },
    },
  )
  return c
}

export function makeSupabase(
  tables: Record<string, TableConfig | TableConfig[]> = {},
  opts: MockSupabaseOptions = {},
) {
  const callCounts: Record<string, number> = {}
  // Records the columns each table was filtered by, so tests can assert query
  // scoping (e.g. workflow_executions scoped by workflow_id, not a non-existent
  // organization_id column). Keyed by table name.
  const eqCalls: Record<string, Array<[string, unknown]>> = {}
  const allowlistEmail = opts.allowlistEmail ?? 'dan@pennie.com'

  return {
    eqCalls,
    from: (table: string) => {
      const raw = tables[table]
      const cfgArr: TableConfig[] = Array.isArray(raw) ? raw : raw ? [raw] : [{}]
      const idx = callCounts[table] ?? 0
      callCounts[table] = idx + 1
      const cfg = cfgArr[Math.min(idx, cfgArr.length - 1)] ?? {}

      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop === 'symbol') return undefined

            if (prop === 'eq') {
              return (col: string, val: unknown) => {
                const calls = (eqCalls[table] ??= [])
                calls.push([col, val])
                return chain
              }
            }

            const readSingle = (): { data: unknown; error: unknown } =>
              cfg.singleError ? { data: null, error: cfg.singleError } : cfg.single ? { data: cfg.single, error: null } : { data: null, error: NOT_FOUND }
            const readList = (): { data: unknown; error: unknown } => ({ data: cfg.list ?? [], error: null })

            if (prop === 'single') {
              return () => Promise.resolve(readSingle())
            }

            if (prop === 'maybeSingle') {
              if (table === 'user_allowlist' && cfg.single === undefined && cfg.maybeSingle === undefined) {
                return () => Promise.resolve({ data: { email: allowlistEmail }, error: null })
              }
              return () => Promise.resolve({ data: cfg.maybeSingle ?? cfg.single ?? null, error: null })
            }

            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: cfg.list ?? [], error: null }).then(resolve)
            }

            if (prop === 'insert') {
              return () => writeChain(cfg.insertResult, cfg.insertError, readSingle, readList)
            }
            if (prop === 'update') {
              return () => writeChain(cfg.updateResult, cfg.updateError, readSingle, readList)
            }
            if (prop === 'upsert') {
              return () => writeChain(cfg.upsertResult, cfg.upsertError, readSingle, readList)
            }
            if (prop === 'delete') {
              return () => writeChain(undefined, cfg.deleteError, readSingle, readList)
            }

            return () => chain
          },
        },
      )
      return chain
    },
  }
}
