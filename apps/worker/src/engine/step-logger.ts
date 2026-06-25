import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepStatus, ErrorType, StepLogEntry as StepLogLine } from '../types'
import { redactPii, parsePiiFields } from './pii-redactor'
import { isPermanentDbError, isDuplicateError, sleep, type DbError } from '../lib/db-retry'

// Re-export so existing importers of these from step-logger keep working; the
// definitions now live in lib/db-retry (single source of truth, shared with the
// lead-sightings writes — see #237).
export { isPermanentDbError, type DbError }

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
  const { error } = await supabase.from(table).insert(rows)
  return { error: error ? { code: error.code, message: error.message } : null }
}

// One update attempt for workflow_executions, keyed by (id, started_at) with an
// id-only fallback for the partition-pruning case.
async function updateExecutionOnce(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: Record<string, unknown>
): Promise<{ error: DbError | null }> {
  // Use started_at for partition pruning; fall back to id-only if no rows matched.
  const { data, error } = await supabase
    .from('workflow_executions')
    .update(update)
    .eq('id', id)
    .eq('started_at', started_at)
    .select('id')
  if (error) return { error: { code: error.code, message: error.message } }
  if (!data?.length) {
    const { error: e2 } = await supabase.from('workflow_executions').update(update).eq('id', id)
    if (e2) return { error: { code: e2.code, message: e2.message } }
  }
  return { error: null }
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
const CREATE_RETRY_DELAYS_MS = [3_000, 8_000, 15_000]
const FLUSH_RETRY_DELAYS_MS = [2_000, 5_000]
const UPDATE_RETRY_DELAYS_MS = [2_000, 5_000]

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
    cost_usd?: number
    // #353: durable projection of the rich sighting-finalize fields, recovered by
    // the strand drain when the live finalize is lost to isolate eviction.
    sighting_finalize?: unknown
  }
): Promise<void> {
  // The finalize update lands in the same partition-purge window as the insert,
  // so it gets the same transient-retry ladder. Failure is logged, not thrown:
  // the HTTP response already went out, and a stuck 'running' row is less harmful
  // than aborting the finalize chain.
  let lastError: DbError | null = null
  for (let attempt = 0; attempt <= UPDATE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(UPDATE_RETRY_DELAYS_MS[attempt - 1])
    const { error } = await updateExecutionOnce(supabase, id, started_at, update)
    if (!error) return
    if (isPermanentDbError(error)) {
      console.error('[step-logger] workflow_executions update failed (permanent)', { id, error: error.message })
      return
    }
    lastError = error
  }
  console.error('[step-logger] workflow_executions update failed after retries', {
    id,
    error: lastError?.message,
  })
}
