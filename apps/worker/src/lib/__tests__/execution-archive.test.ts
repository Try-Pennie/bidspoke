import { describe, it, expect } from 'vitest'
import { toRow, initialWatermark, MAX_HOURS_PER_RUN, WALL_TIME_BUDGET_MS } from '../execution-archive'
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
  // The cap exists to keep a drain inside the CPU ceiling declared in
  // wrangler.toml rather than raising that ceiling for every request the Worker
  // serves. A0 measured 0.8 ms per bundle, so an hour is about 3.5 s.
  it('keeps a full run inside the declared CPU ceiling with margin', () => {
    const measuredCpuMsPerHour = 4375 * 0.8
    expect(MAX_HOURS_PER_RUN * measuredCpuMsPerHour).toBeLessThan(30_000 / 2)
  })

  it('gains ground every run, so a backlog drains rather than persisting', () => {
    // Anything less than 2 would never catch up on an hourly cadence.
    expect(MAX_HOURS_PER_RUN).toBeGreaterThan(1)
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
