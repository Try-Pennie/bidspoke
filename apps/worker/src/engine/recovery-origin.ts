/**
 * Where a recovery run's lineage began (#2176): the root run every replay and
 * resume in the chain goes back to, and when it started.
 *
 * A credit inquiry post on a recovery run checks first and sends only if its
 * file is missing (Dan, on #2176, 2026-10-15): it looks for the Lead's
 * `Inquiries_<leadId>` file created since the ORIGINAL run's post began. What a
 * recovery run actually has is the id of the run it recovers from; that run's
 * row names its own parent, and so on to the root.
 *
 *  - The original STEP's start is not used. Its row is flushed after the walk,
 *    can fail to flush, and is archived after 7 days, so a recovery run could
 *    not count on reading it. The original RUN's start is in the execution row
 *    the dashboard has just read to start the recovery, and it is never later
 *    than the post began, so the window is only ever wider: the side that never
 *    posts twice. A file another run for the same Lead attached in the seconds
 *    between the run's start and its post would also read as landed; the cost of
 *    that is a post not sent, said on the step, never a second file.
 *  - The ROOT run, not the run directly recovered. A replay of a replay that
 *    skipped as already landed would otherwise look only after the first replay
 *    began, miss the root's file, and attach a second one.
 *  - A chain it cannot read to the end (a run no longer kept, a refused read, a
 *    loop) throws. The caller fails closed on that: it does not post.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from '../lib/format-error'

/** At most this many runs are read up a chain. Real chains are one or two long. */
export const MAX_RECOVERY_LINEAGE = 10

export interface RecoveryOrigin {
  /** The root run of the chain: an execution that recovers no other. */
  executionId: string
  /** When it started, from its row. */
  startedAtMs: number
  /**
   * Every run of the chain, nearest first, the root last. Any of them may have
   * sent the post the read-back still holds, so a recovery asks about each
   * (Dan, 2026-10-16).
   */
  lineage: string[]
}

export async function readRecoveryOrigin(db: SupabaseClient, recoveredFrom: string): Promise<RecoveryOrigin> {
  let id = recoveredFrom
  const lineage: string[] = []
  for (let read = 0; read < MAX_RECOVERY_LINEAGE; read++) {
    lineage.push(id)
    const { data, error } = await db.from('workflow_executions').select('id, started_at, parent_execution_id').eq('id', id).maybeSingle()
    if (error) throw new Error(`could not read execution ${id} in the recovered run's lineage: ${formatErr(error)}`)
    const row: { started_at: unknown; parent_execution_id: unknown } | null = data
    if (!row) throw new Error(`execution ${id} in the recovered run's lineage is no longer kept, so how far back the lineage goes cannot be read`)
    const parent = row.parent_execution_id
    if (typeof parent === 'string' && parent !== '') {
      id = parent
      continue
    }
    const startedAtMs = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN
    if (!Number.isFinite(startedAtMs)) throw new Error(`execution ${id}, the root of the recovered run's lineage, has no readable start`)
    return { executionId: id, startedAtMs, lineage }
  }
  throw new Error(`the recovered run's lineage is longer than ${MAX_RECOVERY_LINEAGE} runs, or loops, so its root was not found`)
}
