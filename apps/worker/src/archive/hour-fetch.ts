/**
 * Reads one closed UTC hour of executions and their steps (#871, Phase A3).
 *
 * Two measured facts decide the shape, both from A0 (ADR 0009):
 *
 * 1. One step query per execution costs 138 ms, about ten minutes of a twelve
 *    minute budget spent fetching before anything is compressed. Batched it is
 *    15.4 ms. Batching is the only shape that fits, not an optimisation.
 * 2. PostgREST caps a response at 1,000 rows whatever limit is asked for, and a
 *    truncated read is FASTER, so truncation presents as a performance win. Both
 *    reads therefore page AND reconcile against an independently counted
 *    expectation, and a mismatch refuses the hour rather than bundling what
 *    arrived.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPages, groupStepsByExecution, stepWindowFor, POSTGREST_ROW_CAP } from './fetch'

/** One page below the cap, so a full page is never ambiguous with a capped one. */
const PAGE_SIZE = POSTGREST_ROW_CAP

export interface HourBundle {
  executionId: string
  execution: Record<string, unknown>
  steps: Record<string, unknown>[]
}

export type HourFetch =
  | { usable: true; bundles: HourBundle[]; empty: boolean; executionCount: number; stepCount: number }
  | { usable: false; reason: string }

interface CountResult {
  count: number | null
  error: unknown
}

async function countRows(
  build: () => PromiseLike<CountResult>,
  what: string,
): Promise<{ count: number } | { error: string }> {
  const { count, error } = await build()
  if (error) return { error: `counting ${what} failed: ${JSON.stringify(error)}` }
  // A null count is not zero. PostgREST omits it when the header is absent, and
  // reading that as "no rows" would make every hour archive nothing and report
  // success (L90).
  if (count === null || count === undefined) {
    return { error: `counting ${what} returned no count, which is not the same as no rows` }
  }
  return { count }
}

export async function fetchHour(
  supabase: SupabaseClient,
  hourStart: string,
  hourEnd: string,
): Promise<HourFetch> {
  const window = stepWindowFor(hourStart, hourEnd)

  const executionCount = await countRows(
    () =>
      supabase
        .from('workflow_executions')
        .select('id', { count: 'exact', head: true })
        .gte('started_at', hourStart)
        .lt('started_at', hourEnd),
    'executions',
  )
  if ('error' in executionCount) return { usable: false, reason: executionCount.error }

  // An hour with no executions is a real answer with its own wording, and it must
  // not go on to read steps: "found nothing" and "read nothing" are different
  // outcomes and must not be reported the same way (L98).
  if (executionCount.count === 0) {
    return { usable: true, bundles: [], empty: true, executionCount: 0, stepCount: 0 }
  }

  const executions = await fetchAllPages<Record<string, unknown>>({
    expected: executionCount.count,
    pageSize: PAGE_SIZE,
    fetchPage: async (from, to) => {
      const { data, error } = (await supabase
        .from('workflow_executions')
        .select('*')
        .gte('started_at', hourStart)
        .lt('started_at', hourEnd)
        // Range paging over an unordered result is undefined: rows can repeat or
        // vanish between pages. Ordered by the primary key, which is unique.
        .order('id')
        .range(from, to)) as unknown as { data: Record<string, unknown>[] | null; error: unknown }
      if (error) return { rows: [], error: JSON.stringify(error) }
      return { rows: data ?? [] }
    },
  })
  if (!executions.usable) return { usable: false, reason: `executions: ${executions.reason}` }

  const stepCount = await countRows(
    () =>
      supabase
        .from('execution_steps')
        .select('id', { count: 'exact', head: true })
        .gte('execution_started_at', window.executionStartedFrom)
        .lt('execution_started_at', window.executionStartedTo)
        .gte('started_at', window.stepStartedFrom)
        .lt('started_at', window.stepStartedTo),
    'steps',
  )
  if ('error' in stepCount) return { usable: false, reason: stepCount.error }

  const steps = await fetchAllPages<Record<string, unknown>>({
    expected: stepCount.count,
    pageSize: PAGE_SIZE,
    fetchPage: async (from, to) => {
      const { data, error } = (await supabase
        .from('execution_steps')
        .select('*')
        // Correctness bound: the hour the step's EXECUTION belongs to.
        .gte('execution_started_at', window.executionStartedFrom)
        .lt('execution_started_at', window.executionStartedTo)
        // Partition pruning hint, widened past the hour end so a step that began
        // after its execution's hour closed is not silently dropped.
        .gte('started_at', window.stepStartedFrom)
        .lt('started_at', window.stepStartedTo)
        .order('id')
        .range(from, to)) as unknown as { data: Record<string, unknown>[] | null; error: unknown }
      if (error) return { rows: [], error: JSON.stringify(error) }
      return { rows: data ?? [] }
    },
  })
  if (!steps.usable) return { usable: false, reason: `steps: ${steps.reason}` }

  const byExecution = groupStepsByExecution(steps.rows)

  const bundles: HourBundle[] = executions.rows.map((execution) => {
    const id = execution.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('an execution row came back with no id, so it cannot be bundled')
    }
    return {
      executionId: id,
      execution,
      // An execution that failed before its first step logged has none, and it
      // is still archived: dropping it leaves the deletion gate one short with
      // nothing explaining the difference.
      steps: byExecution.get(id) ?? [],
    }
  })

  return {
    usable: true,
    bundles,
    empty: false,
    executionCount: executions.rows.length,
    stepCount: steps.rows.length,
  }
}
