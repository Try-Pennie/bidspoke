/**
 * easternDayStartUtc (#1412): the UTC instant an Eastern calendar day begins,
 * so a query over a table partitioned on a UTC timestamp can be bounded to the
 * Eastern day the ledger counts (L39: one timezone, one date helper).
 */
import { describe, expect, it } from 'vitest'
import { EASTERN, PACIFIC, easternDayStartUtc, easternParts, zonedDayStartUtc, zonedParts } from '../clock'

describe('zonedDayStartUtc (#1546)', () => {
  it('is 07:00 UTC in summer (PDT) and 08:00 UTC in winter (PST) for the Pacific day', () => {
    expect(new Date(zonedDayStartUtc('2027-09-20', PACIFIC)).toISOString()).toBe('2027-09-20T07:00:00.000Z')
    expect(new Date(zonedDayStartUtc('2027-01-15', PACIFIC)).toISOString()).toBe('2027-01-15T08:00:00.000Z')
  })

  it('agrees with easternDayStartUtc for the Eastern day', () => {
    for (const day of ['2027-03-14', '2027-11-07', '2027-09-20']) expect(zonedDayStartUtc(day, EASTERN)).toBe(easternDayStartUtc(day))
  })

  it('lands on minute 0 of the asked for Pacific date across both clock changes', () => {
    for (const day of ['2027-03-14', '2027-03-15', '2027-11-07', '2027-11-08', '2028-02-29']) {
      const start = zonedDayStartUtc(day, PACIFIC)
      expect(zonedParts(start, PACIFIC), day).toMatchObject({ date: day, minuteOfDay: 0 })
      expect(zonedParts(start - 1, PACIFIC).date, day).not.toBe(day)
    }
  })

  it('refuses a value that is not a calendar date', () => {
    expect(() => zonedDayStartUtc('2027-02-30', PACIFIC)).toThrow(/not a calendar date/)
  })
})

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
