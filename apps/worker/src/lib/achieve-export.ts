// Nightly export of achieve_evaluations to Snowflake, with the execution's
// trades data joined in at export time (issue #28).
//
// Geoff's Achieve/FDR analysis wants offer outcomes joined against trades
// data, but trades step payloads live in execution_steps, whose rows age out
// on the ~7-day partition retention — a query-time join has a short shelf
// life. So the join happens HERE, while the rows are at most ~1 day old: each
// un-exported evaluation gets its execution's trades_request step output
// written to achieve_evaluations.trades, and the combined row is MERGEd to
// Snowflake where it lives permanently. Full payloads ship as VARIANTs so the
// analysis can pick fields in Snowflake without re-exporting.
//
// Runs on the same 09:00 UTC schedule as the sightings export and reuses its
// chassis (batched MERGE, exported_at marking, purge-after-grace).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { executeStatement, type SnowflakeConfig } from './snowflake'
import {
  exportTable,
  purgeOldExported,
  purgeBatched,
  readSnowflakeConfig,
  reconcileColumns,
  type ColSpec,
} from './sightings-export'
import { isNoRowMatchedError, requireRowsAffected, toThrowable } from './db-retry'
import { formatErr } from './format-error'

// The Main Flow step whose output carries the trades data (a salesforce node;
// output = { status, body } with the trades response in body).
export const TRADES_STEP_NAMESPACE = 'trades_request'

const BACKFILL_BATCH = 100

export const ACHIEVE_COLS: ColSpec[] = [
  { name: 'id', type: 'varchar' },
  { name: 'trace_id', type: 'varchar' },
  { name: 'execution_id', type: 'varchar' },
  { name: 'workflow_id', type: 'varchar' },
  { name: 'node_namespace', type: 'varchar' },
  { name: 'submission_id', type: 'varchar' },
  { name: 'requested_at_utc', type: 'timestamp_ntz' },
  { name: 'duration_ms', type: 'number' },
  { name: 'http_status', type: 'number' },
  { name: 'response_status', type: 'varchar' },
  { name: 'response_reason', type: 'varchar' },
  { name: 'offer_count', type: 'number' },
  { name: 'request_payload', type: 'variant' },
  { name: 'response_body', type: 'variant' },
  { name: 'offers', type: 'variant' },
  { name: 'trades', type: 'variant' },
  // Achieve's own request id and the Cloudflare ray from the proxy in front of them, both
  // stamped on every response. Their decline responses carry no detail beyond one sentence,
  // so the request id is what lets support find a specific call (#1310 follow-up).
  { name: 'achieve_request_id', type: 'varchar' },
  { name: 'cf_ray', type: 'varchar' },
  // The credit figures behind their decline reasons, derived at send time. The reconcile
  // above adds this column to Snowflake by itself, so no DDL is run by hand for it.
  { name: 'credit_metrics', type: 'variant' },
]

