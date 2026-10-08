import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepStatus, ErrorType, StepLogEntry as StepLogLine } from '../types'
import { redactPii, parsePiiFields, redactPiiInLogMessage } from './pii-redactor'
import {
  isPermanentDbError,
  isDuplicateError,
  isNoRowMatchedError,
  requireRowsAffected,
  withDbRetry,
  normalizeDbError,
  NO_ROW_MATCHED_CODE,
  DB_WRITE_RETRY_DELAYS_MS,
  type DbError,
} from '../lib/db-retry'
import { waitToRetry, type RetryTiming } from '../lib/post-response-budget'

// Re-export so existing importers of these from step-logger keep working; the
// definitions now live in lib/db-retry (single source of truth, shared with the
// lead-sightings writes — see #237).
export { isPermanentDbError, NO_ROW_MATCHED_CODE, type DbError }

export interface StepLogEntry {
  execution_id: string
  execution_started_at: string
  step_namespace: string
  step_node_id?: string
  step_type: string
  step_subtype?: string
  status: StepStatus
  input: unknown
  output: unknown
  logs?: StepLogLine[]
  error_message?: string
  error_type?: ErrorType
  retries_used: number
  started_at: string
  completed_at: string
  duration_ms: number
  step_order: number
  parallel_group_id?: string
}

// --- Shared insert/update plumbing for the execution-log hot path ----------
//
// These two tables (workflow_executions, execution_steps) persist via PostgREST.
// The nightly partition-purge cron runs DDL on them, which forces a PostgREST
// schema-cache reload that 503s inserts for a few seconds ("Could not query the
// database for the schema cache."). The defense is a retry ladder long enough to
// outlast the lock/reload window (see the *_RETRY_DELAYS_MS below). A direct-
// Postgres (Hyperdrive) fast path used to front this; it was retired once the
// purge moved to TRUNCATE (no schema reload) — see ADR notes / #363.

// One insert attempt. Returns a normalized DbError so both call sites share
// retry logic.
async function insertRowsOnce(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[]
): Promise<{ error: DbError | null }> {
  // Shares one normalizer with requireRowsAffected so an empty-bodied failure
  // reports its HTTP status here too, rather than an empty message (#1111).
  return { error: normalizeDbError(await supabase.from(table).insert(rows)) }
}

// One update attempt for workflow_executions, keyed by (id, started_at) with an
// id-only fallback for the partition-pruning case. Both statements return the
// matched ids: an UPDATE that touches nothing is a missing row, not a success.
async function updateExecutionOnce(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: Record<string, unknown>
): Promise<{ error: DbError | null }> {
  // Use started_at for partition pruning. A zero-row match here is NOT yet a
  // missing row, so onMiss stays silent and we fall through to the id-only
  // statement below.
  const first = await updateExecutionInPartitionOnce(supabase, id, started_at, update)
  if (first.error && !isNoRowMatchedError(first.error)) return { error: first.error }
  if (first.rows.length) return { error: null }

  // An UPDATE without the partition key still scans every partition, so zero
  // rows here means the row genuinely does not exist anywhere.
  const second = await requireRowsAffected(missingRowTarget(id), () =>
    supabase.from('workflow_executions').update(update).eq('id', id).select('id')
  )
  return { error: second.error }
}

function missingRowTarget(id: string): string {
  return `workflow_executions (id=${id}): the execution record is missing`
}

// The partition-keyed statement on its own: (id, started_at) is the primary key,
// so it prunes to the one partition that can hold the row. Returns the matched
// ids, and a zero-row match comes back as NO_ROW_MATCHED rather than success.
function updateExecutionInPartitionOnce(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: Record<string, unknown>
): Promise<{ rows: unknown[]; error: DbError | null }> {
  return requireRowsAffected(missingRowTarget(id), () =>
    supabase.from('workflow_executions').update(update).eq('id', id).eq('started_at', started_at).select('id')
  )
}

