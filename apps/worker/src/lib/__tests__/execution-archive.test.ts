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

  // THE CPU QUESTION (#876, Phase A8): does a CATCH-UP run fit in the declared
  // ceiling, not just an ordinary one?
  //
  // This used to price a run as MAX_HOURS_PER_RUN times an hour of 4,375
  // executions, a mean measured when it was written. That is the same defect as
  // the wall-time one below, one function apart, and it was found by sweeping
  // for a second instance of the class immediately after fixing the first
  // (L387): at the busiest measured hour of 9,716 executions, three hours is
  // 23.3 seconds against a 30 second ceiling, and the guard passed only because
  // its volume figure was stale.
  //
  // DERIVED FROM WHAT ACTUALLY BINDS instead. CPU and wall time both scale with
  // the number of executions a run gets through, so the wall budget is already
  // a ceiling on executions, and pricing CPU from it keeps the two in step
  // however the cap or the volume moves. No hours term appears, deliberately:
  // an hour is not a fixed quantity of work.
  const CPU_MS_PER_BUNDLE = 0.8 // ADR 0009, p50 0.799 across stringify, gzip, base64 and verify
  const DECLARED_CPU_CEILING_MS = 30_000 // wrangler.toml [limits] cpu_ms

  it('keeps even a full catch-up run inside the declared CPU ceiling', () => {
    // The most executions any run can reach: its whole wall budget spent at the
    // p95 cost of an execution.
    const mostExecutionsPerRun = WALL_TIME_BUDGET_MS / MEASURED_P95_MS_PER_EXECUTION
    const cpuMs = mostExecutionsPerRun * CPU_MS_PER_BUNDLE

    // Half the ceiling, so the margin absorbs a bundle that costs its p99
    // rather than its p50. Measured 2026-09-10 this is about 10.3 seconds.
    expect(cpuMs).toBeLessThan(DECLARED_CPU_CEILING_MS / 2)
  })

  it('has the wall budget, not the hour cap, bounding the work a run can do', () => {
    // States the relationship the guard above depends on. If the cap ever
    // became the binding limit, CPU would scale with it again and the
    // derivation would be measuring the wrong thing (L63).
    const mostExecutionsPerRun = WALL_TIME_BUDGET_MS / MEASURED_P95_MS_PER_EXECUTION
    const capWouldAllow = MAX_HOURS_PER_RUN * MEASURED_BUSIEST_HOUR_EXECUTIONS

    expect(mostExecutionsPerRun).toBeLessThan(capWouldAllow)
  })

  // WHAT AN HOUR COSTS, measured over 163 single-hour production runs in the 7
  // days to 2026-09-10, not over one recovery run.
  //
  // THE UNIT IS PER EXECUTION, and that is the correction. This block used to
  // hold a flat 257,000 ms per hour, taken from the 2026-08-22 recovery run. An
  // hour's cost is not a property of the archive, it is a property of how much
  // traffic that hour held: measured across the day the cost runs from 53 s to
  // 336 s, a six-fold spread, and it correlates with the execution count at
  // 0.937. A constant in the wrong unit drifts GREEN as the business grows,
  // which is the direction nobody checks (L323, L354).
  //
  // Re-take all four numbers with supabase/tests/measure-archive-hour-cost.sql.
  const MEASURED_MEAN_MS_PER_EXECUTION = 48.4
  const MEASURED_P95_MS_PER_EXECUTION = 60.8
  /** The busiest single hour seen in those 7 days. Grows with the business. */
  const MEASURED_BUSIEST_HOUR_EXECUTIONS = 9_716
  /** The mean hour, which is what an ordinary catch-up run actually meets. */
  const MEASURED_MEAN_HOUR_EXECUTIONS = 3_900

  const hourCostMs = (executions: number, msEach: number) => executions * msEach

  // A cap the clock stops before it can ever be reached is not a cap. It reads
  // as the control and can never fire, which is worse than no number at all
  // because whoever reads it believes it (L109).
  //
  // Judged at the ORDINARY hour, deliberately. The old form asserted the cap was
  // reachable at the worst hour, and that is not true and cannot be made true:
  // three of the busiest hour costs about 1,772 s against a platform cron
  // ceiling of 900 s, so no wall budget inside the ceiling could reach the cap
  // at peak. Requiring it there would have forced the cap down to 1, which is
  // the number that cannot catch up at all. The cap governs the quiet half of
  // the day, where a backlog is actually drained, and the reserve governs the
  // busy half. This fails if the cap is raised without the wall budget, or the
  // budget lowered without the cap.
  it('can actually reach its hour cap on an ordinary hour, inside its wall budget', () => {
    const cost = hourCostMs(MEASURED_MEAN_HOUR_EXECUTIONS, MEASURED_P95_MS_PER_EXECUTION)
    expect(MAX_HOURS_PER_RUN * cost).toBeLessThanOrEqual(WALL_TIME_BUDGET_MS)
  })

  // THE LIMIT THAT ACTUALLY BINDS, and the one worth watching. A run must be
  // able to finish the BUSIEST hour, or the archive stops advancing at peak
  // entirely: the reserve refuses to start an hour it cannot finish, so a
  // busiest hour that no longer fits means zero hours archived, an outcome that
  // reads as a healthy short run rather than as a stall (L98).
  //
  // Cost is linear in volume, so this is a growth budget. At the p95 rate the
  // busiest measured hour costs about 591 s against 780 s, which is roughly 32%
  // headroom. When traffic grows past that this goes red, which is the point:
  // the alternative is finding out from a backlog nobody can explain.
  it('can finish the busiest hour ever measured, with stated room to grow', () => {
    const worstHourMs = hourCostMs(MEASURED_BUSIEST_HOUR_EXECUTIONS, MEASURED_P95_MS_PER_EXECUTION)

    expect(worstHourMs).toBeLessThan(WALL_TIME_BUDGET_MS)
    // Stated as a ratio rather than a spare-seconds figure, so it keeps its
    // meaning when either side moves.
    const headroom = WALL_TIME_BUDGET_MS / worstHourMs
    expect(headroom, 'the busiest hour no longer leaves 25% growth room').toBeGreaterThan(1.25)
  })

  // The mean rate is the one every projection uses, so it must not quietly
  // become the p95's equal: if it does, the distribution has changed shape and
  // every figure derived from the mean is describing a different system.
  it('keeps the mean and the tail distinguishable, since projections use the mean', () => {
    expect(MEASURED_MEAN_MS_PER_EXECUTION).toBeLessThan(MEASURED_P95_MS_PER_EXECUTION)
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
