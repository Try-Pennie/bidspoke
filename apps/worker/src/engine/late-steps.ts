/**
 * Steps that settle after the continuation window closes (#2541).
 *
 * A run that answered early keeps walking, and finalize stops waiting for that
 * walk 12 s after the answer (#1860). The step rows were written once, at that
 * cut-off, so a step still running then was never recorded, even when it later
 * completed or failed. Measured 2026-10-20 over 7 days: in 0 of 48 runs degraded
 * as unfinished did the step the run names have a row, including 6 LendSwift
 * runs whose patch step logged step_complete 12.4 to 24.5 s after it started. So
 * the "Work after an answer did not finish in time" alert pointed at a run that
 * did not contain the step it asked a person to check.
 *
 * This writes those steps, in a waitUntil of their own, while the invocation is
 * still alive. It changes nothing about when or whether the alert pages: the
 * page and finalize never wait on it, and it never waits on them beyond the cut
 * off flush it follows.
 *
 *  - It takes only the entries no earlier flush was handed (`StepFlushCursor`), so
 *    an entry is never written twice, however many times this runs.
 *  - It waits for the walk until LATE_STEP_RESERVE_MS before the post-response
 *    deadline (20 s after the answer) and no longer, then writes what settled by
 *    then. A step that has not settled stays absent, and the run already names it
 *    in its reason ("Still running then").
 *  - It starts no write after that late cut-off, so the dead letter's reserve
 *    (the last 3 s) stays free of it, and its retries stop at the dead letter's cut
 *    off like every other post-response write.
 *  - When the cut-off flush never ran (the execution row was never created, so
 *    finalize rebuilds the row and flushes the whole queue itself), it writes
 *    nothing, so that re-flush is not doubled.
 *
 * Never throws: every failure is logged.
 */
import { DEAD_LETTER_RESERVE_MS, withinBudget, withReserve, type RetryTiming } from '../lib/post-response-budget'
import { formatErr } from '../lib/format-error'
import type { StepLogEntry } from './step-logger'

/**
 * The room a late write gets between the late cut-off and the dead letter's cut
 * off: one batch insert, which answered within a few hundred milliseconds on a
 * healthy database (the cut-off flush of the 2026-10-20 run landed at once).
 */
export const LATE_STEP_WRITE_MS = 2_000

/**
 * The tail of the post-response budget the late write never starts in: the dead
 * letter's own reserve plus the write's room. With a 25 s budget, the late write
 * waits for the walk until 20 s after the answer.
 */
export const LATE_STEP_RESERVE_MS = DEAD_LETTER_RESERVE_MS + LATE_STEP_WRITE_MS

/** Which entries of a run's step queue have been handed to a flush. */
export class StepFlushCursor {
  private through: number | null = null

  /** True once a flush has been handed the queue. */
  get started(): boolean {
    return this.through !== null
  }

  /** The entries no flush has been handed yet, now marked as handed. */
  take<T>(queue: readonly T[]): T[] {
    const from = this.through ?? 0
    this.through = queue.length
    return queue.slice(from)
  }
}

export interface LateStepArgs {
  /** The run's walk, settled or not. */
  walk: Promise<unknown>
  /** The cut-off flush; the late write begins only once it has settled. */
  mainFlush: Promise<unknown>
  cursor: StepFlushCursor
  queue: readonly StepLogEntry[]
  /** Writes the entries; resolves to an error message, or null when they all landed. */
  write: (entries: StepLogEntry[]) => Promise<string | null>
  /** The run's post-response budget, with the dead letter's reserve. */
  timing: RetryTiming | undefined
  executionId: string
}

export async function recordLateSteps(args: LateStepArgs): Promise<void> {
  const { cursor, queue, timing, executionId } = args
  try {
    await args.mainFlush
    if (!cursor.started) return
    const lateTiming = withReserve(timing, LATE_STEP_RESERVE_MS)
    const waited = await withinBudget(args.walk, lateTiming)
    const budget = timing?.budget
    if (budget && budget.msUntilCutoff(LATE_STEP_RESERVE_MS) < 0) {
      // Taken now, so a later run of this finds nothing either.
      const left = cursor.take(queue)
      if (left.length > 0) {
        console.error(`[late-steps] ${left.length} step row(s) of execution ${executionId} settled after the late cut-off and were not written`)
      }
      return
    }
    const late = cursor.take(queue)
    if (!waited.settled) {
      console.error(`[late-steps] the walk of execution ${executionId} had not settled ${LATE_STEP_RESERVE_MS} ms before the post-response deadline; a step still running then is not recorded`)
    }
    if (late.length === 0) return
    const written = await withinBudget(args.write(late), timing)
    if (!written.settled) {
      console.error(`[late-steps] the ${late.length} late step row(s) of execution ${executionId} did not answer within the post-response budget; they may still land`)
    } else if (written.value) {
      console.error(`[late-steps] the late step rows of execution ${executionId} were not all written:`, written.value)
    } else {
      console.log(`[late-steps] wrote ${late.length} step row(s) of execution ${executionId} that settled after the continuation window`)
    }
  } catch (e) {
    console.error(`[late-steps] could not write the late step rows of execution ${executionId}:`, formatErr(e))
  }
}
