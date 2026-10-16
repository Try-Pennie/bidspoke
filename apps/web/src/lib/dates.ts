const ET = 'America/New_York'

/** "Apr 7, 2026, 2:34 PM EDT" */
export function formatDatetime(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(dateStr))
}

/** "Apr 7, 2026" — for list columns where time isn't relevant */
export function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(dateStr))
}

/** "Oct 14, 2:34 PM": day and clock time in ET with no zone suffix, for a column whose header says ET once. */
export function formatEtDayTime(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(dateStr))
}

/** "Oct 14, 2026, 2:34 PM": day, year and ET clock time with no zone suffix; an unreadable time comes back as given. */
export function formatEtDateTime(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)
}

/**
 * A moment in a named zone, for a figure kept in that zone's day (the held
 * clicks count's Pacific day): 'day-time' "Oct 14, 2:34 PM PDT", 'clock'
 * "2:34 PM PDT", 'day' "Oct 14". A time carries its zone's name, because it is
 * not ET. An unreadable moment comes back as given.
 */
export function formatInZone(iso: string, timeZone: string, style: 'day-time' | 'clock' | 'day'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const day = style === 'clock' ? {} : { month: 'short', day: 'numeric' } as const
  const time = style === 'day' ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } as const
  return new Intl.DateTimeFormat('en-US', { timeZone, ...day, ...time }).format(d)
}

/** "Sep 20": a calendar date (YYYY-MM-DD) as written, in no zone; an unreadable one comes back as given. */
export function formatCalendarDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d)
}

/** "2:34 PM": the ET clock time alone, for a row under a day heading. */
export function formatEtClock(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(dateStr))
}

/** "2026-10-14": the ET calendar day a moment falls on. */
export function etDayKey(at: string | number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(at))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * "Today", "Yesterday", or "Mon, Oct 12": a day heading in ET. Yesterday is the
 * calendar day before today's, so a day with a clock change still counts as one.
 */
export function etDayHeading(dateStr: string, now: number): string {
  const day = etDayKey(dateStr)
  const today = etDayKey(now)
  if (day === today) return 'Today'
  const before = new Date(`${today}T12:00:00Z`)
  before.setUTCDate(before.getUTCDate() - 1)
  if (day === before.toISOString().slice(0, 10)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(`${day}T12:00:00Z`))
}

/** "2:34:12 PM" — for execution list sidebar timestamps. Seconds matter when many runs fire in the same minute. */
export function formatTime(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date(dateStr))
}

/** "14:34:12.482" — 24-hour ET with milliseconds, for step log lines.
 * Logs fire many times per second, so seconds + millis matter; the column is
 * labeled ET once rather than repeating a timezone suffix on every line. */
export function formatLogTime(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(new Date(dateStr))
}

/** "Today" / "Yesterday" / "Apr 7" — for execution list date group headers */
export function getDateLabel(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  // Compare calendar dates in ET
  const fmt = (dt: Date) => new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt)
  const today = fmt(now)
  const yesterday = fmt(new Date(now.getTime() - 86_400_000))
  const dStr = fmt(d)
  if (dStr === today) return 'Today'
  if (dStr === yesterday) return 'Yesterday'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
  }).format(d)
}
