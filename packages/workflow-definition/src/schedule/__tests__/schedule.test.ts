/**
 * A schedule trigger's settings (#1952, #1698 1.6): the validator a save will
 * call, and the defaults by period. An unparseable or unsupported schedule is
 * refused with its reason, never dropped (the Hatchet anti-pattern in #1698).
 */
import { describe, expect, it } from 'vitest'
import { reattemptAtMs, scheduleDefaults, schedulePeriodSeconds, validateSchedule, type ScheduleConfig } from '../schedule'

const NY = 'America/New_York'
const HOUR_S = 3600
const DAY_S = 86_400

const daily = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  cron: '0 8 * * *',
  timezone: NY,
  overlap: 'skip',
  catch_up: 'none',
  jitter_max_seconds: 60,
  ...over,
})
const reasons = (config: unknown) => validateSchedule(config).map((p) => p.reason)

describe('schedulePeriodSeconds: the shortest gap between consecutive fires', () => {
  it('is 23 hours for a daily New York cron (the spring change) and 24 for a daily UTC one', () => {
    // The shortest gap is what the period means: how often it normally fires.
    expect(schedulePeriodSeconds({ cron: '0 8 * * *' }, NY)).toBe(23 * HOUR_S)
    expect(schedulePeriodSeconds({ cron: '0 8 * * *' }, 'UTC')).toBe(DAY_S)
  })

  it('is 24 hours for a weekday UTC cron, whose Friday to Monday gap of three days is not the shortest', () => {
    expect(schedulePeriodSeconds({ cron: '0 8 * * MON-FRI' }, 'UTC')).toBe(DAY_S)
  })

  it('is a week for a weekly cron, about a month for a monthly one, and the interval for an interval', () => {
    expect(schedulePeriodSeconds({ cron: '0 6 * * MON' }, 'UTC')).toBe(7 * DAY_S)
    expect(schedulePeriodSeconds({ cron: '0 6 1 * *' }, 'UTC')).toBe(28 * DAY_S)
    expect(schedulePeriodSeconds({ interval_seconds: 2700 }, 'UTC')).toBe(2700)
  })

  it('sees the shorter gap a spring change makes in a frequent cron whose first 800 fires end before it', () => {
    // Every two hours is 12 fires a day, so 800 fires from 1 January end in early
    // March. On 2027-03-14, 00:00 EST is 05:00Z and 02:00 is read as 03:00 EDT, 07:00Z:
    // then 04:00 EDT is 08:00Z, one hour later.
    expect(schedulePeriodSeconds({ cron: '0 */2 * * *' }, NY)).toBe(HOUR_S)
    expect(schedulePeriodSeconds({ cron: '0 */2 * * *' }, 'UTC')).toBe(2 * HOUR_S)
  })

  it('is five minutes for an every five minute cron', () => {
    expect(schedulePeriodSeconds({ cron: '*/5 8-20 * * SUN-SAT' }, NY)).toBe(300)
  })
})

describe('scheduleDefaults: catch up by period (L533)', () => {
  it('a day or less does not catch up and carries no re-attempt', () => {
    for (const timing of [{ cron: '0 8 * * *' }, { cron: '0 8 * * MON-FRI' }, { cron: '*/30 7-20 * * *' }, { interval_seconds: 43_200 }]) {
      expect(scheduleDefaults(timing, NY), JSON.stringify(timing)).toEqual({ overlap: 'skip', catch_up: 'none', jitter_max_seconds: 60 })
    }
  })

  it('a weekly cron catches up its latest missed fire within 72 hours (half a week, capped) and re-attempts after 4 hours', () => {
    expect(scheduleDefaults({ cron: '0 6 * * MON' }, NY)).toEqual({
      overlap: 'skip',
      catch_up: 'latest',
      catch_up_window_seconds: 72 * HOUR_S,
      reattempt_after_seconds: 4 * HOUR_S,
      jitter_max_seconds: 60,
    })
  })

  it('a two day interval catches up within a day, half its period', () => {
    expect(scheduleDefaults({ interval_seconds: 2 * DAY_S }, 'UTC')).toMatchObject({ catch_up: 'latest', catch_up_window_seconds: DAY_S })
  })

  it('never sets a jitter as long as half the period', () => {
    expect(scheduleDefaults({ cron: '* * * * *' }, 'UTC').jitter_max_seconds).toBe(30)
    expect(scheduleDefaults({ interval_seconds: 60 }, 'UTC').jitter_max_seconds).toBe(30)
  })

  it('every default it produces passes the validator', () => {
    for (const timing of [{ cron: '0 6 * * MON' }, { cron: '0 6 1 * *' }, { cron: '* * * * *' }, { interval_seconds: 2700 }, { interval_seconds: 3 * DAY_S }]) {
      expect(validateSchedule({ ...timing, timezone: NY, ...scheduleDefaults(timing, NY) }), JSON.stringify(timing)).toEqual([])
    }
  })
})