// #1214: `logs` is `{ level, message, ts }[]` and `message` is a string, so the
// field walk that covers `input` and `output` cannot reach inside it. Applied
// at both write sites, because a scrub on one of two writers is not a scrub.
function redactLogs(logs: StepLogLine[] | undefined, piiFields: string[]): StepLogLine[] | undefined {
  if (logs === undefined) return undefined
  if (piiFields.length === 0) return logs
  return logs.map((line) => ({ ...line, message: redactPiiInLogMessage(line.message, piiFields) }))
}

export async function writeStepLog(
  supabase: SupabaseClient,
  entry: StepLogEntry,
  piiFieldsRaw: string
): Promise<void> {
  const piiFields = parsePiiFields(piiFieldsRaw)
  const row = {
    ...entry,
    input: redactPii(entry.input, piiFields),
    output: redactPii(entry.output, piiFields),
    ...(entry.logs === undefined ? {} : { logs: redactLogs(entry.logs, piiFields) }),
  }
  const { error } = await supabase.from('execution_steps').insert(row)
  if (error) {
    console.error('[step-logger] execution_steps insert failed', {
      execution_id: entry.execution_id,
      step_namespace: entry.step_namespace,
      step_type: entry.step_type,
      error,
    })
  }
}

// Retry delays. These writes outlast the nightly partition-purge lock/reload
// window (the purge bounds its own lock to ~2s, but the PostgREST schema-cache
// reload it triggers can 503 for a few seconds). Lost 8 executions' audit trail
// on 2026-06-10 and several more on 2026-06-12 before this was hardened.
//
// They run in post-response waitUntil work, which Cloudflare cancels 30 seconds
// after the response, and they run there together: create, then the step flush
// chained on it, then finalize, then the dead letter. #1113 sized the finalize
// ladder at 112 seconds on the belief that this time was free, so in a real
// outage its later rungs and the dead letter behind them were cancelled before
// they ran (#1850). Every ladder now takes the run's shared post-response budget
// (lib/post-response-budget.ts) and stops retrying at its cut-off, and each one
// on its own fits inside that budget with what must follow it (asserted in
// lib/__tests__/post-response-budget.test.ts). A database outage longer than
// the budget cannot be outlasted here at all: a row left at 'running' goes to
// the strand drain, and a row that never landed goes to the dead letter.
//
// CREATE and FLUSH stop FINALIZE_RESERVE_MS short of the deadline, because
// finalize can reconstruct a missing execution row by itself and so needs the
// time more. FLUSH carries step logs, tier-1 observability (best-effort by
// design, see engine/durability.ts).
export const CREATE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000]
export const FLUSH_RETRY_DELAYS_MS = [2_000, 5_000]
// The finalize UPDATE is the only durable record that a lead was served. On
// 2026-09-02 Supabase returned empty-bodied HTTP 500s across roughly 90 seconds
// (#1113); no ladder inside the platform's 30 seconds can outlast that, so this
// one backs off quickly and leaves time for the dead letter, and the strand
// drain (30-minute floor) stays the backstop for a row left at 'running'.
export const UPDATE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]

