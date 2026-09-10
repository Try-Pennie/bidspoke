/**
 * Whether the execution archive has stopped making progress (#946).
 *
 * The archive ran hourly for NINETEEN hours archiving nothing, and nothing said
 * so. Every signal reported health: the cron heartbeat was current, so the job
 * was firing; worker analytics showed zero errors; the run lock was not held, so
 * it was not stuck; Slack was silent, because the run completed. Meanwhile
 * `execution_archive_progress`, `execution_archive_ids` and
 * `execution_archive_refusals` were all empty. It was found by hand.
 *
 * The cause is fixed (#945: the initial watermark could never reach a settled
 * hour) but the gap that hid it is what this closes. A run that finds no hour
 * ready and a run with nothing left to do both stop quietly and successfully
 * (L98), and the longer that goes on the healthier it looks. That matters more
 * here than for an ordinary job, because the archive is the thing that has to be
 * trusted before anything is allowed to delete (ADR 0009), so "it has been
 * running fine" is exactly the belief a silent standstill manufactures.
 *
 * It decides, it does not act: no Supabase, no KV, no Slack.
 */
import { formatErr } from '../lib/format-error'
import { nextHourToArchive } from './clock'

const HOUR_MS = 60 * 60 * 1000

/**
 * How long the archive may make no progress, while settled hours are waiting,
 * before it is a standstill.
 *
 * Derived from the CADENCE, not from the per-run cap. This comment used to name
 * the per-run cap and then restate its value in parentheses beside it, and that
 * copy went stale the moment #953 moved the cap, which is how a value
 * maintained by hand beside its source always ends (L41). Nothing here depends
 * on it: three hours is three cadences whatever the cap is. The guard that now
 * refuses that shape is budget-values-not-copied-into-prose.test.ts, and it is
 * why the old sentence is described here rather than quoted: it cannot tell a
 * line demonstrating the mistake from a line making it.
 *
 * The cron is hourly, so one slow or skipped run is normal. Three cadences is
 * long enough that a single missed run does not speak, and short enough to be
 * far inside the 7 day retention of the partitions this protects. A threshold
 * near that retention would report the loss rather than prevent it.
 *
 * WHAT THIS DELIBERATELY DOES NOT CATCH, so nobody reads it as wider than it
 * is: an archive HOLDING STATION. At peak volume a run gets through about one
 * hour per hourly run, so the watermark keeps moving and this stays healthy
 * while a backlog sits there not shrinking. That is the honest reading, since
 * progress really is being made, and the quantity that would report it is
 * `hoursBehind` rather than the watermark's age.
 */
export const STANDSTILL_MS = 3 * HOUR_MS

/** Walking further back than this is pointless: the number is only a threshold. */
const MAX_HOURS_COUNTED = 24 * 30

export type StandstillVerdict =
  /** Either caught up, or behind but still moving. */
  | { status: 'healthy'; hoursBehind: number }
  /**
   * No progress row and no sign the job has ever run. Deliberately silent: the
   * cron heartbeat already covers a job that never fires, and saying it twice
   * under two names is how an alert becomes noise.
   */
  | { status: 'never-ran' }
  /**
   * No progress row, the job is running, and not enough time has passed to
   * conclude anything. `startClockAt` is the observation the caller must RECORD,
   * so the next check has an age to judge rather than starting over.
   */
  | { status: 'no-progress-yet'; startClockAt: string }
  /** The 2026-08-21 case: running hourly, and no watermark has ever been written. */
  | { status: 'never-wrote-progress'; runningForMs: number }
  /** A watermark that exists, has settled hours waiting, and has not moved. */
  | { status: 'stalled'; hoursBehind: number; frozenForMs: number }
  /**
   * A watermark that cannot be interpreted. Its own outcome rather than a
   * fallback to healthy, because reporting health on a value nothing can read is
   * the exact silence this check exists to break (L11).
   */
  | { status: 'unreadable'; reason: string }

export interface StandstillInput {
  /** From `execution_archive_progress`, or null when the row does not exist. */
  watermarkHour: string | null
  watermarkUpdatedAt: string | null
  /** The archive cron's heartbeat, so "the job is running" is a fact rather than an assumption. */
  jobLastRan: string | null
  /** When this check first saw a running job with no progress row, or null if never. */
  noProgressSince: string | null
  now: Date
}

/**
 * Settled hours between the watermark and now, using the loop's own readiness
 * predicate so the two can never disagree about what "ready" means (L144).
 */
function hoursWaiting(watermarkHour: string, now: Date): number {
  let hour = watermarkHour
  let behind = 0
  for (;;) {
    const next = nextHourToArchive({ watermarkHour: hour, now })
    if (!next.archive) return behind
    behind++
    hour = next.hourStart
    if (behind >= MAX_HOURS_COUNTED) return behind
  }
}

function ageMs(iso: string | null, now: Date): number | null {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? now.getTime() - ms : null
}

export function evaluateStandstill(input: StandstillInput): StandstillVerdict {
  const { watermarkHour, watermarkUpdatedAt, jobLastRan, noProgressSince, now } = input

  if (watermarkHour === null) {
    // The heartbeat, not the progress row, is what says the job is alive. A job
    // that has never fired is the heartbeat check's business, not this one's.
    if (ageMs(jobLastRan, now) === null) return { status: 'never-ran' }

    const runningForMs = ageMs(noProgressSince, now)
    if (runningForMs === null) return { status: 'no-progress-yet', startClockAt: now.toISOString() }
    if (runningForMs <= STANDSTILL_MS) return { status: 'no-progress-yet', startClockAt: noProgressSince as string }
    return { status: 'never-wrote-progress', runningForMs }
  }

  let hoursBehind: number
  try {
    hoursBehind = hoursWaiting(watermarkHour, now)
  } catch (err) {
    return {
      status: 'unreadable',
      reason: `the stored watermark "${watermarkHour}" cannot be read: ${formatErr(err)}`,
    }
  }

  // A watermark that has not advanced because there is nothing settled to
  // advance TO is the caught-up state. This is the whole reason the comparison
  // is against the newest settled hour rather than against the clock: measured
  // against the clock, every quiet night would read as a standstill.
  if (hoursBehind === 0) return { status: 'healthy', hoursBehind: 0 }

  const frozenForMs = ageMs(watermarkUpdatedAt, now)
  if (frozenForMs === null) {
    return {
      status: 'unreadable',
      reason: `the progress row carries no readable updated_at, so there is no way to tell how long it has been frozen`,
    }
  }
  if (frozenForMs <= STANDSTILL_MS) return { status: 'healthy', hoursBehind }

  return { status: 'stalled', hoursBehind, frozenForMs }
}
