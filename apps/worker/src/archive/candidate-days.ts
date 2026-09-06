/**
 * Which UTC days the deletion gate should measure (#872, Phase A4).
 *
 * Two bounds, and getting either wrong produces a permanent, self-inflicted
 * refusal rather than a visible error.
 *
 * NEWEST: a day may only be measured once the archiver has FINISHED it. The
 * watermark is the last hour fully archived, so a day is finished only when the
 * watermark has reached its final hour. Measuring a day mid-flight produces a
 * genuine, correct shortfall that clears itself later, which is exactly the
 * shape that teaches everyone to ignore the gate.
 *
 * OLDEST: a day whose Postgres partition has already been dropped counts zero
 * executions while the archive still holds them all, so it would refuse forever
 * with `executions-surplus` and never be clearable. Measurement therefore stops
 * at the retention boundary.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Days of history the partitions hold: the age at which
 * `truncate_verified_execution_partitions` destroys a day.
 *
 * 7 is the designed window. It ran at 14 and then 21 from 2026-08-23 to
 * 2026-09-06 (migrations `20260823000002`, `20260824000002`) as insurance while
 * the archive backlog drained and deletion was not yet gated on the archive; the
 * gate shipped (#873, migration `20260903210000`) and #1038 put it back once every
 * retained day showed 24 archived hours (migration `20260906180000`).
 *
 * ONE NUMBER, for two purposes that must not diverge: how far back the gate
 * measures, and how long a day has left. They were one constant by accident and
 * it was wrong for both at once, then briefly two constants, which is worse. With
 * two, measuring 7 days while the deadline was 21 put the alert threshold
 * (`ALERT_WHEN_DAYS_LEFT`, three days before deletion) entirely outside the range
 * of days that get measured, so the gate could not have alerted about anything,
 * ever, while every test passed (L174). Measuring the whole retained window makes
 * that unreachable by construction: every day that still exists is a day the gate
 * vouches for.
 *
 * It must equal what the purge jobs are actually scheduled at, and
 * `apps/web/src/lib/__guards__/worker/archive-retention-matches-purge.test.ts`
 * derives that from the migrations and fails when the two differ. It has differed:
 * this said 7 while the purge ran at 21 from 2026-08-24 until 2026-09-03, so the
 * gate told the team a day was one night from deletion when it had fifteen
 * (#1017). The cron is the authority, never this line.
 */
export const RETENTION_DAYS = 7

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}

/**
 * The newest day the archiver has finished, or null if it has not finished one.
 *
 * A day is finished when the watermark is at or past its 23:00 hour, because the
 * watermark names the last hour fully archived and 23:00 is a day's last hour.
 */
export function newestFinishedDay(watermarkHour: string, now: Date): string | null {
  const watermarkMs = Date.parse(watermarkHour)
  if (!Number.isFinite(watermarkMs)) return null
  // The day the watermark sits in is finished only if the watermark IS its last
  // hour; otherwise the newest finished day is the one before it.
  const watermarkDay = dayString(watermarkMs)
  const lastHourOfThatDay = dayStartMs(watermarkDay) + 23 * HOUR_MS
  const finishedMs = watermarkMs >= lastHourOfThatDay ? dayStartMs(watermarkDay) : dayStartMs(watermarkDay) - DAY_MS
  // Never a day that has not itself ended, whatever the watermark claims.
  const todayMs = dayStartMs(dayString(now.getTime()))
  if (finishedMs >= todayMs) return dayString(todayMs - DAY_MS)
  return dayString(finishedMs)
}

/**
 * Days to measure, oldest first.
 *
 * Oldest first so a run that runs out of budget leaves the days closest to
 * deletion measured, rather than the ones with days of slack left.
 */
export function candidateDays(input: { watermarkHour: string | null; now: Date }): string[] {
  if (input.watermarkHour === null) return []
  const newest = newestFinishedDay(input.watermarkHour, input.now)
  if (newest === null) return []

  const todayMs = dayStartMs(dayString(input.now.getTime()))
  const oldestAllowedMs = todayMs - (RETENTION_DAYS - 1) * DAY_MS
  const newestMs = dayStartMs(newest)

  const days: string[] = []
  for (let ms = oldestAllowedMs; ms <= newestMs; ms += DAY_MS) days.push(dayString(ms))
  return days
}
