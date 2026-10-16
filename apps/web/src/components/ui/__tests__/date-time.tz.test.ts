/**
 * The typed date and time rules behind DateField and TimeField (#2137, design
 * round 1, "Typed, with a calendar"). Dates stay `YYYY-MM-DD` strings and the
 * grid is integer arithmetic, so the machine's zone cannot move a day; "today"
 * is the Eastern date. This file runs twice, under two vitest projects whose
 * processes start in America/Los_Angeles and in Pacific/Kiritimati (UTC+14),
 * the zones furthest either side of Eastern on the same calendar day.
 */
import { describe, expect, it } from 'vitest'
import {
  addDays, addMonths, daysInMonth, endOfWeek, formatShortDate, formatTime, fullDateName, monthGrid, monthTitle,
  parseTypedDate, parseTypedTime, startOfWeek, todayEastern, weekdayOf,
} from '../date-time'

// The machine zone this run was started in, measured, so a project whose zone
// did not take effect fails here rather than passing in the zone of the laptop.
const OFFSET_IN_JANUARY: Record<string, number> = { 'America/Los_Angeles': 480, 'Pacific/Kiritimati': -840 }

describe('the zone this run is in', () => {
  it('is one of the two zones the date rules are proved under, and the process really is in it', () => {
    const zone = process.env.TZ ?? ''
    expect(Object.keys(OFFSET_IN_JANUARY)).toContain(zone)
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(OFFSET_IN_JANUARY[zone])
  })
})

describe('today is the Eastern date, whatever the machine zone', () => {
  it('reads the Eastern day at an instant where Los Angeles and Kiritimati disagree with it', () => {
    // 2026-11-02 04:30 UTC is Nov 1, 11:30 PM in New York (after the clocks went
    // back that morning), Nov 1 8:30 PM in Los Angeles and Nov 2 6:30 PM in Kiritimati.
    expect(todayEastern(Date.UTC(2026, 10, 2, 4, 30))).toBe('2026-11-01')
    // One hour later it is midnight Eastern, Nov 2.
    expect(todayEastern(Date.UTC(2026, 10, 2, 5, 0))).toBe('2026-11-02')
  })

  it('crosses the spring change the same way: 2027-03-14 03:59 UTC is still Mar 13 in New York', () => {
    expect(todayEastern(Date.UTC(2027, 2, 14, 4, 59))).toBe('2027-03-13')
    expect(todayEastern(Date.UTC(2027, 2, 14, 5, 0))).toBe('2027-03-14')
  })
})

