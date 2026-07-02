// Nightly export of lead_sightings + lead_sighting_bids to Snowflake.
// Runs at 09:00 UTC (4am ET winter / 5am ET summer) via the scheduled trigger
// in apps/worker/src/index.ts. Snowflake is canonical for analytics; Supabase
// is a write buffer that gets purged 24h after successful export.

import type { SupabaseClient } from '@supabase/supabase-js'
import { coerceString } from './coerce'
import type { Env } from '../index'
import { executeStatement, type SnowflakeConfig } from './snowflake'

const BATCH_SIZE = 200            // rows per Snowflake MERGE
const PURGE_GRACE_HOURS = 24      // delete from Supabase only after this many hours since export
// Per-run backstop on rows exported per table. Far above a normal night (~83K
// finalized sightings) so steady-state runs are unaffected; it only bounds a
// catch-up run draining a large backlog, alongside the platform clean-stop in
// exportTable. A multi-day backlog drains over a few runs rather than one giant run.
const MAX_ROWS_PER_RUN = 400_000

// Column names + Snowflake types for value formatting. 'variant' carries JSON:
// the value travels as an escaped string in the VALUES list (Snowflake VALUES
// only allows constants) and the USING projection wraps it in PARSE_JSON.
export type ColType = 'varchar' | 'number' | 'boolean' | 'timestamp_tz' | 'timestamp_ntz' | 'variant'

export interface ColSpec {
  name: string
  type: ColType
}

const SIGHTING_COLS: ColSpec[] = [
  { name: 'id', type: 'varchar' },
  { name: 'ssn', type: 'varchar' },
  { name: 'person_id', type: 'varchar' },
  { name: 'trace_id', type: 'varchar' },
  { name: 'execution_id', type: 'varchar' },
  { name: 'workflow_id', type: 'varchar' },
  { name: 'workflow_version_id', type: 'varchar' },
  { name: 'workflow_version_sha', type: 'varchar' },
  { name: 'execution_started_at_et', type: 'timestamp_tz' },
  { name: 'execution_finished_at_et', type: 'timestamp_tz' },
  { name: 'execution_started_at_utc', type: 'timestamp_ntz' },
  { name: 'execution_ended_at_utc', type: 'timestamp_ntz' },
  { name: 'duration_ms', type: 'number' },
  { name: 'source_name', type: 'varchar' },
  { name: 'subaccount_uuid', type: 'varchar' },
  { name: 'lead_uuid', type: 'varchar' },
  { name: 'external_partner_name', type: 'varchar' },
  { name: 'external_routing_code', type: 'varchar' },
  { name: 'external_exchange_status', type: 'varchar' },
  { name: 'offer_landing_page', type: 'varchar' },
  { name: 'terminal_node_id', type: 'varchar' },
  { name: 'terminal_node_label', type: 'varchar' },
  { name: 'response_status_code', type: 'number' },
  { name: 'reject_reason', type: 'varchar' },
  { name: 'outcome', type: 'varchar' },
  { name: 'prospect_id', type: 'varchar' },
  { name: 'equifax_status', type: 'varchar' },
  { name: 'equifax_error_type', type: 'varchar' },
  { name: 'equifax_score', type: 'number' },
  { name: 'winning_partner_slug', type: 'varchar' },
  { name: 'winning_bid_cents', type: 'number' },
  { name: 'partners_attempted', type: 'number' },
  { name: 'partners_responded', type: 'number' },
  { name: 'state', type: 'varchar' },
  { name: 'zip', type: 'varchar' },
  { name: 'fico_tier', type: 'varchar' },
  { name: 'employment_status', type: 'varchar' },
  { name: 'education_level', type: 'varchar' },
  { name: 'rent_or_own', type: 'varchar' },
  { name: 'loan_purpose', type: 'varchar' },
  { name: 'income_pmt_frequency', type: 'varchar' },
  { name: 'annual_income', type: 'number' },
  { name: 'external_debt', type: 'number' },
  { name: 'loan_amount', type: 'number' },
  { name: 'tcpa_consent', type: 'boolean' },
  { name: 'fcra_consent', type: 'boolean' },
  { name: 'user_ip', type: 'varchar' },
  { name: 'user_agent', type: 'varchar' },
]

