/**
 * Which instants a schedule fires at (#1952, #1698 1.6). One implementation
 * for the ops tick (B2), the canvas's next five fires (L150) and the converter's
 * fixture test, so the three cannot disagree.
 *
 * A cron fires at WALL times in its zone: each matching calendar day's wall
 * times are turned into instants by zonedWallTimeToUtc, the shared clock's
 * inverse of zonedParts, so a New York cron keeps its local hour across a
 * daylight saving change (Cloudflare's cron is UTC only). A wall time the spring
 * change skips fires once, moved forward by the gap (02:04 becomes 03:04 EDT); a
 * wall time the autumn change repeats fires once, at its first occurrence; and
 * two wall times that land on one instant fire once. Pipedream's own behaviour
 * at a change is unmeasured (see pipedream-timer.ts), so this is Bidspoke's rule,
 * RFC 5545's, stated rather than inherited.
 *
 * An interval fires every N seconds counted from the Unix epoch, whatever its
 * zone, so its slots are fixed instants that any tick, deploy or workflow id
 * computes identically, and one that does not divide the hour or the day simply
 * walks across them.
 *
 * Nothing here reads the machine clock: every instant is a parameter (R13).
 */
import { zonedParts, zonedWallTimeToUtc, type ScheduleZone } from '@bidspoke/buyer-profile'
import { parseCron, type CronSpec } from './cron'
import { problem, ScheduleConfigError } from './problems'

export type ScheduleTiming =
  | { kind: 'cron'; spec: CronSpec; zone: ScheduleZone }
  | { kind: 'interval'; seconds: number }

const DAY_MS = 86_400_000
/** How far a search for a cron's next fire looks. Eight years always holds two 29ths of February. */
export const SEARCH_HORIZON_DAYS = 8 * 366

/** A stored (named weekday) cron's timing; throws ScheduleConfigError with the parser's reason. */
export function cronTiming(cron: string, zone: ScheduleZone): ScheduleTiming {
  const parsed = parseCron(cron, 'bidspoke')
  if (!parsed.ok) throw new ScheduleConfigError([parsed.problem])
  return { kind: 'cron', spec: parsed.spec, zone }
}

/** The tick runs once a minute, so an interval is whole minutes of at least one. */
export function intervalProblem(seconds: unknown) {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 60 || seconds % 60 !== 0) {
    return problem('interval_invalid', `an interval of ${String(seconds)} seconds is not a whole number of minutes of at least one; the ops tick runs once a minute`)
  }
  return null
}

export function intervalTiming(seconds: number): ScheduleTiming {
  const p = intervalProblem(seconds)
  if (p) throw new ScheduleConfigError([p])
  return { kind: 'interval', seconds }
}

const isoDay = (dayMs: number): string => new Date(dayMs).toISOString().slice(0, 10)

/** The UTC midnight carrying a zone's calendar date at an instant: the date itself, as a number to step by days. */
function localDayAt(instantMs: number, zone: ScheduleZone): number {
  return Date.parse(`${zonedParts(instantMs, zone).date}T00:00:00Z`)
}

/** The fires on one local calendar day, ascending and without repeats; empty when the day does not match. */
function cronFiresOnDay(spec: CronSpec, zone: ScheduleZone, dayMs: number): number[] {
  const d = new Date(dayMs)
  if (!spec.months.has(d.getUTCMonth() + 1) || !spec.daysOfMonth.has(d.getUTCDate()) || !spec.weekdays.has(d.getUTCDay())) return []
  const date = isoDay(dayMs)
  const out: number[] = []
  for (const h of spec.hours) for (const m of spec.minutes) out.push(zonedWallTimeToUtc(date, h * 60 + m, zone).utcMs)
  out.sort((a, b) => a - b)
  return out.filter((t, i) => i === 0 || t !== out[i - 1])
}

function assertTime(ms: number, what: string): void {
  if (!Number.isFinite(ms)) throw new Error(`${what} is not a time (${ms})`)
}

/**
 * Fires strictly after `afterMs` and at or before `untilMs`, ascending, stopping
 * after `max`. The day walk stops at `untilMs`, so a short window of a rare cron
 * costs a day or two, never the horizon.
 */
function collect(timing: ScheduleTiming, afterMs: number, untilMs: number, max: number): number[] {
  assertTime(afterMs, 'the start')
  assertTime(untilMs, 'the end')
  const out: number[] = []
  if (timing.kind === 'interval') {
    const step = timing.seconds * 1000
    for (let t = (Math.floor(afterMs / step) + 1) * step; t <= untilMs && out.length < max; t += step) out.push(t)
    return out
  }
  // A day earlier than the start's local date, because a gap shift can move a fire
  // forward; then day by day until a whole day starts past the end.
  const lastDay = localDayAt(untilMs, timing.zone) + DAY_MS
  for (let day = localDayAt(afterMs, timing.zone) - DAY_MS; day <= lastDay && out.length < max; day += DAY_MS) {
    for (const t of cronFiresOnDay(timing.spec, timing.zone, day)) {
      if (t <= afterMs || t > untilMs || (out.length > 0 && t <= out[out.length - 1])) continue
      out.push(t)
      if (out.length >= max) break
    }
  }
  return out
}

/** The next `count` fires strictly after `afterMs`, within the search horizon. */
export function nextFires(timing: ScheduleTiming, afterMs: number, count: number): number[] {
  return collect(timing, afterMs, afterMs + SEARCH_HORIZON_DAYS * DAY_MS, count)
}

/**
 * Every fire in (fromExclusiveMs, toInclusiveMs]. Refuses, rather than
 * truncates, when there are more than `limit`: a silently shortened list reads
 * as nothing more being due (L24).
 */
export function firesBetween(timing: ScheduleTiming, fromExclusiveMs: number, toInclusiveMs: number, limit: number): number[] {
  const out = collect(timing, fromExclusiveMs, toInclusiveMs, limit + 1)
  if (out.length > limit) throw new Error(`more than ${limit} fires between ${new Date(fromExclusiveMs).toISOString()} and ${new Date(toInclusiveMs).toISOString()}`)
  return out
}

/** The latest fire at or before `atMs` and strictly after `afterExclusiveMs`, or null. */
export function latestFireAtOrBefore(timing: ScheduleTiming, atMs: number, afterExclusiveMs: number): number | null {
  assertTime(atMs, 'the instant')
  assertTime(afterExclusiveMs, 'the lower bound')
  if (atMs <= afterExclusiveMs) return null
  if (timing.kind === 'interval') {
    const step = timing.seconds * 1000
    const t = Math.floor(atMs / step) * step
    return t > afterExclusiveMs ? t : null
  }
  const lower = Math.max(afterExclusiveMs, atMs - SEARCH_HORIZON_DAYS * DAY_MS)
  const firstDay = localDayAt(lower, timing.zone) - DAY_MS
  for (let day = localDayAt(atMs, timing.zone) + DAY_MS; day >= firstDay; day -= DAY_MS) {
    const fires = cronFiresOnDay(timing.spec, timing.zone, day)
    for (let i = fires.length - 1; i >= 0; i--) {
      if (fires[i] <= atMs) return fires[i] > afterExclusiveMs ? fires[i] : null
    }
  }
  return null
}
