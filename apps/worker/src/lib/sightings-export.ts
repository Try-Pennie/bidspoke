// Export of lead_sightings + lead_sighting_bids to Snowflake, and the purge that
// drops rows once Snowflake has them.
//
// TWO separate cron invocations, on purpose (see index.ts / wrangler.toml):
//   runSightingsExport  "37 */2 * * *"    every 2h at :37
//   runSightingsPurge   "47 1-23/2 * * *" odd hours at :47
// They used to be one invocation sharing one WALL_TIME_BUDGET_MS deadline. When
// export throughput grew to fill that budget, the purge phases found the deadline
// already passed, deleted nothing, and logged a console.warn with `errors: []` --
// so nothing alerted, and the backlog grew by a full day's inflow every day
// (2026-07-10). A separate invocation gives the purge its own fresh budget.
//
// Snowflake is canonical for analytics; Supabase is a write buffer purged 24h
// after a successful export. A failed EXPORT normally self-heals next run, under
// 2h later. A failed PURGE does not mean analytics are stale: those rows are
// already in Snowflake, and only the Supabase cleanup is behind.

import type { SupabaseClient } from '@supabase/supabase-js'
import { coerceString } from './coerce'
import { partitionKeyFor } from './partitioned-tables'
import type { Env } from '../index'
import {
  executeStatement,
  escapeSqlLiteral,
  isTransientSnowflakeError,
  SnowflakeSendMeter,
  SnowflakeStatementError,
  type SnowflakeConfig,
  type SnowflakeSendStats,
  type SnowflakeStatementResponse,
} from './snowflake'
import { requireRowsAffected, toThrowable, toDbError } from './db-retry'
import { formatErr } from './format-error'
import { notifyExportFailure } from './export-alerts'

const BATCH_SIZE = 200            // rows per Snowflake MERGE
export const PURGE_GRACE_HOURS = 24      // delete from Supabase only after this many hours since export
/**
 * The earliest a lead_sighting_bids row can have been purged, measured from its
 * attempt: the export runs after the attempt and the purge follows the export by
 * the grace. Any check comparing against bid rows imports this rather than
 * copying the number, so the two cannot drift (#1413, L592).
 */
export const BID_PURGE_HORIZON_MS = PURGE_GRACE_HOURS * 3600 * 1000
// Per-run backstop on rows exported per table. Far above a normal night (~83K
// finalized sightings) so steady-state runs are unaffected; it only bounds a
// catch-up run draining a large backlog, alongside the platform clean-stop in
// exportTable. A multi-day backlog drains over a few runs rather than one giant run.
const MAX_ROWS_PER_RUN = 400_000

// Cloudflare Cron Trigger invocations get killed by the platform at ~15 minutes
// wall time (observed: outcome "exceededWallTime" at exactly 899985ms on
// 2026-07-03, draining a large backlog). That kill is silent -- the whole
// invocation dies mid-run, so runSightingsExport's .then()/.catch() (the
// completion log + failure alert) never runs, even though the run itself made
// real progress (29,600 rows exported before the kill that day). This budget
// is a soft, self-imposed deadline well under the platform's hard limit so
// every phase stops itself cleanly -- same as the existing subrequest-limit /
// permanent-statement-timeout clean-stops -- leaving room for the last
// in-flight batch plus the completion log/alert to actually run.
//
// HEADROOM, MEASURED 2026-09-25 (#749) from the per-batch exported_at stamps of
// the last day's runs: about 3.1s per 200-row sightings batch (p95 4.7s) and
// 2.3s per bids batch. The busiest two hour run carried 11.6K sightings and 7K
// bids, about 270s of this 720s budget. So a run can drain its own inflow plus
// ONE failed run's backlog at peak (about 540s), but not two (about 815s), and
// two is exactly what the export alert waits for before paging. The hard kill is
// at 15 minutes, so the budget cannot grow enough to change that. Instead a run
// that stops at a limit with rows still waiting says so (ExportStop): the first
// such run is held as transient, and a second in a row pages as the runaway.
// Re-measure with the stamp query in the #749 PR if the per-batch cost moves.
export const WALL_TIME_BUDGET_MS = 12 * 60 * 1000

/**
 * Why an export stopped before it ran out of rows (#749). Null means it drained,
 * or never saw evidence of more: a run whose budget was gone before its first
 * look has nothing to say about the backlog.
 */
export type ExportStopReason = 'wall_time' | 'subrequest_limit' | 'row_cap' | 'statement_timeout'
export interface ExportStop {
  reason: ExportStopReason | null
}

const STOP_WORDS: Record<ExportStopReason, string> = {
  wall_time: 'the wall-time budget',
  subrequest_limit: 'the platform subrequest ceiling',
  row_cap: 'the per-run row cap',
  statement_timeout: 'a batch that kept timing out',
}

/** The summary line for a table that stopped with rows still waiting. */
export function stoppedBehindMessage(label: string, reason: ExportStopReason, exported: number): string {
  return `${label} export: stopped at ${STOP_WORDS[reason]} after ${exported} rows with rows still waiting to export; the rest continues next run`
}

// Column names + Snowflake types for value formatting. 'variant' carries JSON:
// the value travels as an escaped string in the VALUES list (Snowflake VALUES
// only allows constants) and the USING projection wraps it in PARSE_JSON.
export type ColType = 'varchar' | 'number' | 'boolean' | 'timestamp_tz' | 'timestamp_ntz' | 'variant'

export interface ColSpec {
  name: string
  type: ColType
}

