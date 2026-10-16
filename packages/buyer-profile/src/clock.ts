/**
 * One clock (L39, L74). Every hour, day, window and blackout the buyer
 * profiles reason about is America/New_York, and nothing here reads a local
 * Date getter, so the machine zone cannot leak in.
 *
 * The zone is a parameter of the one reader, `zonedParts`, for the few facts
 * that live on another day (#1542): the click counter's day ends at midnight
 * Pacific, because clicks arrive after offers and an Eastern day would push a
 * late evening click into the next day's count. `easternParts` is
 * `zonedParts` in New York, so the two readings cannot drift apart.
 *
 * Workflow schedules (#1952) extend this clock in place rather than fork a
 * second one (L655): a cron fires at a wall time in its zone, so they need the
 * inverse reading, `zonedWallTimeToUtc`, and UTC as a zone (SCHEDULE_ZONES).
 * Both go through zonedParts, so a schedule and a buyer's hours cannot read the
 * same instant differently at a daylight saving change.
 */

export interface OperatingWindow {
  /** 0 is Sunday, matching Postgres dow. */
  dayOfWeek: number
  /** Minute of the Eastern day, inclusive. */
  opensMinute: number
  /** Minute of the Eastern day, exclusive. 1440 means through midnight. */
  closesMinute: number
}

export interface EasternParts {
  /** YYYY-MM-DD in Eastern. */
  date: string
  /** 0 is Sunday. */
  dayOfWeek: number
  /** 0 to 1439. */
  minuteOfDay: number
  /** The UTC epoch hour. Eastern offsets are whole hours, so clock hours line up, and the repeated 1am on the autumn change is two buckets. */
  hourBucket: number
}

/** The zones the product reasons in. A closed list, so a typo is a compile error rather than a formatter throwing at run time. */
export const CLOCK_ZONES = ['America/New_York', 'America/Los_Angeles'] as const
export type ClockZone = (typeof CLOCK_ZONES)[number]
export const EASTERN: ClockZone = 'America/New_York'
export const PACIFIC: ClockZone = 'America/Los_Angeles'

/**
 * The zones a buyer profile's hours and reset times may be SHOWN in (#2143,
 * PM-10), each with the name the page shows it by. Only the partners page reads
 * this list: the hours are stored and judged in Eastern whatever is chosen, and
 * the click count still resets at midnight Pacific, so nothing that judges a
 * lead (the engine, the evaluators in this package) may read it, and
 * display-time-zone-is-display-only.test.ts fails if one does.
 *
 * The database holds the same values as a CHECK on
 * buyer_profiles.display_time_zone and refuses anything else by name
 * (display_time_zone_invalid); fixtures/display-time-zones.json carries this
 * list to the SQL suite, which compares it with the CHECK (L41, L611).
 */
export const DISPLAY_TIME_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'] as const
export type DisplayTimeZone = (typeof DISPLAY_TIME_ZONES)[number]

/** The name each zone is shown by, never the identifier (L611). */
export const DISPLAY_TIME_ZONE_LABELS: Readonly<Record<DisplayTimeZone, string>> = {
  'America/New_York': 'Eastern',
  'America/Chicago': 'Central',
  'America/Denver': 'Mountain',
  'America/Los_Angeles': 'Pacific',
}

/** What an unset display zone shows in: the zone the hours are stored in. */
export const DEFAULT_DISPLAY_TIME_ZONE: DisplayTimeZone = 'America/New_York'

export function isDisplayTimeZone(value: unknown): value is DisplayTimeZone {
  return typeof value === 'string' && (DISPLAY_TIME_ZONES as readonly string[]).includes(value)
}

/**
 * The zones a workflow schedule may fire in (#1952): the product zones plus
 * UTC, which 14 of the 77 timers in the 2026-09-30 Pipedream export use (12 as
 * `UTC`, 2 as `Etc/UTC`; the fixture is packages/workflow-definition/src/schedule/fixtures/pipedream-timers.json). Kept apart from CLOCK_ZONES so nothing that judges a lead can
 * start reading UTC, and closed for the same reason CLOCK_ZONES is: a zone the
 * offsets below do not cover would make zonedWallTimeToUtc guess.
 */
