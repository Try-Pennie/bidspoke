/**
 * zonedWallTimeToUtc (#1952): the instant a wall clock time on a calendar date
 * names in a zone, the inverse of zonedParts. Schedules fire at wall times, so
 * the one clock answers this rather than a second date helper (L655): a cron
 * evaluator with its own offset arithmetic would disagree with every reading
 * zonedParts gives at exactly the boundaries that matter.
 *
 * The two ambiguous cases follow RFC 5545 (3.3.5) and Temporal's 'compatible'
 * disambiguation, and say which they hit:
 * - a time the spring change skips is read with the offset in force before the
 *   change, so 02:04 on that day is 03:04 daylight time;
 * - a time the autumn change repeats is its FIRST occurrence.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { SCHEDULE_ZONES, isScheduleZone, zonedParts, zonedWallTimeToUtc } from '../clock'

// Far from every zone here, so a local Date getter shows up as a wrong answer (L504).
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata'
})

const NY = 'America/New_York'

describe('zonedWallTimeToUtc', () => {
  it('reads an ordinary New York time with the offset in force that day', () => {
    expect(zonedWallTimeToUtc('2027-01-15', 8 * 60, NY)).toEqual({ utcMs: Date.UTC(2027, 0, 15, 13, 0), kind: 'exact' })
    expect(zonedWallTimeToUtc('2027-07-15', 8 * 60, NY)).toEqual({ utcMs: Date.UTC(2027, 6, 15, 12, 0), kind: 'exact' })
  })

  it('moves a time the spring change skips forward by the gap: 02:04 is 03:04 EDT', () => {
    // 2027-03-14: New York goes from 01:59 EST to 03:00 EDT.
    const r = zonedWallTimeToUtc('2027-03-14', 2 * 60 + 4, NY)
    expect(r).toEqual({ utcMs: Date.UTC(2027, 2, 14, 7, 4), kind: 'gap_shifted' })
    expect(zonedParts(r.utcMs, NY)).toMatchObject({ date: '2027-03-14', minuteOfDay: 3 * 60 + 4 })
  })

  it('takes the first of the two 01:00s the autumn change repeats', () => {
    // 2027-11-07: 01:00 EDT is 05:00 UTC, and 01:00 EST an hour later is 06:00 UTC.
    expect(zonedWallTimeToUtc('2027-11-07', 60, NY)).toEqual({ utcMs: Date.UTC(2027, 10, 7, 5, 0), kind: 'overlap_first' })
  })

  it('reads 02:04 on the autumn change day once, as EST', () => {
    expect(zonedWallTimeToUtc('2027-11-07', 2 * 60 + 4, NY)).toEqual({ utcMs: Date.UTC(2027, 10, 7, 7, 4), kind: 'exact' })
  })

  it('reads UTC with no offset at all, every day of the year', () => {
    expect(zonedWallTimeToUtc('2027-03-14', 2 * 60 + 4, 'UTC')).toEqual({ utcMs: Date.UTC(2027, 2, 14, 2, 4), kind: 'exact' })
    expect(zonedWallTimeToUtc('2027-11-07', 60, 'UTC')).toEqual({ utcMs: Date.UTC(2027, 10, 7, 1, 0), kind: 'exact' })
  })

  it('round trips through zonedParts for every minute of an ordinary day', () => {
    for (let m = 0; m < 1440; m += 7) {
      const { utcMs } = zonedWallTimeToUtc('2027-06-02', m, NY)
      expect(zonedParts(utcMs, NY)).toMatchObject({ date: '2027-06-02', minuteOfDay: m })
    }
  })

  it('refuses a date that is not a calendar date and a minute outside the day (L50)', () => {
    expect(() => zonedWallTimeToUtc('2027-02-30', 0, NY)).toThrow(/not a calendar date/)
    expect(() => zonedWallTimeToUtc('2027-2-3', 0, NY)).toThrow(/not a calendar date/)
    expect(() => zonedWallTimeToUtc('2027-02-03', 1440, NY)).toThrow(/minute of the day/)
    expect(() => zonedWallTimeToUtc('2027-02-03', -1, NY)).toThrow(/minute of the day/)
    expect(() => zonedWallTimeToUtc('2027-02-03', 1.5, NY)).toThrow(/minute of the day/)
  })
})

describe('SCHEDULE_ZONES', () => {
  it('holds the product zones plus UTC, as a closed list', () => {
    expect([...SCHEDULE_ZONES]).toEqual(['America/New_York', 'America/Los_Angeles', 'UTC'])
    expect(isScheduleZone('UTC')).toBe(true)
    expect(isScheduleZone('Etc/UTC')).toBe(false)
    expect(isScheduleZone('Europe/London')).toBe(false)
    expect(isScheduleZone(undefined)).toBe(false)
  })

  it('zonedParts reads UTC as the UTC calendar', () => {
    expect(zonedParts(Date.UTC(2027, 2, 14, 23, 59), 'UTC')).toMatchObject({ date: '2027-03-14', dayOfWeek: 0, minuteOfDay: 23 * 60 + 59 })
  })
})
