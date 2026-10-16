/**
 * A buyer's hours and reset times shown in its display zone (#2143, PM-10).
 *
 * The hours are stored and judged in Eastern whatever the profile chooses, and
 * the click count resets at midnight Pacific; the zone changes only what the
 * page shows. So the page draws the stored Eastern windows in the chosen zone
 * and turns an edit made there back into Eastern windows before it reaches the
 * profile document.
 *
 * A weekly window has no date, so it is drawn by one shift (zoneShiftFromEastern
 * in lib/dates.ts, -180 for Pacific). A window that crosses midnight in the
 * display zone is drawn on both days it touches, and Eastern midnight inside a
 * display day (9:00 PM Pacific) joins the two Eastern windows either side of it
 * into one row, so an always open week reads as seven whole days. Each row keeps
 * the stored windows it was drawn from, and an edit rewrites only those: every
 * other stored window is passed through as the same object, untouched.
 *
 * Pure, and free of any date or clock reading except through lib/dates.ts and
 * the package's own clock, so it is tested at fixed instants.
 */
import {
  DISPLAY_TIME_ZONE_LABELS,
  PACIFIC,
  zonedDayStartUtc,
  zonedParts,
  type BuyerProfileDocument,
  type DisplayTimeZone,
  type ProfileWindowDocument,
} from '@bidspoke/buyer-profile'
import { addDays, formatTime } from '@/components/ui/date-time'
import { formatEtClock, zoneShiftFromEastern } from '@/lib/dates'

const DAY = 1440
const WEEK = 7 * DAY
const mod = (n: number, m: number) => ((n % m) + m) % m

type Span = Pick<ProfileWindowDocument, 'day_of_week' | 'opens_minute' | 'closes_minute'>

/** One part of a stored window as drawn: `part` is its place among that window's parts. */
interface Piece extends Span {
  source: ProfileWindowDocument
  part: number
}

/** A row the hours editor draws, with the stored windows (and their parts) it was drawn from. */
export interface DisplayWindow extends Span {
  sources: ProfileWindowDocument[]
  pieces: Piece[]
}

/**
 * A span moved by `shift` minutes and cut at each midnight it crosses. A span
 * whose close is not after its open is kept as one span of the same length, so
 * the editor still flags it and the save still refuses it.
 */
function moved(span: Span, shift: number): Span[] {
  const start = mod(span.day_of_week * DAY + span.opens_minute + shift, WEEK)
  const length = span.closes_minute - span.opens_minute
  if (length <= 0) {
    const day = Math.floor(start / DAY)
    const opens = start - day * DAY
    return [{ day_of_week: day, opens_minute: opens, closes_minute: Math.max(0, opens + length) }]
  }
  const out: Span[] = []
  for (let s = start, end = start + length; s < end;) {
    const dayStart = Math.floor(s / DAY) * DAY
    const pieceEnd = Math.min(end, dayStart + DAY)
    out.push({ day_of_week: mod(dayStart / DAY, 7), opens_minute: s - dayStart, closes_minute: pieceEnd - dayStart })
    s = pieceEnd
  }
  return out
}

const byDayThenOpens = (a: Span, b: Span) => a.day_of_week - b.day_of_week || a.opens_minute - b.opens_minute

/** Spans drawn in the display zone, returned as the Eastern windows that store them, touching ones on a day joined. */
function toEastern(spans: readonly Span[], shift: number): ProfileWindowDocument[] {
  const out: ProfileWindowDocument[] = []
  for (const s of spans.flatMap((span) => moved(span, -shift)).sort(byDayThenOpens)) {
    const last = out[out.length - 1]
    const valid = s.closes_minute > s.opens_minute
    if (valid && last && last.day_of_week === s.day_of_week && last.closes_minute > last.opens_minute && s.opens_minute <= last.closes_minute) {
      last.closes_minute = Math.max(last.closes_minute, s.closes_minute)
    } else {
      out.push({ day_of_week: s.day_of_week, opens_minute: s.opens_minute, closes_minute: s.closes_minute })
    }
  }
  return out
}

