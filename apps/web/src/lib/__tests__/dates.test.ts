/**
 * Date/time formatters. The execution detail page mixes these with raw ISO
 * slices in the past (#113), so the key guarantee here is that formatLogTime
 * converts UTC to ET rather than echoing the ISO clock time.
 */
import { describe, it, expect } from 'vitest'
import { formatEtDayTime, formatLogTime } from '../dates'

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