// Batch-insert an accumulated queue of step logs. Used at end of execution
// to flush all step logs in a single round-trip instead of one-per-step.
// Returns the Postgres error message when the insert is rejected so callers
// can downgrade the execution outcome instead of silently completing.
// workflow_id + is_test are stamped here (one site) so the percentile RPCs
// can sample steps per (workflow, namespace) without joining executions.
export async function flushStepLogs(
  supabase: SupabaseClient,
  queue: StepLogEntry[],
  piiFieldsRaw: string,
  meta?: { workflowId: string; isTest: boolean },
  // #1850: the clock and the run's post-response budget. A wait that would run
  // past the cut-off is not taken, and neither is the row by row fallback.
  timing?: RetryTiming,
): Promise<string | null> {
  if (queue.length === 0) return null
  const piiFields = parsePiiFields(piiFieldsRaw)
  const rows = queue.map((entry) => ({
    ...entry,
    ...(meta ? { workflow_id: meta.workflowId, is_test: meta.isTest } : {}),
    input: redactPii(entry.input, piiFields),
    output: redactPii(entry.output, piiFields),
    ...(entry.logs === undefined ? {} : { logs: redactLogs(entry.logs, piiFields) }),
  }))

  // Retry the batch on transient errors (schema-cache reload / partition-lock
  // window) so a nightly-purge collision doesn't wipe the whole step history
  // and leave the run showing "unknown step".
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= FLUSH_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0 && !(await waitToRetry(FLUSH_RETRY_DELAYS_MS[attempt - 1], timing))) break
    const { error } = await insertRowsOnce(supabase, 'execution_steps', rows)
    if (!error) return null
    lastError = error
    // A permanent error means one malformed row poisons the whole atomic batch
    // — stop retrying and isolate it per-row below.
    if (isPermanentDbError(error)) break
  }

  console.error('[step-logger] execution_steps batch insert failed', {
    count: rows.length,
    execution_id: queue[0]?.execution_id,
    error: lastError,
  })
  // The batch insert is atomic, so one malformed row (e.g. a bad uuid) drops
  // EVERY step for the run — the execution then shows no path and the canvas
  // doesn't light up. Fall back to per-row inserts so the good steps still
  // persist and the offending row is isolated in the logs instead of taking
  // the whole history down with it.
  let failed = 0
  let firstRowError: string | null = null
  for (const [index, row] of rows.entries()) {
    // One insert per row against a database that is still failing can outrun
    // the budget on a long run, so the fallback stops at the cut-off and counts
    // what it never tried.
    if (timing?.budget && timing.budget.msUntilCutoff(timing.reserveMs ?? 0) <= 0) {
      const skipped = rows.length - index
      failed += skipped
      console.error('[step-logger] row by row fallback stopped at the post-response budget', {
        execution_id: queue[0]?.execution_id,
        skipped,
      })
      firstRowError ??= `not attempted: the post-response budget ran out (${lastError?.message ?? 'no error'})`
      break
    }
    const { error: rowErr } = await insertRowsOnce(supabase, 'execution_steps', [row])
    if (rowErr) {
      failed++
      if (!firstRowError) firstRowError = rowErr.message
      console.error('[step-logger] row insert failed', {
        step_namespace: row.step_namespace,
        step_node_id: row.step_node_id,
        error: rowErr.message,
      })
    }
  }
  if (failed === 0) return null
  return `${failed}/${rows.length} step rows failed: ${firstRowError ?? lastError?.message}`
}

export async function createExecutionRecord(
  supabase: SupabaseClient,
  record: {
    id: string
    workflow_id: string
    workflow_version_id: string
    parent_execution_id?: string
    resumed_from_execution_id?: string
    source: string
    trigger_payload: unknown
    trace_id: string
    started_at: string
    is_test: boolean
  },
  retryDelaysMs: readonly number[] = CREATE_RETRY_DELAYS_MS,
  // #1850: the clock and the run's post-response budget.
  timing?: RetryTiming,
): Promise<void> {
  // Throw on (final) insert failure. The caller chains this into flushStepLogs
  // via `.then().catch()`, so a thrown error surfaces as a clear "Step logs
  // failed to persist: <actual cause>" instead of a downstream FK violation
  // when the missing parent row blocks the step batch insert.
  const row = { ...record, status: 'running', trigger_type: 'http_webhook' }
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      if (!(await waitToRetry(retryDelaysMs[attempt - 1], timing))) break
      console.warn('[step-logger] retrying workflow_executions insert', {
        execution_id: record.id,
        attempt,
        previous_error: lastError?.message,
      })
    }
    const { error } = await insertRowsOnce(supabase, 'workflow_executions', [row])
    if (!error) return
    // A duplicate means the row already exists — whether a prior attempt landed
    // and only its response was lost, or the id genuinely collides. Either way
    // the audit row is present, which is all we want.
    if (isDuplicateError(error)) return
    // Malformed row / schema drift won't be fixed by waiting — fail fast.
    if (isPermanentDbError(error)) {
      throw new Error(`workflow_executions insert failed: ${error.message}`)
    }
    lastError = error
  }
  throw new Error(`workflow_executions insert failed: ${lastError?.message}`)
}

