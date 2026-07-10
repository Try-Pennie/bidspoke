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
import { executeStatement, escapeSqlLiteral, type SnowflakeConfig } from './snowflake'
import { requireRowsAffected, toThrowable } from './db-retry'
import { formatErr } from './format-error'

const BATCH_SIZE = 200            // rows per Snowflake MERGE
const PURGE_GRACE_HOURS = 24      // delete from Supabase only after this many hours since export
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
export const WALL_TIME_BUDGET_MS = 12 * 60 * 1000

// Column names + Snowflake types for value formatting. 'variant' carries JSON:
// the value travels as an escaped string in the VALUES list (Snowflake VALUES
// only allows constants) and the USING projection wraps it in PARSE_JSON.
export type ColType = 'varchar' | 'number' | 'boolean' | 'timestamp_tz' | 'timestamp_ntz' | 'variant'

export interface ColSpec {
  name: string
  type: ColType
}

// Both tables are partitioned monthly on a timestamp, and `id` is not the
// partition key. A write keyed on id alone cannot be pruned, so Postgres fans it
// out to every partition -- including drained ones that still carry their bloat.
// Bounding each write by the key range of the rows already in hand collapses the
// fan-out to the one or two partitions the batch actually spans. The key map is
// the canonical registry (also read by the partition-key write guard, #619).
// Re-exported so existing importers of partitionKeyFor from this module still work.
export { partitionKeyFor }

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
  errors: string[]
}

export interface PurgeSummary {
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
export async function runSightingsExport(
  supabase: SupabaseClient,
  env: Env,
  now: () => number = Date.now,
): Promise<ExportSummary> {
  const config = readSnowflakeConfig(env)
  const summary: ExportSummary = {
    sightings_exported: 0,
    bids_exported: 0,
    errors: [],
  }
  // One deadline for both export phases, set once up front, so each stops itself
  // cleanly before Cloudflare's hard ~15min cron kill. The purge is NOT here: it
  // runs in its own cron invocation with its own fresh budget. When they shared
  // this deadline, export growth (the Lead Economy cutover roughly tripled inflow
  // over 2 days) consumed the whole budget and the purge silently deleted nothing.
  const deadline = now() + WALL_TIME_BUDGET_MS

  try {
    summary.sightings_exported = await exportTable(
      supabase,
      config,
      'lead_sightings',
      SIGHTING_COLS,
      // Sightings: only finalized, non-test, un-exported
      (q) => q.eq('outcome_state', 'finalized').eq('is_test', false).is('exported_at', null),
      MAX_ROWS_PER_RUN,
      DEFAULT_SLEEP,
      deadline,
      now,
    )
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
      (q) => q.eq('is_test', false).is('exported_at', null),
      MAX_ROWS_PER_RUN,
      DEFAULT_SLEEP,
      deadline,
      now,
    )
  } catch (e) {
    if (e instanceof PartialExportError) summary.bids_exported = e.exported
    summary.errors.push(`bids export: ${formatErr(e)}`)
  }

  return summary
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
): Promise<number> {
  const colNames = cols.map((c) => c.name).join(', ')
  const partitionKey = partitionKeyFor(tableName)
  let totalExported = 0

  // Loop until no more un-exported rows (or we hit the per-run cap / platform limit).
  while (true) {
    const remaining = maxRows - totalExported
    if (remaining <= 0) break
    if (deadline !== undefined && now() >= deadline) {
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
        if (!data || data.length === 0) return 0

        const rows = data as unknown as Array<Record<string, unknown>>
        const sql = buildMergeSql(tableName, cols, rows)
        await executeStatement(config, sql)

        const ids = rows.map((r) => r.id as string)
        const { min, max } = partitionBounds(rows, partitionKey)
        // .select('id') because PostgREST reports an UPDATE that matched nothing
        // as a plain success. The exported_at stamp is what makes a row purgeable
        // and stops it being re-selected, so a silent no-op means this batch
        // re-exports every run and the table never drains (#583). A PARTIAL match
        // is benign (those rows vanished, so they cannot be re-selected); zero
        // matched with rows in hand is a real failure.
        // onMiss 'throw': a batch whose exported_at never lands re-exports forever.
        const { rows: marked, error: updErr } = await requireRowsAffected(
          `${tableName}.exported_at (${ids.length} rows; the batch would re-export forever)`,
          () =>
            supabase
              .from(tableName)
              .update({ exported_at: new Date().toISOString() })
              .in('id', ids)
              .gte(partitionKey, min)
              .lte(partitionKey, max)
              .select('id'),
          { onMiss: 'throw' },
        )
        if (updErr) throw toThrowable(updErr)
        if (marked.length < ids.length) {
          console.warn(
            `[sightings-export] ${tableName}: marked ${marked.length}/${ids.length} exported rows; the rest vanished between select and update`
          )
        }

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
      // A batch that permanently times out after exhausting retries is sustained
      // contention on this specific batch, not a broken run -- if earlier batches
      // in this run already exported real rows, keep that progress instead of
      // discarding it and reporting 0. Only propagate (and alert) when nothing
      // exported yet this run, which is a genuinely stuck state worth flagging.
      if (isStatementTimeout(e) && totalExported > 0) {
        console.warn(
          `[sightings-export] ${tableName}: batch permanently hit statement timeout after ${totalExported} rows exported this run; remaining backlog continues next run`
        )
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
        const { data, error } = await supabase
          .from(tableName)
          .select(`id, ${partitionKey}`)
          .not('exported_at', 'is', null)
          .lt('exported_at', cutoff)
          .limit(batch)
        if (error) throw error
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