/** The Snowflake DDL type for a ColSpec, used by both CREATE and ALTER. */
const SNOWFLAKE_TYPE: Record<ColType, string> = {
  varchar: 'VARCHAR',
  number: 'NUMBER',
  boolean: 'BOOLEAN',
  timestamp_tz: 'TIMESTAMP_TZ',
  timestamp_ntz: 'TIMESTAMP_NTZ',
  variant: 'VARIANT',
}

/**
 * Adds any column an export's ColSpec declares that the Snowflake table does not have.
 *
 * The tables are created with CREATE TABLE IF NOT EXISTS, which does nothing to a table
 * that already exists, so a new entry in a ColSpec used to mean the next run wrote a
 * statement naming a column Snowflake had never heard of. That fails every night until a
 * person runs the DDL by hand, which is #428's shape, and it fails AFTER the export has
 * already done its reading, so the cost is a whole missed night each time.
 *
 * It reads what the table actually has rather than relying on ADD COLUMN IF NOT EXISTS,
 * whose support cannot be tested from here (L82: measure the platform guarantee rather
 * than trusting the documentation).
 *
 * Only the Achieve export calls this today. The sightings export shares the same exposure
 * but runs against a budget that has already been starved once by work added to it
 * (#1078), so it is left alone deliberately rather than by oversight; adding the call is
 * one line when somebody wants it.
 */
export async function reconcileColumns(
  config: SnowflakeConfig,
  table: string,
  cols: ColSpec[],
  // Injected so the tests drive the real logic rather than a reimplementation of it.
  query: (config: SnowflakeConfig, statement: string) => Promise<SnowflakeStatementResponse> = executeStatement
): Promise<string[]> {
  // readSnowflakeConfig passes its env through without validating, so an unset
  // SNOWFLAKE_SCHEMA arrives here as undefined. Refusing by name beats the TypeError that
  // .toUpperCase() would otherwise raise, which would surface as a nightly export failure
  // naming nothing (L11).
  if (!config.schema) {
    throw new Error('reconcileColumns: no Snowflake schema configured, so the table could not be located')
  }

  // Filtered by schema as well as table name: information_schema.columns spans every schema
  // in the database, so a same named table elsewhere would answer for this one. Its columns
  // would read as present, the genuinely missing ones would never be added, and the failure
  // would surface later as the write naming a column that does not exist, which is exactly
  // what this exists to prevent.
  const listing = await query(
    config,
    'SELECT column_name FROM information_schema.columns' +
      ` WHERE table_schema = '${escapeSqlLiteral(config.schema.toUpperCase())}'` +
      ` AND table_name = '${escapeSqlLiteral(table.toUpperCase())}'`
  )

  const nameAt = (listing.resultSetMetaData?.rowType ?? []).findIndex(
    (c) => c.name.toLowerCase() === 'column_name'
  )
  const rows = listing.data ?? []
  // Snowflake upper cases unquoted identifiers, so the comparison is case insensitive in
  // both directions rather than trusting either side's spelling.
  const existing = new Set(
    rows
      .map((r) => (nameAt >= 0 ? r[nameAt] : r[0]))
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase())
  )

  // An empty listing means the table could not be read, never that it has no columns: the
  // caller has just run CREATE TABLE IF NOT EXISTS against it. Adding every column would
  // fail anyway, and carrying on would let the write that follows fail with an error about
  // something else entirely (L98: finding nothing is not the same as finding nothing wrong).
  if (existing.size === 0) {
    throw new Error(
      `reconcileColumns: no columns found for ${table}, so its schema could not be read`
    )
  }

  const added: string[] = []
  for (const col of cols) {
    if (existing.has(col.name.toLowerCase())) continue
    await query(config, `ALTER TABLE ${table} ADD COLUMN ${col.name} ${SNOWFLAKE_TYPE[col.type]}`)
    added.push(col.name)
  }
  return added
}

// Both tables are partitioned monthly on a timestamp, and `id` is not the
// partition key. A write keyed on id alone cannot be pruned, so Postgres fans it
// out to every partition -- including drained ones that still carry their bloat.
// Bounding each write by the key range of the rows already in hand collapses the
// fan-out to the one or two partitions the batch actually spans. The key map is
// the canonical registry (also read by the partition-key write guard, #619).
// Re-exported so existing importers of partitionKeyFor from this module still work.
export { partitionKeyFor }

// A column a concurrent writer can still CORRECT after the row became exportable,
// together with the value it corrects to (#483).
//
// lead_sighting_bids.is_winner is the only one. A bid row is exportable the moment
// it is inserted, which is mid-run, and finalize only decides the winner at the end
// of the run. Finalize's correction is `is_winner = true, exported_at = null`, and
// that exported_at=null is the repair path: it re-queues an already-exported bid so
// the corrected flag reaches Snowflake next run.
//
// Which means an unconditional `exported_at` stamp is unsafe. Export SELECTs the bid
// (is_winner false), MERGEs that stale false into Snowflake, and only then stamps. If
// the correction commits inside that window (a Snowflake round trip wide, ~1.7s
// measured) the stamp overwrites the exported_at=null the correction just wrote. The
// row then looks exported, is never re-selected, and is purged 24h later: Snowflake
// records the winner as a loser, permanently. So the stamp asserts the value we
// actually shipped, and a row corrected under us stays unstamped and re-exports.
//
// lead_sightings needs no entry: its filter requires outcome_state='finalized', which
// finalize sets in the same statement as the fields it corrects, so a sighting only
// becomes exportable once it is already final.
const CORRECTABLE_COL: Record<string, { col: string; correctedTo: unknown }> = {
  lead_sighting_bids: { col: 'is_winner', correctedTo: true },
}