// #584: the create-time fields the finalize call site threads through so a
// missing base row can be reconstructed. Mirrors createExecutionRecord's input
// minus id/started_at (already function params) and trigger_type (constant).
export interface ExecutionCreateFields {
  workflow_id: string
  workflow_version_id?: string | null
  source?: string | null
  trigger_payload?: unknown
  trace_id?: string | null
  is_test: boolean
  parent_execution_id?: string | null
  resumed_from_execution_id?: string | null
}

// #584: recreate a lost workflow_executions row from the create fields plus the
// final-state finalize columns. Runs only after updateExecutionOnce found no row
// (both partition-keyed and id-only statements matched zero rows), so a plain
// insert is correct. Any error other than a duplicate is returned so the caller
// still dead-letters it (#487). Uses the shared transient retry ladder so a
// schema-cache blip during reconstruction self-heals.
//
// #1883: a duplicate is NOT a reconstruction. It means the original create was
// still in flight when finalize looked and landed at the same moment, so the row
// that exists is the create's, still at 'running', and nothing of the final
// state is in it. It is reported as `landedConcurrently` for the caller to write
// the final state to that row.
type ReconstructOutcome =
  | { kind: 'reconstructed' }
  | { kind: 'landedConcurrently' }
  | { kind: 'failed'; error: DbError }

async function reconstructExecutionRecord(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: Record<string, unknown>,
  createFields: ExecutionCreateFields,
  timing?: RetryTiming,
): Promise<ReconstructOutcome> {
  const row = { id, started_at, trigger_type: 'http_webhook', ...createFields, ...update }
  let landedConcurrently = false
  const { error } = await withDbRetry(async () => {
    const res = await insertRowsOnce(supabase, 'workflow_executions', [row])
    // Stop the ladder at once: the row exists, and retrying the insert cannot
    // put the final state into it.
    if (res.error && isDuplicateError(res.error)) {
      landedConcurrently = true
      return { error: null }
    }
    return res
  }, DB_WRITE_RETRY_DELAYS_MS, timing)
  if (error) {
    console.error('[step-logger] workflow_executions reconstruction insert failed, execution record lost', {
      id,
      started_at,
      status: update.status,
      error: error.message,
    })
    return { kind: 'failed', error }
  }
  if (landedConcurrently) return { kind: 'landedConcurrently' }
  console.warn('[step-logger] workflow_executions row reconstructed at finalize (no row existed when finalize looked)', {
    id,
    started_at,
    status: update.status,
  })
  return { kind: 'reconstructed' }
}

// #1883: the rebuild insert hit a duplicate, so the original create landed while
// finalize was looking. Write the final state to that row, through the same
// partition-keyed statement and on the same clock and budget as the finalize
// ladder, and report success only when the update matched it. A zero-row match
// is returned as NO_ROW_MATCHED (permanent, so it is not retried) for the caller
// to dead-letter.
async function finalizeConcurrentlyCreatedRow(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: Record<string, unknown>,
  timing?: RetryTiming,
): Promise<DbError | null> {
  const { error } = await withDbRetry(
    async () => ({ error: (await updateExecutionInPartitionOnce(supabase, id, started_at, update)).error }),
    UPDATE_RETRY_DELAYS_MS,
    timing,
  )
  if (error) {
    console.error('[step-logger] workflow_executions original create landed concurrently with the finalize rebuild, and the final state did not reach it', {
      id,
      started_at,
      status: update.status,
      error: error.message,
    })
    return error
  }
  console.warn('[step-logger] workflow_executions original create landed concurrently with the finalize rebuild; final state written to it', {
    id,
    started_at,
    status: update.status,
  })
  return null
}