describe('calendar arithmetic is on strings, never Date objects', () => {
  it('knows the weekday of known days', () => {
    expect(weekdayOf('2026-11-26')).toBe(4) // Thursday, Thanksgiving
    expect(weekdayOf('2027-01-01')).toBe(5) // Friday
    expect(weekdayOf('2026-11-01')).toBe(0) // Sunday, the autumn change
  })

  it('counts the days of each month, leap years included', () => {
    expect(daysInMonth(2027, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2100, 2)).toBe(28)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('steps across a month and a year boundary', () => {
    expect(addDays('2027-01-31', 1)).toBe('2027-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28')
    expect(addDays('2026-11-01', 7)).toBe('2026-11-08')
    // Across both daylight saving changes: whole days, never 23 or 25 hours.
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02')
    expect(addDays('2027-03-13', 2)).toBe('2027-03-15')
  })

  it('a month step keeps the day, clamped to the shorter month', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2027-01-15', -1)).toBe('2026-12-15')
    expect(addMonths('2027-01-15', 12)).toBe('2028-01-15')
  })

  it('finds the Sunday and Saturday of a date\'s week', () => {
    expect(startOfWeek('2026-11-26')).toBe('2026-11-22')
    expect(endOfWeek('2026-11-26')).toBe('2026-11-28')
    expect(startOfWeek('2027-01-01')).toBe('2026-12-27')
  })

  it('lays a month out in weeks from Sunday, padding the first and last weeks', () => {
    const jan = monthGrid(2027, 1)
    expect(jan[0]).toEqual([null, null, null, null, null, '2027-01-01', '2027-01-02'])
    expect(jan.flat().filter(Boolean)).toHaveLength(31)
    expect(jan.every((w) => w.length === 7)).toBe(true)
    const nov = monthGrid(2026, 11)
    expect(nov[0][0]).toBe('2026-11-01')
    expect(monthTitle(2027, 1)).toBe('January 2027')
  })

  it('names a day in full for a screen reader, and briefly for the box', () => {
    expect(fullDateName('2027-01-01')).toBe('Friday, January 1, 2027')
    expect(formatShortDate('2026-11-26')).toBe('Nov 26, 2026')
  })
})

describe('a typed date', () => {
  const TODAY = '2026-10-15'
  const ok = (text: string) => parseTypedDate(text, TODAY)

  it('reads the three listed forms', () => {
    expect(ok('1/1/2027')).toEqual({ ok: true, date: '2027-01-01' })
    expect(ok('12/25/2026')).toEqual({ ok: true, date: '2026-12-25' })
    expect(ok('2027-01-01')).toEqual({ ok: true, date: '2027-01-01' })
    expect(ok('Jan 1, 2027')).toEqual({ ok: true, date: '2027-01-01' })
    expect(ok('january 1 2027')).toEqual({ ok: true, date: '2027-01-01' })
    expect(ok('  Nov 26, 2026 ')).toEqual({ ok: true, date: '2026-11-26' })
  })

  it('reads back what the box shows, both ways', () => {
    for (const iso of ['2026-11-26', '2027-01-01', '2028-02-29', '2026-12-31']) {
      expect(ok(formatShortDate(iso))).toEqual({ ok: true, date: iso })
    }
  })

  it('a missing year means the next time that day comes round, today included', () => {
    expect(ok('Dec 25')).toEqual({ ok: true, date: '2026-12-25' })
    expect(ok('Jan 1')).toEqual({ ok: true, date: '2027-01-01' })
    expect(ok('10/15')).toEqual({ ok: true, date: '2026-10-15' })
    expect(ok('10/14')).toEqual({ ok: true, date: '2027-10-14' })
    expect(ok('Feb 29')).toEqual({ ok: true, date: '2028-02-29' })
  })

  it('refuses a two digit year rather than guessing the century', () => {
    const r = ok('1/1/27')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/year in full/i)
  })

  it('refuses a day the month does not have, and anything unreadable, saying how to write one', () => {
    const feb = ok('Feb 30, 2027')
    expect(feb.ok).toBe(false)
    if (!feb.ok) expect(feb.message).toBe('February 2027 has 28 days.')
    for (const text of ['tomorrow', '13/1/2027', '2027-13-01', 'Jan', '1/1/2027x']) {
      const r = ok(text)
      expect(r.ok, text).toBe(false)
      if (!r.ok) expect(r.message, text).toMatch(/like Jan 1, 2027/)
    }
  })
})

describe('a typed time', () => {
  it('reads each listed form, and the box shows it back in one twelve hour spelling', () => {
    const cases: Array<[string, number, string]> = [
      ['9:00 AM', 540, '9:00 AM'],
      ['9am', 540, '9:00 AM'],
      ['5:00 pm', 1020, '5:00 PM'],
      ['5pm', 1020, '5:00 PM'],
      ['17:00', 1020, '5:00 PM'],
      ['12:30 pm', 750, '12:30 PM'],
      ['0:00', 0, '12:00 AM'],
    ]
    for (const [text, minutes, shown] of cases) {
      expect(parseTypedTime(text, 'start'), text).toEqual({ ok: true, minutes })
      expect(formatTime(minutes)).toBe(shown)
      expect(parseTypedTime(formatTime(minutes), 'start')).toEqual({ ok: true, minutes })
    }
  })

  it('opens at 12:00 AM is the start of the day, and closes at 12:00 AM or 11:59 PM is its end', () => {
    expect(parseTypedTime('12:00 AM', 'start')).toEqual({ ok: true, minutes: 0 })
    expect(parseTypedTime('12:00 AM', 'end')).toEqual({ ok: true, minutes: 1440 })
    expect(parseTypedTime('11:59 PM', 'end')).toEqual({ ok: true, minutes: 1440 })
    expect(parseTypedTime('11:59 PM', 'start')).toEqual({ ok: true, minutes: 1439 })
    expect(formatTime(1440)).toBe('12:00 AM')
    expect(parseTypedTime(formatTime(1440), 'end')).toEqual({ ok: true, minutes: 1440 })
  })

  it('refuses what it cannot read, saying how to write one', () => {
    for (const text of ['9', '13pm', '9:60 am', '25:00', 'noon', '0am']) {
      const r = parseTypedTime(text, 'start')
      expect(r.ok, text).toBe(false)
      if (!r.ok) expect(r.message, text).toMatch(/like 9:00 AM/)
    }
  })
})
