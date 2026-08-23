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
import {
  nextBacklogDay,
  MAX_NO_PROGRESS_ATTEMPTS,
  SET_ASIDE_MS,
  daysSetAside,
  recordAttempt,
  pruneBacklogState,
  emptyBacklogState,
  type BacklogState,
} from '../backlog'

const FULL = 24

describe('nextBacklogDay', () => {
  it('takes the OLDEST day that is short of hours, because that is the one closest to being purged', () => {
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-16', '2026-08-17', '2026-08-18'],
      recordedHoursByDay: { '2026-08-16': 2, '2026-08-17': 0, '2026-08-18': FULL },
      newestFinishedDay: '2026-08-22',
      setAsideDays: new Set(),
    })

    expect(day).toBe('2026-08-16')
  })

  it('answers null when every day Postgres holds is fully archived', () => {
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-16', '2026-08-17'],
      recordedHoursByDay: { '2026-08-16': FULL, '2026-08-17': FULL },
      newestFinishedDay: '2026-08-22',
      setAsideDays: new Set(),
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
      setAsideDays: new Set(),
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
      setAsideDays: new Set(),
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
      setAsideDays: new Set(),
    })

    expect(day).toBe('2026-08-19')
  })
})

/**
 * Setting aside a day that cannot be finished (#1021).
 *
 * The selector takes the OLDEST incomplete day, which is right, and that is
 * exactly why one unfinishable day blocks every day behind it forever. The walk
 * would select it on every run, gain nothing, and never reach the days waiting
 * behind, whose partitions get purged on schedule regardless. Every run still
 * looks busy, which is the #1019 shape in a new place.
 *
 * The memory of attempts is kept OUT of the selector so both halves stay
 * testable: the selector is told which days are set aside, and a separate
 * transition decides when a day becomes one.
 */
const NOW = Date.parse('2026-08-23T22:00:00.000Z')

describe('nextBacklogDay with days set aside (#1021)', () => {
  it('skips a set-aside day and takes the next oldest, so the days behind it are not blocked', () => {
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-16', '2026-08-17', '2026-08-18'],
      recordedHoursByDay: { '2026-08-16': 4, '2026-08-17': 0, '2026-08-18': 0 },
      newestFinishedDay: '2026-08-22',
      setAsideDays: new Set(['2026-08-16']),
    })

    expect(day).toBe('2026-08-17')
  })

  it('takes the set-aside day again once nothing else is outstanding', () => {
    // Setting aside is not abandoning. With no other work to do, retrying the
    // hard day is strictly better than idling: its partition is still going to be
    // purged either way.
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-16', '2026-08-17'],
      recordedHoursByDay: { '2026-08-16': 4, '2026-08-17': 24 },
      newestFinishedDay: '2026-08-22',
      setAsideDays: new Set(['2026-08-16']),
    })

    expect(day).toBe('2026-08-16')
  })

  it('behaves as before when no day is set aside', () => {
    const day = nextBacklogDay({
      daysHeldInPostgres: ['2026-08-16', '2026-08-17'],
      recordedHoursByDay: { '2026-08-16': 4 },
      newestFinishedDay: '2026-08-22',
      setAsideDays: new Set(),
    })

    expect(day).toBe('2026-08-16')
  })
})

describe('daysSetAside', () => {
  it('reports a day whose window has not expired', () => {
    const state: BacklogState = { noProgress: {}, setAsideUntil: { '2026-08-16': NOW + 1000 } }
    expect(daysSetAside(state, NOW)).toEqual(['2026-08-16'])
  })

  it('stops reporting a day once its window has passed, so it is retried', () => {
    // The cause may have been transient (a slow read, a Snowflake blip). A day set
    // aside forever on one bad hour would be indistinguishable from one abandoned.
    const state: BacklogState = { noProgress: {}, setAsideUntil: { '2026-08-16': NOW - 1 } }
    expect(daysSetAside(state, NOW)).toEqual([])
  })
})

describe('recordAttempt', () => {
  it('clears the count on a run that gained an hour', () => {
    const state: BacklogState = { noProgress: { '2026-08-16': 2 }, setAsideUntil: {} }
    const r = recordAttempt(state, '2026-08-16', true, NOW)

    expect(r.outcome).toEqual({ kind: 'progressed' })
    expect(r.state.noProgress['2026-08-16']).toBeUndefined()
  })

  it('counts a run that gained nothing without setting the day aside yet', () => {
    const r = recordAttempt(emptyBacklogState(), '2026-08-16', false, NOW)

    expect(r.outcome).toEqual({ kind: 'no-progress', attempts: 1 })
    expect(r.state.setAsideUntil['2026-08-16']).toBeUndefined()
  })

  it('sets the day aside on the attempt that reaches the limit', () => {
    const state: BacklogState = { noProgress: { '2026-08-16': MAX_NO_PROGRESS_ATTEMPTS - 1 }, setAsideUntil: {} }
    const r = recordAttempt(state, '2026-08-16', false, NOW)

    expect(r.outcome).toEqual({
      kind: 'set-aside',
      attempts: MAX_NO_PROGRESS_ATTEMPTS,
      eligibleAgainAtMs: NOW + SET_ASIDE_MS,
    })
    expect(r.state.setAsideUntil['2026-08-16']).toBe(NOW + SET_ASIDE_MS)
  })

  it('starts the count over after a set-aside, so the next window needs its own failures', () => {
    // Otherwise one historic bad patch would set the day aside again on its first
    // retry forever, which is abandoning it under another name.
    const state: BacklogState = { noProgress: { '2026-08-16': MAX_NO_PROGRESS_ATTEMPTS - 1 }, setAsideUntil: {} }
    const afterSetAside = recordAttempt(state, '2026-08-16', false, NOW).state
    const retry = recordAttempt(afterSetAside, '2026-08-16', false, NOW + SET_ASIDE_MS + 1)

    expect(retry.outcome).toEqual({ kind: 'no-progress', attempts: 1 })
  })

  it('progress on a set-aside day releases it immediately', () => {
    const state: BacklogState = { noProgress: {}, setAsideUntil: { '2026-08-16': NOW + SET_ASIDE_MS } }
    const r = recordAttempt(state, '2026-08-16', true, NOW)

    expect(r.state.setAsideUntil['2026-08-16']).toBeUndefined()
  })

  it('keeps other days untouched', () => {
    const state: BacklogState = { noProgress: { '2026-08-17': 1 }, setAsideUntil: { '2026-08-18': NOW + 1 } }
    const r = recordAttempt(state, '2026-08-16', false, NOW)

    expect(r.state.noProgress['2026-08-17']).toBe(1)
    expect(r.state.setAsideUntil['2026-08-18']).toBe(NOW + 1)
  })
})

describe('pruneBacklogState', () => {
  it('drops state for a day Postgres no longer holds, because it can never be worked again', () => {
    const state: BacklogState = {
      noProgress: { '2026-08-10': 3, '2026-08-17': 1 },
      setAsideUntil: { '2026-08-10': NOW + 1, '2026-08-17': NOW + 1 },
    }
    const pruned = pruneBacklogState(state, new Set(['2026-08-17']))

    expect(pruned.noProgress).toEqual({ '2026-08-17': 1 })
    expect(pruned.setAsideUntil).toEqual({ '2026-08-17': NOW + 1 })
  })

  it('keeps everything when every day is still held', () => {
    const state: BacklogState = { noProgress: { '2026-08-17': 1 }, setAsideUntil: {} }
    expect(pruneBacklogState(state, new Set(['2026-08-17', '2026-08-18']))).toEqual(state)
  })
})