const BID_COLS: ColSpec[] = [
  { name: 'id', type: 'varchar' },
  { name: 'sighting_id', type: 'varchar' },
  { name: 'ssn', type: 'varchar' },
  { name: 'trace_id', type: 'varchar' },
  { name: 'execution_id', type: 'varchar' },
  { name: 'partner_slug', type: 'varchar' },
  { name: 'bid_position', type: 'number' },
  { name: 'is_winner', type: 'boolean' },
  { name: 'attempted_at_utc', type: 'timestamp_ntz' },
  { name: 'attempted_at_et', type: 'timestamp_tz' },
  { name: 'responded_at_utc', type: 'timestamp_ntz' },
  { name: 'responded_at_et', type: 'timestamp_tz' },
  { name: 'duration_ms', type: 'number' },
  { name: 'http_status', type: 'number' },
  { name: 'bid_cents', type: 'number' },
  { name: 'classification', type: 'varchar' },
  { name: 'decline_reason', type: 'varchar' },
  { name: 'resolver_type', type: 'varchar' },
  { name: 'skip_reason', type: 'varchar' },
]

// ============================================================
// Public API
// ============================================================

export interface ExportSummary {
  sightings_exported: number
  bids_exported: number
  sightings_purged: number
  bids_purged: number
  errors: string[]
}

// Strand cleanup (formerly the in-Worker sweepStaleInFlightSightings) now runs
// DB-side via two pg_cron functions BEFORE this 09:00 export: reduce_finalize_
// stranded (08:00, recoverable strands → real outcome) and finalize_unrecoverable_
// stranded (08:30, the rest → reject_reason='strand_unrecoverable'). The Worker
// version timed out on the multi-partition UPDATE at the PostgREST 8s gateway and
// failed silently (#351); the pg_cron versions have no gateway limit. So by export
// time every stale in_flight row is already 'finalized' and picked up below.
export async function runSightingsExport(supabase: SupabaseClient, env: Env): Promise<ExportSummary> {
  const config = readSnowflakeConfig(env)
  const summary: ExportSummary = {
    sightings_exported: 0,
    bids_exported: 0,
    sightings_purged: 0,
    bids_purged: 0,
    errors: [],
  }

  try {
    summary.sightings_exported = await exportTable(
      supabase,
      config,
      'lead_sightings',
      SIGHTING_COLS,
      // Sightings: only finalized, non-test, un-exported
      (q) => q.eq('outcome_state', 'finalized').eq('is_test', false).is('exported_at', null),
      MAX_ROWS_PER_RUN,
    )
  } catch (e) {
    summary.errors.push(`sightings export: ${formatErr(e)}`)
  }

  try {
    summary.bids_exported = await exportTable(
      supabase,
      config,
      'lead_sighting_bids',
      BID_COLS,
      (q) => q.eq('is_test', false).is('exported_at', null),
      MAX_ROWS_PER_RUN,
    )
  } catch (e) {
    summary.errors.push(`bids export: ${formatErr(e)}`)
  }

  try {
    summary.sightings_purged = await purgeOldExported(supabase, 'lead_sightings')
  } catch (e) {
    summary.errors.push(`sightings purge: ${formatErr(e)}`)
  }

  try {
    summary.bids_purged = await purgeOldExported(supabase, 'lead_sighting_bids')
  } catch (e) {
    summary.errors.push(`bids purge: ${formatErr(e)}`)
  }

  return summary
}

// ============================================================
// Internals
// ============================================================

export function readSnowflakeConfig(env: Env): SnowflakeConfig {
  return {
    account: env.SNOWFLAKE_ACCOUNT,
    user: env.SNOWFLAKE_USER,
    privateKeyPem: env.SNOWFLAKE_PRIVATE_KEY,
    database: env.SNOWFLAKE_DATABASE,
    schema: env.SNOWFLAKE_SCHEMA,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    role: env.SNOWFLAKE_ROLE,
  }
}

type FilterFn = <T extends { eq: (k: string, v: unknown) => T; is: (k: string, v: unknown) => T }>(q: T) => T
type Sleep = (ms: number) => Promise<void>

