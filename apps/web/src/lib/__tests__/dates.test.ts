/**
 * Date/time formatters. The execution detail page mixes these with raw ISO
 * slices in the past (#113), so the key guarantee here is that formatLogTime
 * converts UTC to ET rather than echoing the ISO clock time.
 */
import { describe, it, expect } from 'vitest'
import { DISPLAY_TIME_ZONES } from '@bidspoke/buyer-profile'
import { etDayHeading, etDayKey, formatCalendarDay, formatEtClock, formatEtDateTime, formatEtDayTime, formatInZone, formatLogTime, zoneShiftFromEastern } from '../dates'

// #2135: the partners page's times all go through dates.ts (dates-in-partners guard).
describe('formatEtDateTime and formatCalendarDay (#2135)', () => {
  it('gives the ET day, year and clock time with no zone suffix', () => {
    expect(formatEtDateTime('2026-10-14T18:34:12.482Z')).toBe('Oct 14, 2026, 2:34 PM')
    expect(formatEtDateTime('2027-01-01T03:00:00.000Z')).toBe('Dec 31, 2026, 10:00 PM')
  })

  it('names a calendar date as written, whatever zone the browser is in', () => {
    expect(formatCalendarDay('2027-09-20')).toBe('Sep 20')
    expect(formatCalendarDay('2027-01-01')).toBe('Jan 1')
  })

  it('gives back what it cannot read, rather than Invalid Date', () => {
    expect(formatEtDateTime('not a time')).toBe('not a time')
    expect(formatCalendarDay('soon')).toBe('soon')
    expect(formatInZone('later', 'America/Los_Angeles', 'day')).toBe('later')
  })

  it('formatInZone shows a moment in a named zone, its time with the zone\'s name', () => {
    // 06:30 UTC on Oct 15 is still Oct 14 in Los Angeles (PDT, UTC-7).
    expect(formatInZone('2026-10-15T06:30:00.000Z', 'America/Los_Angeles', 'day-time')).toBe('Oct 14, 11:30 PM PDT')
    expect(formatInZone('2026-10-15T06:30:00.000Z', 'America/Los_Angeles', 'clock')).toBe('11:30 PM PDT')
    expect(formatInZone('2026-10-15T06:30:00.000Z', 'America/Los_Angeles', 'day')).toBe('Oct 14')
  })
})

describe('formatLogTime (#113)', () => {
  it('converts a UTC instant to ET, not the raw UTC clock time', () => {
    // 18:34:12.482 UTC during EDT (UTC-4) is 14:34:12.482 ET.
    const out = formatLogTime('2026-06-17T18:34:12.482Z')
    expect(out).toBe('14:34:12.482')
    // Guard against the old bug: never the raw UTC slice.
    expect(out).not.toContain('18:34')
  })

  it('keeps millisecond precision (logs fire many times per second)', () => {
    expect(formatLogTime('2026-06-17T18:00:00.007Z')).toBe('14:00:00.007')
  })

  it('uses 24-hour format with no AM/PM or timezone suffix', () => {
    const out = formatLogTime('2026-06-17T23:05:09.100Z')  // 19:05 ET
    expect(out).toBe('19:05:09.100')
    expect(out).not.toMatch(/[AP]M|ET|EDT|EST/)
  })
})

describe('formatEtDayTime (#2101)', () => {
  it('gives the ET day and clock time with no zone suffix, for a column labelled ET', () => {
    // 18:34 UTC during EDT is 2:34 PM ET.
    expect(formatEtDayTime('2026-10-14T18:34:12.482Z')).toBe('Oct 14, 2:34 PM')
    // After midnight UTC is still the previous ET day.
    expect(formatEtDayTime('2026-10-15T02:05:00.000Z')).toBe('Oct 14, 10:05 PM')
    expect(formatEtDayTime('2026-12-01T15:00:00.000Z')).toBe('Dec 1, 10:00 AM')
  })
})

describe('the incident card day headings (#2101)', () => {
  // 6:12 PM ET on Wednesday 14 October 2026.
  const NOW = Date.parse('2026-10-14T22:12:00.000Z')

  it('keys a moment by its ET calendar day', () => {
    expect(etDayKey('2026-10-15T02:05:00.000Z')).toBe('2026-10-14')
    expect(etDayKey('2026-10-15T04:05:00.000Z')).toBe('2026-10-15')
  })

  it('heads today and yesterday by name and older days by weekday and date', () => {
    expect(etDayHeading('2026-10-14T13:00:00.000Z', NOW)).toBe('Today')
    expect(etDayHeading('2026-10-14T03:30:00.000Z', NOW)).toBe('Yesterday')
    expect(etDayHeading('2026-10-14T04:30:00.000Z', NOW)).toBe('Today')
    expect(etDayHeading('2026-10-12T15:00:00.000Z', NOW)).toBe('Mon, Oct 12')
  })

  it('counts yesterday across a clock change by calendar day, not by 24 hours', () => {
    // 1 November 2026 is the day EDT ends: it has 25 hours in ET.
    const afterChange = Date.parse('2026-11-02T04:30:00.000Z') // 11:30 PM EST, Nov 1
    expect(etDayHeading('2026-10-31T23:00:00.000Z', afterChange)).toBe('Yesterday')
  })

  it('gives the clock time alone for a row under its day heading', () => {
    expect(formatEtClock('2026-10-14T18:34:00.000Z')).toBe('2:34 PM')
  })
})

describe('a display zone for the partners page (#2143, PM-10)', () => {
  // 6:34 PM UTC on Wednesday 14 October 2026: 2:34 PM Eastern, 11:34 AM Pacific.
  const AT = '2026-10-14T18:34:00.000Z'

  it('leaves every existing caller in Eastern when no zone is given', () => {
    expect(formatEtClock(AT)).toBe(formatEtClock(AT, 'America/New_York'))
    expect(formatEtDayTime(AT)).toBe(formatEtDayTime(AT, 'America/New_York'))
    expect(etDayKey(AT)).toBe(etDayKey(AT, 'America/New_York'))
  })

  it('gives the clock time in each of the four zones', () => {
    expect(DISPLAY_TIME_ZONES.map((z) => formatEtClock(AT, z))).toEqual(['2:34 PM', '1:34 PM', '12:34 PM', '11:34 AM'])
    expect(formatEtClock(Date.parse(AT), 'America/Los_Angeles')).toBe('11:34 AM')
  })

  it('gives the day and the clock time in the zone, crossing back over midnight', () => {
    expect(formatEtDayTime('2026-10-15T02:05:00.000Z', 'America/Los_Angeles')).toBe('Oct 14, 7:05 PM')
  })

  it('keys and heads a moment by the calendar day in the zone', () => {
    // 1:30 AM Eastern on Oct 14 is 10:30 PM Pacific on Oct 13.
    const early = '2026-10-14T05:30:00.000Z'
    const now = Date.parse('2026-10-14T22:12:00.000Z')
    expect(etDayKey(early)).toBe('2026-10-14')
    expect(etDayKey(early, 'America/Los_Angeles')).toBe('2026-10-13')
    expect(etDayHeading(early, now)).toBe('Today')
    expect(etDayHeading(early, now, 'America/Los_Angeles')).toBe('Yesterday')
  })

  it('says how far each zone\'s clock is from Eastern, the shift weekly hours are drawn with', () => {
    expect(DISPLAY_TIME_ZONES.map((z) => zoneShiftFromEastern(z))).toEqual([0, -60, -120, -180])
  })
})
