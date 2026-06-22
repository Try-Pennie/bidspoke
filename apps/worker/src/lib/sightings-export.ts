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
  stale_swept: number
  sightings_exported: number
  bids_exported: number
  sightings_purged: number
  bids_purged: number
  errors: string[]
}

const STALE_IN_FLIGHT_HOURS = 2        // grace past any execution + finalize window
const STALE_IN_FLIGHT_FLOOR_DAYS = 90  // partition-pruning floor; the daily sweep means no row survives unswept this long

// A sighting only exports once finalizeSighting flips it to 'finalized', and
// only purges once it's exported. finalize is a best-effort waitUntil with no
// retry, so a lost finalize (worker eviction, a statement timeout) leaves the
// row 'in_flight' forever — never exported, never purged. This sweep finalizes
// rows well past any execution window as 'abandoned' so they export (with the
// identity fields written at insert) and then purge normally. The lower bound
// keeps the scan partition-pruned on the (execution_started_at_utc-partitioned)
// table.
export async function sweepStaleInFlightSightings(supabase: SupabaseClient): Promise<number> {
  const now = Date.now()
  const cutoff = new Date(now - STALE_IN_FLIGHT_HOURS * 3600 * 1000).toISOString()
  const floor = new Date(now - STALE_IN_FLIGHT_FLOOR_DAYS * 24 * 3600 * 1000).toISOString()
  const { error, count } = await supabase
    .from('lead_sightings')
    .update(
      {
        outcome_state: 'finalized',
        outcome: 'abandoned',
        reject_reason: 'never_finalized',
        updated_at: new Date().toISOString(),
      },
      { count: 'exact' },
    )
    .eq('outcome_state', 'in_flight')
    .eq('is_test', false)
    .gte('execution_started_at_utc', floor)
    .lt('execution_started_at_utc', cutoff)
  if (error) throw new Error(`stale in_flight sweep failed: ${error.message}`)
  return count ?? 0
}

export async function runSightingsExport(supabase: SupabaseClient, env: Env): Promise<ExportSummary> {
  const config = readSnowflakeConfig(env)
  const summary: ExportSummary = {
    stale_swept: 0,
    sightings_exported: 0,
    bids_exported: 0,
    sightings_purged: 0,
    bids_purged: 0,
    errors: [],
  }

  // Sweep stale in_flight rows to 'finalized' FIRST so they're picked up by the
  // sightings export in this same run.
  try {
    summary.stale_swept = await sweepStaleInFlightSightings(supabase)
  } catch (e) {
    summary.errors.push(`stale in_flight sweep: ${formatErr(e)}`)
  }

  try {
    summary.sightings_exported = await exportTable(
      supabase,
      config,
      'lead_sightings',
      SIGHTING_COLS,
      // Sightings: only finalized, non-test, un-exported
      (q) => q.eq('outcome_state', 'finalized').eq('is_test', false).is('exported_at', null),
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

export async function exportTable(
  supabase: SupabaseClient,
  config: SnowflakeConfig,
  tableName: string,
  cols: ColSpec[],
  applyFilter: FilterFn,
): Promise<number> {
  const colNames = cols.map((c) => c.name).join(', ')
  let totalExported = 0

  // Loop until no more un-exported rows.
  while (true) {
    const baseQuery = supabase.from(tableName).select(colNames).limit(BATCH_SIZE)
    const { data, error } = await applyFilter(baseQuery)
    if (error) throw error
    if (!data || data.length === 0) break

    const rows = data as unknown as Array<Record<string, unknown>>
    const sql = buildMergeSql(tableName, cols, rows)
    await executeStatement(config, sql)

    const ids = rows.map((r) => r.id as string)
    const { error: updErr } = await supabase
      .from(tableName)
      .update({ exported_at: new Date().toISOString() })
      .in('id', ids)
    if (updErr) throw updErr

    totalExported += rows.length
    if (rows.length < BATCH_SIZE) break
  }

  return totalExported
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

export async function purgeOldExported(supabase: SupabaseClient, tableName: string): Promise<number> {
  const cutoff = new Date(Date.now() - PURGE_GRACE_HOURS * 3600 * 1000).toISOString()
  const { error, count } = await supabase
    .from(tableName)
    .delete({ count: 'exact' })
    .not('exported_at', 'is', null)
    .lt('exported_at', cutoff)
  if (error) throw error
  return count ?? 0
}

function formatErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