/** The rows the hours editor draws for stored Eastern windows, shifted by `shift` minutes. */
export function displayWindows(windows: readonly ProfileWindowDocument[], shift: number): DisplayWindow[] {
  const pieces: Piece[] = windows
    .flatMap((source) => moved(source, shift).map((span, part) => ({ ...span, source, part })))
    .sort(byDayThenOpens)
  // Eastern midnight as a minute of the display day: where two Eastern days meet inside one display day.
  const junction = mod(shift, DAY)
  const rows: DisplayWindow[] = []
  for (const p of pieces) {
    const last = rows[rows.length - 1]
    if (junction !== 0 && last && last.day_of_week === p.day_of_week && last.closes_minute === junction && p.opens_minute === junction && p.closes_minute > p.opens_minute && last.closes_minute > last.opens_minute) {
      last.closes_minute = p.closes_minute
      last.sources.push(p.source)
      last.pieces.push(p)
    } else {
      rows.push({ day_of_week: p.day_of_week, opens_minute: p.opens_minute, closes_minute: p.closes_minute, sources: [p.source], pieces: [p] })
    }
  }
  return rows
}

/**
 * The stored windows after one drawn row is changed to `next`, or removed when
 * `next` is null. Only the stored windows the row was drawn from are rewritten,
 * with whatever of them lies outside the row (the other half of a window split
 * by the display zone's midnight) kept; they take the place of the first of
 * them, and every other window is the same object it was.
 */
export function replaceDisplayWindow(windows: readonly ProfileWindowDocument[], shift: number, target: DisplayWindow, next: Span | null): ProfileWindowDocument[] {
  const affected = new Set(target.sources)
  const kept: Span[] = []
  for (const source of affected) {
    moved(source, shift).forEach((span, part) => {
      if (!target.pieces.some((p) => p.source === source && p.part === part)) kept.push(span)
    })
  }
  const rewritten = toEastern(next ? [...kept, next] : kept, shift)
  const out: ProfileWindowDocument[] = []
  let placed = false
  for (const w of windows) {
    if (!affected.has(w)) out.push(w)
    else if (!placed) {
      out.push(...rewritten)
      placed = true
    }
  }
  return out
}

/** The stored windows with a window added as drawn in the display zone. */
export function addDisplayWindow(windows: readonly ProfileWindowDocument[], shift: number, next: Span): ProfileWindowDocument[] {
  return [...windows, ...toEastern([next], shift)]
}

const timeWord = (clock: string) => (clock === '12:00 AM' ? 'midnight' : clock)

/**
 * When the click count next resets, in the display zone (#1542): the count's
 * day is the Pacific day, so it resets at the next midnight Pacific, which is a
 * different hour elsewhere on the nights the clocks change (4:00 AM Eastern on
 * the March night, 2:00 AM on the November one).
 */
export function clickCountResetSentence(nowMs: number, zone: DisplayTimeZone): string {
  const tomorrow = addDays(zonedParts(nowMs, PACIFIC).date, 1)
  const reset = zonedDayStartUtc(tomorrow, PACIFIC)
  return `The count resets at ${timeWord(formatEtClock(reset, zone))} ${DISPLAY_TIME_ZONE_LABELS[zone]} time.`
}

/** Eastern midnight as a time in the display zone. Eastern midnight is never a clock change, so the shift alone gives it. */
function easternMidnightIn(zone: DisplayTimeZone): string {
  return formatTime(mod(zoneShiftFromEastern(zone), DAY))
}

/** When an offer buyer's day of counts starts, in the display zone: midnight Eastern. */
export function easternDayResetSentence(zone: DisplayTimeZone): string {
  const label = DISPLAY_TIME_ZONE_LABELS[zone]
  if (zoneShiftFromEastern(zone) === 0) return `A day runs midnight to midnight ${label} time.`
  const t = easternMidnightIn(zone)
  return `A day runs from ${t} to ${t} ${label} time, starting the evening before.`
}

/**
 * The profile document a save sends, carrying `display_time_zone` only when the
 * person changed it from what is stored (#2143). An absent key keeps the stored
 * zone, so a save made over an older copy cannot put back a zone someone else
 * has since set; null clears it. Unset and null are the same choice.
 */
export function profileWithChangedZoneOnly(profile: BuyerProfileDocument, stored: BuyerProfileDocument | null): BuyerProfileDocument {
  if ((profile.display_time_zone ?? null) !== (stored?.display_time_zone ?? null)) return profile
  const { display_time_zone: _unchanged, ...rest } = profile
  return rest
}

/** What a blackout date covers when hours are shown in another zone; nothing to say in Eastern. */
export function blackoutZoneNote(zone: DisplayTimeZone): string | null {
  if (zoneShiftFromEastern(zone) === 0) return null
  return `Each date is an Eastern day: it starts at ${easternMidnightIn(zone)} ${DISPLAY_TIME_ZONE_LABELS[zone]} time the evening before.`
}