const DEFAULT_SLEEP: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function exportTable(
  supabase: SupabaseClient,
  config: SnowflakeConfig,
  tableName: string,
  cols: ColSpec[],
  applyFilter: FilterFn,
  // Backstop so one run can't loop unbounded against a large backlog (e.g. the
  // ~700K pile-up after an export was wedged for days). The real platform ceiling
  // is enforced by the clean-stop below; this is just a guard rail.
  maxRows: number = Number.POSITIVE_INFINITY,
  sleep: Sleep = DEFAULT_SLEEP,
): Promise<number> {
  const colNames = cols.map((c) => c.name).join(', ')
  let totalExported = 0

  // Loop until no more un-exported rows (or we hit the per-run cap / platform limit).
  while (true) {
    const remaining = maxRows - totalExported
    if (remaining <= 0) break
    const batchLimit = Math.min(BATCH_SIZE, remaining)

    try {
      const exportedCount = await withStatementTimeoutRetry(async () => {
        const baseQuery = supabase.from(tableName).select(colNames).limit(batchLimit)
        const { data, error } = await applyFilter(baseQuery)
        if (error) throw error
        if (!data || data.length === 0) return 0

        const rows = data as unknown as Array<Record<string, unknown>>
        const sql = buildMergeSql(tableName, cols, rows)
        await executeStatement(config, sql)

        const ids = rows.map((r) => r.id as string)
        const { error: updErr } = await supabase
          .from(tableName)
          .update({ exported_at: new Date().toISOString() })
          .in('id', ids)
        if (updErr) throw updErr

        return rows.length
      }, sleep)

      if (exportedCount === 0) break
      totalExported += exportedCount
      if (exportedCount < batchLimit) break
    } catch (e) {
      // Cloudflare caps subrequests per invocation. When draining a large backlog
      // we may hit it mid-run; that is NOT a failure -- stop cleanly, keep the rows
      // already exported, and let the next scheduled run continue (rows are still
      // un-exported, the MERGE is idempotent). Anything else is a real error and
      // must propagate so it still alerts.
      if (isSubrequestLimit(e)) {
        console.warn(
          `[sightings-export] ${tableName}: hit platform subrequest limit after ${totalExported} rows; remaining backlog continues next run`
        )
        break
      }
      throw e
    }
  }

  return totalExported
}

// Detects the Cloudflare "Too many subrequests" platform error so a backlog drain
// can stop cleanly instead of failing the run.
export function isSubrequestLimit(e: unknown): boolean {
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : typeof (e as { message?: unknown } | null)?.message === 'string'
          ? (e as { message: string }).message
          : ''
  return /too many subrequests|subrequest limit/i.test(msg)
}

// Production traffic goes through PostgREST, which authenticates as a role
// with an 8s statement_timeout/lock_timeout -- much tighter than the 2min
// cluster default (a direct DB connection bypasses this and looked healthy,
// which is what made the 2026-07-02 recurrence look unexplained). A query
// this fast (single-digit ms with the right index) only needs a moment to
// clear a transient collision with the table's constant live-traffic writes,
// so a couple of short retries recovers most of these without masking a
// genuine, persistent failure.
export function isStatementTimeout(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (code === '57014') return true
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : typeof (e as { message?: unknown } | null)?.message === 'string'
          ? (e as { message: string }).message
          : ''
  return /57014|statement timeout/i.test(msg)
}

export const STATEMENT_TIMEOUT_MAX_ATTEMPTS = 3
const STATEMENT_TIMEOUT_RETRY_DELAY_MS = 250

async function withStatementTimeoutRetry<T>(fn: () => Promise<T>, sleep: Sleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!isStatementTimeout(e) || attempt >= STATEMENT_TIMEOUT_MAX_ATTEMPTS) throw e
      await sleep(STATEMENT_TIMEOUT_RETRY_DELAY_MS * attempt)
    }
  }
}

export function buildMergeSql(tableName: string, cols: ColSpec[], rows: Array<Record<string, unknown>>): string {
  const colList = cols.map((c) => c.name).join(', ')
  const sourceColList = cols.map((c) => `s.${c.name}`).join(', ')
  // UPDATE clause covers every column except id (the join key). Lets us
  // re-export rows when columns are added or values are corrected upstream
  // (e.g., outcome backfill).
  const updateSet = cols
    .filter((c) => c.name !== 'id')
    .map((c) => `${c.name} = s.${c.name}`)
    .join(', ')
  const valuesList = rows
    .map((r) => '(' + cols.map((c) => formatValue(r[c.name], c.type)).join(', ') + ')')
    .join(', ')
  const tupleAlias = '(' + cols.map((c) => c.name).join(', ') + ')'
  // Variant columns travel as escaped JSON strings (VALUES only allows
  // constants) and get PARSE_JSON applied in this projection.
  const projection = cols
    .map((c) => (c.type === 'variant' ? `PARSE_JSON(${c.name}) AS ${c.name}` : c.name))
    .join(', ')

  return `
MERGE INTO ${tableName} t
USING (
  SELECT ${projection} FROM (VALUES ${valuesList}) AS s${tupleAlias}
) s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET ${updateSet}
WHEN NOT MATCHED THEN INSERT (${colList}) VALUES (${sourceColList})
`.trim()
}

