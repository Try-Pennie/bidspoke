/**
 * A schedule trigger's settings (#1952, #1698 1.1 and 1.6): the shape, the
 * validator a save calls, and the defaults by period.
 *
 * The shape is #1698 1.1's `schedule` member, with units named on the fields:
 * exactly one of `cron` (weekdays by name, cron.ts) or `interval_seconds`; a
 * zone from the closed SCHEDULE_ZONES list; `overlap`; `catch_up`, with its
 * window and an optional re-attempt; and the most a fire's dispatch may be
 * spread after its slot (D7). It is exported for the TriggerConfig union of
 * #1947 to carry; until that union and the save path exist, nothing stores one.
 *
 * Overlap is a vocabulary here and an enforcement in the database (#1948): skip
 * is a partial unique index on a workflow's ACTIVE scheduled run, and queue is
 * claim ordering, because a unique index on a fire time constrains one point
 * while overlap is an interval (the L693 finding on Discussion #1945).
 */
import { isScheduleZone, type ScheduleZone } from '@bidspoke/buyer-profile'
import { cronTiming, intervalProblem, intervalTiming, latestFireAtOrBefore, nextFires, type ScheduleTiming } from './fires'
import { parseCron } from './cron'
import { problem, ScheduleConfigError, type ScheduleProblem } from './problems'

export const OVERLAP_MODES = ['skip', 'queue'] as const
export type OverlapMode = (typeof OVERLAP_MODES)[number]

export const CATCH_UP_MODES = ['none', 'latest'] as const
export type CatchUpMode = (typeof CATCH_UP_MODES)[number]

export interface ScheduleConfig {
  cron?: string
  interval_seconds?: number
  timezone: ScheduleZone
  overlap: OverlapMode
  catch_up: CatchUpMode
  /** With catch_up 'latest': how far back the latest missed slot may be and still fire. */
  catch_up_window_seconds?: number
  /** After a failed run, fire the slot again this much later, inside the same period (L533). */
  reattempt_after_seconds?: number
  /** A fire is dispatched up to this long after its slot, by a fixed per workflow offset (D7). 0 is none. */
  jitter_max_seconds: number
}

export type ScheduleTimingInput = { cron: string } | { interval_seconds: number }

const HOUR_S = 3600
const DAY_S = 86_400
/** Catch up never reaches further back than this (#1698 1.6). */
export const MAX_CATCH_UP_WINDOW_SECONDS = 72 * HOUR_S
export const DEFAULT_REATTEMPT_AFTER_SECONDS = 4 * HOUR_S
export const DEFAULT_JITTER_MAX_SECONDS = 60
export const MAX_JITTER_SECONDS = 300
/** Schedules longer than this catch up by default; this or shorter do not. */
export const CATCH_UP_PERIOD_THRESHOLD_SECONDS = DAY_S

/**
 * Where the period is sampled from: fixed instants, never the clock, so a
 * schedule's defaults and validation are the same whenever they are computed.
 * 1 January; three days before each of 2027's US daylight saving changes (14
 * March and 7 November), for a cron sparse enough that its fires around the
 * change are a day or more apart; and 05:00 UTC on each change day, which is
 * before 02:00 local in New York and Los Angeles alike, for a cron so frequent
 * that 800 fires from three days earlier end before the change. A single sample
 * from January misses the shorter gap a change makes in every cron that fires
 * more than a few times a day.
 */
const PERIOD_SAMPLE_FROM_MS = [
  Date.UTC(2027, 0, 1),
  Date.UTC(2027, 2, 11),
  Date.UTC(2027, 2, 14, 5),
  Date.UTC(2027, 10, 4),
  Date.UTC(2027, 10, 7, 4),
]
const PERIOD_SAMPLE_FIRES = 800

function timingOf(input: ScheduleTimingInput, zone: ScheduleZone): ScheduleTiming {
  return 'cron' in input ? cronTiming(input.cron, zone) : intervalTiming(input.interval_seconds)
}

/**
 * The shortest gap between two consecutive fires, in seconds: how often the
 * schedule normally fires. A weekday cron's period is a day (its Friday to
 * Monday gap is three), a daily New York cron's is 23 hours (the spring change).
 * Sampled as up to 800 fires from each of the five fixed instants in
 * PERIOD_SAMPLE_FROM_MS (above): 800 fires
 * are about 13 hours of an every minute cron and up to the eight year search
 * horizon of a monthly one, so the samples are placed so that some sample
 * crosses each change whatever the cron's frequency.
 */
