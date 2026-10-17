import { describe, expect, it } from 'vitest'
import { scheduleFromTrigger } from '../schedule'

describe('scheduleFromTrigger (#1949)', () => {
  it('reads the config of a schedule trigger, unvalidated', () => {
    const config = { cron: '0 9 * * MON', timezone: 'America/New_York' }
    expect(scheduleFromTrigger({ type: 'schedule', config })).toEqual({ kind: 'schedule', config })
    // Unvalidated on purpose: the tick judges it inside its own boundary.
    expect(scheduleFromTrigger({ type: 'schedule' })).toEqual({ kind: 'schedule', config: undefined })
  })

  it('says none for any other trigger, and for something that is not a trigger', () => {
    for (const t of [{ type: 'http_webhook', config: {} }, null, undefined, 'schedule', [], { config: {} }]) {
      expect(scheduleFromTrigger(t)).toEqual({ kind: 'none' })
    }
  })
})
