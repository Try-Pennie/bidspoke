/**
 * dailyCapObjectName (#1410): the one derivation of the daily cap object's name
 * for a partner at an instant, on the Eastern day the shared clock defines
 * (L39). Two call sites derived it inline on the UTC day; both now call this.
 */
import { describe, expect, it } from 'vitest'
import { dailyCapObjectName } from '../daily-cap-name'

describe('dailyCapObjectName', () => {
  it('names the object by slug and the Eastern date, and returns that date for the caller to show', () => {
    // 2027-09-21 03:59 UTC is still 2027-09-20 in New York.
    expect(dailyCapObjectName('tripoint', Date.UTC(2027, 8, 21, 3, 59))).toEqual({ name: 'cap-tripoint-2027-09-20', date: '2027-09-20' })
    expect(dailyCapObjectName('tripoint', Date.UTC(2027, 8, 21, 4, 0))).toEqual({ name: 'cap-tripoint-2027-09-21', date: '2027-09-21' })
  })

  it('rolls at Eastern midnight on both daylight saving change days', () => {
    // Spring forward 2027-03-14: midnight is still EST, 05:00 UTC.
    expect(dailyCapObjectName('m1', Date.UTC(2027, 2, 14, 4, 59)).date).toBe('2027-03-13')
    expect(dailyCapObjectName('m1', Date.UTC(2027, 2, 14, 5, 0)).date).toBe('2027-03-14')
    // Fall back 2027-11-07: midnight is still EDT, 04:00 UTC.
    expect(dailyCapObjectName('m1', Date.UTC(2027, 10, 7, 3, 59)).date).toBe('2027-11-06')
    expect(dailyCapObjectName('m1', Date.UTC(2027, 10, 7, 4, 0)).date).toBe('2027-11-07')
  })
})
