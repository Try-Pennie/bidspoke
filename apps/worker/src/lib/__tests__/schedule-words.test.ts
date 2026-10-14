/**
 * A cron schedule in words a non engineer reads (#1300). Alerts said `23 * * * *`
 * where a reader needs "every hour at :23". A shape this does not know returns
 * null, so the caller says "the next scheduled run" rather than a wrong time.
 */
import { describe, it, expect } from 'vitest'
import { scheduleInWords } from '../schedule-words'

describe('scheduleInWords', () => {
  it('reads the shapes the worker runs on', () => {
    expect(scheduleInWords('* * * * *')).toBe('every minute')
    expect(scheduleInWords('*/5 * * * *')).toBe('every 5 minutes')
    expect(scheduleInWords('23 * * * *')).toBe('every hour at :23')
    expect(scheduleInWords('0 * * * *')).toBe('every hour on the hour')
    expect(scheduleInWords('37 */2 * * *')).toBe('every 2 hours at :37')
  })

  it('reads a daily time in Eastern time, which is how the reader thinks', () => {
    // 13:00 UTC is 9:00 AM EDT in October and 8:00 AM EST in January.
    expect(scheduleInWords('0 13 * * *', new Date('2026-10-14T00:00:00Z'))).toBe('daily at 9:00 AM ET')
    expect(scheduleInWords('0 13 * * *', new Date('2026-01-14T00:00:00Z'))).toBe('daily at 8:00 AM ET')
    expect(scheduleInWords('17 8 * * *', new Date('2026-10-14T00:00:00Z'))).toBe('daily at 4:17 AM ET')
  })

  it('returns null for a shape it does not read, rather than a wrong time', () => {
    expect(scheduleInWords('0 9 * * 1')).toBeNull()
    expect(scheduleInWords('5,35 * * * *')).toBeNull()
    expect(scheduleInWords('not a cron')).toBeNull()
  })
})
