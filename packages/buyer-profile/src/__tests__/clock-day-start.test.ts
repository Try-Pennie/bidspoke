/**
 * easternDayStartUtc (#1412): the UTC instant an Eastern calendar day begins,
 * so a query over a table partitioned on a UTC timestamp can be bounded to the
 * Eastern day the ledger counts (L39: one timezone, one date helper).
 */
import { describe, expect, it } from 'vitest'
import { easternDayStartUtc, easternParts } from '../clock'

describe('easternDayStartUtc', () => {
  it('is 04:00 UTC in summer (EDT) and 05:00 UTC in winter (EST)', () => {
    expect(new Date(easternDayStartUtc('2027-09-20')).toISOString()).toBe('2027-09-20T04:00:00.000Z')
    expect(new Date(easternDayStartUtc('2027-01-15')).toISOString()).toBe('2027-01-15T05:00:00.000Z')
  })

  it('the instant it returns is midnight of that Eastern date, and one millisecond before is the previous date', () => {
    for (const day of ['2027-03-14', '2027-11-07', '2027-12-31', '2028-02-29']) {
      const start = easternDayStartUtc(day)
      expect(easternParts(start), day).toMatchObject({ date: day, minuteOfDay: 0 })
      expect(easternParts(start - 1).date, day).not.toBe(day)
    }
  })

  it('refuses a value that is not a calendar date', () => {
    for (const bad of ['2027-13-01', '20270920', 'today', '2027-02-30']) {
      expect(() => easternDayStartUtc(bad), bad).toThrow(/not a calendar date/)
    }
  })
})
