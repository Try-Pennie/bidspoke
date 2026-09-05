/**
 * Whether a stored archive run lock is genuinely held, or left behind by a run
 * the platform killed (#954).
 *
 * The lock stops two overlapping invocations both draining and both sending. It
 * is an OPTIMISATION, not the correctness story: the watermark and the deletion
 * gate's COUNT(DISTINCT) are what make a duplicate harmless. That is exactly why
 * it must not be able to suppress work.
 *
 * It could. Observed on prod 2026-08-21: the 17:23 run still held the key at
 * 17:35, twelve minutes later and two minutes past its own 10 minute wall
 * budget, with nothing written and no error recorded. The `finally` that deletes
 * the lock covers success and failure but not the isolate being terminated. The
 * next invocation read the key, treated it as a concurrent run and returned
 * `skipped: 'locked'`, which is indistinguishable from correct behaviour. So one
 * terminated run silently cost the run after it too, and the only thing that
 * ever cleared it was the 15 minute TTL.
 *
 * The fix is to stamp the lock with the deadline its holder is working to, and
 * to treat a lock past that deadline as stale rather than held. A takeover is
 * REPORTED rather than quietly done, because a killed run is the event this
 * exists to make visible (L98).
 */

/**
 * How far past its own deadline a holder may be before it is presumed dead.
 *
 * Not zero. The run checks its wall budget BETWEEN hours, so the hour in flight
 * when the deadline passes still has to finish sending and advance the
 * watermark. Measured on the 2026-08-22 recovery run, an hour costs 202 to 257
 * seconds end to end, so a run can legitimately be several minutes past its
 * deadline. Taking over inside that window would put two live runs on the same
 * hour, which is the thing the lock exists to avoid.
 *
 * Five minutes: above the worst measured overrun of one hour's send, and well
 * below the hourly cadence, so a killed run is reclaimed by the very next
 * invocation rather than waiting out the TTL.
 */
export const STALE_GRACE_MS = 5 * 60 * 1000

/**
 * Longest a stored deadline may sit in the future before the value is presumed
 * wrong rather than the run presumed long.
 *
 * A deadline beyond anything a run could claim means the stamp is bad, and
 * trusting it would block archiving for as long as the bad stamp said. One hour
 * is comfortably above any legitimate wall budget and far below the horizons a
 * corrupt or mis-clocked value produces.
 */
export const MAX_DEADLINE_AHEAD_MS = 60 * 60 * 1000

export interface LockStamp {
  startedAt: string
  deadlineAt: string
  /**
   * The cron event the holder was invoked for, when it was a cron (#1181).
   *
   * Cloudflare re-dispatches a scheduled event whose invocation it terminated,
   * and the retry carries the same `scheduledTime`. Measured on prod: the
   * 2026-09-05 00:23:35 run was terminated after 43 seconds and the retry
   * arrived at 00:24:18, read this lock as held with 9 minutes of deadline
   * left, and skipped. The same at 2026-08-26 03:23 and 2026-09-01 19:23. So
   * the platform's own recovery was refused by our lock every time, and the
   * hours waited a full cadence for the deadline rule to notice.
   *
   * Absent for the backlog walk and the admin route, which are not cron
   * retries and get only the deadline rule.
   */
  scheduledFor?: string
}

export type LockDecision =
  | { action: 'take' }
  | { action: 'skip'; heldForMs: number; deadlineInMs: number }
  | {
      action: 'take-over'
      /** Null when the stored value carried no readable start, never a made up zero (L90). */
      heldForMs: number | null
      /** How far past deadline plus grace the holder was, or null when that cannot be computed. */
      overdueByMs: number | null
      reason: string
    }

export interface LockDecisionInput {
  stored: string | null
  now: Date
  /** The budget THIS run would work to, used only to interpret a value that carries no deadline. */
  wallBudgetMs: number
  /** The cron event THIS invocation is running for, when it is a cron. See LockStamp.scheduledFor. */
  scheduledFor?: Date
}