interface StampGroup {
  ids: string[]
  // The column values this group's stamp asserts, as a PostgREST .match() object.
  // Empty for a table with no correctable column, where .match({}) adds no filters
  // and the stamp is the unconditional write it always was.
  assert: Record<string, unknown>
  // True when every row in the group could be corrected out from under the stamp,
  // so matching zero rows is a legitimate outcome rather than a broken write.
  mayMissAll: boolean
}

// Split a merged batch into the stamps it needs: one per distinct value of the
// correctable column, so each stamp can assert the value it shipped. Without a
// correctable column this is a single unconditional group, byte-for-byte the
// write that existed before.
export function stampGroups(rows: Array<Record<string, unknown>>, tableName: string): StampGroup[] {
  const correctable = CORRECTABLE_COL[tableName]
  if (!correctable) {
    return [{ ids: rows.map((r) => r.id as string), assert: {}, mayMissAll: false }]
  }

  const { col, correctedTo } = correctable

  // The stamp asserts this column, so it must actually be in the SELECT list. If a
  // future edit drops it from the table's ColSpec, every row's value reads
  // undefined, every stamp asserts undefined, nothing is ever marked exported, and
  // the table re-exports forever while the purge starves. Fail loudly here instead.
  if (rows.length > 0 && !(col in rows[0])) {
    throw new Error(
      `${tableName}: correctable column "${col}" is not in the exported columns, so the exported_at stamp cannot assert it`
    )
  }

  const byValue = new Map<string, { value: unknown; ids: string[] }>()
  for (const r of rows) {
    const value = r[col]
    const key = JSON.stringify(value ?? null)
    const group = byValue.get(key) ?? { value, ids: [] }
    group.ids.push(r.id as string)
    byValue.set(key, group)
  }

  return [...byValue.values()].map((g) => ({
    ids: g.ids,
    assert: { [col]: g.value },
    // A row already holding the corrected value cannot change again, so its stamp
    // keeps the #583 hard guard. Only the pre-correction group can lose every row
    // to a concurrent correction.
    mayMissAll: g.value !== correctedTo,
  }))
}

// Lowest and highest partition-key value in a page of rows. Values are kept as
// the strings PostgREST returned (never reformatted) so they round-trip exactly;
// only the comparison parses them, which keeps a mixed-precision fractional
// second from ordering wrong the way a lexicographic compare would.
export function partitionBounds(
  rows: Array<Record<string, unknown>>,
  key: string,
): { min: string; max: string } {
  let min: string | undefined
  let max: string | undefined
  for (const row of rows) {
    const value = row[key]
    if (typeof value !== 'string') {
      // Never silently fall back to an unbounded write: that is the slow path we
      // are removing, and it would regress invisibly.
      throw new Error(`[sightings-export] row is missing partition key ${key}; cannot bound the write`)
    }
    if (min === undefined || Date.parse(value) < Date.parse(min)) min = value
    if (max === undefined || Date.parse(value) > Date.parse(max)) max = value
  }
  if (min === undefined || max === undefined) {
    throw new Error(`[sightings-export] cannot compute partition bounds from an empty page`)
  }
  return { min, max }
}