// Self-creating so there is no manual Snowflake step to forget. Idempotent;
// runs once per export. Types mirror ACHIEVE_COLS.
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS achieve_evaluations (
  id VARCHAR PRIMARY KEY,
  trace_id VARCHAR,
  execution_id VARCHAR,
  workflow_id VARCHAR,
  node_namespace VARCHAR,
  submission_id VARCHAR,
  requested_at_utc TIMESTAMP_NTZ,
  duration_ms NUMBER,
  http_status NUMBER,
  response_status VARCHAR,
  response_reason VARCHAR,
  offer_count NUMBER,
  request_payload VARIANT,
  response_body VARIANT,
  offers VARIANT,
  trades VARIANT,
  achieve_request_id VARCHAR,
  cf_ray VARCHAR,
  credit_metrics VARIANT
)
`.trim()

export interface AchieveExportSummary {
  trades_backfilled: number
  evaluations_exported: number
  evaluations_purged: number
  sandbox_purged: number
  errors: string[]
}

// Sandbox rows are never exported (see the export filter below), so the normal purge,
// which only deletes rows whose exported_at is set, can never reach them: they would
// accumulate forever (#644). They get their own retention instead.
//
// A week, not the 24h grace the exported rows get, because purging a sandbox row is
// PERMANENT: Snowflake never received a copy. A week is long enough to debug a sandbox
// validation session and short enough to bound the table if the node sits pointed at
// Achieve's sandbox for weeks waiting on production credentials.
const SANDBOX_RETENTION_HOURS = 7 * 24

/**
 * Reclaim sandbox evaluations past their retention window.
 *
 * The filter is the safety contract. An unexported PRODUCTION row looks superficially
 * similar (exported_at IS NULL) but is merely pending export, and deleting one would
 * lose it for good. So this keys on `is_sandbox`, never on the absence of an export
 * stamp. The cutoff is on `requested_at_utc`, which is also the partition key, so the
 * scan prunes to the partitions it actually touches.
 */
export async function purgeSandboxEvaluations(
  supabase: SupabaseClient,
  maxRows?: number,
  sleep?: (ms: number) => Promise<void>,
  deadline?: number,
  now: () => number = Date.now,
): Promise<number> {
  const cutoff = new Date(now() - SANDBOX_RETENTION_HOURS * 60 * 60 * 1000).toISOString()
  return purgeBatched(
    supabase,
    'achieve_evaluations',
    (q) => q.eq('is_sandbox', true).lt('requested_at_utc', cutoff),
    maxRows,
    sleep,
    deadline,
    now,
  )
}

/**
 * Pure mapping: which evaluation rows get which trades output. Exported for
 * tests. Rows whose execution has no trades step stay untouched (null trades
 * still exports — an evaluation without trades is data, not an error).
 */
export function matchTradesToEvaluations(
  evals: Array<{ id: string; execution_id: string }>,
  steps: Array<{ execution_id: string; output: unknown }>
): Array<{ id: string; trades: unknown }> {
  const byExecution = new Map(steps.map((s) => [s.execution_id, s.output]))
  return evals
    .filter((e) => byExecution.has(e.execution_id))
    .map((e) => ({ id: e.id, trades: byExecution.get(e.execution_id) }))
}

async function backfillTrades(supabase: SupabaseClient): Promise<number> {
  let total = 0
  while (true) {
    const { data: evals, error } = await supabase
      .from('achieve_evaluations')
      .select('id, execution_id, requested_at_utc')
      .eq('is_test', false)
      .is('exported_at', null)
      .is('trades', null)
      .limit(BACKFILL_BATCH)
    if (error) throw error
    if (!evals || evals.length === 0) break

    // Bound started_at for partition pruning on execution_steps: the trades
    // step starts shortly before the achieve step in the same execution, so
    // an hour of slack before the oldest evaluation covers it.
    const oldest = evals.reduce(
      (min, e) => (String(e.requested_at_utc) < min ? String(e.requested_at_utc) : min),
      String(evals[0].requested_at_utc)
    )
    const sinceBound = new Date(new Date(oldest).getTime() - 60 * 60 * 1000).toISOString()

    // paginate-ok: bounded to one BACKFILL_BATCH (100) of execution_ids, and
    // each execution has a single trades_request step — at most ~100 rows.
    const { data: steps, error: stepsErr } = await supabase
      .from('execution_steps')
      .select('execution_id, output')
      .in('execution_id', evals.map((e) => e.execution_id))
      .eq('step_namespace', TRADES_STEP_NAMESPACE)
      .gte('started_at', sinceBound)
    if (stepsErr) throw stepsErr

    // requested_at_utc is the partition key. Matching id alone scans every
    // monthly partition to update one row (#589); pairing id with the row's own
    // requested_at_utc prunes to the single owning partition, the way
    // lead_sightings.finalize matches its exact partition-key value.
    const requestedById = new Map(evals.map((e) => [e.id, String(e.requested_at_utc)]))

    const updates = matchTradesToEvaluations(evals, (steps ?? []) as Array<{ execution_id: string; output: unknown }>)
    for (const u of updates) {
      // .select('id') because a zero-row UPDATE is reported as a success. The row
      // can legitimately vanish (purged between select and update), which is not
      // an error, but it is also not a backfill and must not be counted (#583).
      const { rows, error: updErr } = await requireRowsAffected(
        'achieve_evaluations.trades_backfill',
        () =>
          supabase
            .from('achieve_evaluations')
            .update({ trades: u.trades })
            .eq('id', u.id)
            .eq('requested_at_utc', requestedById.get(u.id)!)
            .select('id'),
        { onMiss: 'warn', context: { id: u.id } },
      )
      if (updErr && !isNoRowMatchedError(updErr)) throw toThrowable(updErr)
      if (rows.length === 0) continue
      total++
    }

    // Rows with no trades step would re-match forever; the loop is bounded by
    // the un-exported set, which the export below drains, so a partial batch
    // means we are done for this run.
    if (evals.length < BACKFILL_BATCH) break
    if (updates.length === 0) break
  }
  return total
}

export async function runAchieveExport(supabase: SupabaseClient, env: Env): Promise<AchieveExportSummary> {
  const config: SnowflakeConfig = readSnowflakeConfig(env)
  const summary: AchieveExportSummary = {
    trades_backfilled: 0,
    evaluations_exported: 0,
    evaluations_purged: 0,
    sandbox_purged: 0,
    errors: [],
  }

  let backfillOk = true
  try {
    summary.trades_backfilled = await backfillTrades(supabase)
  } catch (e) {
    // Trades are an enrichment, so a failed backfill must not block the export
    // of rows that already carry trades. But it does gate trades-null rows: see
    // the export filter below (#484).
    backfillOk = false
    summary.errors.push(`trades backfill: ${formatErr(e)}`)
  }

  try {
    await executeStatement(config, CREATE_TABLE_SQL)
    // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so the DDL
    // above cannot deliver a newly added column to the live table. Without this, adding one
    // to ACHIEVE_COLS makes every subsequent run write a statement naming a column
    // Snowflake does not have (#428). Runs before the export rather than after, so a column
    // that cannot be added stops the run instead of failing it halfway through writing.
    const added = await reconcileColumns(config, 'achieve_evaluations', ACHIEVE_COLS)
    if (added.length > 0) console.log(`[achieve-export] added Snowflake columns: ${added.join(', ')}`)
    summary.evaluations_exported = await exportTable(
      supabase,
      config,
      'achieve_evaluations',
      ACHIEVE_COLS,
      (q) => {
        // is_sandbox: the request carried Achieve's seeded showroom identity, so the offers
        // and the accept/decline on that row describe a FAKE person. Exporting them would put
        // fabricated offer amounts and APRs alongside real ones in Snowflake with nothing to
        // tell them apart. The lead volume in those rows is real, but it stays queryable in
        // Supabase; only the fake offer signal is withheld.
        const base = q.eq('is_test', false).eq('is_sandbox', false).is('exported_at', null)
        // When the backfill failed this run, a trades-null row is ambiguous: it
        // could be legitimately trades-less, or a row we simply failed to
        // enrich. Exporting it stamps exported_at, which permanently hides it
        // from the next backfill (it filters exported_at IS NULL) and purges the
        // source ~24h later -- the trades would be lost for good. So defer every
        // trades-null row until a run whose backfill succeeded. Rows that
        // already have trades still export. The failure alerts via summary.errors
        // (notifyExportFailure), so a persistently-failing backfill is visible.
        return backfillOk ? base : base.not('trades', 'is', null)
      },
    )
  } catch (e) {
    summary.errors.push(`evaluations export: ${formatErr(e)}`)
  }

  try {
    summary.evaluations_purged = await purgeOldExported(supabase, 'achieve_evaluations')
  } catch (e) {
    summary.errors.push(`evaluations purge: ${formatErr(e)}`)
  }

  // Sandbox rows never export, so the purge above can never reach them (#644).
  try {
    summary.sandbox_purged = await purgeSandboxEvaluations(supabase)
  } catch (e) {
    summary.errors.push(`sandbox purge: ${formatErr(e)}`)
  }

  return summary
}