export function schedulePeriodSeconds(input: ScheduleTimingInput, zone: ScheduleZone): number {
  const timing = timingOf(input, zone)
  if (timing.kind === 'interval') return timing.seconds
  // The answer depends only on the cron and the zone, and the tick validates every
  // schedule every minute, so it is remembered rather than resampled.
  const key = `${zone}\u0000${(input as { cron: string }).cron}`
  const known = PERIODS.get(key)
  if (known !== undefined) return known
  let gap = Number.POSITIVE_INFINITY
  for (const from of PERIOD_SAMPLE_FROM_MS) {
    const fires = nextFires(timing, from, PERIOD_SAMPLE_FIRES)
    for (let i = 1; i < fires.length; i++) gap = Math.min(gap, fires[i] - fires[i - 1])
  }
  if (!Number.isFinite(gap)) throw new ScheduleConfigError([problem('cron_never_fires', 'the cron fires fewer than twice in eight years')])
  if (PERIODS.size >= PERIOD_MEMO_LIMIT) PERIODS.clear()
  PERIODS.set(key, gap / 1000)
  return gap / 1000
}

const PERIODS = new Map<string, number>()
const PERIOD_MEMO_LIMIT = 1000

/**
 * The settings a schedule gets unless a person chooses otherwise (L533): skip
 * an overlapping fire; a day or less does not catch up, because its next fire
 * comes soon; longer catches up its latest missed fire within half its period
 * capped at 72 hours, and re-attempts a failed run 4 hours later. The jitter is
 * 60 seconds, or half the period when that is shorter.
 */