export const SIGHTING_COLS: ColSpec[] = [
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
  // What we quoted the lead's SOURCE, against winning_bid_cents above, which is
  // what a BUYER offered us. Opposite directions of money, so the pair is the
  // per-lead margin and neither may be summed as if it were the other.
  { name: 'quoted_rate_cents', type: 'number' },
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

/**
 * The sighting column NAMES this export ships, for tests that need to relate a
 * value the engine records to a value the warehouse receives. Those are two
 * separate lists in two files, so a column written to Postgres and left out of
 * here is invisible to every warehouse query and then dropped at the retention
 * window, with nothing failing in between.
 */
export const sightingExportColumns: string[] = SIGHTING_COLS.map((c) => c.name)

export const BID_COLS: ColSpec[] = [
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
  // Our ESTIMATE of the lead's value, filled from the Salesforce formula field
  // ExternalExchangeRevenue__c (#354). Deliberately NOT folded into bid_cents,
  // which means what a buyer offered us on every row it holds: mixing a
  // derivation into it would make every warehouse sum part measurement and part
  // estimate with nothing announcing it. Same reasoning as quoted_rate_cents.
  { name: 'estimated_revenue_cents', type: 'number' },
  { name: 'classification', type: 'varchar' },
  { name: 'decline_reason', type: 'varchar' },
  { name: 'resolver_type', type: 'varchar' },
  { name: 'skip_reason', type: 'varchar' },
]

export const bidExportColumns: string[] = BID_COLS.map((c) => c.name)

// ============================================================
// Public API
// ============================================================

export interface ExportSummary {
  sightings_exported: number
  bids_exported: number
  errors: string[]
  /** Rows Snowflake refused this run, now set aside rather than retried (#427). */
  set_aside: SetAsideRow[]
  /** What this run's MERGEs cost and how often they were resubmitted (#1443). */
  snowflake_send: SnowflakeSendStats
}

/** A row Snowflake refused on its own merits, set aside so the rest can export (#427). */
export interface SetAsideRow {
  table: string
  id: string
  reason: string
}

/**
 * The most rows one run may set aside before it stops treating them as bad rows
 * and treats them as an outage instead (#427).
 *
 * Setting a row aside is right when the ROW is wrong. When many are refused, the
 * likelier story is that something about the destination is wrong for everyone
 * (a column made NOT NULL, a type changed), and quietly setting aside hundreds of
 * rows would turn an outage into a data gap nobody sees. Each refused row also
 * costs about two statements per halving on the way to finding it, so this also
 * bounds what one run spends looking.
 */
export const SET_ASIDE_MAX_PER_RUN = 20

/** Snowflake's reason is stored with the row, bounded so one huge message cannot bloat it. */
const SET_ASIDE_REASON_MAX_CHARS = 1_000

/**
 * Whether Snowflake refused a statement because of what was IN it, which is the
 * only case splitting the batch can help (#427).
 *
 * 422 is Snowflake's answer for a statement that compiled and then failed on the
 * data (a NULL into a NOT NULL column, a value that does not fit its type), and
 * 400 covers a value that broke the statement itself. Everything else is left
 * alone: a temporary failure is the retry path's business, an auth or permission
 * refusal is the same for every row, and a statement never sent for lack of time
 * was never judged at all.
 */
function isRowRejection(e: unknown): e is SnowflakeStatementError {
  return (
    e instanceof SnowflakeStatementError &&
    (e.status === 400 || e.status === 422) &&
    !isTransientSnowflakeError(e.status, e.message)
  )
}

type ExportRow = Record<string, unknown>

/**
 * MERGEs `rows`, and when Snowflake refuses them for a data reason, halves the
 * set until each refusal is pinned to one row (#427).
 *
 * Halving rather than going row by row because the common case is one bad row in
 * two hundred, which halving finds in about sixteen statements instead of two
 * hundred. Rows that got through are returned for stamping; the refused ones are
 * returned with Snowflake's own words for why.
 */
async function mergeIsolatingRefusals(
  config: SnowflakeConfig,
  tableName: string,
  cols: ColSpec[],
  rows: ExportRow[],
  // This ATTEMPT's view of the allowance: a copy the caller throws away if the
  // attempt is retried, so finding a row twice never spends the run's allowance twice.
  budget: { refusedLeft: number },
  // A row this run already set aside costs nothing to find again.
  alreadySetAside: (id: string) => boolean,
  // The run's send meter (#1443). Omitted by direct callers, which then count nothing.
  meter?: SnowflakeSendMeter,
): Promise<{ shipped: ExportRow[]; refused: Array<{ row: ExportRow; reason: string }> }> {
  try {
    await executeStatement(config, buildMergeSql(tableName, cols, rows), undefined, { meter })
    return { shipped: rows, refused: [] }
  } catch (e) {
    if (!isRowRejection(e)) throw e
    if (rows.length === 1) {
      if (!alreadySetAside(rows[0].id as string)) budget.refusedLeft--
      if (budget.refusedLeft < 0) {
        throw new Error(
          `${tableName}: Snowflake refused more than ${SET_ASIDE_MAX_PER_RUN} rows in one run, so this is treated as ` +
            `an outage rather than bad rows and nothing was set aside. The last refusal: ${formatErr(e)}`,
        )
      }
      return { shipped: [], refused: [{ row: rows[0], reason: e.message.slice(0, SET_ASIDE_REASON_MAX_CHARS) }] }
    }
    const half = Math.ceil(rows.length / 2)
    const left = await mergeIsolatingRefusals(config, tableName, cols, rows.slice(0, half), budget, alreadySetAside, meter)
    const right = await mergeIsolatingRefusals(config, tableName, cols, rows.slice(half), budget, alreadySetAside, meter)
    return { shipped: [...left.shipped, ...right.shipped], refused: [...left.refused, ...right.refused] }
  }
}

/**
 * Pages about rows set aside this run, on a job name of their own (#427).
 *
 * Not folded into the export's failure alert, because the export did NOT fail:
 * every other row reached Snowflake, and an export alert that cleared the moment
 * the next run succeeded would report a row nobody has fixed as recovered. Called
 * with an empty list on a run that set nothing aside, which clears the condition
 * so the next set aside row pages at once instead of waiting out a cooldown.
 */
export async function notifySetAsideRows(
  supabase: SupabaseClient,
  rows: SetAsideRow[],
  kv: Parameters<typeof notifyExportFailure>[3],
): Promise<void> {
  await notifyExportFailure(
    supabase,
    'Lead sightings rows set aside',
    rows.map((r) => `${r.table} ${r.id}: ${r.reason}`),
    kv,
    {
      consequence:
        'Snowflake refused these rows, so they were set aside and every other row exported. They are kept in Supabase ' +
        'and will not be purged, but they are missing from reporting until fixed.',
      fixHint:
        'Correct the value Snowflake names (or the Snowflake column), then set export_rejected_at and ' +
        'export_rejected_reason back to null on the row. The next export sends it again.',
      headlineVerb: 'set rows aside',
      itemNoun: { one: 'row', many: 'rows' },
    },
  )
}

export interface PurgeSummary {
  sightings_purged: number
  bids_purged: number
  errors: string[]
}

// Strand cleanup (formerly the in-Worker sweepStaleInFlightSightings) now runs
// DB-side via pg_cron functions BEFORE this 09:00 export: reduce_finalize_stranded
// (every 30 minutes, plus a deeper 07:45 pass; recoverable strands → real outcome)
// and finalize_unrecoverable_stranded (08:30, the rest →
// reject_reason='strand_unrecoverable'). The Worker version timed out on the
// multi-partition UPDATE and failed silently (#351). That was service_role's 30s
// statement_timeout, NOT an 8s gateway (#614): 8s is the authenticator/authenticated
// limit, and this Worker authenticates with SUPABASE_SECRET_KEY. The pg_cron jobs run
// as postgres with no role-level override, so they get the 120s cluster default. So by
// export time every stale in_flight row is already 'finalized' and picked up below.
export async function runSightingsExport(
  supabase: SupabaseClient,
  env: Env,
  now: () => number = Date.now,
): Promise<ExportSummary> {
  const config = readSnowflakeConfig(env)
  const summary: Omit<ExportSummary, 'snowflake_send'> = {
    sightings_exported: 0,
    bids_exported: 0,
    errors: [],
    set_aside: [],
  }
  // One per run, shared by both phases, so the logged summary says what every
  // MERGE of this run cost and how often one was resubmitted (#1443).
  const sendMeter = new SnowflakeSendMeter()
  // One deadline for both export phases, set once up front, so each stops itself
  // cleanly before Cloudflare's hard ~15min cron kill. The purge is NOT here: it
  // runs in its own cron invocation with its own fresh budget. When they shared
  // this deadline, export growth (the Lead Economy cutover roughly tripled inflow
  // over 2 days) consumed the whole budget and the purge silently deleted nothing.
  const deadline = now() + WALL_TIME_BUDGET_MS
  // One set aside allowance for the whole run, shared by both tables (#427).
  const refusalBudget = { refusedLeft: SET_ASIDE_MAX_PER_RUN }
  const sightingsStop: ExportStop = { reason: null }
  const bidsStop: ExportStop = { reason: null }

  try {
    summary.sightings_exported = await exportTable(
      supabase,
      config,
      'lead_sightings',
      SIGHTING_COLS,
      // Sightings: only finalized, non-test, un-exported
      (q) => q.eq('outcome_state', 'finalized').eq('is_test', false).is('exported_at', null).is('export_rejected_at', null),
      MAX_ROWS_PER_RUN,
      DEFAULT_SLEEP,
      deadline,
      now,
      summary.set_aside,
      refusalBudget,
      sendMeter,
      sightingsStop,
    )
    if (sightingsStop.reason) {
      summary.errors.push(stoppedBehindMessage('sightings', sightingsStop.reason, summary.sightings_exported))
    }
  } catch (e) {
    if (e instanceof PartialExportError) summary.sightings_exported = e.exported
    summary.errors.push(`sightings export: ${formatErr(e)}`)
  }

  try {
    summary.bids_exported = await exportTable(
      supabase,
      config,
      'lead_sighting_bids',
      BID_COLS,
      (q) => q.eq('is_test', false).is('exported_at', null).is('export_rejected_at', null),
      MAX_ROWS_PER_RUN,
      DEFAULT_SLEEP,
      deadline,
      now,
      summary.set_aside,
      refusalBudget,
      sendMeter,
      bidsStop,
    )
    if (bidsStop.reason) {
      summary.errors.push(stoppedBehindMessage('bids', bidsStop.reason, summary.bids_exported))
    }
  } catch (e) {
    if (e instanceof PartialExportError) summary.bids_exported = e.exported
    summary.errors.push(`bids export: ${formatErr(e)}`)
  }

  return { ...summary, snowflake_send: sendMeter.snapshot() }
}

// Deletes rows Snowflake already has. Runs in its OWN cron invocation, on its own
// wall-time budget, precisely so a long export cannot leave it with nothing.
// Nothing here touches Snowflake: a failure means Supabase is carrying rows it
// should have dropped, NOT that analytics are stale.
// The two tables share one Cloudflare invocation's subrequest budget, and this
// runs sightings before bids. On 2026-07-10 the first real run spent the whole
// budget draining an 87K sightings backlog and lead_sighting_bids got zero, so
// the scheduled dispatch scopes each cron to ONE table (see index.ts): a
// separate invocation per table means neither can starve the other of
// subrequests. `tables` defaults to both for direct/manual use.
export async function runSightingsPurge(
  supabase: SupabaseClient,
  now: () => number = Date.now,
  sleep: Sleep = DEFAULT_SLEEP,
  tables: readonly ('lead_sightings' | 'lead_sighting_bids')[] = ['lead_sightings', 'lead_sighting_bids'],
): Promise<PurgeSummary> {
  const summary: PurgeSummary = { sightings_purged: 0, bids_purged: 0, errors: [] }
  const deadline = now() + WALL_TIME_BUDGET_MS

  for (const tableName of tables) {
    const label = tableName === 'lead_sightings' ? 'sightings' : 'bids'
    try {
      const purged = await purgeOldExported(supabase, tableName, MAX_ROWS_PER_RUN, sleep, deadline, now)
      if (tableName === 'lead_sightings') summary.sightings_purged = purged
      else summary.bids_purged = purged
      await assertNothingLeftToPurge(supabase, tableName, purged)
    } catch (e) {
      summary.errors.push(`${label} purge: ${formatErr(e)}`)
    }
  }

  return summary
}

// purgeOldExported returns 0 for two very different runs: "nothing needed
// purging" (healthy) and "could not purge anything" (the wall-time budget or the
// platform subrequest ceiling ended the drain before a delete landed). Both used
// to report `purged: 0, errors: []`, which is how 107,274 purgeable rows sat
// past their retention window for days with every run looking clean (#613).
// Throwing here routes the second case into the caller's existing errors[], which
// notifyExportFailure already alerts on.
async function assertNothingLeftToPurge(
  supabase: SupabaseClient,
  tableName: string,
  purged: number,
): Promise<void> {
  if (purged > 0) return
  if (!(await purgeableBacklogExists(supabase, tableName))) return
  throw new Error(
    'deleted 0 rows while purgeable rows remain (the wall-time budget or the platform subrequest ceiling ended the drain before any delete landed)'
  )
}

// Deliberately an existence probe, not a COUNT: an exact count over a six-figure
// backlog spanning monthly partitions is the same query shape that keeps hitting
// service_role's 30s statement_timeout, so a counting check would fail on exactly
// the bad day it needs to fire. One bounded row answers the only question asked.
async function purgeableBacklogExists(supabase: SupabaseClient, tableName: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(tableName)
    .select('id')
    .not('exported_at', 'is', null)
    .lt('exported_at', purgeCutoff())
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
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

type FilterFn = <
  T extends {
    eq: (k: string, v: unknown) => T
    is: (k: string, v: unknown) => T
    not: (k: string, op: string, v: unknown) => T
  },
>(
  q: T,
) => T
// The predicate that decides which rows a purge may delete. Structural rather than
// generic (as FilterFn is): the generic form makes TS chase the postgrest builder's
// recursive type through the extra range operators and blow the instantiation depth.
interface PurgeQuery {
  eq(k: string, v: unknown): PurgeQuery
  is(k: string, v: unknown): PurgeQuery
  not(k: string, op: string, v: unknown): PurgeQuery
  lt(k: string, v: unknown): PurgeQuery
  limit(n: number): PromiseLike<{ data: unknown; error: unknown }>
}
type PurgeFilter = (q: PurgeQuery) => PurgeQuery
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
  // Soft wall-time deadline (epoch ms); undefined = no deadline (existing
  // direct-call behavior is unchanged). See WALL_TIME_BUDGET_MS.
  deadline?: number,
  now: () => number = Date.now,
  // Rows Snowflake refused and this run set aside are appended here (#427).
  setAside: SetAsideRow[] = [],
  // How many more rows this RUN may set aside. A caller exporting several tables
  // passes one object to every call so the limit covers the run, not each table.
  refusalBudget: { refusedLeft: number } = { refusedLeft: SET_ASIDE_MAX_PER_RUN },
  // The run's send meter (#1443). Omitted by direct callers, which then count nothing.
  meter?: SnowflakeSendMeter,
  // Set when the run stops at a limit with rows still waiting (#749).
  stop: ExportStop = { reason: null },
): Promise<number> {
  const colNames = cols.map((c) => c.name).join(', ')
  const partitionKey = partitionKeyFor(tableName)
  let totalExported = 0
  // The only evidence of rows still waiting at the top of the loop: the batch
  // before came back full. A run stopped before its first look saw nothing.
  let lastBatchFull = false

  // Loop until no more un-exported rows (or we hit the per-run cap / platform limit).
  while (true) {
    const remaining = maxRows - totalExported
    if (remaining <= 0) {
      if (lastBatchFull) stop.reason = 'row_cap'
      break
    }
    if (deadline !== undefined && now() >= deadline) {
      if (lastBatchFull) stop.reason = 'wall_time'
      console.warn(
        `[sightings-export] ${tableName}: hit wall-time budget after ${totalExported} rows; remaining backlog continues next run`
      )
      break
    }
    const batchLimit = Math.min(BATCH_SIZE, remaining)

    try {
      const exportedCount = await withStatementTimeoutRetry(async () => {
        const baseQuery = supabase.from(tableName).select(colNames).limit(batchLimit)
        const { data, error } = await applyFilter(baseQuery)
        if (error) throw error
        if (!data || data.length === 0) return { shipped: 0, selected: 0 }

        const selected = data as unknown as Array<Record<string, unknown>>
        // This closure is re-run whole when a statement times out, so nothing it
        // counts may be counted at the moment a refusal is FOUND: a retry finds the
        // same unmarked row again. The isolation works on a throwaway copy of the
        // allowance, and the run's allowance is spent only below, once per row
        // actually marked (#427).
        const isSetAside = (id: string) => setAside.some((r) => r.table === tableName && r.id === id)
        const { shipped: rows, refused } = await mergeIsolatingRefusals(
          config, tableName, cols, selected, { refusedLeft: refusalBudget.refusedLeft }, isSetAside, meter,
        )

        // Every row refused, and nothing else got through this run: that is the
        // destination refusing everyone (a column made NOT NULL, a type changed),
        // not a bad row, and setting the whole batch aside would turn an outage
        // into a silent gap. Rethrown as the failure it is (#427).
        if (rows.length === 0 && totalExported === 0) {
          throw new SnowflakeStatementError(refused[0].reason, 422, null)
        }

        if (refused.length > 0) {
          const refusedRows = refused.map((r) => r.row)
          const bounds = partitionBounds(refusedRows, partitionKey)
          // One write per row, because each carries its own reason. Bounded by the
          // partition key like every other write here, and required to land: a mark
          // that matched nothing would leave the row to be halved out again every run.
          for (const { row, reason } of refused) {
            const id = row.id as string
            const { error: markErr } = await requireRowsAffected(
              `${tableName}.export_rejected_at (row ${id})`,
              () =>
                supabase
                  .from(tableName)
                  .update({ export_rejected_at: new Date().toISOString(), export_rejected_reason: reason })
                  .in('id', [id])
                  .gte(partitionKey, bounds.min)
                  .lte(partitionKey, bounds.max)
                  .select('id'),
            )
            if (markErr) throw toThrowable(markErr)
            if (isSetAside(id)) continue
            setAside.push({ table: tableName, id, reason })
            refusalBudget.refusedLeft--
            console.warn(`[sightings-export] ${tableName}: set aside row ${id}, which Snowflake refused: ${reason}`)
          }
        }

        if (rows.length === 0) return { shipped: 0, selected: selected.length }

        const ids = rows.map((r) => r.id as string)
        const { min, max } = partitionBounds(rows, partitionKey)
        const stampedAt = new Date().toISOString()

        // .select('id') because PostgREST reports an UPDATE that matched nothing
        // as a plain success. The exported_at stamp is what makes a row purgeable
        // and stops it being re-selected, so a silent no-op means this batch
        // re-exports every run and the table never drains (#583). A PARTIAL match
        // is benign (those rows vanished, or were corrected under us and now owe a
        // re-export); zero matched with rows in hand is a real failure.
        //
        // Each group asserts the correctable value it actually shipped (#483), so a
        // row corrected between the SELECT and this stamp matches nothing, keeps
        // exported_at null, and re-exports next run with the corrected value.
        let markedTotal = 0
        for (const group of stampGroups(rows, tableName)) {
          const asserted = Object.entries(group.assert)
            .map(([c, v]) => ` where ${c}=${String(v)}`)
            .join('')
          const { rows: marked, error: updErr } = await requireRowsAffected(
            `${tableName}.exported_at (${group.ids.length} rows${asserted}; the batch would re-export forever)`,
            () =>
              supabase
                .from(tableName)
                .update({ exported_at: stampedAt })
                .in('id', group.ids)
                .gte(partitionKey, min)
                .lte(partitionKey, max)
                // The values we shipped to Snowflake. Empty for a table with no
                // correctable column, where this adds no filters (#483).
                .match(group.assert)
                .select('id'),
            // A pre-correction group CAN legitimately match zero rows: every row in
            // it was corrected under us. Those rows keep exported_at null, so they
            // re-export and converge on the next run rather than being lost, and
            // sustained non-convergence is exactly what the #613 purge-backlog alarm
            // watches for. Every other group keeps the #583 hard guard, where a zero
            // match means the write itself is broken.
            { onMiss: group.mayMissAll ? 'warn' : 'throw' },
          )
          if (updErr && !group.mayMissAll) throw toThrowable(updErr)
          markedTotal += marked.length
        }

        if (markedTotal < ids.length) {
          console.warn(
            `[sightings-export] ${tableName}: marked ${markedTotal}/${ids.length} exported rows; the rest vanished or were corrected between select and update`
          )
        }

        return { shipped: rows.length, selected: selected.length }
      }, sleep)

      if (exportedCount.selected === 0) break
      totalExported += exportedCount.shipped
      lastBatchFull = exportedCount.selected >= batchLimit
      if (!lastBatchFull) break
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
        // A batch was in hand and never stamped, so rows are still waiting.
        stop.reason = 'subrequest_limit'
        break
      }
      // A batch that permanently times out after exhausting retries is sustained
      // contention on this specific batch, not a broken run -- if earlier batches
      // in this run already exported real rows, keep that progress instead of
      // discarding it and reporting 0. Only propagate (and alert) when nothing
      // exported yet this run, which is a genuinely stuck state worth flagging.
      if (isStatementTimeout(e) && totalExported > 0) {
        console.warn(
          `[sightings-export] ${tableName}: batch permanently hit statement timeout after ${totalExported} rows exported this run; remaining backlog continues next run`
        )
        stop.reason = 'statement_timeout'
        break
      }
      // A real failure, but earlier batches already exported and stamped their
      // rows. Propagate (this still alerts) while carrying the committed count,
      // so the summary reports "400 exported, then failed" rather than "0".
      throw totalExported > 0 ? new PartialExportError(e, totalExported) : e
    }
  }

  return totalExported
}

