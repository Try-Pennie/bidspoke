import { describe, it, expect } from 'vitest'
import { toRow, initialWatermark, MAX_HOURS_PER_RUN, WALL_TIME_BUDGET_MS } from '../execution-archive'
import { CRON_RUN_BUDGET, REQUEST_RUN_BUDGET } from '../../archive/deadline'
import { HOURS_GAINED_PER_HOUR } from '../../archive/health'
import { SLICE_SIZE } from '../../archive/stream-hour'
import { nextHourToArchive } from '../../archive/clock'
import type { EncodedForSend } from '../../archive/run-loop'
import type { ArchiveScalars } from '../../archive/scalars'

const encoded = (executionId: string, stepCount = 3): EncodedForSend => ({
  executionId,
  wire: 'x',
  wireBytes: 1,
  stepCount,
})

const someScalars: ArchiveScalars = {
  organizationId: 'org-1',
  ssnHash: null,
  workflowId: 'wf-1',
  workflowVersionId: null,
  parentExecutionId: null,
  resumedFromExecutionId: null,
  traceId: null,
  source: null,
  status: 'success',
  outcome: null,
  isTest: false,
  startedAtUtc: '2026-08-16T11:00:00.000',
  completedAtUtc: null,
  durationMs: null,
  costUsd: null,
}

/** Scalars present for every id the caller mentions, which is the healthy case. */
const scalarsFor = (...ids: string[]): Map<string, ArchiveScalars> =>
  new Map(ids.map((id) => [id, someScalars]))

describe('toRow', () => {
  it('stamps the day the execution belongs to, taken per execution', () => {
    const row = toRow(
      encoded('e1'),
      new Map([['e1', '2026-08-16']]),
      new Map([['e1', false]]),
      scalarsFor('e1'),
    )

    expect(row.archiveDay).toBe('2026-08-16')
    expect(row.incomplete).toBe(false)
  })

  it('carries the incomplete marker for an execution archived at the deadline', () => {
    const row = toRow(encoded('e1'), new Map([['e1', '2026-08-16']]), new Map([['e1', true]]), scalarsFor('e1'))

    expect(row.incomplete).toBe(true)
  })

  // archive_day is the column every side of the deletion gate joins on, so a
  // blank one produces a row that can never be matched back to the partition it
  // came from: the Snowflake count would see it and the Postgres count would
  // not, and that day would refuse deletion forever with nothing explaining why.
  it('refuses to build a row with no archive day rather than sending a blank one', () => {
    expect(() => toRow(encoded('e1'), new Map(), new Map(), scalarsFor('e1'))).toThrow(/no archive day/)
    expect(() => toRow(encoded('e1'), new Map([['e1', '']]), new Map(), scalarsFor('e1'))).toThrow(/no archive day/)
  })

  // Three of the archive table's columns are NOT NULL and all three come from
  // here, so a row that reached the send without scalars cannot be written and
  // must not travel in a batch alongside rows that can: the whole statement
  // would be rejected and the hour would stall.
  it('refuses to build a row with no scalars rather than sending a partial one', () => {
    expect(() => toRow(encoded('e1'), new Map([['e1', '2026-08-16']]), new Map(), new Map())).toThrow(/no scalars/)
  })

  it('carries the scalars through to the row', () => {
    const row = toRow(encoded('e1'), new Map([['e1', '2026-08-16']]), new Map(), scalarsFor('e1'))

    expect(row.scalars.organizationId).toBe('org-1')
    expect(row.scalars.startedAtUtc).toBe('2026-08-16T11:00:00.000')
  })

  it('names the execution it could not place, so the refusal is actionable', () => {
    expect(() => toRow(encoded('e-missing'), new Map(), new Map(), scalarsFor('e-missing'))).toThrow(/e-missing/)
  })

  // Two executions in one batch can belong to different days, because an hour
  // near midnight spans a boundary. A single "current day" would stamp both with
  // whichever was set last.
  it('gives each execution in a batch its own day', () => {
    const days = new Map([
      ['before', '2026-08-16'],
      ['after', '2026-08-17'],
    ])

    expect(toRow(encoded('before'), days, new Map(), scalarsFor('before')).archiveDay).toBe('2026-08-16')
    expect(toRow(encoded('after'), days, new Map(), scalarsFor('after')).archiveDay).toBe('2026-08-17')
  })
})

describe('the step count the deletion gate reads', () => {
  // The gate sums step_count on the Snowflake side and compares it against an
  // independent Postgres count. That scalar is only worth anything if it comes
  // from the array actually serialised into the bundle: taken from the intended
  // count instead, both sides agree perfectly while every bundle is short, which
  // is exactly the truncation the paging guard exists to catch (L63).
  it('carries the count through to the row rather than recomputing it', () => {
    const row = toRow(encoded('e1', 14), new Map([['e1', '2026-08-16']]), new Map(), scalarsFor('e1'))

    expect(row.stepCount).toBe(14)
  })

  it('carries a genuine zero for an execution that logged no steps', () => {
    const row = toRow(encoded('e1', 0), new Map([['e1', '2026-08-16']]), new Map(), scalarsFor('e1'))

    expect(row.stepCount).toBe(0)
  })
})