export function formatValue(v: unknown, type: ColType): string {
  if (v === null || v === undefined || v === '') return 'NULL'
  switch (type) {
    case 'varchar':
      return `'${coerceString(v).replace(/'/g, "''")}'`
    case 'number':
      return Number.isFinite(Number(v)) ? String(Number(v)) : 'NULL'
    case 'boolean':
      return v === true || v === 'true' || v === 1 || v === '1' ? 'TRUE' : 'FALSE'
    case 'timestamp_tz':
      return `'${coerceString(v).replace(/'/g, "''")}'::TIMESTAMP_TZ`
    case 'timestamp_ntz':
      return `'${coerceString(v).replace(/'/g, "''")}'::TIMESTAMP_NTZ`
    case 'variant':
      return `'${JSON.stringify(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  }
}

// Rows per purge DELETE. A single unbounded DELETE over a large backlog (2.3M
// rows was observed) could run long enough to be cancelled (57014) under the
// production PostgREST role's 8s statement_timeout, so the purge deletes
// bounded pages instead: select a page of ids, then delete exactly those ids.
// Kept small so the id list stays within the PostgREST request-URL length
// limit and each DELETE is normally trivially fast.
export const PURGE_BATCH = 200

export async function purgeOldExported(
  supabase: SupabaseClient,
  tableName: string,
  // Per-run backstop so a huge backlog drains over several nights rather than
  // running the worker until it hits the platform subrequest ceiling. Steady
  // state (~a day's exported rows) is far below this.
  maxRows: number = MAX_ROWS_PER_RUN,
  sleep: Sleep = DEFAULT_SLEEP,
): Promise<number> {
  const cutoff = new Date(Date.now() - PURGE_GRACE_HOURS * 3600 * 1000).toISOString()
  let purged = 0

  while (purged < maxRows) {
    const batch = Math.min(PURGE_BATCH, maxRows - purged)

    try {
      const purgedCount = await withStatementTimeoutRetry(async () => {
        const { data, error } = await supabase
          .from(tableName)
          .select('id')
          .not('exported_at', 'is', null)
          .lt('exported_at', cutoff)
          .limit(batch)
        if (error) throw error
        const ids = (data ?? []).map((r) => (r as { id: string }).id)
        if (ids.length === 0) return { count: 0, drained: true }

        const { error: delErr, count } = await supabase
          .from(tableName)
          .delete({ count: 'exact' })
          .in('id', ids)
        if (delErr) throw delErr

        return { count: count ?? ids.length, drained: ids.length < batch }
      }, sleep)

      purged += purgedCount.count
      if (purgedCount.count === 0 || purgedCount.drained) break
    } catch (e) {
      // Cloudflare caps subrequests per invocation; hitting it mid-drain is not a
      // failure — stop cleanly and let the next scheduled run continue (rows are
      // still exported, so nothing is lost). Anything else is a real error.
      if (isSubrequestLimit(e)) {
        console.warn(
          `[sightings-export] ${tableName}: hit platform subrequest limit after purging ${purged} rows; remaining backlog continues next run`
        )
        break
      }
      throw e
    }
  }

  return purged
}

// Thrown Supabase/PostgREST errors are plain objects ({ message, code,
// details, hint }), not Error instances, so the old `String(e)` rendered them
// as the useless "[object Object]" that hid the real cause in export alerts.
// Surface the message (plus code when present); fall back to JSON for any other
// object so we never emit "[object Object]" again.
export function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const obj = e as { message?: unknown; code?: unknown }
    const message = typeof obj.message === 'string' ? obj.message : undefined
    const code =
      typeof obj.code === 'string' || typeof obj.code === 'number' ? String(obj.code) : undefined
    if (message) return code ? `${message} (${code})` : message
    try {
      return JSON.stringify(e)
    } catch {
      return '[unserializable error]'
    }
  }
  return String(e)
}
