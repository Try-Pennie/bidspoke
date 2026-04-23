import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepStatus, ErrorType } from '../types'
import { redactPii, parsePiiFields } from './pii-redactor'

export interface StepLogEntry {
  execution_id: string
  execution_started_at: string
  step_namespace: string
  step_type: string
  status: StepStatus
  input: unknown
  output: unknown
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
export async function flushStepLogs(
  supabase: SupabaseClient,
  queue: StepLogEntry[],
  piiFieldsRaw: string
): Promise<void> {
  if (queue.length === 0) return
  const piiFields = parsePiiFields(piiFieldsRaw)
  const rows = queue.map((entry) => ({
    ...entry,
    input: redactPii(entry.input, piiFields),
    output: redactPii(entry.output, piiFields),
  }))
  const { error } = await supabase.from('execution_steps').insert(rows)
  if (error) {
    console.error('[step-logger] execution_steps batch insert failed', {
      count: rows.length,
      execution_id: queue[0]?.execution_id,
      error,
    })
  }
}

export async function createExecutionRecord(
  supabase: SupabaseClient,
  record: {
    id: string
    workflow_id: string
    workflow_version_id: string
    parent_execution_id?: string
    source: string
    trigger_payload: unknown
    trace_id: string
    started_at: string
    is_test: boolean
  }
): Promise<void> {
  await supabase.from('workflow_executions').insert({
    ...record,
    status: 'running',
    trigger_type: 'http_webhook',
  })
}

export async function updateExecutionRecord(
  supabase: SupabaseClient,
  id: string,
  started_at: string,
  update: {
    status: string
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
