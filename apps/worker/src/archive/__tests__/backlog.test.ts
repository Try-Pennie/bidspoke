/**
 * Choosing which day the backlog walk works on next (#1015).
 *
 * The candidate days come from what Postgres ACTUALLY still holds, never from a
 * retention constant. The constant and the database disagreed on 2026-08-23 (the
 * code said 7 days, the purge jobs said 9), and a walk driven by the constant
 * would have skipped 2026-08-16 completely, which was the day nearest to being
 * destroyed. Asking the data removes a whole class of that mistake (#1017).
 */
import { describe, it, expect } from 'vitest'
import { nextBacklogDay } from '../backlog'

const FULL = 24

describe('nextBacklogDay', () => {
  it('takes the OLDEST day that is short of hours, because that is the one closest to being purged', () => {
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-16', '2026-08-17', '2026-08-18'],
      recordedHoursByDay: { '2026-08-16': 2, '2026-08-17': 0, '2026-08-18': FULL },
      newestFinishedDay: '2026-08-22',
    })

    expect(day).toBe('2026-08-16')
  })

  it('answers null when every day Postgres holds is fully archived', () => {
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-16', '2026-08-17'],
      recordedHoursByDay: { '2026-08-16': FULL, '2026-08-17': FULL },
      newestFinishedDay: '2026-08-22',
    })

    expect(day).toBeNull()
  })

  it('ignores a day Postgres no longer holds, however incomplete the archive is', () => {
    // Its rows are gone, so there is nothing left to read. Offering it would put
    // the walk in a loop on a day that can never be completed, which is the same
    // treadmill in a different place.
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-18'],
      recordedHoursByDay: { '2026-08-15': 0, '2026-08-18': 3 },
      newestFinishedDay: '2026-08-22',
    })

    expect(day).toBe('2026-08-18')
  })

  it('leaves alone any day the live archiver has not finished', () => {
    // The hourly run owns the frontier. Re-archiving a day still in flight would
    // record an hour count that understates it, and the deletion gate reads that
    // count, so the repair would make the day look worse than it is.
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-22', '2026-08-23'],
      recordedHoursByDay: { '2026-08-22': FULL, '2026-08-23': 6 },
      newestFinishedDay: '2026-08-22',
    })

    expect(day).toBeNull()
  })

  it('treats a day with no recorded hours at all as the emptiest kind of incomplete', () => {
    // A day absent from the recorded map is not a day with nothing to do. It is a
    // day nothing has ever looked at, which is the case this walk exists for.
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-19', '2026-08-20'],
      recordedHoursByDay: { '2026-08-20': 12 },
      newestFinishedDay: '2026-08-22',
    })

    expect(day).toBe('2026-08-19')
  })
})
