/**
 * One Eastern clock (L39, L74). Every hour, day, window and blackout the buyer
 * profiles reason about is America/New_York, and nothing here reads a local
 * Date getter, so the machine zone cannot leak in.
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

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
})

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export function hourBucket(instantMs: number): number {
  return Math.floor(instantMs / 3_600_000)
}

export function easternParts(instantMs: number): EasternParts {
  const fields: Record<string, string> = {}
  for (const part of EASTERN.formatToParts(new Date(instantMs))) {
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