describe('initialWatermark', () => {
  /**
   * The seam, and the whole reason this block exists.
   *
   * A fresh watermark only matters through `nextHourToArchive`, and until
   * 2026-08-21 the two were only ever tested apart: this file asserted the
   * watermark's value, clock.test.ts asserted the selector's behaviour, and each
   * agreed with itself. Composed, they produced a permanent standstill. The
   * watermark started at the hour before the current one, so the next hour to
   * archive was the CURRENT hour, which has not closed, so the run archived
   * nothing and never advanced the watermark, so the next run recomputed the
   * same too-recent watermark from the new clock.
   *
   * Measured on prod: the job ran hourly for 19 hours (heartbeat present, no
   * worker errors, no run lock held) and `execution_archive_progress`,
   * `execution_archive_ids` and `execution_archive_refusals` were all empty.
   *
   * A test that never composes two units can only prove each is
   * self-consistent (L178), and a run that finds nothing to do is
   * indistinguishable from one with nothing to do (L98), so nothing reported it.
   */
  it('yields a watermark the hour selector will actually archive from', () => {
    // Across the whole hour, because the bug is a boundary between the hour
    // grid and the settle window, and a single sample can sit on the lucky side.
    for (const minute of [0, 1, 17, 30, 59]) {
      const now = new Date(`2026-08-18T10:${String(minute).padStart(2, '0')}:00.000Z`)
      const next = nextHourToArchive({ watermarkHour: initialWatermark(now), now })

      expect(
        next.archive,
        `a first run at :${minute} refused to archive: ${next.archive ? '' : next.reason}`,
      ).toBe(true)
    }
  })

  it('picks the newest hour that is fully settled, not an older one', () => {
    const now = new Date('2026-08-18T10:37:00.000Z')
    const next = nextHourToArchive({ watermarkHour: initialWatermark(now), now })

    // Settle window is 2 hours, so the newest archivable hour at 10:37 is the
    // one running 07:00 to 08:00. Starting further back would make a first run
    // crawl through the retained window an hour at a time for no reason.
    expect(next.archive && next.hourStart).toBe('2026-08-18T07:00:00.000Z')
    expect(next.archive && next.hourEnd).toBe('2026-08-18T08:00:00.000Z')
  })

  it('is exactly one hour behind the oldest watermark that still archives', () => {
    // Pins the derivation rather than the number: one hour later and the
    // selector must refuse, which is what proves this is the newest settled
    // hour rather than an arbitrary offset.
    const now = new Date('2026-08-18T10:00:00.000Z')
    const w = Date.parse(initialWatermark(now))

    expect(nextHourToArchive({ watermarkHour: new Date(w).toISOString(), now }).archive).toBe(true)
    expect(nextHourToArchive({ watermarkHour: new Date(w + 3_600_000).toISOString(), now }).archive).toBe(false)
  })

  it('lands on an hour boundary, which the hour selector requires', () => {
    for (const minute of [0, 1, 29, 30, 59]) {
      const w = initialWatermark(new Date(`2026-08-18T10:${String(minute).padStart(2, '0')}:13.500Z`))
      expect(Date.parse(w) % 3_600_000, `minute ${minute}`).toBe(0)
    }
  })
})

