/**
 * Measuring a day for the deletion gate, end to end (#872, Phase A4).
 *
 * These drive the REAL `runArchiveGate` against recording doubles, so they see
 * the statements it actually issues and the values it actually records, rather
 * than which functions it called. The bundles in the probe are built by the real
 * `encodeBundle`, so a probe that passes has genuinely decompressed a bundle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import { runArchiveGate, ARCHIVE_GATE_JOB, PROBE_SAMPLE_SIZE, ALERT_WHEN_DAYS_LEFT } from '../archive-gate'
import { encodeBundle } from '../../archive/bundle'
import { notifyExportFailure } from '../export-alerts'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const NOW = new Date('2026-08-22T13:00:00.000Z')
/** The oldest candidate day, and therefore the one the urgency rule speaks about. */
const OLDEST_DAY = '2026-08-16'
const WATERMARK = '2026-08-21T23:00:00.000Z'

const env = { IDEMPOTENCY: undefined } as unknown as Env

interface DayFacts {
  pgExecutions: number
  pgSteps: number
  orphanExecutions: number
  hoursRecorded: number
  hoursExecutions: number
  erased: number
  sfExecutions: number
  sfSteps: number
  incomplete: number
  /** Postgres's view of the sampled executions. */
  sample: Array<{ execution_id: string; trace_id: string | null; step_count: number }>
}

function facts(over: Partial<DayFacts> = {}): DayFacts {
  return {
    pgExecutions: 3,
    pgSteps: 6,
    orphanExecutions: 0,
    hoursRecorded: 24,
    hoursExecutions: 3,
    erased: 0,
    sfExecutions: 3,
    sfSteps: 6,
    incomplete: 0,
    sample: [{ execution_id: 'e-1', trace_id: 't-1', step_count: 2 }],
    ...over,
  }
}

/**
 * A Supabase double that answers the three RPCs and records what was written.
 * `perDay` lets one day differ from the rest, which is how each refusal is
 * produced without spoiling the others.
 */
function supabaseDouble(opts: { watermark: string | null; base: DayFacts; perDay?: Record<string, DayFacts> }) {
  const recorded: Array<Record<string, unknown>> = []
  const factsFor = (day: string) => opts.perDay?.[day] ?? opts.base

  const client = {
    from() {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: opts.watermark === null ? null : { watermark_hour: opts.watermark },
            error: null,
          }),
      }
      return chain
    },
    rpc(name: string, args: Record<string, unknown>) {
      const day = String(args.p_day)
      const f = factsFor(day)
      if (name === 'archive_day_measurements') {
        return Promise.resolve({
          data: [
            {
              pg_execution_count: f.pgExecutions,
              pg_step_count: f.pgSteps,
              orphan_execution_count: f.orphanExecutions,
              orphan_step_count_seen: f.orphanExecutions * 11,
              orphan_sample_size: Math.min(f.orphanExecutions, 500),
              hours_recorded: f.hoursRecorded,
              hours_execution_count: f.hoursExecutions,
              erased_execution_count: f.erased,
            },
          ],
          error: null,
        })
      }
      if (name === 'archive_day_probe_sample') {
        return Promise.resolve({ data: f.sample, error: null })
      }
      if (name === 'record_archive_day_measurement') {
        recorded.push(args)
        return Promise.resolve({ data: null, error: null })
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  } as unknown as SupabaseClient

  return { client, recorded, factsFor }
}

/** A Snowflake double answering both statement shapes from the same day facts. */
function snowflakeDouble(
  factsFor: (day: string) => DayFacts,
  bundles: Map<string, { wire: string; traceId: string | null }>,
) {
  const statements: string[] = []
  return {
    statements,
    query: async (statement: string): Promise<unknown[][]> => {
      statements.push(statement)
      const day = /archive_day = '(\d{4}-\d{2}-\d{2})'/.exec(statement)?.[1] ?? ''
      const f = factsFor(day)
      if (statement.includes('COALESCE(SUM(step_count)')) {
        return [[String(f.sfExecutions), String(f.sfSteps), String(f.incomplete)]]
      }
      return f.sample
        .filter((s) => bundles.has(s.execution_id))
        .map((s) => {
          const b = bundles.get(s.execution_id) as { wire: string; traceId: string | null }
          return [s.execution_id, b.traceId, b.wire]
        })
    },
  }
}

