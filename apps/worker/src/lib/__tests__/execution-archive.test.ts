import { describe, it, expect } from 'vitest'
import { toRow, initialWatermark, MAX_HOURS_PER_RUN, WALL_TIME_BUDGET_MS } from '../execution-archive'
import type { EncodedForSend } from '../../archive/run-loop'

const encoded = (executionId: string, stepCount = 3): EncodedForSend => ({
  executionId,
  wire: 'x',
  wireBytes: 1,
  stepCount,
})

describe('toRow', () => {
  it('stamps the day the execution belongs to, taken per execution', () => {
    const row = toRow(
      encoded('e1'),
      new Map([['e1', '2026-08-16']]),
      new Map([['e1', false]]),
    )

    expect(row.archiveDay).toBe('2026-08-16')
    expect(row.incomplete).toBe(false)
  })

  it('carries the incomplete marker for an execution archived at the deadline', () => {
    const row = toRow(encoded('e1'), new Map([['e1', '2026-08-16']]), new Map([['e1', true]]))

    expect(row.incomplete).toBe(true)
  })

  // archive_day is the column every side of the deletion gate joins on, so a
  // blank one produces a row that can never be matched back to the partition it
  // came from: the Snowflake count would see it and the Postgres count would
  // not, and that day would refuse deletion forever with nothing explaining why.
  it('refuses to build a row with no archive day rather than sending a blank one', () => {
    expect(() => toRow(encoded('e1'), new Map(), new Map())).toThrow(/no archive day/)
    expect(() => toRow(encoded('e1'), new Map([['e1', '']]), new Map())).toThrow(/no archive day/)
  })

  it('names the execution it could not place, so the refusal is actionable', () => {
    expect(() => toRow(encoded('e-missing'), new Map(), new Map())).toThrow(/e-missing/)
  })

  // Two executions in one batch can belong to different days, because an hour
  // near midnight spans a boundary. A single "current day" would stamp both with
  // whichever was set last.
  it('gives each execution in a batch its own day', () => {
    const days = new Map([
      ['before', '2026-08-16'],
      ['after', '2026-08-17'],
    ])

    expect(toRow(encoded('before'), days, new Map()).archiveDay).toBe('2026-08-16')
    expect(toRow(encoded('after'), days, new Map()).archiveDay).toBe('2026-08-17')
  })
})

describe('the step count the deletion gate reads', () => {
  // The gate sums step_count on the Snowflake side and compares it against an
  // independent Postgres count. That scalar is only worth anything if it comes
  // from the array actually serialised into the bundle: taken from the intended
  // count instead, both sides agree perfectly while every bundle is short, which
  // is exactly the truncation the paging guard exists to catch (L63).
  it('carries the count through to the row rather than recomputing it', () => {
    const row = toRow(encoded('e1', 14), new Map([['e1', '2026-08-16']]), new Map())

    expect(row.stepCount).toBe(14)
  })

  it('carries a genuine zero for an execution that logged no steps', () => {
    const row = toRow(encoded('e1', 0), new Map([['e1', '2026-08-16']]), new Map())

    expect(row.stepCount).toBe(0)
  })
})

describe('initialWatermark', () => {
  it('starts one hour before the hour that just closed, not at the start of retention', () => {
    const w = initialWatermark(new Date('2026-08-18T10:37:00.000Z'))

    expect(w).toBe('2026-08-18T09:00:00.000Z')
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
