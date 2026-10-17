/**
 * The typed date and time rules behind DateField and TimeField (#2137, design
 * round 1, "Typed, with a calendar"). A date is a `YYYY-MM-DD` string from end
 * to end and every step through the calendar is integer arithmetic on it, so no
 * Date object and no machine zone ever touches a day; "today" is the Eastern
 * date, read through the one clock in @bidspoke/buyer-profile. A time is minutes
 * of the day, 0 to 1440, so a per buyer display zone can wrap it later.
 */
import { easternParts } from '@bidspoke/buyer-profile'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

const DATE_EXAMPLE = 'Type it like Jan 1, 2027.'
const TIME_EXAMPLE = 'Type it like 9:00 AM.'

// ── Days as integers ──────────────────────────────────────────────────────────

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

function parts(iso: string): [number, number, number] {
  const m = ISO.exec(iso)
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${iso}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

/** Days in a month, month 1 to 12. */
export function daysInMonth(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/** Days since 1970-01-01 of a civil date (Howard Hinnant's days_from_civil). */
function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** The civil date of a day number (civil_from_days). */
function fromDayNumber(z: number): string {
  const zz = z + 719468
  const era = Math.floor(zz / 146097)
  const doe = zz - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return iso(y, m, d)
}

/** 0 is Sunday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = parts(date)
  // 1970-01-01 was a Thursday.
  return (((dayNumber(y, m, d) + 4) % 7) + 7) % 7
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date)
  return fromDayNumber(dayNumber(y, m, d) + n)
}

/** The same day n months on, clamped to the last day of a shorter month. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = parts(date)
  const index = y * 12 + (m - 1) + n
  const ny = Math.floor(index / 12)
  const nm = index - ny * 12 + 1
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)))
}

export function startOfWeek(date: string): string {
  return addDays(date, -weekdayOf(date))
}

export function endOfWeek(date: string): string {
  return addDays(date, 6 - weekdayOf(date))
}

/** The month as weeks from Sunday to Saturday, with null where a week runs into the next or previous month. */
export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const first = iso(year, month, 1)
  const days = daysInMonth(year, month)
  const cells: Array<string | null> = Array.from({ length: weekdayOf(first) }, () => null)
  for (let d = 1; d <= days; d++) cells.push(iso(year, month, d))
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

export function monthTitle(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`
}

export function yearMonthOf(date: string): { year: number; month: number } {
  const [y, m] = parts(date)
  return { year: y, month: m }
}

export function isIsoDate(text: string): boolean {
  const m = ISO.exec(text)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)
}

/** "Friday, January 1, 2027": the name a screen reader hears for a day in the calendar. */
export function fullDateName(date: string): string {
  const [y, m, d] = parts(date)
  return `${WEEKDAYS[weekdayOf(date)]}, ${MONTHS[m - 1]} ${d}, ${y}`
}

/** "Jan 1, 2027": what the box shows, which reads back as the same date. */
export function formatShortDate(date: string): string {
  const [y, m, d] = parts(date)
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`
}

/** "Thursday, Nov 26, 2026": a day off as the blackout list shows it, with its weekday (#2325). */
export function formatWeekdayDate(date: string): string {
  return `${WEEKDAYS[weekdayOf(date)]}, ${formatShortDate(date)}`
}

/** Today's date in Eastern, the zone every blackout day is kept in. */
export function todayEastern(nowMs: number): string {
  return easternParts(nowMs).date
}

// ── Typed dates ───────────────────────────────────────────────────────────────

export type DateParse = { ok: true; date: string } | { ok: false; message: string }

function monthFromName(name: string): number | null {
  const lower = name.toLowerCase()
  if (lower.length < 3) return null
  const i = MONTHS.findIndex((m) => m.toLowerCase().startsWith(lower) || lower === m.toLowerCase().slice(0, 3))
  return i === -1 ? null : i + 1
}

/** A month and day with no year is the next time it comes round, today counting as the next. */
function nextOccurrence(month: number, day: number, today: string): DateParse {
  const [ty] = parts(today)
  for (let y = ty; y <= ty + 8; y++) {
    if (day > daysInMonth(y, month)) continue
    const candidate = iso(y, month, day)
    if (candidate >= today) return { ok: true, date: candidate }
  }
  return { ok: false, message: `${MONTHS[month - 1]} has no day ${day}. ${DATE_EXAMPLE}` }
}

function build(year: string | undefined, month: number, day: number, today: string): DateParse {
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, message: `That is not a date. ${DATE_EXAMPLE}` }
  if (year === undefined) return nextOccurrence(month, day, today)
  if (year.length !== 4) return { ok: false, message: 'Write the year in full, like Jan 1, 2027.' }
  const y = Number(year)
  const days = daysInMonth(y, month)
  if (day > days) return { ok: false, message: `${MONTHS[month - 1]} ${y} has ${days} days.` }
  return { ok: true, date: iso(y, month, day) }
}

/**
 * Reads a typed date. Accepted: `M/D/YYYY`, `YYYY-MM-DD` and `Mon D, YYYY`
 * (a month name or its first three letters, the comma optional). A missing year
 * is the next occurrence of that day; a two digit year is refused rather than
 * guessed at.
 */
export function parseTypedDate(text: string, today: string): DateParse {
  const t = text.trim()
  const numeric = /^(\d{1,2})\/(\d{1,2})(?:\/(\d+))?$/.exec(t)
  if (numeric) return build(numeric[3], Number(numeric[1]), Number(numeric[2]), today)
  const isoForm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (isoForm) return build(isoForm[1], Number(isoForm[2]), Number(isoForm[3]), today)
  const named = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d+))?$/.exec(t)
  if (named) {
    const month = monthFromName(named[1])
    if (month !== null) return build(named[3], month, Number(named[2]), today)
  }
  return { ok: false, message: `"${t}" is not a date. ${DATE_EXAMPLE}` }
}

// ── Typed times ───────────────────────────────────────────────────────────────

export type TimeParse = { ok: true; minutes: number } | { ok: false; message: string }

/**
 * Reads a typed time of day. Accepted: `9:00 AM`, `9am`, `5:00 pm`, `5pm` and
 * the 24 hour `17:00`. `edge` says which end of a window the box is: at the
 * `end`, 12:00 AM is the midnight that ends the day (1440), and so is 11:59 PM,
 * the latest a time box could say before (7 of the 12 live windows close there).
 */
export function parseTypedTime(text: string, edge: 'start' | 'end'): TimeParse {
  const t = text.trim().toLowerCase().replace(/\./g, '')
  const refuse: TimeParse = { ok: false, message: `"${text.trim()}" is not a time. ${TIME_EXAMPLE}` }
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t)
  if (!m) return refuse
  const hour = Number(m[1])
  const minute = m[2] === undefined ? 0 : Number(m[2])
  if (minute > 59) return refuse
  let minutes: number
  if (m[3] !== undefined) {
    if (hour < 1 || hour > 12) return refuse
    const pm = m[3].startsWith('p')
    minutes = ((hour % 12) + (pm ? 12 : 0)) * 60 + minute
  } else {
    // Without AM or PM only the 24 hour form with its colon is read; a bare "9" is a guess.
    if (m[2] === undefined || hour > 24 || (hour === 24 && minute !== 0)) return refuse
    minutes = hour * 60 + minute
  }
  if (edge === 'end' && (minutes === 0 || minutes === 1439)) return { ok: true, minutes: 1440 }
  if (minutes === 1440 && edge === 'start') return refuse
  return { ok: true, minutes }
}

/** The one spelling of a time on the page: "9:00 AM". 1440, the end of the day, reads as 12:00 AM. */
export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