export function scheduleDefaults(input: ScheduleTimingInput, zone: ScheduleZone): Pick<ScheduleConfig, 'overlap' | 'catch_up' | 'catch_up_window_seconds' | 'reattempt_after_seconds' | 'jitter_max_seconds'> {
  const period = schedulePeriodSeconds(input, zone)
  const jitter_max_seconds = Math.min(DEFAULT_JITTER_MAX_SECONDS, Math.floor(period / 2))
  if (period <= CATCH_UP_PERIOD_THRESHOLD_SECONDS) return { overlap: 'skip', catch_up: 'none', jitter_max_seconds }
  return {
    overlap: 'skip',
    catch_up: 'latest',
    catch_up_window_seconds: Math.min(MAX_CATCH_UP_WINDOW_SECONDS, Math.floor(period / 2)),
    reattempt_after_seconds: DEFAULT_REATTEMPT_AFTER_SECONDS,
    jitter_max_seconds,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const wholeSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/**
 * Every problem with a schedule's settings, empty when it is valid. A save
 * refuses a schedule with any (never drops it); the tick calls scheduleTiming,
 * which throws the same reasons, inside its per schedule boundary.
 */
export function validateSchedule(config: unknown): ScheduleProblem[] {
  if (!isRecord(config)) return [problem('schedule_needs_cron_or_interval', 'a schedule needs its settings')]
  const problems: ScheduleProblem[] = []
  const hasCron = config.cron !== undefined
  const hasInterval = config.interval_seconds !== undefined
  let input: ScheduleTimingInput | null = null
  if (!hasCron && !hasInterval) problems.push(problem('schedule_needs_cron_or_interval', 'a schedule needs a cron or an interval'))
  else if (hasCron && hasInterval) problems.push(problem('schedule_has_cron_and_interval', 'a schedule has a cron or an interval, not both'))
  else if (hasCron) {
    const parsed = parseCron(config.cron as string, 'bidspoke')
    if (parsed.ok) input = { cron: config.cron as string }
    else problems.push(parsed.problem)
  } else {
    const p = intervalProblem(config.interval_seconds)
    if (p) problems.push(p)
    else input = { interval_seconds: config.interval_seconds as number }
  }

  const zoneOk = isScheduleZone(config.timezone)
  if (!zoneOk) problems.push(problem('timezone_unsupported', `the zone ${String(config.timezone)} is not one a schedule may fire in (America/New_York, America/Los_Angeles, UTC)`))
  if (!(OVERLAP_MODES as readonly unknown[]).includes(config.overlap)) problems.push(problem('overlap_invalid', `overlap ${String(config.overlap)} is not skip or queue`))
  const catchUpOk = (CATCH_UP_MODES as readonly unknown[]).includes(config.catch_up)
  if (!catchUpOk) problems.push(problem('catch_up_invalid', `catch_up ${String(config.catch_up)} is not none or latest`))

  let period: number | null = null
  if (input !== null && zoneOk) {
    try {
      period = schedulePeriodSeconds(input, config.timezone as ScheduleZone)
    } catch (err) {
      if (err instanceof ScheduleConfigError) problems.push(...err.problems)
      else throw err
    }
  }

  const window = config.catch_up_window_seconds
  if (config.catch_up === 'latest') {
    if (!wholeSeconds(window) || window < 60 || window > MAX_CATCH_UP_WINDOW_SECONDS || (period !== null && window >= period)) {
      problems.push(problem('catch_up_window_invalid', `catch up needs a window of whole seconds from 60 to ${MAX_CATCH_UP_WINDOW_SECONDS}, shorter than the schedule's period, so it never reaches a slot the next one would serve`))
    }
  } else if (catchUpOk && window !== undefined) {
    problems.push(problem('catch_up_window_invalid', 'a catch up window is set on a schedule that does not catch up'))
  }

  const reattempt = config.reattempt_after_seconds
  if (reattempt !== undefined && (!wholeSeconds(reattempt) || reattempt < 60 || (period !== null && reattempt >= period))) {
    problems.push(problem('reattempt_after_invalid', 'a re-attempt is whole seconds of at least 60 and shorter than the period, so it lands before the next slot'))
  }

  const jitter = config.jitter_max_seconds
  if (!wholeSeconds(jitter) || jitter < 0 || jitter > MAX_JITTER_SECONDS || (period !== null && jitter >= period)) {
    problems.push(problem('jitter_invalid', `the jitter is whole seconds from 0 to ${MAX_JITTER_SECONDS}, shorter than the period`))
  }
  return problems
}

/** A valid schedule's timing; throws ScheduleConfigError naming every problem otherwise. */
export function scheduleTiming(config: ScheduleConfig): ScheduleTiming {
  const problems = validateSchedule(config)
  if (problems.length > 0) throw new ScheduleConfigError(problems)
  return config.cron !== undefined ? cronTiming(config.cron, config.timezone) : intervalTiming(config.interval_seconds as number)
}

/**
 * When a failed run of `scheduledForMs` is fired again (L533), or null for a
 * schedule with no re-attempt. The validator holds the delay under the
 * shortest gap, so it always lands before the next slot. An instant that is not
 * one of the schedule's slots is refused (L50).
 */
export function reattemptAtMs(config: ScheduleConfig, scheduledForMs: number): number | null {
  const timing = scheduleTiming(config)
  if (latestFireAtOrBefore(timing, scheduledForMs, scheduledForMs - 1) !== scheduledForMs) {
    throw new Error(`${new Date(scheduledForMs).toISOString()} is not a slot of this schedule`)
  }
  if (config.reattempt_after_seconds === undefined) return null
  return scheduledForMs + config.reattempt_after_seconds * 1000
}

/** What a stored trigger says about a schedule (#1949). */
export type TriggerSchedule = { kind: 'none' } | { kind: 'schedule'; config: unknown }

/**
 * The schedule a stored trigger carries, read in one place: `{ type:
 * 'schedule', config: <ScheduleConfig> }`, the `{ type, config }` shape every
 * trigger already has (the http_webhook one in apps/worker/src/types.ts). The
 * config is returned unvalidated, for the caller to judge with validateSchedule
 * inside its own boundary, so an invalid one is reported rather than dropped.
 * The ops database reads the same two fields to set a schedule's floor
 * (supabase-ops migration 20261017090000, save_workflow_copies): a change to
 * this shape when #1947's TriggerConfig union lands changes both.
 */
export function scheduleFromTrigger(trigger: unknown): TriggerSchedule {
  if (!isRecord(trigger) || trigger.type !== 'schedule') return { kind: 'none' }
  return { kind: 'schedule', config: trigger.config }
}
