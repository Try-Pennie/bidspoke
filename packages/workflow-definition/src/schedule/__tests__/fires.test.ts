/**
 * The fire calculator (#1952): which instants a schedule fires at. A cron fires
 * at WALL times in its zone, read through the one shared clock
 * (@bidspoke/buyer-profile zonedWallTimeToUtc), so a New York cron keeps its
 * local hour across a daylight saving change, which Cloudflare's UTC only cron
 * cannot. An interval fires every N seconds counted from the Unix epoch, so its
 * slots are the same instants whatever workflow id or deploy computes them.
 *
 * Every instant here is a literal: nothing reads the machine clock (R13). That
 * the schedule code reads no local date getter either is held by
 * schedule-reads-no-machine-clock.test.ts, and the shared clock's own tests run
 * under a far away TZ.
 */
import { describe, expect, it } from 'vitest'
import { zonedParts } from '@bidspoke/buyer-profile'
import { cronTiming, firesBetween, intervalTiming, latestFireAtOrBefore, nextFires } from '../fires'

const NY = 'America/New_York'
const iso = (ms: number) => new Date(ms).toISOString()
const isoAll = (ms: number[]) => ms.map(iso)
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe('cron fires in New York across daylight saving', () => {
  it('keeps 08:00 local on both sides of the spring change, which moves it an hour in UTC', () => {
    const t = cronTiming('0 8 * * *', NY)
    expect(isoAll(nextFires(t, Date.UTC(2027, 2, 12, 0, 0), 4))).toEqual([
      '2027-03-12T13:00:00.000Z',
      '2027-03-13T13:00:00.000Z',
      '2027-03-14T12:00:00.000Z',
      '2027-03-15T12:00:00.000Z',
    ])
  })

  it('keeps 08:00 local across the autumn change', () => {
    const t = cronTiming('0 8 * * *', NY)
    expect(isoAll(nextFires(t, Date.UTC(2027, 10, 6, 0, 0), 2))).toEqual(['2027-11-06T12:00:00.000Z', '2027-11-07T13:00:00.000Z'])
  })

  it('fires a slot the spring change skips once, an hour later in wall time (the export\'s `4 2 * * *`)', () => {
    const t = cronTiming('4 2 * * *', NY)
    const fires = nextFires(t, Date.UTC(2027, 2, 13, 0, 0), 3)
    expect(isoAll(fires)).toEqual(['2027-03-13T07:04:00.000Z', '2027-03-14T07:04:00.000Z', '2027-03-15T06:04:00.000Z'])
    expect(zonedParts(fires[1], NY)).toMatchObject({ date: '2027-03-14', minuteOfDay: 3 * 60 + 4 })
  })

  it('fires a slot the autumn change repeats once, at its first occurrence (the export\'s `0 21,23,1,3,5 * * *`)', () => {
    const t = cronTiming('0 21,23,1,3,5 * * *', NY)
    const fires = firesBetween(t, Date.UTC(2027, 10, 7, 0, 0), Date.UTC(2027, 10, 7, 12, 0), 10)
    // 01:00 EDT (05:00Z) fires; 01:00 EST an hour later (06:00Z) does not. 03:00 and 05:00 are EST.
    expect(isoAll(fires)).toEqual(['2027-11-07T01:00:00.000Z', '2027-11-07T03:00:00.000Z', '2027-11-07T05:00:00.000Z', '2027-11-07T08:00:00.000Z', '2027-11-07T10:00:00.000Z'])
  })

  it('does not fire a gap slot twice when it lands on a slot the cron already has', () => {
    // 02:00 is skipped and read as 03:00 EDT, the instant 03:00 already names.
    const t = cronTiming('0 2,3 * * *', NY)
    expect(isoAll(firesBetween(t, Date.UTC(2027, 2, 14, 0, 0), Date.UTC(2027, 2, 14, 23, 0), 10))).toEqual(['2027-03-14T07:00:00.000Z'])
  })

  it('every five minutes in business hours is 156 fires on an ordinary day and on both change days', () => {
    const t = cronTiming('*/5 8-20 * * SUN-SAT', NY)
    for (const day of [Date.UTC(2027, 5, 1), Date.UTC(2027, 2, 14), Date.UTC(2027, 10, 7)]) {
      expect(firesBetween(t, day, day + DAY + 6 * HOUR, 400).filter((f) => zonedParts(f, NY).date === iso(day).slice(0, 10))).toHaveLength(13 * 12)
    }
  })
})

