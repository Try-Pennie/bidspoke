// Achieve (FDR) evaluation logging.
// The achieve_fdr code node marks its output with _achieve_evaluation: true.
// After the walk completes, the engine scans the step log queue for marked
// outputs and writes one achieve_evaluations row per call, in waitUntil.
// Best-effort: failures never block the workflow.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { StepLogEntry } from './step-logger'

export interface AchieveEvaluationInsert {
  trace_id: string
  execution_id: string
  workflow_id: string
  node_namespace: string
  submission_id: string | null
  requested_at_utc: string
  duration_ms: number | null
  http_status: number | null
  response_status: string | null
  response_reason: string | null
  offer_count: number
  request_payload: unknown
  response_body: unknown
  offers: unknown
  is_test: boolean
}

interface AchieveStepOutput {
  _achieve_evaluation: true
  status?: number
  response_status?: string
  response_reason?: string
  offer_count?: number
  request?: Record<string, unknown>
  response?: unknown
  offers?: unknown
}

function isAchieveOutput(output: unknown): output is AchieveStepOutput {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { _achieve_evaluation?: unknown })._achieve_evaluation === true
  )
}

// Strip direct identifiers from the stored request copy. The live API call
// keeps them; the analysis table joins on trace_id / submission_id instead.
const REDACTED_REQUEST_KEYS = ['social_security_number', 'date_of_birth']

function redactRequest(request: Record<string, unknown> | undefined): unknown {
  if (!request) return null
  const copy: Record<string, unknown> = { ...request }
  for (const key of REDACTED_REQUEST_KEYS) {
    if (key in copy) copy[key] = '[redacted]'
  }
  return copy
}

export function extractAchieveEvaluations(
  stepLogQueue: StepLogEntry[],
  meta: {
    trace_id: string
    execution_id: string
    workflow_id: string
    submission_id: string | null
    is_test: boolean
  },
): AchieveEvaluationInsert[] {
  const rows: AchieveEvaluationInsert[] = []
  for (const entry of stepLogQueue) {
    if (!isAchieveOutput(entry.output)) continue
    const output = entry.output
    rows.push({
      trace_id: meta.trace_id,
      execution_id: meta.execution_id,
      workflow_id: meta.workflow_id,
      node_namespace: entry.step_namespace,
      submission_id: meta.submission_id,
      requested_at_utc: entry.started_at,
      duration_ms: entry.duration_ms ?? null,
      http_status: typeof output.status === 'number' ? output.status : null,
      response_status: output.response_status ?? null,
      response_reason: output.response_reason ?? null,
      offer_count: typeof output.offer_count === 'number' ? output.offer_count : 0,
      request_payload: redactRequest(output.request),
      response_body: output.response ?? null,
      offers: output.offers ?? null,
      is_test: meta.is_test,
    })
  }
  return rows
}

export async function insertAchieveEvaluations(
  supabase: SupabaseClient,
  rows: AchieveEvaluationInsert[],
): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('achieve_evaluations').insert(rows)
  if (error) {
    console.error('[achieve-log] insert failed:', error.message)
  }
}
