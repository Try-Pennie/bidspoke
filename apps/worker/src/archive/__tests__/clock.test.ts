import { describe, it, expect, afterEach, vi } from 'vitest'
import { archiveDay, nextHourToArchive, SETTLE_WINDOW_MS, canonicalHourStart } from '../clock'
import ARCHIVE_DAY_CASES from '../fixtures/archive-day-cases.json'

/**
 * The day an execution belongs to is implemented three times across this
 * milestone: here in TypeScript, as date_trunc('day', started_at AT TIME ZONE
 * 'UTC') in the deletion gate's SQL, and as a partition-bound string in the
 * repoint. The whole deletion guarantee rests on all three agreeing, and the
 * disagreement is silent and asymmetric: a day computed from a host-local Date
 * differs for one hour a day in most zones, so a fraction of executions land in
 * one day by the archiver and the neighbouring day by the gate, and both days
 * disagree forever (L26, L39).
 *
 * So the cases live in ONE committed fixture that every implementation reads.
 * The SQL expression is the declared source of truth; this is the side that has
 * to match it.
 */
describe('archiveDay, against the shared fixture', () => {
  it('has cases either side of UTC midnight and either side of a DST change', () => {
    const kinds = new Set(ARCHIVE_DAY_CASES.map((c) => c.kind))
    expect(kinds).toContain('utc-midnight')
    expect(kinds).toContain('dst-change')
  })

  for (const testCase of ARCHIVE_DAY_CASES) {
    it(`${testCase.kind}: ${testCase.startedAt} belongs to ${testCase.archiveDay}`, () => {
      expect(archiveDay(testCase.startedAt)).toBe(testCase.archiveDay)
    })
  }

  // On a UTC host a host-local rule and the UTC rule give IDENTICAL answers, so
  // no behavioural test running on a UTC runner can tell them apart, and CI runs
  // in UTC. The fixture alone would therefore pass on the runner whichever rule
  // shipped. Node re-reads TZ at runtime, so this test moves the host itself and
  // asserts the day does not follow it (L159: prove the case can fire, in the
  // environment that actually runs it).
  // vi.stubEnv rather than touching process directly: this package is typed for
  // the Workers runtime and has no Node types, and the stub is undone for us.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('gives the same day whatever timezone the host is in', () => {
    const discriminating = ARCHIVE_DAY_CASES.filter((c) => c.note.includes('DISCRIMINATING'))
    expect(discriminating.length).toBeGreaterThanOrEqual(3)

    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      vi.stubEnv('TZ', zone)
      for (const testCase of discriminating) {
        expect(archiveDay(testCase.startedAt), `${testCase.startedAt} under ${zone}`)
          .toBe(testCase.archiveDay)
      }
    }
  })

  it('refuses a timestamp it cannot parse rather than naming some default day', () => {
    expect(() => archiveDay('not a timestamp')).toThrow(/not a timestamp/)
  })

  it('refuses a timestamp with no timezone, which would be read as host-local', () => {
    expect(() => archiveDay('2026-08-16T23:30:00')).toThrow(/timezone/i)
  })
})

describe('nextHourToArchive', () => {
  const watermark = '2026-08-16T10:00:00.000Z'
  const settled = (hourEnd: string): Date => new Date(Date.parse(hourEnd) + SETTLE_WINDOW_MS)

  it('takes the hour after the watermark once it has closed and settled', () => {
    const result = nextHourToArchive({ watermarkHour: watermark, now: settled('2026-08-16T12:00:00Z') })

    expect(result.archive).toBe(true)
    if (!result.archive) return
    expect(result.hourStart).toBe('2026-08-16T11:00:00.000Z')
    expect(result.hourEnd).toBe('2026-08-16T12:00:00.000Z')
  })

  it('waits while the hour is still open', () => {
    const result = nextHourToArchive({ watermarkHour: watermark, now: new Date('2026-08-16T11:30:00Z') })

    expect(result.archive).toBe(false)
    if (result.archive) return
    expect(result.reason).toMatch(/has not closed/)
  })

  // The hour has closed, but the tail consumer may not have written its cost
  // yet. Archiving now freezes an execution missing the field the archive
  // exists to preserve.
  it('waits while the closed hour is still inside the settle window', () => {
    const result = nextHourToArchive({ watermarkHour: watermark, now: new Date('2026-08-16T12:30:00Z') })

    expect(result.archive).toBe(false)
    if (result.archive) return
    expect(result.reason).toMatch(/settle window/)
  })

  it('names the wait in a way that distinguishes the two reasons for waiting', () => {
    const open = nextHourToArchive({ watermarkHour: watermark, now: new Date('2026-08-16T11:30:00Z') })
    const settling = nextHourToArchive({ watermarkHour: watermark, now: new Date('2026-08-16T12:30:00Z') })

    expect(open.archive).toBe(false)
    expect(settling.archive).toBe(false)
    if (open.archive || settling.archive) return
    expect(open.reason).not.toBe(settling.reason)
  })

  it('advances one hour at a time when it is behind, rather than jumping to the newest', () => {
    const result = nextHourToArchive({ watermarkHour: watermark, now: new Date('2026-08-18T00:00:00Z') })

    expect(result.archive).toBe(true)
    if (!result.archive) return
    expect(result.hourStart).toBe('2026-08-16T11:00:00.000Z')
  })

  it('refuses a watermark that is not on an hour boundary rather than drifting off it', () => {
    expect(() => nextHourToArchive({ watermarkHour: '2026-08-16T10:17:00.000Z', now: new Date('2026-08-18T00:00:00Z') }))
      .toThrow(/hour boundary/)
  })

  it('refuses a watermark in the future, which would silently archive nothing forever', () => {
    expect(() => nextHourToArchive({ watermarkHour: '2027-01-01T00:00:00.000Z', now: new Date('2026-08-18T00:00:00Z') }))
      .toThrow(/future/)
  })
})

describe('canonicalHourStart', () => {
  // The database renders a timestamptz its own way and the caller asks with ISO.
  // Whether a given engine's Date.parse accepts the difference is
  // implementation-defined, and a mismatch does not throw: it produces an empty
  // set of already-archived hours, which means "skip nothing" and silently
  // restores the repair treadmill (#1019). So the normalisation is explicit and
  // asserted here rather than left to the host's tolerance (L52).
  it('reduces every rendering of one instant to the same canonical hour', () => {
    const same = [
      '2026-08-16 00:00:00+00',
      '2026-08-16T00:00:00+00:00',
      '2026-08-16 00:00:00.000+00',
      '2026-08-16T00:00:00Z',
      '2026-08-16T00:00:00.000Z',
      '  2026-08-16 00:00:00+00  ',
    ]

    for (const raw of same) {
      expect(canonicalHourStart(raw), `"${raw}"`).toBe('2026-08-16T00:00:00.000Z')
    }
  })

  it('keeps a non-zero offset meaning the instant it names, not the wall clock', () => {
    // 02:00 at +02:00 is midnight UTC. Dropping the offset would silently shift
    // the hour and make a recorded hour look unrecorded.
    expect(canonicalHourStart('2026-08-16 02:00:00+02')).toBe('2026-08-16T00:00:00.000Z')
  })

  it('answers null for something it cannot read, rather than a wrong instant', () => {
    for (const bad of ['', 'not a time', '2026-13-45 00:00:00+00']) {
      expect(canonicalHourStart(bad), `"${bad}"`).toBeNull()
    }
  })
})
