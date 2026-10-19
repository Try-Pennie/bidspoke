import type { SupabaseClient } from '@supabase/supabase-js'

/** Ids per read, so the IN list stays a short URL however many runs are asked about. */
export const REPLAYED_CHUNK = 100

/**
 * Which of these executions have been replayed or resumed at least once: the
 * ids some other execution names as its parent. The run lists mark those rows
 * "Replayed" (GET /api/executions, and the failed runs of an incident, #2102).
 *
 * Throws on a failed read. A caller that would rather show its rows unmarked
 * than not at all catches it and says so.
 */
export async function readReplayedIds(supabase: SupabaseClient, ids: readonly string[]): Promise<Set<string>> {
  const replayed = new Set<string>()
  for (let i = 0; i < ids.length; i += REPLAYED_CHUNK) {
    const chunk = ids.slice(i, i + REPLAYED_CHUNK)
    // paginate-ok .in(parent_execution_id): one chunk (<=100) of parent ids, few
    // children each (measured 2026-10-18: never more than 1)
    const { data, error } = await supabase
      .from('workflow_executions')
      .select('parent_execution_id')
      .in('parent_execution_id', chunk)
    if (error) throw new Error(`replayed executions could not be read: ${error.message}`)
    for (const row of (data ?? []) as Array<{ parent_execution_id: string | null }>) {
      if (row.parent_execution_id) replayed.add(row.parent_execution_id)
    }
  }
  return replayed
}
