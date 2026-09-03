import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepStatus, ErrorType, StepLogEntry as StepLogLine } from '../types'
import { redactPii, parsePiiFields } from './pii-redactor'
import {
  isPermanentDbError,
  isDuplicateError,
  isNoRowMatchedError,
  requireRowsAffected,
  withDbRetry,
  normalizeDbError,
  sleep,
  NO_ROW_MATCHED_CODE,
  type DbError,
} from '../lib/db-retry'

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
  const target = `workflow_executions (id=${id}): the execution record is missing`

  // Use started_at for partition pruning. A zero-row match here is NOT yet a
  // missing row, so onMiss stays silent and we fall through to the id-only
  // statement below.
  const first = await requireRowsAffected(target, () =>
    supabase.from('workflow_executions').update(update).eq('id', id).eq('started_at', started_at).select('id')
  )
  if (first.error && !isNoRowMatchedError(first.error)) return { error: first.error }
  if (first.rows.length) return { error: null }

  // An UPDATE without the partition key still scans every partition, so zero
  // rows here means the row genuinely does not exist anywhere.
  const second = await requireRowsAffected(target, () =>
    supabase.from('workflow_executions').update(update).eq('id', id).select('id')
  )
  return { error: second.error }
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

// Retry delays. These inserts run inside waitUntil(), off the request critical
// path, so the added wall-clock is free. The ladder must outlast the nightly
// partition-purge lock/reload window (the purge bounds its own lock to ~2s, but
// the PostgREST schema-cache reload it triggers can 503 for a few seconds).
// Lost 8 executions' audit trail on 2026-06-10 and several more on 2026-06-12
// before this was hardened.
// These two were re-examined alongside the UPDATE ladder below and deliberately
// left as they are (#1113), so the difference is a decision rather than an
// oversight. CREATE runs while the request is still in flight, so its span is
// bounded by the caller's patience, not by the outage. FLUSH carries step logs,
// which are tier-1 observability (best-effort by design, see engine/durability.ts):
// losing one debug row to a long outage is the tolerable outcome the tier exists
// to name, and it is not worth holding an isolate open for two minutes.
const CREATE_RETRY_DELAYS_MS = [3_000, 8_000, 15_000]
const FLUSH_RETRY_DELAYS_MS = [2_000, 5_000]
// The finalize UPDATE is the only durable record that a lead was served, and it
// runs in a post-response waitUntil, so the wall-clock this ladder spends costs
// the lead nothing while giving up early costs a stranded row and a page.
//
// Sized against a MEASURED outage rather than a guess (#1113): on 2026-09-02
// Supabase returned empty-bodied HTTP 500s across roughly 90 seconds, and the
// old [2s, 5s] ladder was spent seven seconds in. This spans 112 seconds over
// six attempts, which clears that wobble and still gives up long before the
// strand drain's 30-minute floor, so the drain stays the backstop rather than
// racing a retry that is still in flight (asserted in step-logger.test.ts).
export const UPDATE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

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
  meta?: { workflowId: string; isTest: boolean }
): Promise<string | null> {
  if (queue.length === 0) return null
  const piiFields = parsePiiFields(piiFieldsRaw)
  const rows = queue.map((entry) => ({
    ...entry,
    ...(meta ? { workflow_id: meta.workflowId, is_test: meta.isTest } : {}),
    input: redactPii(entry.input, piiFields),
    output: redactPii(entry.output, piiFields),
  }))

  // Retry the batch on transient errors (schema-cache reload / partition-lock
  // window) so a nightly-purge collision doesn't wipe the whole step history
  // and leave the run showing "unknown step".
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= FLUSH_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(FLUSH_RETRY_DELAYS_MS[attempt - 1])
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
  for (const row of rows) {
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
  retryDelaysMs: number[] = CREATE_RETRY_DELAYS_MS
): Promise<void> {
  // Throw on (final) insert failure. The caller chains this into flushStepLogs
  // via `.then().catch()`, so a thrown error surfaces as a clear "Step logs
  // failed to persist: <actual cause>" instead of a downstream FK violation
  // when the missing parent row blocks the step batch insert.
  const row = { ...record, status: 'running', trigger_type: 'http_webhook' }
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      console.warn('[step-logger] retrying workflow_executions insert', {
        execution_id: record.id,
        attempt,
        previous_error: lastError?.message,
      })
      await sleep(retryDelaysMs[attempt - 1])
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
// final-state finalize columns. Runs only after updateExecutionOnce confirmed the
// row is genuinely absent (both partition-keyed and id-only statements matched
// zero rows), so a plain insert is correct. A concurrent writer that landed the
// row first surfaces as a duplicate, which is success. Any other error is
// returned so the caller still dead-letters it (#487). Uses the shared transient
// retry ladder so a schema-cache blip during reconstruction self-heals.
async function reconstructExecutionRecord(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: Record<string, unknown>,
  createFields: ExecutionCreateFields
): Promise<DbError | null> {
  const row = { id, started_at, trigger_type: 'http_webhook', ...createFields, ...update }
  const { error } = await withDbRetry(async () => {
    const res = await insertRowsOnce(supabase, 'workflow_executions', [row])
    // A duplicate means the row exists now (success, not a loss). Report it as
    // no-error so withDbRetry stops immediately without burning the ladder.
    if (res.error && isDuplicateError(res.error)) return { error: null }
    return res
  })
  if (error) {
    console.error('[step-logger] workflow_executions reconstruction insert failed, execution record lost', {
      id,
      started_at,
      status: update.status,
      error: error.message,
    })
    return error
  }
  console.warn('[step-logger] workflow_executions row reconstructed at finalize (base insert had failed)', {
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
  // #629: fired once after a missing base row is successfully reconstructed (or
  // a concurrent writer landed it), i.e. the FK parent now exists. The engine
  // uses this to re-flush the step logs whose insert was blocked while the row
  // was missing, so the recovered run keeps its step-by-step trace. Not called
  // on a normal update or when the reconstruction insert itself fails.
  onReconstructed?: () => void
): Promise<DbError | null> {
  // The finalize update lands in the same partition-purge window as the insert,
  // so it gets the same transient-retry ladder. Failure is returned, not thrown:
  // the HTTP response already went out, and a stuck 'running' row is less harmful
  // than aborting the finalize chain. The caller dead-letters the returned error
  // so a lost execution record is announced rather than silently accepted (#487).
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= UPDATE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(UPDATE_RETRY_DELAYS_MS[attempt - 1])
    const { error } = await updateExecutionOnce(supabase, id, started_at, update)
    if (!error) return null
    // A row that does not exist will not appear by waiting, and schema drift is
    // not fixed by waiting either. Both fail fast.
    if (isNoRowMatchedError(error)) {
      // #584: reconstruct the row rather than lose it, when the caller supplied
      // the create fields. The row carries the FINAL status from `update` (not
      // 'running'), so it is a complete terminal record on the first write.
      if (createFields) {
        const reconError = await reconstructExecutionRecord(supabase, id, started_at, update, createFields)
        // Row now exists (reconstructed, or a concurrent writer's duplicate).
        // Signal the caller so it can re-flush the FK-blocked step logs (#629).
        if (reconError === null) onReconstructed?.()
        return reconError
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