// Wraps a genuine export failure that happened *after* some rows were already
// exported and stamped. The run is still a failure and still alerts; this only
// stops the committed progress from being reported as zero.
export class PartialExportError extends Error {
  readonly originalError: unknown
  readonly exported: number

  constructor(originalError: unknown, exported: number) {
    super(formatErr(originalError))
    this.name = 'PartialExportError'
    this.originalError = originalError
    this.exported = exported
  }
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

// Production traffic goes through PostgREST. The Worker authenticates with
// SUPABASE_SECRET_KEY, so its statements run as `service_role`, whose
// statement_timeout is 30s (verified 2026-07-10 in pg_db_role_setting; the 8s
// figure this comment used to cite belongs to `authenticated`/`authenticator`,
// which the Worker never uses). A 57014 from the Worker therefore means a
// statement ran past 30 SECONDS -- a far louder signal than a brief lock
// collision, and worth investigating rather than just retrying through.
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
// A statement timeout on these tables means congestion (a pg_cron job, a
// checkpoint, a burst of live-traffic writes), and the observed congestion
// windows last minutes -- the original 250/500ms backoff burned every retry
// inside the same bad window (2026-07-03 incident: all 3 attempts cancelled
// within ~30s of each other, every run). Waits must be long enough to escape
// the window, not just a transient lock.
const STATEMENT_TIMEOUT_RETRY_DELAYS_MS = [5_000, 20_000]

async function withStatementTimeoutRetry<T>(fn: () => Promise<T>, sleep: Sleep): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!isStatementTimeout(e) || attempt >= STATEMENT_TIMEOUT_MAX_ATTEMPTS) throw e
      await sleep(STATEMENT_TIMEOUT_RETRY_DELAYS_MS[attempt - 1])
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
      return `'${escapeSqlLiteral(coerceString(v))}'`
    case 'number':
      return Number.isFinite(Number(v)) ? String(Number(v)) : 'NULL'
    case 'boolean':
      return v === true || v === 'true' || v === 1 || v === '1' ? 'TRUE' : 'FALSE'
    case 'timestamp_tz':
      return `'${escapeSqlLiteral(coerceString(v))}'::TIMESTAMP_TZ`
    case 'timestamp_ntz':
      return `'${escapeSqlLiteral(coerceString(v))}'::TIMESTAMP_NTZ`
    case 'variant':
      return `'${escapeSqlLiteral(JSON.stringify(v))}'`
  }
}