export const SCHEDULE_ZONES = [...CLOCK_ZONES, 'UTC'] as const
export type ScheduleZone = (typeof SCHEDULE_ZONES)[number]

export function isScheduleZone(value: unknown): value is ScheduleZone {
  return typeof value === 'string' && (SCHEDULE_ZONES as readonly string[]).includes(value)
}

/**
 * Every whole hour offset BEHIND UTC each zone keeps across the year. A wall
 * time is tried at each, and the candidates that read back as that wall time
 * are the answer; none or two is a daylight saving change.
 */
const OFFSET_HOURS_BEHIND_UTC: Readonly<Record<ScheduleZone, readonly number[]>> = {
  'America/New_York': [4, 5],
  'America/Los_Angeles': [7, 8],
  UTC: [0],
}

const FORMATTERS = new Map<ScheduleZone, Intl.DateTimeFormat>()

function formatterFor(zone: ScheduleZone): Intl.DateTimeFormat {
  let f = FORMATTERS.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    FORMATTERS.set(zone, f)
  }
  return f
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export function hourBucket(instantMs: number): number {
  return Math.floor(instantMs / 3_600_000)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * The year, month (1 to 12) and day of a YYYY-MM-DD calendar date, the one
 * check every reader here takes a date through. A value that is not a calendar
 * date (the wrong shape, or a 30th of February) is refused, never coerced to a
 * neighbouring day (L50).
 */
function calendarDate(isoDate: string): [number, number, number] {
  const m = ISO_DATE.exec(isoDate)
  if (!m) throw new Error(`${isoDate} is not a calendar date (YYYY-MM-DD)`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`${isoDate} is not a calendar date`)
  }
  return [y, mo, d]
}

/**
 * The UTC instant an Eastern calendar day begins (#1412). Eastern midnight is
 * 04:00 or 05:00 UTC depending on daylight saving, so the candidate is checked
 * against easternParts rather than assumed; the one that lands on minute 0 of
 * the asked for date is the answer. A value that is not a calendar date is
 * refused, never coerced to a neighbouring day (L50).
 */
export function easternDayStartUtc(isoDate: string): number {
  const [y, mo, d] = calendarDate(isoDate)
  for (const offsetHours of [4, 5]) {
    const candidate = Date.UTC(y, mo - 1, d, offsetHours)
    const parts = easternParts(candidate)
    if (parts.date === isoDate && parts.minuteOfDay === 0) return candidate
  }
  throw new Error(`${isoDate} has no Eastern midnight at a 4 or 5 hour offset`)
}

/**
 * The UTC instant a calendar day begins in a named zone (#1546): the click
 * counter's day is the PACIFIC day, and the daily reconcile bounds its
 * Salesforce read to that day. Both zones' offsets are whole hours between 4
 * and 8, so each candidate is checked against zonedParts rather than assumed,
 * exactly as easternDayStartUtc does.
 */
export function zonedDayStartUtc(isoDate: string, zone: ClockZone): number {
  const [y, mo, d] = calendarDate(isoDate)
  for (const offsetHours of [4, 5, 7, 8]) {
    const candidate = Date.UTC(y, mo - 1, d, offsetHours)
    const parts = zonedParts(candidate, zone)
    if (parts.date === isoDate && parts.minuteOfDay === 0) return candidate
  }
  throw new Error(`${isoDate} has no midnight in ${zone} at a 4 to 8 hour offset`)
}

export function easternParts(instantMs: number): EasternParts {
  return zonedParts(instantMs, EASTERN)
}

/** How a wall time was read: as written, moved forward out of a spring gap, or the first of an autumn repeat. */
export type WallTimeKind = 'exact' | 'gap_shifted' | 'overlap_first'