describe('cron weekdays and days of the month', () => {
  it('reads weekdays in the schedule\'s zone, not UTC', () => {
    // 22:00 Friday in New York is Saturday in UTC: the weekday is New York's.
    const t = cronTiming('0 22 * * FRI', NY)
    const [first] = nextFires(t, Date.UTC(2027, 0, 1, 0, 0), 1)
    expect(iso(first)).toBe('2027-01-02T03:00:00.000Z')
    expect(zonedParts(first, NY).dayOfWeek).toBe(5)
  })

  it('fires weekdays only, Monday to Friday', () => {
    const t = cronTiming('0 8 * * MON-FRI', NY)
    const days = nextFires(t, Date.UTC(2027, 0, 1, 0, 0), 10).map((f) => zonedParts(f, NY).dayOfWeek)
    expect(days).toEqual([5, 1, 2, 3, 4, 5, 1, 2, 3, 4])
  })

  it('fires a monthly cron on the 28th and skips the 31st in a short month', () => {
    expect(isoAll(nextFires(cronTiming('30 22 28 * *', 'UTC'), Date.UTC(2027, 0, 1), 2))).toEqual(['2027-01-28T22:30:00.000Z', '2027-02-28T22:30:00.000Z'])
    expect(isoAll(nextFires(cronTiming('0 0 31 * *', 'UTC'), Date.UTC(2027, 0, 31, 1), 2))).toEqual(['2027-03-31T00:00:00.000Z', '2027-05-31T00:00:00.000Z'])
  })

  it('fires the 29th of February only in a leap year', () => {
    expect(isoAll(nextFires(cronTiming('0 0 29 2 *', 'UTC'), Date.UTC(2027, 0, 1), 2))).toEqual(['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z'])
  })

  it('a fire exactly at the start is not after it', () => {
    const t = cronTiming('0 8 * * *', 'UTC')
    expect(iso(nextFires(t, Date.UTC(2027, 0, 1, 8, 0), 1)[0])).toBe('2027-01-02T08:00:00.000Z')
  })
})

describe('interval fires count from the epoch', () => {
  it('an hourly interval fires on the hour', () => {
    expect(isoAll(nextFires(intervalTiming(3600), Date.UTC(2027, 0, 1, 9, 30), 2))).toEqual(['2027-01-01T10:00:00.000Z', '2027-01-01T11:00:00.000Z'])
  })

  it('an interval that does not divide the hour (the export\'s 2700 s) walks across hours on fixed instants', () => {
    expect(isoAll(nextFires(intervalTiming(2700), Date.UTC(2027, 0, 1, 0, 0), 5))).toEqual([
      '2027-01-01T00:45:00.000Z',
      '2027-01-01T01:30:00.000Z',
      '2027-01-01T02:15:00.000Z',
      '2027-01-01T03:00:00.000Z',
      '2027-01-01T03:45:00.000Z',
    ])
  })

  it('an interval that does not divide the day drifts through it and stays exactly N apart across a daylight saving change', () => {
    const fires = firesBetween(intervalTiming(7 * 3600), Date.UTC(2027, 2, 13), Date.UTC(2027, 2, 16), 20)
    expect(fires.length).toBeGreaterThan(8)
    for (let i = 1; i < fires.length; i++) expect(fires[i] - fires[i - 1]).toBe(7 * HOUR)
    expect(fires[0] % (7 * HOUR)).toBe(0)
  })
})

describe('latestFireAtOrBefore', () => {
  it('finds the latest fire at or before an instant and after a lower bound', () => {
    const t = cronTiming('0 10 * * *', NY)
    expect(iso(latestFireAtOrBefore(t, Date.UTC(2027, 0, 5, 15, 0), Date.UTC(2027, 0, 1))!)).toBe('2027-01-05T15:00:00.000Z')
    expect(iso(latestFireAtOrBefore(t, Date.UTC(2027, 0, 5, 14, 59), Date.UTC(2027, 0, 1))!)).toBe('2027-01-04T15:00:00.000Z')
  })

  it('answers null when nothing fires inside the bounds, the lower bound excluded', () => {
    const t = cronTiming('0 10 * * *', NY)
    expect(latestFireAtOrBefore(t, Date.UTC(2027, 0, 5, 14, 0), Date.UTC(2027, 0, 4, 15, 0))).toBeNull()
  })

  it('finds a weekly fire a week back and an interval fire', () => {
    expect(iso(latestFireAtOrBefore(cronTiming('0 6 * * MON', NY), Date.UTC(2027, 0, 10), Date.UTC(2026, 11, 1))!)).toBe('2027-01-04T11:00:00.000Z')
    expect(iso(latestFireAtOrBefore(intervalTiming(900), Date.UTC(2027, 0, 1, 0, 14), Date.UTC(2026, 0, 1))!)).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('firesBetween', () => {
  it('excludes the start, includes the end', () => {
    const t = cronTiming('* * * * *', 'UTC')
    const from = Date.UTC(2027, 0, 1, 10, 0)
    expect(firesBetween(t, from, from + 3 * MIN, 10)).toEqual([from + MIN, from + 2 * MIN, from + 3 * MIN])
  })

  it('refuses to materialise more fires than the caller allowed, rather than truncating (L24)', () => {
    const t = cronTiming('* * * * *', 'UTC')
    expect(() => firesBetween(t, 0, 10 * MIN, 5)).toThrow(/more than 5 fires/)
  })

  it('answers an empty window of a monthly cron with nothing', () => {
    const t = cronTiming('0 6 1 * *', NY)
    expect(firesBetween(t, Date.UTC(2027, 0, 10), Date.UTC(2027, 0, 10) + 5 * MIN, 10)).toEqual([])
  })
})

describe('cronTiming and intervalTiming refuse what they cannot compute', () => {
  it('throws with the reason for a cron that does not parse', () => {
    expect(() => cronTiming('0 8 * * 1-5', NY)).toThrow(/cron_weekday_not_named/)
  })

  it('throws for an interval below a minute or off the minute', () => {
    expect(() => intervalTiming(30)).toThrow(/interval_invalid/)
    expect(() => intervalTiming(90)).toThrow(/interval_invalid/)
    expect(() => intervalTiming(Number.NaN)).toThrow(/interval_invalid/)
  })
})
