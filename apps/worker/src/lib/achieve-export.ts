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
import { exportTable, purgeOldExported, readSnowflakeConfig, type ColSpec } from './sightings-export'
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
  trades VARIANT
)
`.trim()

export interface AchieveExportSummary {
  trades_backfilled: number
  evaluations_exported: number
  evaluations_purged: number
  errors: string[]
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

    const updates = matchTradesToEvaluations(evals, (steps ?? []) as Array<{ execution_id: string; output: unknown }>)
    for (const u of updates) {
      // .select('id') because a zero-row UPDATE is reported as a success. The row
      // can legitimately vanish (purged between select and update), which is not
      // an error, but it is also not a backfill and must not be counted (#583).
      const { rows, error: updErr } = await requireRowsAffected(
        'achieve_evaluations.trades_backfill',
        () => supabase.from('achieve_evaluations').update({ trades: u.trades }).eq('id', u.id).select('id'),
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
    summary.evaluations_exported = await exportTable(
      supabase,
      config,
      'achieve_evaluations',
      ACHIEVE_COLS,
      (q) => {
        const base = q.eq('is_test', false).is('exported_at', null)
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

  return summary
}

