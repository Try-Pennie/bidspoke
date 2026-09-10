/**
 * What "is the execution archive healthy" actually means, as one answer (#959,
 * #1026, #1033).
 *
 * Answering it used to mean hand assembling seven read-only lookups: two KV
 * keys, `execution_archive_progress`, `execution_archive_ids`,
 * `execution_archive_hours`, `job_runs` and `purge_run_log`. Six of those were
 * added precisely because the state they record was invisible, so leaving them
 * unread repeats the shape they were added to fix (L46: stored data needs a
 * reader, not just a writer).
 *
 * It is worth having because every individual signal read green for nineteen
 * hours while the job archived nothing, and because a stuck run used to be
 * visible only in the four minute window before its lock self-expired.
 *
 * THIS FILE IS THE DERIVATION ONLY, no I/O. Everything below is a pure function
 * of readings the caller took, so the arithmetic that decides "can the walk
 * clear this before the oldest day is destroyed" is testable without a database
 * or a warehouse.
 */
import { RETENTION_DAYS } from './candidate-days'

/** Hours in a day the archive expects to have recorded once a day is finished. */
export const HOURS_IN_A_DAY = 24

/**
 * How much ground the backlog walk gains per hour of real time.
 *
 * The walk archives at most MAX_HOURS_PER_RUN hours per hourly run, so it gains
 * that many hours minus the one that just elapsed. Recorded here as the number
 * the projection uses rather than re-derived, because it is what decides
 * whether a manual push is needed (#1041 is the issue about the number itself
 * being too small).
 */
export const HOURS_GAINED_PER_HOUR = 1

export interface DayCoverage {
  day: string
  hoursRecorded: number
  hoursOutstanding: number
  /** Executions Postgres holds, when a measurement exists for the day. */
  pgExecutions: number | null
  /**
   * Executions Snowflake holds for the day, from the stored measurement.
   *
   * Beside `hoursExecutions` deliberately. The two count different things and a
   * difference between them is usually innocent: `archive_day` in Snowflake is
   * derived from the execution's own id, so it says when the execution
   * HAPPENED, while an hour is recorded when the archive RAN. Showing one
   * without the other is what made them look like a contradiction (#1022).
   */
  sfExecutions: number | null
  /** What the hours themselves counted when they were archived. */
  hoursExecutions: number | null
  /** The first nightly purge that can destroy this day's partition. */
  purgeDate: string
  /** Nights until that purge. Zero means tonight; negative means it is overdue. */
  nightsLeft: number
}

export interface ArchiveBacklog {
  /** The one number: hours outstanding across every day Postgres still holds. */
  hoursOutstanding: number
  oldestDayOutstanding: string | null
  nightsUntilOldestPurged: number | null
  /**
   * Whether the walk can close the gap before the oldest outstanding day is
   * destroyed. Null when nothing is outstanding.
   *
   * This is the question the number exists to answer: on 2026-08-23 the choice
   * between letting the scheduled job handle it and pushing manually was
   * guessed, and guessed wrongly twice.
   */
  clearsBeforeOldestIsPurged: boolean | null
}

/** The first nightly 03:30 UTC purge that can take a day's partition. */
export function purgeDateFor(day: string, retentionDays = RETENTION_DAYS): string {
  const at = Date.parse(`${day}T00:00:00.000Z`)
  return new Date(at + (retentionDays + 1) * 86_400_000).toISOString().slice(0, 10)
}

/** Whole nights from `now` until that day's purge. Zero means tonight. */
export function nightsUntilPurge(day: string, now: Date, retentionDays = RETENTION_DAYS): number {
  const purge = Date.parse(`${purgeDateFor(day, retentionDays)}T00:00:00.000Z`)
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  return Math.round((purge - today) / 86_400_000)
}

/**
 * Per-day coverage, oldest first.
 *
 * Oldest first because that is the order urgency runs in, and the reader is
 * deciding what to do tonight (L609).
 */
export function coverageFor(input: {
  daysHeld: string[]
  hoursByDay: Record<string, string[]>
  measurements: Record<string, { pgExecutions: number; sfExecutions: number; hoursExecutions: number }>
  now: Date
  retentionDays?: number
}): DayCoverage[] {
  const retention = input.retentionDays ?? RETENTION_DAYS
  return [...input.daysHeld]
    .sort()
    .map((day) => {
      const hoursRecorded = (input.hoursByDay[day] ?? []).length
      const measured = input.measurements[day] ?? null
      return {
        day,
        hoursRecorded,
        hoursOutstanding: Math.max(0, HOURS_IN_A_DAY - hoursRecorded),
        pgExecutions: measured?.pgExecutions ?? null,
        sfExecutions: measured?.sfExecutions ?? null,
        hoursExecutions: measured?.hoursExecutions ?? null,
        purgeDate: purgeDateFor(day, retention),
        nightsLeft: nightsUntilPurge(day, input.now, retention),
      }
    })
}

/**
 * The backlog as one number, plus whether it can be cleared in time.
 *
 * TODAY IS EXCLUDED from the outstanding total: the current UTC day is still
 * being written, so its missing hours are hours that have not happened yet.
 * Counting them would report a permanent backlog of roughly half a day and
 * make the number useless for deciding anything (L11).
 */
export function backlogFrom(coverage: DayCoverage[], now: Date): ArchiveBacklog {
  const today = now.toISOString().slice(0, 10)
  const past = coverage.filter((d) => d.day < today && d.hoursOutstanding > 0)

  const hoursOutstanding = past.reduce((total, d) => total + d.hoursOutstanding, 0)
  if (past.length === 0) {
    return {
      hoursOutstanding: 0,
      oldestDayOutstanding: null,
      nightsUntilOldestPurged: null,
      clearsBeforeOldestIsPurged: null,
    }
  }

  const oldest = past[0]
  return {
    hoursOutstanding,
    oldestDayOutstanding: oldest.day,
    nightsUntilOldestPurged: oldest.nightsLeft,
    // Hours of real time until the oldest day dies, against hours of ground the
    // walk gains in that time. A day already overdue cannot be cleared at all,
    // which nightsLeft <= 0 expresses without a special case.
    //
    // STRICTLY less than, so an exact tie reports that it does NOT clear. The
    // two ways of being wrong here are not equal: saying it will clear when it
    // will not means nobody pushes and the day is destroyed, while saying it
    // will not when it would means somebody pushes unnecessarily. Bias hard
    // toward the harmless one (L648). The walk also only gains ground on hours
    // where it wins the archive lock, so the ceiling is optimistic already.
    clearsBeforeOldestIsPurged:
      oldest.nightsLeft > 0 && hoursOutstanding < oldest.nightsLeft * 24 * HOURS_GAINED_PER_HOUR,
  }
}