describe('run budgets', () => {
  // MEASURED ON PROD 2026-08-22, and the reason this block was rewritten: one
  // hour of 2,615 executions holds 183.5 MB of raw rows plus 33.8 MB of encoded
  // wires, both alive at once, against Cloudflare's 128 MB ceiling. That is
  // roughly 70 kB per execution including its steps.
  const WORKER_MEMORY_CEILING_BYTES = 128 * 1024 * 1024

  // The WORST WINDOW, not the mean. Sizes are heavily skewed (7.5 kB median wire
  // against 218 kB largest), so a mean justifies a slice size the tail breaks.
  const MEASURED_WORST_SLICE_BYTES = 14.1 * 1024 * 1024
  const MEASURED_AT_SLICE_SIZE = 150
  const MEASURED_HOUR_BYTES = (253.3 + 46.2) * 1024 * 1024

  // The assertion that matters, against the limit that actually binds. The
  // previous version of this block asserted the CPU margin instead, and it
  // passed the whole time the archive was being killed for memory every hour: a
  // guard that measures a proxy for the quantity it protects reports health
  // while the real thing fails (L63).
  it('keeps a slice inside the memory ceiling, judged on the worst slice measured', () => {
    // Scaled from the measurement, so raising SLICE_SIZE past what the evidence
    // supports fails here rather than in production at 3 a.m.
    const sliceBytes = (SLICE_SIZE / MEASURED_AT_SLICE_SIZE) * MEASURED_WORST_SLICE_BYTES

    expect(sliceBytes).toBeLessThan(WORKER_MEMORY_CEILING_BYTES / 5)
  })

  // Kept, because the whole point of slicing is that this number no longer
  // decides memory. If it ever does again, this fails rather than the platform.
  it('does not let the per-run hour cap decide memory at all', () => {
    // One hour exceeds the ceiling on its own, which is why no value of the hour
    // cap could have fixed this and why the slice is the unit that protects it.
    expect(MEASURED_HOUR_BYTES).toBeGreaterThan(WORKER_MEMORY_CEILING_BYTES)
    expect(SLICE_SIZE).toBeLessThan(3575)
  })

  it('keeps a full run inside the declared CPU ceiling with margin', () => {
    const measuredCpuMsPerHour = 4375 * 0.8
    expect(MAX_HOURS_PER_RUN * measuredCpuMsPerHour).toBeLessThan(30_000 / 2)
  })

  // MEASURED IN PRODUCTION on the 2026-08-22 recovery run, from the watermark's
  // own timestamps: the run began at 20:23:00Z, finished the 13:00 hour at
  // 20:26:22Z and the 14:00 hour at 20:30:39Z. So an hour of real data costs
  // between 202 and 257 seconds end to end, far more than the 48 s the local
  // rehearsal suggested, because the rehearsal does not pay the Worker's
  // per-request latency or the Snowflake send.
  const MEASURED_WORST_MS_PER_HOUR = 257_000

  // A cap the clock stops before it can ever be reached is not a cap. It reads
  // as the control and can never fire, which is worse than no number at all
  // because whoever reads it believes it (L109). This fails if the hour cap is
  // raised without the wall budget, or the wall budget lowered without the cap.
  it('can actually reach its hour cap inside its own wall-time budget', () => {
    expect(MAX_HOURS_PER_RUN * MEASURED_WORST_MS_PER_HOUR).toBeLessThanOrEqual(WALL_TIME_BUDGET_MS)
  })

  it('gains ground every run, so a backlog drains rather than persisting', () => {
    // Anything less than 2 would never catch up on an hourly cadence.
    expect(MAX_HOURS_PER_RUN).toBeGreaterThan(1)
  })

  it('gains MORE than the hour that elapsed, so it can recover rather than hold station', () => {
    // At a cap of 2 the archive gained exactly one hour per hour of real time:
    // it kept up and could never close a gap. Recovering from an outage needs
    // the cap above 2, and the rate the health report projects with has to be
    // the same number (#1041).
    expect(MAX_HOURS_PER_RUN).toBeGreaterThan(2)
    expect(HOURS_GAINED_PER_HOUR).toBe(MAX_HOURS_PER_RUN - 1)
    expect(HOURS_GAINED_PER_HOUR).toBeGreaterThan(1)
  })

  it('keeps one source for the cap and the budget, not two copies', () => {
    // These names are the derived reading. Two constants for one meaning leave
    // every reader of the older one answering a superseded question (L428),
    // and the catch-up rate above was exactly such a reader.
    expect(MAX_HOURS_PER_RUN).toBe(CRON_RUN_BUDGET.maxHours)
    expect(WALL_TIME_BUDGET_MS).toBe(CRON_RUN_BUDGET.wallMs)
  })

  it('leaves the platform real margin, which is what the reserve protects', () => {
    // The cron ceiling is 15 minutes. The margin used to absorb an OVERSHOOT,
    // because the deadline was checked before an hour began and an hour runs to
    // completion once begun. The run loop now reserves room for the hour it is
    // about to start, so the margin only has to cover the platform rather than
    // a whole extra hour, and the budget can use more of the ceiling.
    const ceilingMs = 15 * 60 * 1000
    expect(WALL_TIME_BUDGET_MS).toBeLessThan(ceilingMs)
    expect(ceilingMs - WALL_TIME_BUDGET_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('runs a request-context archive to a smaller budget than a cron one', () => {
    // Same run, far less room (#1048), and the two must not drift into being
    // the same number.
    expect(REQUEST_RUN_BUDGET.wallMs).toBeLessThan(CRON_RUN_BUDGET.wallMs)
    expect(REQUEST_RUN_BUDGET.maxHours).toBeLessThan(CRON_RUN_BUDGET.maxHours)
  })

  it('leaves the platform room after the wall-time budget', () => {
    expect(WALL_TIME_BUDGET_MS).toBeLessThan(15 * 60 * 1000)
  })
})

describe('the per-invocation request allowance', () => {
  // Measured shape of one hour, from ADR 0009: ~4,375 executions at 11.9 steps
  // each is ~52,000 step rows, which at the 1,000 row page cap is 52 pages, plus
  // 5 pages of executions and 2 counts. So an hour costs roughly 60 reads, not
  // the handful a hand-picked estimate would assume.
  it('a measured hour costs far more requests than a small estimate would suggest', () => {
    const executions = 4375
    const steps = Math.ceil(executions * 11.9)
    const pageCap = 1000
    const reads = 2 + Math.ceil(executions / pageCap) + Math.ceil(steps / pageCap)

    expect(reads).toBeGreaterThan(50)
    // And a full run of MAX_HOURS_PER_RUN still fits inside a Worker's 1,000
    // subrequest allowance, with the sends and id writes on top.
    expect(MAX_HOURS_PER_RUN * (reads + 12)).toBeLessThan(1000)
  })
})
