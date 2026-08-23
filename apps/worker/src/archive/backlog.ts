/**
 * Choosing which day the archive backlog walk works on next (#1015).
 *
 * The archive advances strictly forward from a watermark and never revisits, so a
 * day it did not cover stays uncovered until something goes back for it. On
 * 2026-08-23 six such days existed (2026-08-16 to 2026-08-21) and nothing had
 * reported them: the hourly run was healthy the whole time, because it was busy
 * with the current hour.
 *
 * THE CANDIDATES COME FROM THE DATA, NOT FROM A RETENTION CONSTANT. `RETENTION_DAYS`
 * said 7 while the purge jobs said 9, so a list computed from the constant began at
 * 2026-08-17 and silently excluded 2026-08-16, which was the day nearest to being
 * destroyed (#1017). Asking Postgres which days it still holds cannot drift from
 * what Postgres will actually let us read.
 *
 * It decides, it does not act.
 */

/** Hours in a full UTC day, and therefore what a completely archived day holds. */
export const HOURS_PER_DAY = 24

/**
 * Runs that gained nothing before a day is set aside (#1021).
 *
 * Three, not one: a single barren run is routinely legitimate (the invocation was
 * killed, a read timed out, Snowflake blipped) and setting the day aside on it
 * would move the walk off a day that was about to succeed. Three consecutive
 * hourly runs is three cadences, which is the same reasoning the standstill
 * threshold uses, and it is far inside the day's remaining life: the earliest a
 * backlog day is purged is the night after it enters the window.
 */
export const MAX_NO_PROGRESS_ATTEMPTS = 3

/**
 * How long a set-aside day is passed over before it is tried again.
 *
 * Setting aside is not abandoning. The cause may be transient, and the day's
 * partition will be purged whether or not anyone looks at it again, so a
 * permanent skip would be abandonment under a gentler name. Six hours is long
 * enough that the walk gets real work done on the days behind it, and short
 * enough that a day still gets several more chances before its purge night.
 */
export const SET_ASIDE_MS = 6 * 60 * 60 * 1000

/**
 * What the walk remembers between runs.
 *
 * Deliberately a plain value with no clock and no storage in it, so every
 * transition below can be driven directly. The runner is the only part that knows
 * where this lives.
 */
export interface BacklogState {
  /** Consecutive runs that recorded no new hour, per day. */
  noProgress: Record<string, number>
  /** Days passed over, each with the epoch ms at which it becomes eligible again. */
  setAsideUntil: Record<string, number>
}

export function emptyBacklogState(): BacklogState {
  return { noProgress: {}, setAsideUntil: {} }
}

/** Days still inside their set-aside window, and therefore to be passed over. */
export function daysSetAside(state: BacklogState, nowMs: number): string[] {
  return Object.entries(state.setAsideUntil)
    .filter(([, until]) => until > nowMs)
    .map(([day]) => day)
    .sort()
}

export type BacklogOutcome =
  | { kind: 'progressed' }
  /** Gained nothing, but not yet at the limit. Deliberately quiet: it may recover. */
  | { kind: 'no-progress'; attempts: number }
  /** At the limit. The walk moves on, and this is the one that must be said out loud. */
  | { kind: 'set-aside'; attempts: number; eligibleAgainAtMs: number }

/**
 * Folds one run's result into the state, and says what that result MEANS.
 *
 * Keyed on hours GAINED rather than on the run reporting failure, because the
 * failure mode this exists for answered success on every call while making no
 * progress at all (#1019). A transition reading `failed` would stay quiet through
 * exactly the case it is for.
 */
export function recordAttempt(
  state: BacklogState,
  day: string,
  progressed: boolean,
  nowMs: number,
): { state: BacklogState; outcome: BacklogOutcome } {
  const noProgress = { ...state.noProgress }
  const setAsideUntil = { ...state.setAsideUntil }

  if (progressed) {
    // Progress releases the day in both senses. A day that is moving must not
    // stay passed over, or the walk would abandon the day it just proved it can
    // work on.
    delete noProgress[day]
    delete setAsideUntil[day]
    return { state: { noProgress, setAsideUntil }, outcome: { kind: 'progressed' } }
  }

  const attempts = (noProgress[day] ?? 0) + 1
  if (attempts < MAX_NO_PROGRESS_ATTEMPTS) {
    noProgress[day] = attempts
    return { state: { noProgress, setAsideUntil }, outcome: { kind: 'no-progress', attempts } }
  }

  // The count restarts here rather than persisting. Carrying it across the window
  // would set the day aside again on its first retry for ever, which is
  // abandonment under another name.
  delete noProgress[day]
  const eligibleAgainAtMs = nowMs + SET_ASIDE_MS
  setAsideUntil[day] = eligibleAgainAtMs
  return {
    state: { noProgress, setAsideUntil },
    outcome: { kind: 'set-aside', attempts, eligibleAgainAtMs },
  }
}

/**
 * Forgets days Postgres no longer holds.
 *
 * Their rows are gone, so they can never be worked again and their counters can
 * never be cleared by progress. Without this the state grows for ever and a
 * long-dead day could still be reported as set aside.
 */
export function pruneBacklogState(state: BacklogState, daysHeldInPostgres: ReadonlySet<string>): BacklogState {
  const keep = <T,>(rec: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(rec).filter(([day]) => daysHeldInPostgres.has(day)))
  return { noProgress: keep(state.noProgress), setAsideUntil: keep(state.setAsideUntil) }
}

export interface BacklogInput {
  /** UTC days (YYYY-MM-DD) whose executions Postgres still holds. */
  daysHeldInPostgres: string[]
  /** Hours the archive has recorded, per UTC day. A day absent here has none. */
  recordedHoursByDay: Record<string, number>
  /**
   * The newest day the live archiver has finished.
   *
   * Anything after it belongs to the hourly run, not to the walk. Re-archiving a
   * day still in flight records an hour count that understates it, and the
   * deletion gate reads that count, so the repair would make the day look worse
   * than leaving it alone.
   */
  newestFinishedDay: string
  /**
   * Days to pass over because repeated runs gained nothing on them (#1021).
   *
   * Passed over only while OTHER work exists. With nothing else outstanding the
   * hard day is taken again: retrying it beats idling, since its partition is
   * going to be purged either way.
   */
  setAsideDays: ReadonlySet<string>
}

/**
 * The oldest day that is still readable and not yet fully archived, or null.
 *
 * Oldest first because that is the one closest to being purged, and a day that is
 * purged is unrecoverable rather than merely late.
 */
export function nextBacklogDay(input: BacklogInput): string | null {
  const candidates = input.daysHeldInPostgres
    // Only days the live archiver has finished with. String comparison is safe
    // and total for YYYY-MM-DD, which is why the format is fixed.
    .filter((day) => day <= input.newestFinishedDay)
    // A day missing from the map has NO recorded hours, which is the emptiest
    // kind of incomplete rather than nothing to do.
    .filter((day) => (input.recordedHoursByDay[day] ?? 0) < HOURS_PER_DAY)
    .sort()

  if (candidates.length === 0) return null

  // Prefer a day that is not set aside. Falling back to the set-aside ones rather
  // than returning null is the whole reason setting aside is not abandoning: when
  // they are all that is left, working on one is strictly better than idling.
  const notSetAside = candidates.filter((day) => !input.setAsideDays.has(day))
  return notSetAside.length > 0 ? notSetAside[0] : candidates[0]
}
