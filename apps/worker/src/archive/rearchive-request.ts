/**
 * Parsing and bounding a re-archive request (#976).
 *
 * Its own module because every one of these rules is a refusal, and a refusal
 * that lives inside a route handler cannot be tested against the inputs that
 * actually arrive.
 *
 * The shape it accepts is deliberately narrow. A repair that re-reads an
 * arbitrary range is a way to spend a whole invocation's budget by typo, and
 * this runs against the same production tables the hourly job does.
 */
import { SETTLE_WINDOW_MS } from './clock'

const HOUR_MS = 60 * 60 * 1000

/**
 * Hours one call may attempt.
 *
 * A day is 24, which is the largest repair anyone should need in one go, and it
 * is also roughly what the run's own budgets allow: at 202 to 257 seconds per
 * real hour the wall budget stops well before this, and the loop reports what it
 * skipped. This exists so a request for a YEAR is refused at the door rather
 * than accepted and silently truncated.
 */
export const MAX_HOURS_PER_REQUEST = 24

export type ReArchiveRequest =
  | {
      ok: true
      hours: string[]
      /**
       * Which form was used, because it decides whether already archived hours
       * are skipped.
       *
       * A 'day' is a REPAIR of whatever is missing, so hours already recorded are
       * left alone or the run cannot advance (#1019). A named 'hour' is a
       * deliberate redo of that hour, which is the only way to correct an hour
       * archived wrongly, so nothing is skipped.
       */
      form: 'day' | 'hour'
    }
  | { ok: false; reason: string }

interface RawRequest {
  hour?: unknown
  day?: unknown
}

function isHourBoundary(iso: string): boolean {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) && ms % HOUR_MS === 0
}

/**
 * Turns `{ hour }` or `{ day }` into the exact list of UTC hours to re-read.
 *
 * `now` is required, not optional: an hour that has not closed, or that is still
 * inside the settle window, would be archived incomplete and its row would then
 * UNDERSTATE the day for the deletion gate, which is worse than the missing hour
 * the repair was called to fix.
 */
export function parseReArchiveRequest(body: RawRequest, now: Date): ReArchiveRequest {
  const { hour, day } = body

  if (hour !== undefined && day !== undefined) {
    return { ok: false, reason: 'give either hour or day, not both, so it is clear what will be re-read' }
  }

  let hours: string[]
  let form: 'day' | 'hour'
  if (typeof hour === 'string') {
    if (!isHourBoundary(hour)) {
      return {
        ok: false,
        reason: `"${hour}" is not a UTC hour boundary, and the archive addresses whole hours only`,
      }
    }
    hours = [new Date(Date.parse(hour)).toISOString()]
    form = 'hour'
  } else if (typeof day === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return { ok: false, reason: `"${day}" is not a YYYY-MM-DD day` }
    }
    const dayStart = Date.parse(`${day}T00:00:00.000Z`)
    if (!Number.isFinite(dayStart)) return { ok: false, reason: `"${day}" is not a real date` }
    hours = Array.from({ length: 24 }, (_, i) => new Date(dayStart + i * HOUR_MS).toISOString())
    form = 'day'
  } else {
    // Not defaulted to anything. A missing field and a deliberate choice must
    // not produce the same work, least of all work against production tables.
    return { ok: false, reason: 'give an hour (an ISO UTC hour boundary) or a day (YYYY-MM-DD)' }
  }

  if (hours.length > MAX_HOURS_PER_REQUEST) {
    return { ok: false, reason: `at most ${MAX_HOURS_PER_REQUEST} hours per request` }
  }

  // Refused rather than trimmed. Silently dropping the hours that are not ready
  // would report a day fully re-archived while some of it was never attempted.
  const readyBefore = now.getTime() - SETTLE_WINDOW_MS - HOUR_MS
  const tooRecent = hours.filter((h) => Date.parse(h) > readyBefore)
  if (tooRecent.length > 0) {
    return {
      ok: false,
      reason:
        `${tooRecent.length} of these hours have not closed and cleared the settle window ` +
        `(the newest re-archivable hour begins ${new Date(Math.floor(readyBefore / HOUR_MS) * HOUR_MS).toISOString()}), ` +
        'and archiving one early would record a count that understates its day',
    }
  }

  return { ok: true, hours, form }
}
