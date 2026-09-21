import { beforeAll, describe, expect, it } from 'vitest'
import { easternParts, hourBucket, isOpen, type OperatingWindow } from '../clock'

// The machine clock is deliberately set far from Eastern (L504), so any code
// path that reads a local Date getter instead of the named zone shows up as a
// wrong date or minute below.
beforeAll(() => {
  process.env.TZ = 'Pacific/Kiritimati'
})

const ms = (iso: string): number => Date.parse(iso)

describe('easternParts reads America/New_York, whatever the machine zone is', () => {
  it('reads 23:59:59 on Sunday 2026-09-20 one second before Eastern midnight', () => {
    // 2026-09-21 03:59:59 UTC is 2026-09-20 23:59:59 EDT
    expect(easternParts(ms('2026-09-21T03:59:59Z'))).toEqual({
      date: '2026-09-20',
      dayOfWeek: 0,
      minuteOfDay: 23 * 60 + 59,
      hourBucket: hourBucket(ms('2026-09-21T03:59:59Z')),
    })
  })
  it('rolls to Monday 2026-09-21 00:00 at Eastern midnight', () => {
    const parts = easternParts(ms('2026-09-21T04:00:00Z'))
    expect(parts.date).toBe('2026-09-21')
    expect(parts.dayOfWeek).toBe(1)
    expect(parts.minuteOfDay).toBe(0)
  })
  it('puts the two 1am hours of 2026-11-01 in different hour buckets with the same minute of day', () => {
    // Fall back: 05:00 UTC is 01:00 EDT, 06:00 UTC is 01:00 EST
    const first = easternParts(ms('2026-11-01T05:30:00Z'))
    const second = easternParts(ms('2026-11-01T06:30:00Z'))
    expect(first.date).toBe('2026-11-01')
    expect(second.date).toBe('2026-11-01')
    expect(first.minuteOfDay).toBe(90)
    expect(second.minuteOfDay).toBe(90)
    expect(second.hourBucket).toBe(first.hourBucket + 1)
  })
  it('skips from 01:59:59 to 03:00:00 on 2027-03-14', () => {
    // Spring forward: 06:59:59 UTC is 01:59:59 EST, 07:00:00 UTC is 03:00:00 EDT
    expect(easternParts(ms('2027-03-14T06:59:59Z')).minuteOfDay).toBe(119)
    expect(easternParts(ms('2027-03-14T07:00:00Z')).minuteOfDay).toBe(180)
    expect(easternParts(ms('2027-03-14T07:00:00Z')).date).toBe('2027-03-14')
  })
  it('hour buckets are the UTC epoch hour, so clock hours line up and roll on the hour', () => {
    expect(hourBucket(ms('2026-09-21T14:59:59Z'))).toBe(hourBucket(ms('2026-09-21T14:00:00Z')))
    expect(hourBucket(ms('2026-09-21T15:00:00Z'))).toBe(hourBucket(ms('2026-09-21T14:00:00Z')) + 1)
  })
})

describe('isOpen over operating windows and blackout dates, all Eastern', () => {
  // Liberty One as Sam gave it, 8am to 6pm Pacific, which is 11:00 to 21:00 Eastern, every day.
  const libertyOne: OperatingWindow[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    opensMinute: 11 * 60,
    closesMinute: 21 * 60,
  }))
  // 2026-09-21 is a Monday. 15:00 UTC is 11:00 EDT.
  const open = ms('2026-09-21T15:00:00Z')

  it('is closed one minute before opening', () => {
    expect(isOpen(libertyOne, [], open - 60_000)).toBe(false)
  })
  it('is open at the opening minute', () => {
    expect(isOpen(libertyOne, [], open)).toBe(true)
  })
  it('is open at the last minute before closing', () => {
    expect(isOpen(libertyOne, [], ms('2026-09-22T00:59:59Z'))).toBe(true)
  })
  it('is closed at the closing minute', () => {
    expect(isOpen(libertyOne, [], ms('2026-09-22T01:00:00Z'))).toBe(false)
  })
  it('is closed on a blackout date even inside the hours', () => {
    expect(isOpen(libertyOne, ['2026-09-21'], open)).toBe(false)
  })
  it('is open again the day after a blackout date', () => {
    expect(isOpen(libertyOne, ['2026-09-21'], ms('2026-09-22T15:00:00Z'))).toBe(true)
  })
  it('is never open with no windows, because no rows means never open (L72)', () => {
    expect(isOpen([], [], open)).toBe(false)
  })
  it('honours a window on one weekday only', () => {
    const mondaysOnly: OperatingWindow[] = [{ dayOfWeek: 1, opensMinute: 0, closesMinute: 24 * 60 }]
    expect(isOpen(mondaysOnly, [], open)).toBe(true)
    expect(isOpen(mondaysOnly, [], ms('2026-09-22T15:00:00Z'))).toBe(false)
  })
  it('treats an overnight window as two rows, one either side of midnight', () => {
    const overnight: OperatingWindow[] = [
      { dayOfWeek: 1, opensMinute: 22 * 60, closesMinute: 24 * 60 },
      { dayOfWeek: 2, opensMinute: 0, closesMinute: 2 * 60 },
    ]
    expect(isOpen(overnight, [], ms('2026-09-22T03:30:00Z'))).toBe(true) // Monday 23:30 EDT
    expect(isOpen(overnight, [], ms('2026-09-22T05:30:00Z'))).toBe(true) // Tuesday 01:30 EDT
    expect(isOpen(overnight, [], ms('2026-09-22T06:30:00Z'))).toBe(false) // Tuesday 02:30 EDT
  })
})
