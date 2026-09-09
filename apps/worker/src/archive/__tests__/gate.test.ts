/**
 * The deletion gate's reading of a day's measurements (#872, Phase A4).
 *
 * The gate stores NUMBERS and never a verdict. This is the reader that turns
 * those numbers into refusals, and every rule the phase states has a test here
 * that PRODUCES the outcome rather than one that merely passes (L151).
 *
 * The thing being defended against is `app_config.logpush_active`: a hand-set
 * boolean that asserted a backup existed, was never checked against one, and
 * gated a 90 day purge for months. So the shape here is inverted. Nothing
 * declares a day safe; a day is deletable only when every measurement is
 * present, fresh and equal, and every way of failing to establish that is a
 * refusal with its own wording.
 */
import { describe, it, expect } from 'vitest'
import { refusalsFor, deletable, MEASUREMENT_MAX_AGE_MS, type DayMeasurement } from '../gate'

const NOW = new Date('2026-08-22T13:00:00.000Z')
const DAY = '2026-08-14'

/** A day that reconciles perfectly. Every test below spoils exactly one thing. */
function clean(over: Partial<DayMeasurement> = {}): DayMeasurement {
  return {
    archiveDay: DAY,
    pgExecutionCount: 105_412,
    sfExecutionCount: 105_412,
    pgStepCount: 1_048_220,
    sfStepCount: 1_048_220,
    orphanExecutionCount: 0,
    orphanStepCountSeen: 0,
    orphanSampleSize: 0,
    hoursRecorded: 24,
    hoursExecutionCount: 105_412,
    erasedExecutionCount: 0,
    incompleteCount: 0,
    probeSampled: 40,
    probeOk: true,
    probeFailureReason: null,
    measuredAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    firstMeasuredAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    ...over,
  }
}

/**
 * A clean day whose hourly execution counts SUM to its day count.
 *
 * Derived rather than pinned, so a test that changes the day's execution count
 * to produce some other refusal does not accidentally also produce
 * `late-executions` and assert about a fixture it did not mean to build.
 */
function reconciled(over: Partial<DayMeasurement> = {}): DayMeasurement {
  const m = clean(over)
  return over.hoursExecutionCount === undefined ? { ...m, hoursExecutionCount: m.pgExecutionCount } : m
}

function codes(m: DayMeasurement | null): string[] {
  return refusalsFor(m, { archiveDay: DAY, now: NOW }).map((r) => r.code)
}

function messages(m: DayMeasurement | null): string {
  return refusalsFor(m, { archiveDay: DAY, now: NOW })
    .map((r) => r.message)
    .join(' | ')
}

describe('a day that reconciles', () => {
  it('is deletable, with nothing to say', () => {
    expect(refusalsFor(reconciled(), { archiveDay: DAY, now: NOW })).toEqual([])
    expect(deletable(reconciled(), { archiveDay: DAY, now: NOW })).toBe(true)
  })
})

describe('a day nobody measured', () => {
  it('refuses, and says that rather than naming a count', () => {
    // The load-bearing rule: if archiving stalls, no day becomes deletable and
    // the truncate simply finds nothing authorised. No code path is needed to
    // notice, which is the point.
    expect(codes(null)).toEqual(['never-measured'])
    expect(messages(null)).toMatch(/never measured/)
  })

  it('is not deletable', () => {
    expect(deletable(null, { archiveDay: DAY, now: NOW })).toBe(false)
  })

  it('refuses a row that exists but was never actually measured', () => {
    // A row written by a run that failed before it could measure anything. A
    // null measured_at is not a fresh measurement of nothing.
    expect(codes(reconciled({ measuredAt: null }))).toEqual(['never-measured'])
  })
})

describe('a stale measurement', () => {
  it('refuses, and says how old it is', () => {
    const old = new Date(NOW.getTime() - MEASUREMENT_MAX_AGE_MS - 60 * 60 * 1000).toISOString()

    expect(codes(reconciled({ measuredAt: old }))).toEqual(['stale-measurement'])
    expect(messages(reconciled({ measuredAt: old }))).toMatch(/31 hours old/)
  })

  it('accepts a measurement inside the window, so the check is not simply always refusing', () => {
    const recent = new Date(NOW.getTime() - MEASUREMENT_MAX_AGE_MS + 60 * 60 * 1000).toISOString()

    expect(codes(reconciled({ measuredAt: recent }))).toEqual([])
  })
})