/** A real bundle, encoded by the real encoder, so the probe genuinely decompresses. */
async function bundleFor(executionId: string, steps: number) {
  const encoded = await encodeBundle({
    execution: { id: executionId, started_at: `${OLDEST_DAY}T04:00:00.000Z` },
    steps: Array.from({ length: steps }, (_, i) => ({ id: `s-${i}` })),
  })
  return encoded.wire
}

async function run(opts: {
  watermark?: string | null
  base?: DayFacts
  perDay?: Record<string, DayFacts>
  bundles?: Map<string, { wire: string; traceId: string | null }>
}) {
  const base = opts.base ?? facts()
  const db = supabaseDouble({
    watermark: opts.watermark === undefined ? WATERMARK : opts.watermark,
    base,
    perDay: opts.perDay,
  })
  const bundles = opts.bundles ?? new Map([['e-1', { wire: await bundleFor('e-1', 2), traceId: 't-1' }]])
  const sf = snowflakeDouble(db.factsFor, bundles)
  const summary = await runArchiveGate(env, db.client, { querySnowflake: sf.query, now: () => NOW })
  return { summary, recorded: db.recorded, statements: sf.statements }
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === ARCHIVE_GATE_JOB)
    .flatMap((c) => c[2] as string[])
}

function resultFor(summary: Awaited<ReturnType<typeof run>>['summary'], day: string) {
  const r = summary.results.find((x) => x.archiveDay === day)
  if (r === undefined) throw new Error(`${day} was not measured`)
  return r
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('a healthy set of days', () => {
  it('measures every candidate day and finds them all verified', async () => {
    const { summary } = await run({})

    expect(summary.daysConsidered).toBe(6)
    expect(summary.daysMeasured).toBe(6)
    expect(summary.daysDeletable).toBe(6)
    expect(summary.failed).toBe(false)
  })

  it('records the numbers it measured, not a verdict', async () => {
    const { recorded } = await run({})
    const row = recorded.find((r) => r.p_day === OLDEST_DAY)

    expect(row).toBeDefined()
    expect(row?.p_pg_execution_count).toBe(3)
    expect(row?.p_sf_execution_count).toBe(3)
    expect(row?.p_probe_ok).toBe(true)
    expect(row?.p_probe_sampled).toBe(1)
    // Nothing resembling is_safe_to_delete: that is what logpush_active was.
    expect(Object.keys(row ?? {}).some((k) => /safe|verified|ok_to/.test(k))).toBe(false)
  })

  it('raises no alert', async () => {
    await run({})
    expect(alerted()).toEqual([])
  })

  it('asks Snowflake through a statement that deduplicates before summing steps', async () => {
    // The send path is a plain INSERT and re-sends are deliberately tolerated,
    // so a bare SUM(step_count) would double count a recovered hour and report a
    // step surplus on exactly the days a recovery had touched.
    const { statements } = await run({})
    const counts = statements.find((s) => s.includes('COALESCE(SUM(step_count)')) ?? ''

    expect(counts).toMatch(/GROUP BY execution_id/)
    expect(counts).toMatch(/MAX\(step_count\)/)
  })
})

describe('a day whose counts do not reconcile', () => {
  it('refuses it and alerts when it is close to deletion', async () => {
    const { summary } = await run({
      perDay: { [OLDEST_DAY]: facts({ sfExecutions: 2 }) },
    })

    expect(resultFor(summary, OLDEST_DAY).refusals.map((r) => r.code)).toEqual(['executions-disagree'])
    expect(alerted().join(' ')).toMatch(/2026-08-16 is not verified with 1 day left/)
  })

  it('records the refusal but stays quiet for a day with plenty of runway', async () => {
    // A day one day old refusing for incomplete-rows is normal: the amend pass
    // has a three day floor. Alerting on those daily is how an alert becomes
    // noise, and it would be loudest for the days with the most slack (L112).
    const recent = '2026-08-21'
    const { summary } = await run({ perDay: { [recent]: facts({ incomplete: 2 }) } })

    expect(resultFor(summary, recent).refusals.map((r) => r.code)).toEqual(['incomplete-rows'])
    expect(resultFor(summary, recent).daysLeft).toBeGreaterThan(ALERT_WHEN_DAYS_LEFT)
    expect(alerted()).toEqual([])
  })

  it('does not count a refused day as deletable', async () => {
    const { summary } = await run({ perDay: { [OLDEST_DAY]: facts({ orphanExecutions: 4 }) } })

    expect(summary.daysDeletable).toBe(5)
  })
})

describe('a day the archiver has not finished', () => {
  it('refuses on the missing hours, not on a step shortfall of unexplained size', async () => {
    // pg_step_count is SUMMED from the recorded hours, so with hours missing
    // every other count is measured over a fraction of the day. Reporting that
    // as "steps disagree" would send whoever reads it hunting for lost rows
    // when the real answer is that the day is not finished (L11).
    const { summary } = await run({
      perDay: { [OLDEST_DAY]: facts({ hoursRecorded: 19, pgSteps: 4 }) },
    })

    expect(resultFor(summary, OLDEST_DAY).refusals.map((r) => r.code)).toEqual(['hours-missing'])
    expect(resultFor(summary, OLDEST_DAY).refusals[0].message).toMatch(/only 19 of the 24 hours/)
  })
})

describe('executions written after their hour was archived', () => {
  it('is its own refusal, because nothing else would notice it', async () => {
    // Every hour reconciled at the time it ran, so the archiver saw nothing
    // wrong and the Snowflake side matches what it archived. Only comparing the
    // day's own execution count against the sum of its hours reveals it.
    const { summary } = await run({
      perDay: { [OLDEST_DAY]: facts({ pgExecutions: 5, hoursExecutions: 3, sfExecutions: 3 }) },
    })

    const refusals = resultFor(summary, OLDEST_DAY).refusals
    expect(refusals.map((r) => r.code)).toContain('late-executions')
    expect(refusals.map((r) => r.message).join(' ')).toMatch(/2 arrived after their hour was archived/)
  })
})

describe('orphan executions', () => {
  it('counts executions exactly and calls the step figure a lower bound', async () => {
    // Counting every orphan step timed out at 30 s against production on the
    // worst day, which is the day the measurement exists to report. So the step
    // number comes from a bounded sample and the message says so.
    const { summary } = await run({ perDay: { [OLDEST_DAY]: facts({ orphanExecutions: 900 }) } })

    const message = resultFor(summary, OLDEST_DAY).refusals.map((r) => r.message).join(' ')
    expect(message).toMatch(/900 executions on 2026-08-16 have no archived row/)
    expect(message).toMatch(/at least 9,900 step rows, counted across 500 of them/)
  })
})

describe('the payload probe', () => {
  it('fails the day when the bundle holds a different number of steps than Postgres', async () => {
    // The bundle is real and really decompressed; only its contents disagree.
    const bundles = new Map([['e-1', { wire: await bundleFor('e-1', 9), traceId: 't-1' }]])
    const { summary } = await run({
      base: facts({ sample: [{ execution_id: 'e-1', trace_id: 't-1', step_count: 11 }] }),
      bundles,
    })

    const refusals = resultFor(summary, OLDEST_DAY).refusals
    expect(refusals.map((r) => r.code)).toContain('probe-failed')
    expect(refusals.map((r) => r.message).join(' ')).toMatch(/reports 9 steps, Postgres has 11/)
  })

  it('fails the day when a sampled execution has no bundle at all', async () => {
    // Missing is a failure, never a smaller sample. Sampling fewer would turn
    // the strongest evidence a day can produce into a pass.
    const { summary } = await run({ bundles: new Map() })

    expect(resultFor(summary, OLDEST_DAY).refusals.map((r) => r.code)).toContain('probe-failed')
    expect(resultFor(summary, OLDEST_DAY).measurement?.probeSampled).toBe(1)
  })

  it('fails the day when the bundle belongs to a different execution', async () => {
    const bundles = new Map([['e-1', { wire: await bundleFor('someone-else', 2), traceId: 't-1' }]])
    const { summary } = await run({ bundles })

    expect(resultFor(summary, OLDEST_DAY).measurement?.probeFailureReason).toMatch(/do not belong/)
  })

  it('fails the day when the archived trace_id is not the one Postgres holds', async () => {
    const bundles = new Map([['e-1', { wire: await bundleFor('e-1', 2), traceId: 't-wrong' }]])
    const { summary } = await run({ bundles })

    expect(resultFor(summary, OLDEST_DAY).measurement?.probeFailureReason).toMatch(/archived trace_id/)
  })

  it('is sized from a detection floor rather than a round number', async () => {
    // 95% confidence of catching a defect affecting 5% of a day.
    expect(PROBE_SAMPLE_SIZE).toBeGreaterThanOrEqual(59)
  })
})

describe('a day with genuinely no executions', () => {
  it('is a measured zero and is verified, with an honest probe of nothing', async () => {
    const empty = facts({ pgExecutions: 0, pgSteps: 0, sfExecutions: 0, sfSteps: 0, hoursExecutions: 0, sample: [] })
    const { summary } = await run({ base: empty })

    expect(resultFor(summary, OLDEST_DAY).refusals).toEqual([])
    expect(resultFor(summary, OLDEST_DAY).measurement?.probeSampled).toBe(0)
    expect(summary.daysDeletable).toBe(6)
  })
})

describe('when the archive has no watermark', () => {
  it('measures nothing rather than recording that every day failed', async () => {
    const { summary, recorded } = await run({ watermark: null })

    expect(summary.daysConsidered).toBe(0)
    expect(recorded).toEqual([])
  })
})

describe('when one day cannot be measured at all', () => {
  it('keeps measuring the rest, and records nothing for the one that failed', async () => {
    // Above all it must not stop the days CLOSER to deletion from being
    // measured, so the failure is per day rather than per run.
    const db = supabaseDouble({ watermark: WATERMARK, base: facts() })
    const bundles = new Map([['e-1', { wire: await bundleFor('e-1', 2), traceId: 't-1' }]])
    const sf = snowflakeDouble(db.factsFor, bundles)
    let calls = 0
    const failing = async (statement: string): Promise<unknown[][]> => {
      calls++
      if (calls === 1) throw new Error('warehouse could not resume')
      return sf.query(statement)
    }

    const summary = await runArchiveGate(env, db.client, { querySnowflake: failing, now: () => NOW })

    expect(summary.daysMeasured).toBe(5)
    expect(summary.failed).toBe(true)
    expect(resultFor(summary, OLDEST_DAY).error).toMatch(/warehouse could not resume/)
    expect(db.recorded.some((r) => r.p_day === OLDEST_DAY)).toBe(false)
    // The day it failed on is the closest to deletion, so it is alerted.
    expect(alerted().join(' ')).toMatch(/2026-08-16 could not be measured/)
  })

  it('does not fabricate a measurement when the Postgres RPC answers with no row', async () => {
    // An empty answer and a day of no executions are different facts, and zeros
    // would sail through the gate as a verified empty day (L215).
    const db = supabaseDouble({ watermark: WATERMARK, base: facts() })
    const rpc = db.client.rpc.bind(db.client)
    ;(db.client as unknown as { rpc: unknown }).rpc = (name: string, args: Record<string, unknown>) =>
      name === 'archive_day_measurements' ? Promise.resolve({ data: [], error: null }) : rpc(name, args)

    const summary = await runArchiveGate(env, db.client, {
      querySnowflake: async () => [['0', '0', '0']],
      now: () => NOW,
    })

    expect(summary.daysMeasured).toBe(0)
    expect(resultFor(summary, OLDEST_DAY).error).toMatch(/not the same as a day of no executions/)
  })
})
