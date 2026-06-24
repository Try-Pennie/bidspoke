import type { Env } from '../index'

// Direct-Postgres writer for the execution-log hot path (workflow_executions +
// execution_steps), via a Cloudflare Hyperdrive binding.
//
// Why this exists: the engine's audit-trail inserts normally go through
// PostgREST (@supabase/supabase-js). The nightly partition-purge cron runs DDL
// (DETACH/DROP PARTITION) on those two tables, which forces PostgREST to reload
// its schema cache; while it reloads it answers inserts with HTTP 503
// "Could not query the database for the schema cache. Retrying." (PGRST002).
// On 2026-06-12 03:30 UTC several Engine Bidding runs exhausted their insert
// retries against that 503 and were promoted to `failed` even though the
// workflow itself ran fine and responded.
//
// A direct Postgres connection has no schema cache, so DDL can never 503 it.
// The only effect of the concurrent DETACH/DROP is a brief ACCESS EXCLUSIVE
// lock; the purge already bounds that to 2s (lock_timeout, migration
// 20260611000002), so a queued INSERT proceeds within ~2s.
//
// This path is OFF unless the HYPERDRIVE binding is configured (see
// wrangler.toml runbook). When absent, the engine stays on PostgREST and pg is
// never imported. callers fail over to PostgREST automatically, so enabling or
// disabling Hyperdrive is non-breaking.

export function hyperdriveEnabled(env: Env | undefined): env is Env & { HYPERDRIVE: Hyperdrive } {
  return !!env?.HYPERDRIVE?.connectionString
}

// Columns that are JSONB in the target tables. Their JS values are serialized
// with JSON.stringify and the placeholder is cast `::jsonb`. (node-postgres
// would stringify plain objects on its own, but explicit casts are unambiguous
// for both objects and JSON arrays.)
export const EXECUTION_JSONB_COLS = new Set(['trigger_payload', 'response_body', 'sighting_finalize'])
export const STEP_JSONB_COLS = new Set(['input', 'output', 'logs'])

type Row = Record<string, unknown>

// Insert one or more rows into `table` over a direct Postgres connection.
// Throws on error (the caller decides retry / fail-over). The column list is
// the union of keys with a defined value across all rows; a row missing one of
// those keys inserts NULL — matching how supabase-js batches uneven rows.
export async function pgInsert(
  env: Env & { HYPERDRIVE: Hyperdrive },
  table: string,
  rows: Row[],
  jsonbCols: Set<string>
): Promise<void> {
  if (rows.length === 0) return

  const cols = Array.from(
    rows.reduce<Set<string>>((set, row) => {
      for (const key of Object.keys(row)) {
        if (row[key] !== undefined) set.add(key)
      }
      return set
    }, new Set<string>())
  )
  if (cols.length === 0) return

  const params: unknown[] = []
  const tuples = rows.map((row) => {
    const placeholders = cols.map((col) => {
      const value = row[col]
      const isJsonb = jsonbCols.has(col)
      params.push(isJsonb && value != null ? JSON.stringify(value) : value ?? null)
      return isJsonb ? `$${params.length}::jsonb` : `$${params.length}`
    })
    return `(${placeholders.join(', ')})`
  })

  const colList = cols.map((col) => `"${col}"`).join(', ')
  const text = `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(', ')}`

  const { Client } = await import('pg')
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString })
  await client.connect()
  try {
    await client.query(text, params)
  } finally {
    // Runs inside waitUntil(), off the request critical path. Hyperdrive pools
    // the underlying server connection, so end() only releases the client.
    await client.end().catch(() => {})
  }
}

// Update `table`, setting the defined keys of `set` where every key of `where`
// matches. Returns the number of rows updated so the caller can fall back to a
// looser key (the partitioned workflow_executions update tries (id, started_at)
// first, then id alone). Throws on error.
export async function pgUpdate(
  env: Env & { HYPERDRIVE: Hyperdrive },
  table: string,
  set: Row,
  where: Row,
  jsonbCols: Set<string>
): Promise<number> {
  const params: unknown[] = []

  const setCols = Object.keys(set).filter((col) => set[col] !== undefined)
  if (setCols.length === 0) return 0
  const setClause = setCols.map((col) => {
    const value = set[col]
    const isJsonb = jsonbCols.has(col)
    params.push(isJsonb && value != null ? JSON.stringify(value) : value ?? null)
    return isJsonb ? `"${col}" = $${params.length}::jsonb` : `"${col}" = $${params.length}`
  })

  const whereCols = Object.keys(where).filter((col) => where[col] !== undefined)
  const whereClause = whereCols.map((col) => {
    params.push(where[col])
    return `"${col}" = $${params.length}`
  })

  const text = `UPDATE ${table} SET ${setClause.join(', ')} WHERE ${whereClause.join(' AND ')}`

  const { Client } = await import('pg')
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString })
  await client.connect()
  try {
    const result = await client.query(text, params)
    return result.rowCount ?? 0
  } finally {
    await client.end().catch(() => {})
  }
}
