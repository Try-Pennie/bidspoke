/**
 * Reduced finalize of stranded workflow_executions rows.
 *
 * Same root cause as the lead_sightings strand (#353 / #343 / #309): the
 * execution-record finalize write in engine/index.ts (status, completed_at,
 * duration_ms) runs in a post-response ctx.waitUntil, fire-and-forget, so the
 * Worker isolate can be evicted before it lands. The row is then stuck at
 * status='running' forever -- it is never purged (purge only targets terminal
 * statuses), so it silently accumulates and pollutes anything that reads
 * "still running" as "still in flight" (e.g. slow-execution-rate.ts, which
 * counts a stranded row's ever-growing elapsed time as a slow run).
 *
 * This does NOT try to guess 'completed' from execution_steps evidence alone.
 * A first attempt at that (a pg_cron SQL function, reverted same day) assumed
 * every workflow signals "response sent" with a dedicated 'response'/'exit'
 * step -- false for Engine Bidding Workflow (the majority of stranded rows),
 * which sends its response from inside a Code node's own script (an early
 * $.respond()-style sentinel), logged with step_type='code' like any other
 * code step. There is no reliable, workflow-agnostic signal in execution_steps
 * alone that distinguishes "the walk finished" from "the walk was cut off here
 * mid-graph" -- so guessing 'completed' risks overstating success on a run
 * that never actually served the lead.
 *
 * Instead this mirrors finalize_unrecoverable_stranded's "label honestly,
 * don't guess" precedent: only claim 'failed' with real evidence (a step that
 * actually failed); everything else is honestly marked unresolved rather than
 * masqueraded as either outcome. completed_at is always reconstructed from
 * real step history (or falls back to started_at) -- never `now()` -- so a
 * bulk catch-up run doesn't make a backlog of days-old executions look like
 * they all just failed simultaneously, which upstream-outage.ts and
 * failure-rate.ts window on completed_at and would page on as a false spike.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const MIN_AGE_MINUTES = 30
export const LOOKBACK_DAYS = 14
export const MAX_PER_RUN = 300

export interface StrandStepEvidence {
  status: string
  step_type: string | null
  error_message: string | null
  completed_at: string | null
}

export interface ResolvedStrand {
  status: 'failed'
  outcome: 'failed' | null
  completed_at: string
  duration_ms: number
  error_message: string
  failed_step_type: string | null
}

const UNRESOLVED_MESSAGE =
  '[recovered] execution stranded: isolate evicted before finalize, outcome could not be confirmed'
const FAILED_NO_MESSAGE_FALLBACK = '[recovered] execution stranded after a failed step'

export function resolveStrandedExecution(steps: StrandStepEvidence[], startedAtIso: string): ResolvedStrand {
  const startedAtMs = new Date(startedAtIso).getTime()
  const failedStep = steps.find((s) => s.status === 'failed')

  if (failedStep) {
    const completedAtIso = failedStep.completed_at ?? startedAtIso
    return {
      status: 'failed',
      outcome: 'failed',
      completed_at: completedAtIso,
      duration_ms: Math.max(0, new Date(completedAtIso).getTime() - startedAtMs),
      error_message: failedStep.error_message ?? FAILED_NO_MESSAGE_FALLBACK,
      failed_step_type: failedStep.step_type,
    }
  }

  const lastCompletedAt = steps
    .map((s) => s.completed_at)
    .filter((c): c is string => c != null)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
  const completedAtIso = lastCompletedAt ?? startedAtIso

  return {
    status: 'failed',
    outcome: null,
    completed_at: completedAtIso,
    duration_ms: Math.max(0, new Date(completedAtIso).getTime() - startedAtMs),
    error_message: UNRESOLVED_MESSAGE,
    failed_step_type: null,
  }
}

export interface ReduceFinalizeResult {
  processed: number
  errors: number
}

/**
 * Finds workflow_executions rows stuck at status='running' past MIN_AGE_MINUTES
 * and finalizes them via resolveStrandedExecution. Bounded to MAX_PER_RUN per
 * invocation (matches the bounded-per-call pattern used elsewhere, e.g. the
 * sightings admin backfill) -- a large backlog catches up over a few runs
 * rather than risking one invocation's CPU/time budget.
 */
export async function runReduceFinalizeStrandedExecutions(
  supabase: SupabaseClient
): Promise<ReduceFinalizeResult> {
  const now = Date.now()
  const ageFloor = new Date(now - MIN_AGE_MINUTES * 60_000).toISOString()
  const lookbackStart = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString()

  const { data: stranded, error: strandedErr } = await supabase
    .from('workflow_executions')
    .select('id, started_at')
    .eq('status', 'running')
    .lt('started_at', ageFloor)
    .gte('started_at', lookbackStart)
    .order('started_at', { ascending: true })
    .limit(MAX_PER_RUN)

  if (strandedErr) {
    console.error('[stranded-executions] scan failed', strandedErr)
    return { processed: 0, errors: 1 }
  }
  if (!stranded?.length) return { processed: 0, errors: 0 }

  let processed = 0
  let errors = 0

  for (const exec of stranded) {
    const { data: steps, error: stepsErr } = await supabase
      .from('execution_steps')
      .select('status, step_type, error_message, completed_at')
      .eq('execution_id', exec.id as string)
      .gte('execution_started_at', lookbackStart)

    if (stepsErr) {
      console.error('[stranded-executions] step lookup failed', { id: exec.id, error: stepsErr })
      errors++
      continue
    }

    const resolved = resolveStrandedExecution((steps ?? []) as StrandStepEvidence[], exec.started_at as string)
    const { error: updateErr } = await supabase
      .from('workflow_executions')
      .update({
        status: resolved.status,
        outcome: resolved.outcome,
        completed_at: resolved.completed_at,
        duration_ms: resolved.duration_ms,
        error_message: resolved.error_message,
        failed_step_type: resolved.failed_step_type,
      })
      .eq('id', exec.id as string)

    if (updateErr) {
      console.error('[stranded-executions] update failed', { id: exec.id, error: updateErr })
      errors++
    } else {
      processed++
    }
  }

  console.log(`[stranded-executions] processed=${processed} errors=${errors} scanned=${stranded.length}`)
  return { processed, errors }
}
