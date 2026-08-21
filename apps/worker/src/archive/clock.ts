/**
 * The archive's clock (#871, Phase A3): which UTC day an execution belongs to,
 * and which hour the next run should archive.
 *
 * Nothing here touches Snowflake or Postgres. It decides, it does not act.
 */

/**
 * How long after an hour closes before its executions are safe to archive.
 *
 * Measured in A0 (ADR 0009): 100% of executions had their cost written beyond
 * the 5 minute mark, and the oldest unsettled one observed was 0.59 seconds old.
 * The floor is 2 hours anyway, because the binding constraint is not the
 * execution (p99 duration 14 s, max 45 s) but the tail consumer writing
 * cost_usd, and nothing stamps when that write happened, so the margin is
 * deliberately far wider than the measurement.
 *
 * That 100% is right about latency and wrong as a universal (#931). It was
 * bucketed over one hour, and a FAILED execution may never carry a cost at all:
 * counted over every execution past this window on 2026-08-21, 20 of 764,301
 * had none, all 20 failed, the oldest 93 hours old with a completion time. So
 * widening this window does not produce a cost for those rows, and nothing may
 * treat a null cost as a reason to keep waiting. See
 * fixtures/cost-settlement.json.
 */
export const SETTLE_WINDOW_MS = 2 * 60 * 60 * 1000

const HOUR_MS = 60 * 60 * 1000

/**
 * The UTC day an execution belongs to, as YYYY-MM-DD.
 *
 * This is the TypeScript half of a rule implemented three times across this
 * milestone. The SQL expression date_trunc('day', started_at AT TIME ZONE 'UTC')
 * is the declared source of truth, and the cases in
 * fixtures/archive-day-cases.json were produced by running it against
 * production. A day derived from host-local time disagrees for four hours a day
 * in this timezone, which would put a fraction of executions in one day by the
 * archiver and the neighbouring day by the deletion gate, with both days
 * disagreeing forever and nothing reporting it (L26, L39).
 */
export function archiveDay(startedAt: string): string {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(startedAt)) {
    throw new Error(
      `"${startedAt}" carries no timezone, so its day would be read in host-local time rather than UTC`,
    )
  }
  const ms = Date.parse(startedAt)
  if (!Number.isFinite(ms)) {
    throw new Error(`"${startedAt}" is not a timestamp, so it has no archive day`)
  }
  // toISOString is always UTC, so slicing its date part is the same rule the SQL
  // applies. Deliberately NOT getFullYear/getMonth/getDate, which are local.
  return new Date(ms).toISOString().slice(0, 10)
}

export type NextHour =
  | { archive: true; hourStart: string; hourEnd: string }
  | { archive: false; reason: string }

/**
 * The hour a run should archive next, or why it should not archive one.
 *
 * Strictly one hour at a time and strictly forward. Advancing straight to the
 * newest closed hour would skip every hour in between, and skipped hours are
 * exactly the ones the deletion gate would then refuse forever.
 *
 * "Nothing to do" is its own answer with its own wording, never a quiet
 * success: a run that found no hour ready and a run that archived everything in
 * range must not read the same (L98).
 */
export function nextHourToArchive(input: { watermarkHour: string; now: Date }): NextHour {
  const watermarkMs = Date.parse(input.watermarkHour)
  if (!Number.isFinite(watermarkMs)) {
    throw new Error(`watermark "${input.watermarkHour}" is not a timestamp`)
  }
  if (watermarkMs % HOUR_MS !== 0) {
    throw new Error(
      `watermark "${input.watermarkHour}" is not on an hour boundary, so advancing from it would drift off the hour grid`,
    )
  }

  const nowMs = input.now.getTime()
  if (watermarkMs > nowMs) {
    throw new Error(
      `watermark "${input.watermarkHour}" is in the future, so no hour would ever be ready and the archive would stall silently`,
    )
  }

  const hourStartMs = watermarkMs + HOUR_MS
  const hourEndMs = hourStartMs + HOUR_MS

  if (hourEndMs > nowMs) {
    return {
      archive: false,
      reason: `the hour beginning ${new Date(hourStartMs).toISOString()} has not closed yet`,
    }
  }
  if (nowMs - hourEndMs < SETTLE_WINDOW_MS) {
    return {
      archive: false,
      reason:
        `the hour beginning ${new Date(hourStartMs).toISOString()} closed but is still inside the ` +
        `${SETTLE_WINDOW_MS / HOUR_MS} hour settle window, so its executions may not carry their cost yet`,
    }
  }

  return {
    archive: true,
    hourStart: new Date(hourStartMs).toISOString(),
    hourEnd: new Date(hourEndMs).toISOString(),
  }
}
