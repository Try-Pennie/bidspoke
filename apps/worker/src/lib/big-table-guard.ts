/**
 * Runtime big-table guard (#222).
 *
 * The static guard (apps/web/.../worker-big-table-pagination.test.ts) only catches
 * PARTITIONED tables. A non-partitioned table that grows past PostgREST's
 * 1,000-row list cap (persons, audit_log both did) isn't caught until a human adds
 * it to BIG_TABLES. This daily check reads live row estimates via the
 * `unpaginated_big_tables` RPC and Slack-alerts any non-partitioned table over the
 * threshold that isn't already known/handled — so it can be paginated + listed
 * before unbounded reads start truncating.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { sendBigTableGrowthAlert } from './slack'

// Tables already known to be big and handled (paginated). This is a verbatim
// mirror of BIG_TABLES in the web static guard
// (apps/web/src/lib/__tests__/worker-big-table-pagination.test.ts) — a sync test
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
  if (await kv.get(sig)) return { offenders: names, alerted: false }

  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('big-table-guard', 'slack connections', connsError)
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendBigTableGrowthAlert(supabase, orgId, offenders)) alerted = true
  }
  if (alerted) await kv.put(sig, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  return { offenders: names, alerted }
}