describe('a day with genuinely no executions', () => {
  it('is a measured zero, and is deletable', () => {
    // Distinguishable from a day never measured: measured_at is set and the
    // probe is an honest zero rather than a vacuous pass.
    const empty = reconciled({
      pgExecutionCount: 0,
      sfExecutionCount: 0,
      pgStepCount: 0,
      sfStepCount: 0,
      probeSampled: 0,
      probeOk: true,
    })

    expect(refusalsFor(empty, { archiveDay: DAY, now: NOW })).toEqual([])
    expect(deletable(empty, { archiveDay: DAY, now: NOW })).toBe(true)
  })
})

describe('the counts disagreeing', () => {
  it('names the execution shortfall, and the erasures it already allowed for', () => {
    const m = reconciled({ pgExecutionCount: 105_412, erasedExecutionCount: 14, sfExecutionCount: 105_398 })
    expect(codes(m)).toEqual([])

    const short = reconciled({ pgExecutionCount: 105_412, erasedExecutionCount: 14, sfExecutionCount: 105_390 })
    expect(codes(short)).toEqual(['executions-disagree'])
    expect(messages(short)).toMatch(/pg 105,412 less 14 erased \/ sf 105,390/)
  })

  it('names the step shortfall and its size', () => {
    // The quantity the gate actually exists to protect. A systematic step loss
    // could affect a large fraction of a day while the execution count and a
    // small sample both stayed green.
    const m = reconciled({ pgStepCount: 1_048_220, sfStepCount: 1_046_901 })

    expect(codes(m)).toEqual(['steps-disagree'])
    expect(messages(m)).toMatch(/pg 1,048,220 \/ sf 1,046,901; shortfall 1,319/)
  })

  it('reports a Snowflake surplus under its own name, not as a shortfall', () => {
    // More archived than Postgres holds means something other than a missing
    // row: a day already truncated, or an execution archived under the wrong
    // day. "Shortfall -8" would send whoever reads it looking for lost data.
    const m = reconciled({ pgExecutionCount: 105_412, sfExecutionCount: 105_420 })

    expect(codes(m)).toEqual(['executions-surplus'])
    expect(messages(m)).toMatch(/more executions than Postgres/)
  })

  it('does not let erasures paper over a real shortfall', () => {
    // The erasure subtraction must not become a licence: 14 erased and 30
    // missing is still 16 rows nobody can account for.
    const m = reconciled({ pgExecutionCount: 100, erasedExecutionCount: 14, sfExecutionCount: 56 })

    expect(codes(m)).toEqual(['executions-disagree'])
  })
})

describe('a day the archiver has not finished', () => {
  it('refuses on the missing hours alone, and says nothing else', () => {
    // pg_step_count is SUMMED from the recorded hours, so with hours missing
    // every other number is measured over a fraction of the day. Reporting a
    // step shortfall here would name a quantity nobody measured (L11).
    const m = reconciled({ hoursRecorded: 19, pgStepCount: 800_000, sfStepCount: 1_048_220 })

    expect(codes(m)).toEqual(['hours-missing'])
    expect(messages(m)).toMatch(/only 19 of the 24 hours of 2026-08-14/)
  })

  it('accepts a full 24, so the check is not simply always refusing', () => {
    expect(codes(reconciled({ hoursRecorded: 24 }))).toEqual([])
  })

  /**
   * A day the archive never touched is not a day it covered badly (#1016).
   *
   * Between 2026-08-16 and 2026-08-21 the archive covered zero days while
   * Postgres held all six, and nothing reported it: the archiver was running
   * normally on current hours the whole time, so it was neither stalled nor
   * failing. It was simply never asked about the older days.
   *
   * The two states need different responses. Some hours archived and some
   * missing is a re-archive of the gap. NO hours archived, while Postgres holds
   * a full day of executions, is a day the walk has never reached, and it is
   * recoverable only until the partition is purged.
   */
  it('names a day with no archived hour at all as never archived, not as short', () => {
    const m = reconciled({ hoursRecorded: 0, pgExecutionCount: 104_599 })

    expect(codes(m)).toEqual(['never-archived'])
    expect(messages(m)).toMatch(/no hour of 2026-08-14 has been archived at all/)
    // The message is about data about to be lost, not about a gate refusing:
    // it names what Postgres is holding that nothing else has a copy of.
    expect(messages(m)).toMatch(/104,599 executions/)
  })

  it('still says short when SOME hours are there', () => {
    expect(codes(reconciled({ hoursRecorded: 1, pgExecutionCount: 104_599 }))).toEqual(['hours-missing'])
  })

  it('does not call an EMPTY day never archived, because there was nothing to archive', () => {
    // A day with no executions has no hours to record and nothing to lose. Its
    // zero is honest, and accusing it would fire on every quiet day (L98).
    const m = reconciled({
      hoursRecorded: 0,
      pgExecutionCount: 0,
      sfExecutionCount: 0,
      pgStepCount: 0,
      sfStepCount: 0,
      hoursExecutionCount: 0,
      probeSampled: 0,
    })
    expect(codes(m)).toEqual([])
  })
})