export async function updateExecutionRecord(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: {
    status: string
    outcome?: string
    final_node_namespace?: string | null
    final_node_id?: string | null
    completed_at: string
    duration_ms: number
    response_body?: unknown
    response_status?: number
    error_message?: string
    /** Node type of the failed step, for upstream-outage attribution (#332). */
    failed_step_type?: string | null
    cost_usd?: number
    // #353: durable projection of the rich sighting-finalize fields, recovered by
    // the strand drain when the live finalize is lost to isolate eviction.
    sighting_finalize?: unknown
    // #419: per-execution field-presence booleans (which watched fields carried
    // a value this run). Dark capture behind FIELD_PRESENCE_CAPTURE.
    field_presence?: Record<string, boolean>
    // #744: this lead reached Salesforce without its email, because Salesforce
    // rejected the address and the node blanked it and retried. Set only when
    // true, so the column is null on the overwhelming majority of runs and the
    // per-source rate is a cheap single-table aggregate.
    email_dropped?: boolean
  },
  // #584: the NOT NULL create fields the finalize call site can hand over. When
  // the base row is missing (createExecutionRecord failed permanently), these let
  // us reconstruct the row from them plus the final-state update, instead of only
  // dead-lettering a served lead that would otherwise leave no audit record. When
  // omitted, a missing row still returns NO_ROW_MATCHED for the caller to
  // dead-letter (the pre-#584 behavior, kept for direct callers).
  createFields?: ExecutionCreateFields,
  // #629: fired once after a missing base row is successfully reconstructed,
  // i.e. the FK parent now exists. The engine uses this to re-flush the step
  // logs whose insert was blocked while the row was missing, so the recovered
  // run keeps its step-by-step trace. Not called on a normal update, when the
  // reconstruction insert itself fails, or when the original create landed
  // concurrently (#1883): that create's own flush is chained behind it, so a
  // re-flush would write every step twice.
  onReconstructed?: () => void,
  // #1850: the clock and the run's post-response budget, shared with the
  // reconstruction below.
  timing?: RetryTiming,
): Promise<DbError | null> {
  // The finalize update lands in the same partition-purge window as the insert,
  // so it gets the same transient-retry ladder. Failure is returned, not thrown:
  // the HTTP response already went out, and a stuck 'running' row is less harmful
  // than aborting the finalize chain. The caller dead-letters the returned error
  // so a lost execution record is announced rather than silently accepted (#487).
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= UPDATE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0 && !(await waitToRetry(UPDATE_RETRY_DELAYS_MS[attempt - 1], timing))) break
    const { error } = await updateExecutionOnce(supabase, id, started_at, update)
    if (!error) {
      // An outage the ladder ABSORBED leaves no other trace: the finalize
      // succeeded, no row stranded, nothing dead-lettered, nothing paged. A
      // database degrading repeatedly would be invisible for as long as it
      // lasted (LESSONS L77), so say how many attempts it cost. Mirrors the
      // warn the CREATE ladder already emits.
      if (attempt > 0) {
        console.warn('[step-logger] workflow_executions update landed only after retries', {
          id,
          attempts: attempt + 1,
          previous_error: lastError?.message,
        })
      }
      return null
    }
    // A row that does not exist will not appear by waiting, and schema drift is
    // not fixed by waiting either. Both fail fast.
    if (isNoRowMatchedError(error)) {
      // #584: reconstruct the row rather than lose it, when the caller supplied
      // the create fields. The row carries the FINAL status from `update` (not
      // 'running'), so it is a complete terminal record on the first write.
      if (createFields) {
        const recon = await reconstructExecutionRecord(supabase, id, started_at, update, createFields, timing)
        if (recon.kind === 'failed') return recon.error
        // #1883: the original create landed at the same moment. Nothing was
        // rebuilt, and its own step log flush is chained behind it, so the
        // re-flush below must not run; the final state still has to be written.
        if (recon.kind === 'landedConcurrently') {
          return finalizeConcurrentlyCreatedRow(supabase, id, started_at, update, timing)
        }
        // The row was rebuilt with the final state in it. Signal the caller so
        // it can re-flush the FK-blocked step logs (#629).
        onReconstructed?.()
        return null
      }
      console.error('[step-logger] workflow_executions update matched zero rows, execution record lost', {
        id,
        started_at,
        status: update.status,
      })
      return error
    }
    if (isPermanentDbError(error)) {
      console.error('[step-logger] workflow_executions update failed (permanent)', { id, error: error.message })
      return error
    }
    lastError = error
  }
  console.error('[step-logger] workflow_executions update failed after retries', {
    id,
    error: lastError?.message,
  })
  return lastError
}
