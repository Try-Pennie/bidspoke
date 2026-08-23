/**
 * Which days the deletion gate measures (#872).
 *
 * Both bounds produce a permanent, self-inflicted refusal when wrong, rather
 * than a visible error, so both are pinned.
 */
import { describe, it, expect } from 'vitest'
import { candidateDays, newestFinishedDay, RETENTION_DAYS } from '../candidate-days'

const NOW = new Date('2026-08-22T13:00:00.000Z')

describe('newestFinishedDay', () => {
  it('is the previous day while the watermark is mid-day', () => {
    // 21 is not finished: the archiver has only reached its 06:00 hour.
    expect(newestFinishedDay('2026-08-21T06:00:00.000Z', NOW)).toBe('2026-08-20')
  })

  it('is that day once the watermark reaches its last hour', () => {
    expect(newestFinishedDay('2026-08-21T23:00:00.000Z', NOW)).toBe('2026-08-21')
  })

  it('is still the previous day at 22:00, one hour short', () => {
    // The off-by-one that would measure a day missing its final hour, producing
    // a real shortfall that clears itself and reads as a data-loss alarm.
    expect(newestFinishedDay('2026-08-21T22:00:00.000Z', NOW)).toBe('2026-08-20')
  })

  it('never returns today, however far ahead the watermark claims to be', () => {
    expect(newestFinishedDay('2026-08-22T23:00:00.000Z', NOW)).toBe('2026-08-21')
  })

  it('returns null for a watermark it cannot read, rather than guessing a day', () => {
    expect(newestFinishedDay('not-a-time', NOW)).toBeNull()
  })
})

describe('candidateDays', () => {
  it('measures nothing when the archive has no watermark at all', () => {
    // No watermark means nothing has been archived, so every day would refuse.
    // Measuring them would fill the table with rows recording that.
    expect(candidateDays({ watermarkHour: null, now: NOW })).toEqual([])
  })

  it('runs oldest first, so a run that runs out of budget covers the days closest to deletion', () => {
    const days = candidateDays({ watermarkHour: '2026-08-21T23:00:00.000Z', now: NOW })

    expect(days[0]).toBe('2026-08-16')
    expect(days[days.length - 1]).toBe('2026-08-21')
  })

  it('stops at the retention boundary, never reaching a day whose partition is gone', () => {
    // A dropped partition counts zero executions while the archive still holds
    // them all, so the day would refuse forever with a surplus nothing could
    // clear.
    const days = candidateDays({ watermarkHour: '2026-08-21T23:00:00.000Z', now: NOW })

    expect(days).toHaveLength(RETENTION_DAYS - 1)
    expect(days).not.toContain('2026-08-15')
  })

  it('measures nothing when the archive has not finished a day inside the window', () => {
    // A watermark days behind the retention boundary: everything it has finished
    // is already dropped, and nothing it has not finished may be measured.
    expect(candidateDays({ watermarkHour: '2026-08-01T23:00:00.000Z', now: NOW })).toEqual([])
  })

  it('measures only as far as the archiver has actually got', () => {
    const days = candidateDays({ watermarkHour: '2026-08-19T23:00:00.000Z', now: NOW })

    expect(days[days.length - 1]).toBe('2026-08-19')
    expect(days).not.toContain('2026-08-20')
  })
})
