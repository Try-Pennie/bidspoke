/**
 * zonedParts (#1542): the shared clock read in a named zone, so the click
 * counter's day (midnight Pacific) and every Eastern reading come from one
 * formatter path rather than a second date helper (L39).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { CLOCK_ZONES, easternParts, PACIFIC, zonedParts } from '../clock'

// Far from both zones, so a local Date getter anywhere shows up as a wrong date (L504).
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata'
})

describe('zonedParts in America/Los_Angeles', () => {
  it('reads 11:59pm Pacific as the same day and 12:01am as the next', () => {
    // 2027-09-21 06:59 UTC is 2027-09-20 23:59 PDT; 07:01 UTC is 00:01 on the 21st.
    expect(zonedParts(Date.UTC(2027, 8, 21, 6, 59), PACIFIC)).toMatchObject({ date: '2027-09-20', minuteOfDay: 23 * 60 + 59 })
    expect(zonedParts(Date.UTC(2027, 8, 21, 7, 1), PACIFIC)).toMatchObject({ date: '2027-09-21', minuteOfDay: 1 })
  })

  it('an Eastern day would already have rolled at 9:30pm Pacific, which is why the click day is Pacific', () => {
    const late = Date.UTC(2027, 8, 21, 4, 30) // 21:30 PDT on the 20th, 00:30 EDT on the 21st
    expect(zonedParts(late, PACIFIC).date).toBe('2027-09-20')
    expect(easternParts(late).date).toBe('2027-09-21')
  })

  it('rolls at Pacific midnight on both daylight saving change days', () => {
    // Spring forward 2027-03-14: midnight is still PST, 08:00 UTC.
    expect(zonedParts(Date.UTC(2027, 2, 14, 7, 59), PACIFIC).date).toBe('2027-03-13')
    expect(zonedParts(Date.UTC(2027, 2, 14, 8, 1), PACIFIC)).toMatchObject({ date: '2027-03-14', minuteOfDay: 1 })
    // Fall back 2027-11-07: midnight is still PDT, 07:00 UTC.
    expect(zonedParts(Date.UTC(2027, 10, 7, 6, 59), PACIFIC).date).toBe('2027-11-06')
    expect(zonedParts(Date.UTC(2027, 10, 7, 7, 1), PACIFIC)).toMatchObject({ date: '2027-11-07', minuteOfDay: 1 })
  })

  it('easternParts is zonedParts in New York, so the two cannot drift', () => {
    const t = Date.UTC(2027, 10, 7, 5, 30)
    expect(easternParts(t)).toEqual(zonedParts(t, 'America/New_York'))
  })

  it('names exactly the two zones the product reasons in', () => {
    expect([...CLOCK_ZONES]).toEqual(['America/New_York', 'America/Los_Angeles'])
  })
})
