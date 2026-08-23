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

  return candidates.length > 0 ? candidates[0] : null
}
