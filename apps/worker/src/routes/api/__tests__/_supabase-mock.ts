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
 * jwtAuth folds the user lookup and the allowlist check into a single
 * `auth_user_with_allowlist` RPC (#329). The mock's `rpc` derives its result
 * from the `users` table config (the user row, or its `singleError` for a real
 * lookup failure) and defaults to allowlisted; override per-test by configuring
 * the `user_allowlist` table (`{ maybeSingle: null }` to simulate a denied user).
 *
 * workflows.test.ts, stats.test.ts and executions.test.ts kept their own copies
 * of this after #330, because each needed something extra: a handler for non-auth
 * rpcs, a results-by-name map, or a record of every chained filter call. All
 * three are supported here now and those copies are gone (#347). The cost they
 * carried was real: the #329 auth change had to be applied in four places.
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
  /**
   * Bare-await returns this error instead of rows. Needed because a route that
   * DISCARDS a list error is indistinguishable from one that read an empty
   * table, and that is exactly the defect class worth testing (#877).
   */
  listError?: QueryError
  /**
   * `count` for a `.select('id', { count: 'exact', head: true })` query. Unset
   * leaves it undefined, which models PostgREST on an errored count and is what
   * a `?? 0` fallback silently turns into "empty".
   */
  count?: number
  /** `.maybeSingle()` result. Falls back to `single`, then null. */
  maybeSingle?: Record<string, unknown> | null
  /** `.maybeSingle()` returns this error instead (a real DB error; no rows is not one). */
  maybeSingleError?: QueryError
  insertResult?: Record<string, unknown> | null
  insertError?: QueryError
  updateResult?: Record<string, unknown> | null
  updateError?: QueryError
  upsertResult?: Record<string, unknown> | null
  upsertError?: QueryError
  deleteError?: QueryError
  /**
   * Rows PostgREST hands back from a write that ends in `.select(...)`, i.e.
   * the rows the write actually touched (#588). `[{ id: 'x' }]` models a write
   * that landed; `[]` models one that matched nothing, which PostgREST reports
   * as a plain success and a route must turn into a 404.
   *
   * Unset falls back to the older behavior (the table's `list`), so a write
   * whose rowcount a test does not care about keeps working.
   */
  writeRows?: Record<string, unknown>[]
}

export interface MockSupabaseOptions {
  /** Email returned by the default `user_allowlist.maybeSingle()` allowlist check. */
  allowlistEmail?: string
  /**
   * Handler for NON-auth rpcs (the grouped timeout-suggestions query, and so on).
   * `auth_user_with_allowlist` is always served internally so jwtAuth's lookup
   * stays out of every test's way. Pass a `vi.fn()` here to assert the arguments
   * a route sent.
   */
  rpc?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>
  /**
   * Results for NON-auth rpcs by name, for the common case where a test only
   * needs to hand back rows. An unlisted name resolves to `[]`, which is what a
   * grouped aggregate returns when it matches nothing.
   */
  rpcs?: Record<string, unknown[]>
}

const NOT_FOUND: QueryError = { message: 'not found', code: 'PGRST116' }

type Outcome = { data: unknown; error: unknown }

// A write builder (insert/update/upsert/delete): chainable, resolving to
// `{ data, error }` on a bare await and on a terminal `.single()`. When the
// write-specific result/error is configured it wins; otherwise it falls back to
// the table's read behavior — preserving the older mocks where a write was a
// passthrough and a configured `singleError` surfaced on the write's `.single()`.
function writeChain(
  result: unknown,
  error: unknown,
  readSingle: () => Outcome,
  readList: () => Outcome,
  writeRows?: Record<string, unknown>[],
  onEq?: (col: string, val: unknown) => void,
): unknown {
  const onSingle = (): Outcome =>
    error ? { data: null, error } : result !== undefined ? { data: result, error: null } : readSingle()
  // `writeRows` wins over `result` because it answers a different question: how
  // many rows the write touched, not what a `.single()` on it returns.
  const onAwait = (): Outcome =>
    error
      ? { data: null, error }
      : writeRows !== undefined
        ? { data: writeRows, error: null }
        : result !== undefined
          ? { data: result, error: null }
          : readList()
  const c: unknown = new Proxy(
    {},
    {
      get(_t, p) {
        if (typeof p === 'symbol') return undefined
        if (p === 'single') return () => Promise.resolve(onSingle())
        if (p === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve(onAwait()).then(resolve)
        // Filters on a WRITE are what scope it to an org. Record them like the
        // read chain does, so a test can assert an update/delete is org-scoped.
        if (p === 'eq' && onEq) {
          return (col: string, val: unknown) => {
            onEq(col, val)
            return c
          }
        }
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
  const calls: Record<string, Array<[string, unknown[]]>> = {}
  const allowlistEmail = opts.allowlistEmail ?? 'dan@pennie.com'

  const firstCfg = (table: string): TableConfig => {
    const raw = tables[table]
    return Array.isArray(raw) ? raw[0] ?? {} : raw ?? {}
  }

  return {
    eqCalls,
    /**
     * Every chained builder call per table, as [method, args]. `eqCalls` is the
     * narrow view of the same thing; this one lets a test assert the whole
     * filter chain a route applied (which columns it scoped by, in what order),
     * which is what the is_test / source scoping assertions need.
     */
    calls,
    // jwtAuth's one-round-trip auth lookup (#329). Mirrors the old two-query
    // behavior: users.singleError -> a real lookup error (500); no user row ->
    // empty rows (401); otherwise one row carrying `allowed`, which defaults to
    // true unless the `user_allowlist` table is configured to deny.
    rpc: (name: string, args: unknown) => {
      if (name !== 'auth_user_with_allowlist') {
        // Non-auth rpcs delegate, so jwtAuth's lookup stays internal and a test
        // never has to reimplement it just to stub one grouped query.
        if (opts.rpc) return opts.rpc(name, args)
        if (opts.rpcs) return Promise.resolve({ data: opts.rpcs[name] ?? [], error: null })
        return Promise.resolve({ data: null, error: null })
      }
      const usersCfg = firstCfg('users')
      if (usersCfg.singleError) return Promise.resolve({ data: null, error: usersCfg.singleError })
      const userRow = usersCfg.single ?? null
      if (!userRow) return Promise.resolve({ data: [], error: null })
      let allowed = true
      const allowCfg = tables['user_allowlist']
      if (allowCfg) {
        const c = Array.isArray(allowCfg) ? allowCfg[0] ?? {} : allowCfg
        if (c.maybeSingle !== undefined || c.single !== undefined) {
          allowed = !!(c.maybeSingle ?? c.single)
        }
      }
      return Promise.resolve({ data: [{ ...userRow, allowed }], error: null })
    },
    from: (table: string) => {
      const raw = tables[table]
      const cfgArr: TableConfig[] = Array.isArray(raw) ? raw : raw ? [raw] : [{}]
      const idx = callCounts[table] ?? 0
      callCounts[table] = idx + 1
      const cfg = cfgArr[Math.min(idx, cfgArr.length - 1)] ?? {}
      const recordEq = (col: string, val: unknown) => {
        const forTable = (eqCalls[table] ??= [])
        forTable.push([col, val])
      }

      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop === 'symbol') return undefined

            if (prop === 'eq') {
              return (col: string, val: unknown) => {
                recordEq(col, val)
                ;(calls[table] ??= []).push(['eq', [col, val]])
                return chain
              }
            }

            const readSingle = (): { data: unknown; error: unknown } =>
              cfg.singleError ? { data: null, error: cfg.singleError } : cfg.single ? { data: cfg.single, error: null } : { data: null, error: NOT_FOUND }
            const readList = (): { data: unknown; error: unknown } =>
              cfg.listError ? { data: null, error: cfg.listError } : { data: cfg.list ?? [], error: null }

            if (prop === 'single') {
              return () => Promise.resolve(readSingle())
            }

            if (prop === 'maybeSingle') {
              if (table === 'user_allowlist' && cfg.single === undefined && cfg.maybeSingle === undefined) {
                return () => Promise.resolve({ data: { email: allowlistEmail }, error: null })
              }
              if (cfg.maybeSingleError) return () => Promise.resolve({ data: null, error: cfg.maybeSingleError })
              return () => Promise.resolve({ data: cfg.maybeSingle ?? cfg.single ?? null, error: null })
            }

            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown) =>
                Promise.resolve(
                  cfg.listError
                    ? { data: null, error: cfg.listError, count: null }
                    : { data: cfg.list ?? [], error: null, count: cfg.count },
                ).then(resolve)
            }

            if (prop === 'insert') {
              // Recorded with its payload, so a test can assert what a route actually wrote
              // (#1117 asserts the stored script), not only that a write happened.
              return (...args: unknown[]) => {
                ;(calls[table] ??= []).push(['insert', args])
                return writeChain(cfg.insertResult, cfg.insertError, readSingle, readList, cfg.writeRows, recordEq)
              }
            }
            if (prop === 'update') {
              // Recorded with its payload, so a test can assert what a route actually wrote
              // (#1117 asserts the stored script), not only that a write happened.
              return (...args: unknown[]) => {
                ;(calls[table] ??= []).push(['update', args])
                return writeChain(cfg.updateResult, cfg.updateError, readSingle, readList, cfg.writeRows, recordEq)
              }
            }
            if (prop === 'upsert') {
              // Recorded with its payload, so a test can assert what a route actually wrote
              // (#1117 asserts the stored script), not only that a write happened.
              return (...args: unknown[]) => {
                ;(calls[table] ??= []).push(['upsert', args])
                return writeChain(cfg.upsertResult, cfg.upsertError, readSingle, readList, cfg.writeRows, recordEq)
              }
            }
            if (prop === 'delete') {
              return () => writeChain(undefined, cfg.deleteError, readSingle, readList, cfg.writeRows, recordEq)
            }

            return (...args: unknown[]) => {
              ;(calls[table] ??= []).push([prop, args])
              return chain
            }
          },
        },
      )
      return chain
    },
  }
}