/**
 * The UTC instant a wall clock time on a calendar date names in a zone (#1952),
 * the inverse of zonedParts, for schedules that fire at wall times. Each of the
 * zone's offsets is tried and checked against zonedParts rather than assumed,
 * as zonedDayStartUtc does, so the two readings cannot disagree.
 *
 * The two ambiguous cases follow RFC 5545 (3.3.5) and Temporal's 'compatible'
 * disambiguation: a time the spring change skips is read with the offset in
 * force before it (02:04 becomes 03:04 daylight time, the later candidate), and
 * a time the autumn change repeats is its first occurrence. The kind says which,
 * so a caller can record it. A date that is not a calendar date or a minute
 * outside the day is refused, never coerced (L50).
 */
export function zonedWallTimeToUtc(isoDate: string, minuteOfDay: number, zone: ScheduleZone): { utcMs: number; kind: WallTimeKind } {
  const [y, mo, d] = calendarDate(isoDate)
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 1440) {
    throw new Error(`${minuteOfDay} is not a minute of the day (0 to 1439)`)
  }
  const wallAsUtc = Date.UTC(y, mo - 1, d, 0, minuteOfDay)
  const candidates = OFFSET_HOURS_BEHIND_UTC[zone].map((h) => wallAsUtc + h * 3_600_000)
  const exact = candidates.filter((c) => {
    const parts = zonedParts(c, zone)
    return parts.date === isoDate && parts.minuteOfDay === minuteOfDay
  })
  if (exact.length === 1) return { utcMs: exact[0], kind: 'exact' }
  if (exact.length > 1) return { utcMs: Math.min(...exact), kind: 'overlap_first' }
  return { utcMs: Math.max(...candidates), kind: 'gap_shifted' }
}

/** The calendar date, weekday and minute of the day at an instant in a named zone. */
export function zonedParts(instantMs: number, zone: ScheduleZone): EasternParts {
  const fields: Record<string, string> = {}
  for (const part of formatterFor(zone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  const hour = Number(fields.hour) % 24
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    dayOfWeek: WEEKDAY_INDEX[fields.weekday],
    minuteOfDay: hour * 60 + Number(fields.minute),
    hourBucket: hourBucket(instantMs),
  }
}

/**
 * Open when the Eastern date is not a blackout and some window for that weekday
 * contains the minute. No windows means never open (L72).
 */
export function isOpen(windows: readonly OperatingWindow[], blackoutDates: readonly string[], instantMs: number): boolean {
  const parts = easternParts(instantMs)
  if (blackoutDates.includes(parts.date)) return false
  return windows.some(
    (w) => w.dayOfWeek === parts.dayOfWeek && parts.minuteOfDay >= w.opensMinute && parts.minuteOfDay < w.closesMinute
  )
}

const MINUTE_MS = 60_000

/**
 * Open at some minute of [fromMs, toMs) (#1767): whether a buyer could have
 * been offered a lead at any time in the span, by the same isOpen every
 * evaluator judges one instant with, so the hours and blackout dates a span is
 * judged by cannot drift from the ones a lead is. Eastern offsets are whole
 * hours, so a span starting on a whole UTC minute is walked minute by minute
 * exactly; one that does not is refused rather than rounded (L50). An end that
 * is not a time is refused too: the loop would never run and the span would
 * read as closed, which suppresses whatever a closed answer decides (L42).
 */
export function isOpenDuring(windows: readonly OperatingWindow[], blackoutDates: readonly string[], fromMs: number, toMs: number): boolean {
  if (!Number.isFinite(fromMs)) throw new Error(`the span's start is not a time (${fromMs})`)
  if (!Number.isFinite(toMs)) throw new Error(`the span's end is not a time (${toMs})`)
  if (!Number.isInteger(fromMs) || fromMs % MINUTE_MS !== 0) {
    throw new Error(`${new Date(fromMs).toISOString()} does not start on a whole minute`)
  }
  for (let t = fromMs; t < toMs; t += MINUTE_MS) {
    if (isOpen(windows, blackoutDates, t)) return true
  }
  return false
}
