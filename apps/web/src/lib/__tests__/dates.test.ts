/**
 * Date/time formatters. The execution detail page mixes these with raw ISO
 * slices in the past (#113), so the key guarantee here is that formatLogTime
 * converts UTC to ET rather than echoing the ISO clock time.
 */
import { describe, it, expect } from 'vitest'
import { etDayHeading, etDayKey, formatElapsed, formatEtClock, formatEtDayTime, formatLogTime } from '../dates'

describe('formatElapsed (#2138): the save bar\'s running time', () => {
  it('counts whole seconds, one second singular, and moves to minutes past a minute', () => {
    expect(formatElapsed(0)).toBe('0 seconds')
    expect(formatElapsed(1_400)).toBe('1 second')
    expect(formatElapsed(2_999)).toBe('2 seconds')
    expect(formatElapsed(59_999)).toBe('59 seconds')
    expect(formatElapsed(60_000)).toBe('1 minute')
    expect(formatElapsed(61_000)).toBe('1 minute 1 second')
    expect(formatElapsed(125_000)).toBe('2 minutes 5 seconds')
  })

  it('never counts below zero, so a clock that steps back says 0 seconds', () => {
    expect(formatElapsed(-5_000)).toBe('0 seconds')
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
