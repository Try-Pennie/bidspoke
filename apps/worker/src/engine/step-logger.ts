import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepStatus, ErrorType, StepLogEntry as StepLogLine } from '../types'
import { redactPii, parsePiiFields } from './pii-redactor'

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

// Batch-insert an accumulated queue of step logs. Used at end of execution
// to flush all step logs in a single round-trip instead of one-per-step.
// Returns the Postgres error message when the insert is rejected so callers
// can downgrade the execution outcome instead of silently completing.
export async function flushStepLogs(
  supabase: SupabaseClient,
  queue: StepLogEntry[],
  piiFieldsRaw: string
): Promise<string | null> {
  if (queue.length === 0) return null
  const piiFields = parsePiiFields(piiFieldsRaw)
  const rows = queue.map((entry) => ({
    ...entry,
    input: redactPii(entry.input, piiFields),
    output: redactPii(entry.output, piiFields),
  }))
  const { error } = await supabase.from('execution_steps').insert(rows)
  if (!error) return null

  console.error('[step-logger] execution_steps batch insert failed', {
    count: rows.length,
    execution_id: queue[0]?.execution_id,
    error,
  })
  // The batch insert is atomic, so one malformed row (e.g. a bad uuid) drops
  // EVERY step for the run — the execution then shows no path and the canvas
  // doesn't light up. Fall back to per-row inserts so the good steps still
  // persist and the offending row is isolated in the logs instead of taking
  // the whole history down with it.
  let failed = 0
  let firstRowError: string | null = null
  for (const row of rows) {
    const { error: rowErr } = await supabase.from('execution_steps').insert(row)
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
  return `${failed}/${rows.length} step rows failed: ${firstRowError ?? error.message}`
}

// Retry delays for the execution-row insert. The nightly partition-purge cron
// takes an ACCESS EXCLUSIVE lock on workflow_executions for up to ~15s; inserts
// queue behind it past the 8s statement timeout and fail — which lost 8
// executions' entire audit trail on 2026-06-10 (and a similar burst 2026-05-30,
// create-daily-partitions). The lock clears within seconds, so a short backoff
// saves the row. This runs inside waitUntil(), off the request critical path,
// so the added wall-clock is free.
const CREATE_RETRY_DELAYS_MS = [3_000, 8_000]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  let lastError: { code?: string; message: string } | null = null
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) {
      console.warn('[step-logger] retrying workflow_executions insert', {
        execution_id: record.id,
        attempt,
        previous_error: lastError?.message,
      })
      await sleep(retryDelaysMs[attempt - 1])
    }
    const { error } = await supabase.from('workflow_executions').insert({
      ...record,
      status: 'running',
      trigger_type: 'http_webhook',
    })
    if (!error) return
    // Unique violation on a retry means a prior attempt actually landed and
    // only its response was lost — the row exists, which is all we want.
    if (attempt > 0 && error.code === '23505') return
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
    error_message?: string
    cost_usd?: number
  }
): Promise<void> {
  // Use started_at for partition pruning; fall back to id-only if no rows matched
  const { data } = await supabase
    .from('workflow_executions')
    .update(update)
    .eq('id', id)
    .eq('started_at', started_at)
    .select('id')

  if (!data?.length) {
    // Partition key mismatch — update without started_at filter
    await supabase
      .from('workflow_executions')
      .update(update)
      .eq('id', id)
  }
}
