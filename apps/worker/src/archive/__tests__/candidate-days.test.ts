/**
 * Which days the deletion gate measures (#872).
 *
 * Both bounds produce a permanent, self-inflicted refusal when wrong, rather
 * than a visible error, so both are pinned.
 */
import { describe, it, expect } from 'vitest'
import { candidateDays, newestFinishedDay, RETENTION_DAYS } from '../candidate-days'
import { MEASUREMENT_MAX_AGE_MS } from '../gate'

const NOW = new Date('2026-08-22T13:00:00.000Z')

/**
 * A UTC day N days before NOW.
 *
 * The window bounds are DERIVED from RETENTION_DAYS rather than written out, so
 * changing retention does not require editing dates in here. It has changed three
 * times in two weeks (7, then 14, then 21), and a fixture pinned to one of them
 * fails for a reason that looks like a defect in the code under test (L41).
 */
function daysBeforeNow(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

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

    expect(days[0]).toBe(daysBeforeNow(RETENTION_DAYS + 1))
    expect(days[days.length - 1]).toBe('2026-08-21')
  })

  it('measures one day past the retention boundary and no further', () => {
    // A day aged RETENTION_DAYS is measured: its partition is truncated at 03:30
    // UTC the NEXT morning, so at 13:00 it still exists and this is the last
    // reading the purge will see. A day aged RETENTION_DAYS + 1 should already be
    // gone; it is a candidate so that a day the purge MISSED (a lock timeout, a
    // stale reading, a gate pass that died) is measured again and taken the next
    // night rather than stranded for good (#1196). The gate skips a candidate the
    // purge has stamped as truncated, because that one would count zero
    // executions against the archive's full count. Two days past is never a
    // candidate: it would have to have been missed twice.
    const days = candidateDays({ watermarkHour: '2026-08-21T23:00:00.000Z', now: NOW })

    expect(days).toHaveLength(RETENTION_DAYS + 1)
    expect(days).toContain(daysBeforeNow(RETENTION_DAYS + 1))
    expect(days).not.toContain(daysBeforeNow(RETENTION_DAYS + 2))
  })

  it('measures the oldest day recently enough for the 03:30 UTC purge to accept it', () => {
    // The gate runs at 13:00 UTC (the `0 13 * * *` trigger in wrangler.toml) and
    // the purge at 03:30 UTC. Day D is deleted on the night of D + RETENTION_DAYS + 1,
    // so the age of its LAST measurement at that instant is what the staleness
    // bound is compared against. Measuring one day short of the boundary made
    // that age 38.5 hours against a 36 hour SQL allowance and a 30 hour one here,
    // so every eligible day was refused as stale and the schedule never deleted
    // anything (#1196). This pins the arithmetic, not the constant: change either
    // cron or either window and it recomputes.
    const days = candidateDays({ watermarkHour: '2026-08-21T23:00:00.000Z', now: NOW })
    const dueTonight = daysBeforeNow(RETENTION_DAYS)
    expect(days).toContain(dueTonight)
    const lastMeasurementMs = NOW.getTime() // NOW is a 13:00 UTC gate run
    const deletionNightMs =
      Date.parse(`${dueTonight}T03:30:00.000Z`) + (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000

    const ageAtDeletionMs = deletionNightMs - lastMeasurementMs
    expect(ageAtDeletionMs).toBeGreaterThan(0)
    expect(ageAtDeletionMs).toBeLessThan(MEASUREMENT_MAX_AGE_MS)
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
