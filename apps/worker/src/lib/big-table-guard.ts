/**
 * Runtime big-table guard (#222).
 *
 * The static guard (apps/web/.../worker-big-table-pagination.test.ts) makes every
 * table a migration creates declare its size: in BIG_TABLES, or in SMALL_TABLES
 * with a row count (#962). A declaration is a forecast, though, and a table
 * declared small can still outgrow it (persons and audit_log both grew past
 * PostgREST's 1,000-row list cap before either list existed). This daily check
 * reads live row counts via the `unpaginated_big_tables` RPC and Slack-alerts any
 * non-partitioned table over the threshold that is not already known and
 * handled, so it can be paginated and listed before unbounded reads start
 * truncating.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { rateLimitedOrgAlert } from './alert-fanout'
import { sendBigTableGrowthAlert } from './slack'

// Tables already known to be big and handled (paginated). This is a verbatim
// mirror of BIG_TABLES in the web static guard
// (apps/web/src/lib/__guards__/worker/worker-big-table-pagination.test.ts); a sync test
// there fails the build if the two drift. Including the partitioned entries is
// harmless: the unpaginated_big_tables RPC already excludes partitioned
// parents/children, so they never appear in its output anyway. Listing the FULL
// set (not just the non-partitioned entries) is what makes the sync test trivial
// and prevents the drift that would otherwise false-alert on a handled table
// like sf_bid_matrix_audit.
export const KNOWN_BIG_TABLES = new Set([
  'execution_steps',
  'workflow_executions',
  'lead_sightings',
  'lead_sighting_bids',
  'bid_matrix_rows',
  'sf_bid_matrix_audit',
  'persons',
  'achieve_evaluations',
  'audit_log',
  'field_presence_daily',
  'workflow_stats_daily',
  'execution_archive_ids',
  // The per-hour ledger of the execution archive, 24 rows a day and never pruned
  // (#1191). Its reads are bounded by a date window or by the 24 hours of one
  // day, not by a page. No apostrophes in this comment: the mirror test in
  // apps/web reads every quoted string inside this literal as a table name.
  'execution_archive_hours',
  // One row per run of every job that takes the archive lock, about 1,166 rows by
  // 2026-09-22 and never pruned (#1438).
  'job_runs',
  // One row per buyer sale, about 825 in the first day of Stage A and never
  // pruned; the daily growth check flagged it on 2026-09-24.
  'buyer_sales',
  // Every saved version of every workflow, never pruned: 548 rows on 2026-09-30,
  // when the daily growth check flagged it.
  'workflow_versions',
  // One row per cron delivery, about 1,900 a day kept 7 days (#2284); the daily
  // growth check flagged it on 2026-10-18 (#2390).
  'cron_tick_deliveries',
  // One row per day or partition each purge run decides on, never pruned: 233
  // rows on 2026-10-18 and about 5 more a day (#962).
  'purge_run_log',
])

// Alert below the 1,000-row cap so there's lead time to paginate before reads
// actually start truncating.
export const BIG_TABLE_ROW_THRESHOLD = 500

export interface TableEstimate {
  table_name: string
  est_rows: number
}

/** Drop tables already known/handled, leaving only unexpected growers. */
export function filterUnhandledBigTables(rows: TableEstimate[]): TableEstimate[] {
  return rows.filter((r) => !KNOWN_BIG_TABLES.has(r.table_name))
}

const COOLDOWN_PREFIX = 'bigtbl:alerted:'
const COOLDOWN_TTL_SECONDS = 7 * 24 * 60 * 60

export async function runBigTableGuard(
  supabase: SupabaseClient,
  kv: KVNamespace,
): Promise<{ offenders: string[]; alerted: boolean }> {
  const { data, error } = await supabase.rpc('unpaginated_big_tables', { p_min_rows: BIG_TABLE_ROW_THRESHOLD })
  if (error) throw new Error(`unpaginated_big_tables rpc failed: ${error.message}`)

  const offenders = filterUnhandledBigTables((data ?? []) as TableEstimate[])
  if (offenders.length === 0) return { offenders: [], alerted: false }

  const names = offenders.map((o) => o.table_name).sort()
  // Dedup by the offending set: re-alert only when the set changes or after the
  // cooldown, so a slow-to-fix table doesn't page every single day.
  const sig = COOLDOWN_PREFIX + names.join(',')
  const alerted = await rateLimitedOrgAlert({
    kv,
    cooldownKey: sig,
    ttlSeconds: COOLDOWN_TTL_SECONDS,
    supabase,
    logLabel: 'big-table-guard',
    // The finding is measured before the list is read (#1303).
    use: 'tell-only',
    perOrg: (orgId) => sendBigTableGrowthAlert(supabase, orgId, offenders),
  })
  return { offenders: names, alerted }
}