/** The value a run writes when it takes the lock. */
export function lockValue(startedAt: Date, wallBudgetMs: number, scheduledFor?: Date): string {
  const stamp: LockStamp = {
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + wallBudgetMs).toISOString(),
  }
  if (scheduledFor !== undefined) stamp.scheduledFor = scheduledFor.toISOString()
  return JSON.stringify(stamp)
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Reads a stored lock value in either shape.
 *
 * The bare ISO string is what the previous version wrote and is what is in
 * production. During the deploy gap a new run reads an old value, and treating
 * that as unreadable would take over a run that is genuinely alive, so it is
 * read as a start with the deadline derived from the reader's own budget.
 */
function readStamp(stored: string, wallBudgetMs: number): LockStamp | null {
  const bare = parseTime(stored)
  if (bare !== null) {
    return { startedAt: stored, deadlineAt: new Date(bare + wallBudgetMs).toISOString() }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const startedAt = parseTime(record.startedAt)
  const deadlineAt = parseTime(record.deadlineAt)
  const scheduledFor = parseTime(record.scheduledFor)
  if (startedAt === null) return null
  const stamp: LockStamp = {
    startedAt: new Date(startedAt).toISOString(),
    deadlineAt:
      deadlineAt === null ? new Date(startedAt + wallBudgetMs).toISOString() : new Date(deadlineAt).toISOString(),
  }
  if (scheduledFor !== null) stamp.scheduledFor = new Date(scheduledFor).toISOString()
  return stamp
}

export function decideLock(input: LockDecisionInput): LockDecision {
  const { stored, now, wallBudgetMs, scheduledFor } = input
  if (stored === null || stored.length === 0) return { action: 'take' }

  const stamp = readStamp(stored, wallBudgetMs)
  if (stamp === null) {
    return {
      action: 'take-over',
      heldForMs: null,
      overdueByMs: null,
      reason: 'the previous run lock could not be read, so it is presumed left behind by a killed run',
    }
  }

  const nowMs = now.getTime()
  const startedMs = Date.parse(stamp.startedAt)
  const deadlineMs = Date.parse(stamp.deadlineAt)
  const heldForMs = nowMs - startedMs

  // Checked BEFORE the deadline, because it is the one case where the deadline
  // says nothing. The runtime only retries a scheduled event after the attempt
  // before it has ended, so a lock carrying this invocation's own scheduled time
  // was written by an attempt that is no longer running, however fresh it looks.
  // Both sides have to name an event: a stamp with none (the previous version's
  // format) and an invocation with none (the backlog walk, the admin route) fall
  // through to the deadline rule, which is what they had before (#1181).
  if (
    scheduledFor !== undefined &&
    stamp.scheduledFor !== undefined &&
    Date.parse(stamp.scheduledFor) === scheduledFor.getTime()
  ) {
    return {
      action: 'take-over',
      heldForMs,
      overdueByMs: null,
      reason:
        `this invocation is a retry of the same scheduled event (${stamp.scheduledFor}), whose earlier attempt ` +
        `took the lock ${Math.round(heldForMs / 1000)} seconds ago; the platform only retries after that attempt ` +
        'has ended, so it was killed rather than still working',
    }
  }

  if (deadlineMs - nowMs > MAX_DEADLINE_AHEAD_MS) {
    return {
      action: 'take-over',
      heldForMs,
      overdueByMs: null,
      reason:
        `the previous run lock claims a deadline ${Math.round((deadlineMs - nowMs) / 60000)} minutes in the ` +
        'future, further ahead than any run could work to, so the stamp is wrong rather than the run long',
    }
  }

  const staleAtMs = deadlineMs + STALE_GRACE_MS
  if (nowMs >= staleAtMs) {
    return {
      action: 'take-over',
      heldForMs,
      overdueByMs: nowMs - staleAtMs,
      reason:
        `the previous run has held the lock for ${Math.round(heldForMs / 60000)} minutes, ` +
        `past its own deadline and the ${Math.round(STALE_GRACE_MS / 60000)} minute grace, ` +
        'so it was killed rather than still working',
    }
  }

  return { action: 'skip', heldForMs, deadlineInMs: deadlineMs - nowMs }
}
