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
import { parseJson } from './json'
import { resolveSalesforceCredentialOrg, requireSalesforceCreds } from './salesforce-creds'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { readSubmissionView, type SubmissionRecord, type SubmissionView } from './achieve-enrollment-view'
import { notifyExportFailure } from './export-alerts'

// The Main Flow step whose output carries the trades data (a salesforce node;
// output = { status, body } with the trades response in body).
export const TRADES_STEP_NAMESPACE = 'trades_request'

const BACKFILL_BATCH = 100

/** The enrichment's slice of the invocation. Small on purpose: it is a second lens, and the
 *  export and the purge behind it need the rest. */
export const ENROLLMENT_BUDGET_MS = 90 * 1000

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
  // Geoff's Equifax figures from Salesforce: the ENROLLMENT view, stored beside ours rather
  // than instead of them. The two count different sets of accounts and answer different
  // questions (#1350).
  { name: 'enrollment_view', type: 'variant' },
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
  credit_metrics VARIANT,
  enrollment_view VARIANT
)
`.trim()

export interface AchieveExportSummary {
  trades_backfilled: number
  enrollment_view_filled: number
  /** Rows left unfilled because the enrichment ran out of time. They export and purge without
   *  it, so a persistently non-zero number means the budget no longer covers the volume. Null
   *  when the enrichment failed before it could count, which is not the same as none (#1363). */
  enrollment_view_skipped: number | null
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

/**
 * Fills `enrollment_view` from the Salesforce Submission record each evaluation names.
 *
 * Read here rather than at send time: the values live durably in Salesforce keyed by an id
 * every row already carries, nothing needs them in real time, and doing it here keeps
 * Salesforce off the live lead path entirely. It also means the column can be filled for rows
 * already collected, which a send-time read could never do.
 */
export async function backfillEnrollmentView(
  supabase: SupabaseClient,
  env: Env,
  // Its own slice of the invocation, not the whole of it. This job shares its wall clock with
  // the export and the purge behind it, and that budget has already been eaten once by work
  // added to it, after which the purge silently deleted nothing. Salesforce round trips are
  // exactly that kind of work, so this stops itself rather than being stopped by the platform.
  deadline: number = Date.now() + ENROLLMENT_BUDGET_MS,
  now: () => number = Date.now,
): Promise<{ filled: number; skipped: number }> {
  const { orgId, error: orgError } = await resolveSalesforceCredentialOrg(supabase)
  if (!orgId) throw new Error(orgError ?? 'no organization holds Salesforce credentials')

  const { instanceUrl, clientId, clientSecret } = await requireSalesforceCreds(
    env,
    supabase,
    orgId,
    'the Achieve enrollment view',
  )
  const token = await getSalesforceToken(env, orgId, instanceUrl, clientId, clientSecret)

  const query = async (soql: string): Promise<SubmissionRecord[]> => {
    const res = await fetch(`${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new Error(`Salesforce query failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    const body = await parseJson<{ records?: SubmissionRecord[] }>(res)
    return body.records ?? []
  }

  // Keyset cursor (#1599): the last id this run has already tried. A row left unfilled (no
  // submission id, or Salesforce had nothing for it) still matches the unfilled filter, so
  // without the cursor every loop re-selected the same first page. With 100 or more such rows
  // at the front, the run re-asked Salesforce about them until the budget ran out and never
  // reached the fillable rows behind them. Ordering by id and starting after the cursor tries
  // each row at most once per run.
  const cursor: { after: string | null } = { after: null }

  let total = 0
  let skipped = 0
  while (true) {
    if (now() >= deadline) {
      // Counted rather than shrugged off: a row not filled here is exported and purged
      // without the enrichment and never gets another chance, so the shortfall has to be
      // visible instead of looking like there was nothing to do. Only rows past the cursor
      // count: those before it were tried this run and are not a budget shortfall.
      const counted = supabase
        .from('achieve_evaluations')
        .select('id', { count: 'exact', head: true })
        .eq('is_test', false)
        .is('exported_at', null)
        .is('enrollment_view', null)
      const { count, error: countError } = await (cursor.after === null ? counted : counted.gt('id', cursor.after))
      if (countError) throw countError
      skipped = count ?? 0
      break
    }
    const page = supabase
      .from('achieve_evaluations')
      .select('id, requested_at_utc, request_payload')
      .eq('is_test', false)
      .is('exported_at', null)
      .is('enrollment_view', null)
      .order('id')
      .limit(BACKFILL_BATCH)
    const { data: rows, error } = await (cursor.after === null ? page : page.gt('id', cursor.after))
    if (error) throw error
    if (!rows || rows.length === 0) break
    cursor.after = String(rows[rows.length - 1].id)

    // requested_at_utc is the partition key, carried alongside so the update below can name
    // it. Matching id alone scans every monthly partition, including drained ones that still
    // carry their bloat.
    const byId = new Map<string, { submissionId: string; requestedAt: string }>()
    for (const row of rows) {
      const submissionId = (row.request_payload as { partner_lead_id?: unknown } | null)?.partner_lead_id
      if (typeof submissionId === 'string' && submissionId) {
        byId.set(String(row.id), { submissionId, requestedAt: String(row.requested_at_utc) })
      }
    }
    // A page with nothing to look up is passed over, not a reason to stop: the cursor has
    // moved past it, and fillable rows may sit behind it.
    const views =
      byId.size === 0
        ? new Map<string, SubmissionView>()
        : await readSubmissionView([...new Set([...byId.values()].map((v) => v.submissionId))], query)

    for (const [rowId, { submissionId, requestedAt }] of byId) {
      const view = views.get(submissionId)
      if (!view) continue
      // Counted by rows actually touched, never by the attempt: supabase-js reports a
      // zero-row UPDATE as a success with error null, so a row purged between the select and
      // the update would otherwise be counted as filled.
      const { rows: touched, error: updateError } = await requireRowsAffected(
        'achieve_evaluations.enrollment_view',
        () =>
          supabase
            .from('achieve_evaluations')
            .update({ enrollment_view: view })
            .eq('id', rowId)
            .eq('requested_at_utc', requestedAt)
            .select('id'),
      )
      if (updateError && !isNoRowMatchedError(updateError)) throw toThrowable(updateError)
      total += touched.length
    }

    if (rows.length < BACKFILL_BATCH) break
  }
  return { filled: total, skipped }
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

/** The alert's own job name, so its reminder schedule is separate from the export's. */
export const ENROLLMENT_SKIPPED_JOB = 'Achieve enrollment view'

/**
 * Pages when the enrollment view ran out of time with rows still unfilled (#1363).
 *
 * Its own alert rather than an entry in the export's errors, because the export did NOT fail:
 * every row still went to Snowflake, only without this column. It matters anyway because the
 * loss is permanent. The enrichment selects rows not yet exported, so once a row is exported it
 * is never filled, and Supabase purges it 24 hours later.
 *
 * Called after every run that measured the shortfall, including a run with none, because the
 * empty report is what clears the standing condition. A run that did NOT measure it (the
 * enrichment threw, which pages through the export alert already) reports nothing, so an
 * unmeasured run cannot read as a healed one.
 */
export async function notifyEnrollmentViewSkipped(
  supabase: SupabaseClient,
  skipped: number | null,
  kv: Parameters<typeof notifyExportFailure>[3],
): Promise<void> {
  if (skipped === null) return
  const items =
    skipped > 0
      ? [`${skipped} ${skipped === 1 ? 'row' : 'rows'} still had no enrollment view when the ${ENROLLMENT_BUDGET_MS / 1000} second budget ran out`]
      : []
  await notifyExportFailure(supabase, ENROLLMENT_SKIPPED_JOB, items, kv, {
    consequence:
      'The export does not wait for this enrichment, so these rows went to Snowflake with enrollment_view empty. ' +
      'An exported row is never selected for it again, and Supabase purges it 24 hours later, so the view is lost for them.',
    fixHint:
      'Once is a slow Salesforce day. If it repeats, check Salesforce API latency, then raise ENROLLMENT_BUDGET_MS ' +
      'in apps/worker/src/lib/achieve-export.ts, which is shared with the export and purge in the same run.',
    headlineVerb: 'ran out of time',
    itemNoun: { one: 'shortfall', many: 'shortfalls' },
  })
}

export async function runAchieveExport(supabase: SupabaseClient, env: Env): Promise<AchieveExportSummary> {
  const config: SnowflakeConfig = readSnowflakeConfig(env)
  const summary: AchieveExportSummary = {
    trades_backfilled: 0,
    enrollment_view_filled: 0,
    enrollment_view_skipped: 0,
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

  // Best effort, and deliberately NOT gating the export the way the trades backfill does. This
  // is a second lens on the same lead rather than the analysis payload, so a Salesforce outage
  // must not hold up rows that are otherwise complete. A failure leaves the column null and
  // says why in summary.errors, which notifyExportFailure already surfaces.
  try {
    const enrollment = await backfillEnrollmentView(supabase, env)
    summary.enrollment_view_filled = enrollment.filled
    summary.enrollment_view_skipped = enrollment.skipped
  } catch (e) {
    summary.enrollment_view_skipped = null
    summary.errors.push(`enrollment view backfill: ${formatErr(e)}`)
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