describe('executions written after their hour was archived', () => {
  it('is its own refusal, naming how many', () => {
    // Every hour reconciled when it ran and Snowflake matches what was
    // archived, so nothing else in the system can see this. Only the day's own
    // count against the sum of its hours reveals it.
    const m = reconciled({
      pgExecutionCount: 105_412,
      hoursExecutionCount: 105_400,
      sfExecutionCount: 105_400,
    })

    expect(codes(m)).toContain('late-executions')
    expect(messages(m)).toMatch(/12 arrived after their hour was archived/)
  })
})

describe('orphan steps', () => {
  it('refuses the day, naming the count', () => {
    // Steps whose execution has no archived row have no copy anywhere.
    const m = reconciled({ orphanExecutionCount: 214, orphanStepCountSeen: 2_204, orphanSampleSize: 214 })

    expect(codes(m)).toEqual(['orphan-executions'])
    expect(messages(m)).toMatch(/214 executions on 2026-08-14 have no archived row/)
    // A lower bound, worded as one. Counting every orphan step timed out on the
    // worst day, which is the day the measurement exists to report.
    expect(messages(m)).toMatch(/at least 2,204 step rows, counted across 214 of them/)
  })
})

describe('the payload probe', () => {
  it('refuses when the probe failed, carrying the reason it gave', () => {
    const m = reconciled({ probeOk: false, probeFailureReason: 'bundle for abc reports 9 steps, Postgres has 11' })

    expect(codes(m)).toEqual(['probe-failed'])
    expect(messages(m)).toMatch(/bundle for abc reports 9 steps/)
  })

  it('refuses a failed probe that carries no reason, rather than passing it', () => {
    // probe_ok false with a null reason is a measurement bug, and reading it as
    // a pass would be the gate defending nothing.
    const m = reconciled({ probeOk: false, probeFailureReason: null })

    expect(codes(m)).toEqual(['probe-failed'])
    expect(messages(m)).toMatch(/no reason was recorded/)
  })

  it('refuses a day whose counts are non-zero but whose probe sampled nothing', () => {
    // A probe that examined no rows is not a probe that passed (L98). Without
    // this, a probe step that silently failed to select any ids reports
    // probe_ok true and the gate approves 105,412 unexamined bundles.
    const m = reconciled({ probeSampled: 0, probeOk: true })

    expect(codes(m)).toEqual(['probe-sampled-nothing'])
  })
})

describe('incomplete rows', () => {
  it('reports them, and refuses', () => {
    // An execution archived at the deadline while still non-terminal is a real
    // row, but it is not the finished story of that lead, and the amend pass
    // has not caught up. Deleting the Postgres copy would freeze it that way.
    const m = reconciled({ incompleteCount: 1 })

    expect(codes(m)).toEqual(['incomplete-rows'])
    expect(messages(m)).toMatch(/1 execution archived incomplete/)
  })

  it('pluralises honestly', () => {
    expect(messages(reconciled({ incompleteCount: 3 }))).toMatch(/3 executions archived incomplete/)
  })
})

describe('several things wrong at once', () => {
  it('reports every one of them, under its own name', () => {
    // Never one generic "not verified". Each of these has a different remedy,
    // and a single message would send whoever reads it to the wrong place.
    const m = reconciled({
      pgExecutionCount: 100,
      sfExecutionCount: 90,
      pgStepCount: 1_000,
      sfStepCount: 900,
      orphanExecutionCount: 5,
      orphanStepCountSeen: 55,
      orphanSampleSize: 5,
      probeOk: false,
      probeFailureReason: 'corrupt',
      incompleteCount: 2,
    })

    expect(codes(m)).toEqual([
      'executions-disagree',
      'steps-disagree',
      'orphan-executions',
      'probe-failed',
      'incomplete-rows',
    ])
  })

  it('says nothing else once the row is missing, because nothing else was measured', () => {
    // A message may claim only what its check actually measured (L11).
    expect(codes(null)).toHaveLength(1)
  })
})

describe('the staleness threshold', () => {
  it('allows a full daily cadence plus slack, so one late run does not refuse every day', () => {
    expect(MEASUREMENT_MAX_AGE_MS).toBeGreaterThan(24 * 60 * 60 * 1000)
  })

  it('is short enough that two consecutive missed runs refuse', () => {
    expect(MEASUREMENT_MAX_AGE_MS).toBeLessThan(48 * 60 * 60 * 1000)
  })
})