// Rows per purge DELETE. A single unbounded DELETE over a large backlog (2.3M
// rows was observed) could run long enough to be cancelled (57014) under
// service_role's 30s statement_timeout, so the purge deletes bounded pages
// instead: select a page of ids, then delete exactly those ids, bounded by the
// page's partition-key range so Postgres prunes to the partitions in play.
// Kept small so the id list stays within the PostgREST request-URL length limit.
export const PURGE_BATCH = 200

// Rows are purgeable once they have been exported and have aged past the grace
// window. Shared by the drain loop and the zero-row backlog check so the two can
// never disagree about which rows should already be gone.
export function purgeCutoff(nowMs: number = Date.now()): string {
  return new Date(nowMs - PURGE_GRACE_HOURS * 3600 * 1000).toISOString()
}

export async function purgeOldExported(
  supabase: SupabaseClient,
  tableName: string,
  // Per-run backstop so a huge backlog drains over several nights rather than
  // running the worker until it hits the platform subrequest ceiling. Steady
  // state (~a day's exported rows) is far below this.
  maxRows: number = MAX_ROWS_PER_RUN,
  sleep: Sleep = DEFAULT_SLEEP,
  // Soft wall-time deadline (epoch ms); undefined = no deadline (existing
  // direct-call behavior is unchanged). See WALL_TIME_BUDGET_MS.
  deadline?: number,
  now: () => number = Date.now,
): Promise<number> {
  const cutoff = purgeCutoff()
  // Only rows already shipped to Snowflake, and only once past the grace window.
  return purgeBatched(
    supabase,
    tableName,
    (q) => q.not('exported_at', 'is', null).lt('exported_at', cutoff),
    maxRows,
    sleep,
    deadline,
    now,
  )
}