describe('validateSchedule', () => {
  it('accepts a well formed daily schedule and a weekly one with catch up', () => {
    expect(validateSchedule(daily())).toEqual([])
    expect(validateSchedule(daily({ cron: '0 6 * * MON', catch_up: 'latest', catch_up_window_seconds: 72 * HOUR_S, reattempt_after_seconds: 4 * HOUR_S }))).toEqual([])
  })

  it('needs exactly one of a cron and an interval', () => {
    expect(reasons({ ...daily(), cron: undefined })).toContain('schedule_needs_cron_or_interval')
    expect(reasons(daily({ interval_seconds: 3600 }))).toContain('schedule_has_cron_and_interval')
  })

  it('refuses an unparseable cron with the parser\'s reason, and a numeric weekday (L733)', () => {
    expect(reasons(daily({ cron: '0 8 * *' }))).toEqual(['cron_not_five_fields'])
    expect(reasons(daily({ cron: '0 8 * * 1-5' }))).toEqual(['cron_weekday_not_named'])
    expect(reasons(daily({ cron: 42 as unknown as string }))).toEqual(['cron_not_five_fields'])
  })

  it('refuses an interval below a minute, off the minute, or not a whole number', () => {
    for (const s of [0, 30, 90, 61.5, -60]) expect(reasons({ ...daily(), cron: undefined, interval_seconds: s }), String(s)).toEqual(['interval_invalid'])
  })

  it('refuses a zone outside the closed list by name, and Etc/UTC (the converter reads that as UTC)', () => {
    expect(reasons(daily({ timezone: 'Europe/London' as never }))).toEqual(['timezone_unsupported'])
    expect(reasons(daily({ timezone: 'Etc/UTC' as never }))).toEqual(['timezone_unsupported'])
  })

  it('refuses an overlap or catch up mode outside the vocabulary', () => {
    expect(reasons(daily({ overlap: 'parallel' as never }))).toEqual(['overlap_invalid'])
    expect(reasons(daily({ catch_up: 'all' as never }))).toEqual(['catch_up_invalid'])
  })

  it('needs a catch up window with latest, longer than a minute, at most 72 hours, and shorter than the period', () => {
    const weekly = (w: unknown) => reasons(daily({ cron: '0 6 * * MON', catch_up: 'latest', catch_up_window_seconds: w as number }))
    expect(weekly(undefined)).toEqual(['catch_up_window_invalid'])
    expect(weekly(30)).toEqual(['catch_up_window_invalid'])
    expect(weekly(73 * HOUR_S)).toEqual(['catch_up_window_invalid'])
    expect(reasons(daily({ catch_up: 'latest', catch_up_window_seconds: 2 * DAY_S }))).toEqual(['catch_up_window_invalid'])
  })

  it('refuses a catch up window on a schedule that does not catch up', () => {
    expect(reasons(daily({ catch_up_window_seconds: HOUR_S }))).toEqual(['catch_up_window_invalid'])
  })

  it('refuses a re-attempt that would land in the next period', () => {
    expect(reasons(daily({ reattempt_after_seconds: DAY_S }))).toEqual(['reattempt_after_invalid'])
    expect(reasons(daily({ reattempt_after_seconds: 10 }))).toEqual(['reattempt_after_invalid'])
    expect(reasons(daily({ reattempt_after_seconds: 4 * HOUR_S }))).toEqual([])
  })

  it('refuses a jitter that is negative, fractional, over 300 seconds, or as long as the period', () => {
    for (const j of [-1, 1.5, 301, undefined]) expect(reasons(daily({ jitter_max_seconds: j as number })), String(j)).toEqual(['jitter_invalid'])
    expect(reasons(daily({ cron: '* * * * *', jitter_max_seconds: 60 }))).toEqual(['jitter_invalid'])
    expect(reasons(daily({ jitter_max_seconds: 0 }))).toEqual([])
  })

  it('refuses something that is not a settings object at all', () => {
    expect(reasons(null)).toEqual(['schedule_needs_cron_or_interval'])
    expect(reasons('0 8 * * *')).toEqual(['schedule_needs_cron_or_interval'])
  })
})

describe('reattemptAtMs: an automatic re-attempt inside the same period (L533)', () => {
  const weekly = daily({ cron: '0 6 * * MON', catch_up: 'latest', catch_up_window_seconds: 72 * HOUR_S, reattempt_after_seconds: 4 * HOUR_S })
  const slot = Date.UTC(2027, 0, 4, 11, 0) // Monday 06:00 EST

  it('is the slot plus the re-attempt delay', () => {
    expect(reattemptAtMs(weekly, slot)).toBe(slot + 4 * HOUR_S * 1000)
  })

  it('is null for a schedule with no re-attempt', () => {
    expect(reattemptAtMs(daily(), Date.UTC(2027, 0, 4, 13, 0))).toBeNull()
  })

  it('still lands before the next slot on the shortest gap, the 23 hour spring day, because the validator bounds it by that gap', () => {
    const dailyRe = daily({ reattempt_after_seconds: 23 * HOUR_S - 60 })
    // 2027-03-13 08:00 EST; the next slot is 23 hours later, 2027-03-14 08:00 EDT (12:00Z).
    expect(reattemptAtMs(dailyRe, Date.UTC(2027, 2, 13, 13, 0))).toBe(Date.UTC(2027, 2, 14, 11, 59))
  })

  it('refuses an instant that is not one of the schedule\'s slots (L50)', () => {
    expect(() => reattemptAtMs(weekly, slot + 60_000)).toThrow(/not a slot/)
  })
})
