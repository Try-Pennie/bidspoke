/**
 * The arithmetic behind "is the archive healthy", and the one decision it
 * exists to make (#959, #1026, #1033).
 *
 * The question that actually gets asked is whether the scheduled walk will
 * close the gap on its own or whether somebody has to push it. On 2026-08-23
 * that was guessed, twice, and wrongly both times, from a dozen manual queries.
 * So the projection is tested directly rather than left to be read off a
 * dashboard.
 */
import { describe, it, expect } from 'vitest'
import {
  backlogFrom,
  coverageFor,
  nightsUntilPurge,
  purgeDateFor,
  HOURS_IN_A_DAY,
} from '../health'

const NOW = new Date('2026-09-10T12:00:00.000Z')

function fullDay(day: string): string[] {
  return Array.from({ length: HOURS_IN_A_DAY }, (_, h) => `${day}T${String(h).padStart(2, '0')}:00:00.000Z`)
}

describe('purgeDateFor', () => {
  it('names the first nightly purge that can take the day', () => {
    // Seven day retention: a day is destroyed by the run on day + 8.
    expect(purgeDateFor('2026-09-01', 7)).toBe('2026-09-09')
  })

  it('moves with the retention window rather than being written as a literal', () => {
    expect(purgeDateFor('2026-09-01', 14)).toBe('2026-09-16')
  })
})

describe('nightsUntilPurge', () => {
  it('counts whole nights, with zero meaning tonight', () => {
    expect(nightsUntilPurge('2026-09-02', NOW, 7)).toBe(0)
    expect(nightsUntilPurge('2026-09-03', NOW, 7)).toBe(1)
  })

  it('goes negative for a day the purge should already have taken', () => {
    // Negative is its own answer: retention is not being enforced, which is a
    // different situation from a day with runway (L11).
    expect(nightsUntilPurge('2026-08-30', NOW, 7)).toBeLessThan(0)
  })
})

describe('coverageFor', () => {
  it('reports each day oldest first, with what is outstanding on it', () => {
    const coverage = coverageFor({
      daysHeld: ['2026-09-05', '2026-09-03'],
      hoursByDay: { '2026-09-03': fullDay('2026-09-03'), '2026-09-05': ['h1', 'h2'] },
      measurements: {},
      now: NOW,
      retentionDays: 7,
    })

    // Oldest first, because that is the order urgency runs in.
    expect(coverage.map((d) => d.day)).toEqual(['2026-09-03', '2026-09-05'])
    expect(coverage[0].hoursOutstanding).toBe(0)
    expect(coverage[1].hoursOutstanding).toBe(22)
  })

  it('shows the Snowflake count beside the hours count rather than one alone', () => {
    // These legitimately differ: archive_day says when the execution HAPPENED,
    // an hour is recorded when the archive RAN. Showing one without the other
    // is what made them look like a contradiction (#1022).
    const coverage = coverageFor({
      daysHeld: ['2026-09-03'],
      hoursByDay: { '2026-09-03': fullDay('2026-09-03') },
      measurements: { '2026-09-03': { pgExecutions: 100, sfExecutions: 100, hoursExecutions: 97 } },
      now: NOW,
      retentionDays: 7,
    })

    expect(coverage[0]).toMatchObject({ pgExecutions: 100, sfExecutions: 100, hoursExecutions: 97 })
  })

  it('says a day has no measurement rather than reporting it as zero', () => {
    const coverage = coverageFor({
      daysHeld: ['2026-09-03'],
      hoursByDay: {},
      measurements: {},
      now: NOW,
      retentionDays: 7,
    })

    // Zero executions and "never measured" are different facts, and only one of
    // them is a reason to act (L90).
    expect(coverage[0].pgExecutions).toBeNull()
    expect(coverage[0].sfExecutions).toBeNull()
  })
})

describe('backlogFrom', () => {
  const coverage = (days: Record<string, number>) =>
    coverageFor({
      daysHeld: Object.keys(days),
      hoursByDay: Object.fromEntries(
        Object.entries(days).map(([day, hours]) => [day, Array.from({ length: hours }, (_, i) => `h${i}`)]),
      ),
      measurements: {},
      now: NOW,
      retentionDays: 7,
    })

  it('adds up the hours outstanding across every finished day', () => {
    const backlog = backlogFrom(coverage({ '2026-09-08': 20, '2026-09-09': 22 }), NOW)

    expect(backlog.hoursOutstanding).toBe(6)
    expect(backlog.oldestDayOutstanding).toBe('2026-09-08')
  })

  it('excludes today, whose missing hours have not happened yet', () => {
    // Counting them would report a permanent backlog of roughly half a day and
    // make the number useless for deciding anything.
    const backlog = backlogFrom(coverage({ '2026-09-10': 12 }), NOW)

    expect(backlog.hoursOutstanding).toBe(0)
    expect(backlog.oldestDayOutstanding).toBeNull()
    // Not false: there is nothing to clear, which is not the same as being
    // unable to clear it.
    expect(backlog.clearsBeforeOldestIsPurged).toBeNull()
  })

  it('says the walk keeps up when the gap is smaller than the time left', () => {
    // 2026-09-09 has 5 nights left and 4 hours outstanding.
    const backlog = backlogFrom(coverage({ '2026-09-09': 20 }), NOW)

    expect(backlog.clearsBeforeOldestIsPurged).toBe(true)
  })

  it('says it does not when the gap is larger than the time left', () => {
    // 2026-09-02 is due tonight and short a full day, so nothing the scheduled
    // walk does will save it. This is the moment a manual push is needed, and
    // the whole reason for computing the number.
    const backlog = backlogFrom(coverage({ '2026-09-02': 0 }), NOW)

    expect(backlog.nightsUntilOldestPurged).toBe(0)
    expect(backlog.clearsBeforeOldestIsPurged).toBe(false)
  })

  it('calls an exact tie a miss, because the two ways of being wrong are not equal', () => {
    // 2026-09-03 has 1 night left and is short all 24 hours. The walk gains at
    // most 24 in that time, so it arrives exactly on the deadline. Reporting
    // that as "it clears" means nobody pushes and the day is destroyed if
    // anything at all goes slowly; reporting it as a miss costs one
    // unnecessary push (L648).
    const backlog = backlogFrom(coverage({ '2026-09-03': 0 }), NOW)

    expect(backlog.nightsUntilOldestPurged).toBe(1)
    expect(backlog.hoursOutstanding).toBe(24)
    expect(backlog.clearsBeforeOldestIsPurged).toBe(false)
  })

  it('says it does not for a day the purge is already overdue on', () => {
    const backlog = backlogFrom(coverage({ '2026-08-30': 10 }), NOW)

    expect(backlog.nightsUntilOldestPurged).toBeLessThan(0)
    expect(backlog.clearsBeforeOldestIsPurged).toBe(false)
  })
})