/**
 * The batched drain shared by every purge: page rows out under a filter, DELETE each
 * page bounded by the partition key, and stop cleanly on the wall-time budget, the
 * platform subrequest ceiling, or a permanently-timing-out batch.
 *
 * The filter is the ONLY thing that varies, and it is the whole safety contract: it
 * decides which rows are deletable. Everything else (batching, partition bounding,
 * statement-timeout retry, clean stops) is identical and must not be re-implemented
 * per caller.
 */
export async function purgeBatched(
  supabase: SupabaseClient,
  tableName: string,
  applyFilter: PurgeFilter,
  maxRows: number = MAX_ROWS_PER_RUN,
  sleep: Sleep = DEFAULT_SLEEP,
  deadline?: number,
  now: () => number = Date.now,
): Promise<number> {
  const partitionKey = partitionKeyFor(tableName)
  let purged = 0

  while (purged < maxRows) {
    if (deadline !== undefined && now() >= deadline) {
      console.warn(
        `[sightings-export] ${tableName}: purge hit wall-time budget after purging ${purged} rows; remaining backlog continues next run`
      )
      break
    }
    const batch = Math.min(PURGE_BATCH, maxRows - purged)

    try {
      const purgedCount = await withStatementTimeoutRetry(async () => {
        // The partition key comes back with the page so the DELETE can be bounded
        // by it; selecting `id` alone leaves nothing to prune on.
        const baseQuery = supabase
          .from(tableName)
          .select(`id, ${partitionKey}`) as unknown as PurgeQuery
        const { data, error } = await applyFilter(baseQuery).limit(batch)
        // PurgeQuery types `error` as unknown (it is structural, not the postgrest
        // type), so rethrow it as a real Error. toThrowable keeps `code`, which is what
        // the statement-timeout and subrequest-ceiling checks below read.
        if (error) throw toThrowable(toDbError(error))
        const page = (data ?? []) as unknown as Array<Record<string, unknown>>
        const ids = page.map((r) => r.id as string)
        if (ids.length === 0) return { count: 0, drained: true }
        const { min, max } = partitionBounds(page, partitionKey)

        const { error: delErr, count } = await supabase
          .from(tableName)
          .delete({ count: 'exact' })
          .in('id', ids)
          .gte(partitionKey, min)
          .lte(partitionKey, max)
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
      // Same reasoning as exportTable: a batch that permanently times out after
      // retries shouldn't discard rows already purged earlier in this run.
      if (isStatementTimeout(e) && purged > 0) {
        console.warn(
          `[sightings-export] ${tableName}: purge batch permanently hit statement timeout after purging ${purged} rows this run; remaining backlog continues next run`
        )
        break
      }
      throw e
    }
  }

  return purged
}

