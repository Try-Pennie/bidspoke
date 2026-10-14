/**
 * Measuring a day for the deletion gate, end to end (#872, Phase A4).
 *
 * These drive the REAL `runArchiveGate` against recording doubles, so they see
 * the statements it actually issues and the values it actually records, rather
 * than which functions it called. The bundles in the probe are built by the real
 * `encodeBundle`, so a probe that passes has genuinely decompressed a bundle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import {
  runArchiveGate,
  ARCHIVE_GATE_JOB,
  PROBE_SAMPLE_SIZE,
  ALERT_WHEN_DAYS_LEFT,
  GATE_SUBREQUEST_SHARE,
  costWarnings,
  ARCHIVE_GATE_CLEANUP_JOB,
  ARCHIVE_GATE_COST_JOB,
  etClock,
  ARCHIVE_GATE_UNREADABLE_REMEDY,
  readLastPurge,
  heldRemedy,
  ARCHIVE_GATE_AT_RISK_REMEDY,
  BENEATH_REMEASURE_PER_PASS,
  type BeneathStatus,
  type PurgeRecord,
} from '../archive-gate'
import { encodeBundle } from '../../archive/bundle'
import { RETENTION_DAYS } from '../../archive/candidate-days'
import { notifyExportFailure } from '../export-alerts'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const NOW = new Date('2026-08-22T13:00:00.000Z')
/**
 * How many days the gate considers, and which day is the oldest, both DERIVED
 * from the retention window rather than written out.
 *
 * Retention has changed three times in two weeks (7, 14, 21) and is due to change
 * again. A fixture pinned to one of those fails for a reason that looks like a
 * defect in the gate rather than a stale expectation (L41).
 */
const CANDIDATE_COUNT = RETENTION_DAYS + 1
const daysBeforeNow = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10)
/**
 * The oldest candidate day: one past retention, so the purge should already have
 * taken it. It is measured so a missed night is caught rather than stranded.
 */
const OLDEST_DAY = daysBeforeNow(CANDIDATE_COUNT)
/** The day whose partition the 03:30 UTC purge takes tonight: the last reading it sees is this run's. */
const DUE_TONIGHT = daysBeforeNow(RETENTION_DAYS)
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
function supabaseDouble(opts: {
  watermark: string | null
  base: DayFacts
  perDay?: Record<string, DayFacts>
  /** Days the purge has already emptied and stamped `executions_truncated_at`. */
  stamped?: string[]
  /** Make the stamped-days read fail, as a Postgres error would. */
  stampedReadError?: string
  /** Make one day's measurement write fail, so a pass is partial rather than clean. */
  recordErrorFor?: string
  /** Make the watermark read THROW, which is the only way to reach the finally. */
  watermarkThrows?: string
}) {
  const recorded: Array<Record<string, unknown>> = []
  const factsFor = (day: string) => opts.perDay?.[day] ?? opts.base
  /**
   * Everything the run did, in the order it did it (#1137).
   *
   * The order is the assertion, not decoration: the whole value of the record is
   * that a run killed mid pass leaves a row with no ending, and that only holds
   * if the row is OPENED before any measurement happens. A test that checked
   * only which calls were made would pass on a version that opened the row at
   * the end, which records nothing about a kill.
   */
  const events: string[] = []
  const jobRuns: Array<{ op: 'insert' | 'close'; row: Record<string, unknown> }> = []

  const client = {
    from(table: string) {
      if (table === 'job_runs') {
        const chain: Record<string, unknown> = {
          insert(row: Record<string, unknown>) {
            events.push(`job_runs.insert:${String(row.job)}`)
            jobRuns.push({ op: 'insert', row })
            return chain
          },
          update(row: Record<string, unknown>) {
            events.push('job_runs.close')
            jobRuns.push({ op: 'close', row })
            return chain
          },
          select: () => chain,
          eq: () => chain,
          // The insert reads its new id back through `single`, and the close
          // reads the row it touched as an array, because a zero row UPDATE
          // reports error null and would otherwise pass (#583).
          single: () => Promise.resolve({ data: { id: 'gate-run-1' }, error: null }),
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: [{ id: 'gate-run-1' }], error: null }).then(res),
        }
        return chain
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (opts.watermarkThrows !== undefined) throw new Error(opts.watermarkThrows)
          return Promise.resolve({
            data: opts.watermark === null ? null : { watermark_hour: opts.watermark },
            error: null,
          })
        },
        // The stamped-days read: `.in('archive_day', days).not('executions_truncated_at', 'is', null)`.
        in: () => ({
          not: () =>
            Promise.resolve(
              opts.stampedReadError !== undefined
                ? { data: null, error: { message: opts.stampedReadError } }
                : { data: (opts.stamped ?? []).map((d) => ({ archive_day: d })), error: null },
            ),
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
        events.push(`measure:${day}`)
        recorded.push(args)
        if (opts.recordErrorFor === day) {
          return Promise.resolve({ data: null, error: { message: 'recording blew up' } })
        }
        return Promise.resolve({ data: null, error: null })
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  } as unknown as SupabaseClient

  return { client, recorded, factsFor, events, jobRuns }
}

/** A Snowflake double answering both statement shapes from the same day facts. */
function snowflakeDouble(
  factsFor: (day: string) => DayFacts,
  bundles: Map<string, { wire: string; traceId: string | null }>,
) {
  const statements: string[] = []
  return {
    statements,
    query: async (statement: string, bindings?: unknown[]): Promise<unknown[][]> => {
      statements.push(statement)
      // The day is BOUND now, not written into the SQL (#1006), so the double
      // reads it from the bindings. Taking it from the statement would find
      // nothing and quietly answer for the wrong day, which is how a fixture
      // starts deciding the test (L143).
      const day = typeof bindings?.[0] === 'string' ? bindings[0] : ''
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
  stamped?: string[]
  stampedReadError?: string
  recordErrorFor?: string
  watermarkThrows?: string
  restrictDays?: { from?: string; to?: string; limit?: number }
  daysHeld?: (range: { from: string; to: string }) => Promise<string[]>
  beneathStatus?: (days: string[]) => Promise<Map<string, BeneathStatus>>
  lastPurge?: (days: string[]) => Promise<Map<string, PurgeRecord>>
  remeasureBeneath?: number
}) {
  const base = opts.base ?? facts()
  const db = supabaseDouble({
    watermark: opts.watermark === undefined ? WATERMARK : opts.watermark,
    base,
    perDay: opts.perDay,
    stamped: opts.stamped,
    stampedReadError: opts.stampedReadError,
    recordErrorFor: opts.recordErrorFor,
    watermarkThrows: opts.watermarkThrows,
  })
  const bundles = opts.bundles ?? new Map([['e-1', { wire: await bundleFor('e-1', 2), traceId: 't-1' }]])
  const sf = snowflakeDouble(db.factsFor, bundles)
  const summary = await runArchiveGate(env, db.client, {
    querySnowflake: sf.query,
    now: () => NOW,
    restrictDays: opts.restrictDays,
    daysHeld: opts.daysHeld,
    beneathStatus: opts.beneathStatus,
    lastPurge: opts.lastPurge,
    remeasureBeneath: opts.remeasureBeneath,
  })
  return { summary, recorded: db.recorded, statements: sf.statements, events: db.events, jobRuns: db.jobRuns }
}

/** The day as the alert says it, "Aug 9", derived so the fixture follows NOW. */
const spoken = (day: string) =>
  new Date(`${day}T00:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

describe('times are spoken in Eastern time, daylight saving included', () => {
  it('says 11:30 PM ET for the 03:30 UTC purge in summer and 10:30 PM ET in winter', () => {
    expect(etClock(new Date('2026-08-23T03:30:00.000Z'))).toBe('11:30 PM ET')
    expect(etClock(new Date('2026-01-10T03:30:00.000Z'))).toBe('10:30 PM ET')
  })
})

/** The lines an alert key was sent, ignoring the empty sends that clear it. */
function sentTo(job: string): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === job)
    .flatMap((c) => c[2] as string[])
}

/** The title and fix of every alert actually raised, so a test sees what a reader sees. */
function raised(): Array<{ job: string; title: string; fix: string | undefined }> {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => (c[2] as string[]).length > 0)
    .map((c) => {
      const remedy = c[4] as { title: string; fixHint?: string }
      return { job: c[1] as string, title: remedy.title, fix: remedy.fixHint }
    })
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

    expect(summary.daysConsidered).toBe(CANDIDATE_COUNT)
    expect(summary.daysMeasured).toBe(CANDIDATE_COUNT)
    expect(summary.daysDeletable).toBe(CANDIDATE_COUNT)
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
  it('refuses it and says the day is held back, with the reason, and no deadline', async () => {
    const { summary } = await run({
      perDay: { [DUE_TONIGHT]: facts({ sfExecutions: 2 }) },
    })

    expect(resultFor(summary, DUE_TONIGHT).refusals.map((r) => r.code)).toEqual(['executions-disagree'])
    // #835: the cleanup takes only verified days, so this day is KEPT. The old
    // "due to be deleted at 11:30 PM ET, and after that it cannot be recovered"
    // quoted a deadline the cleanup never enforces.
    const message = resultFor(summary, DUE_TONIGHT).refusals[0].message
    expect(alerted()).toEqual([`Aug 15 cannot be verified as backed up in Snowflake: ${message}.`])
    expect(alerted().join(' ')).not.toMatch(/due to be deleted|cannot be recovered/)
    expect(raised()).toEqual([
      {
        job: ARCHIVE_GATE_JOB,
        title: 'Run history is held back from deletion until it is backed up',
        fix: 'Re-archive 2026-08-15 with POST /api/admin/re-archive and that day.',
      },
    ])
  })

  it('does not tell the reader to re-archive a day whose only fault is a surplus', async () => {
    // Re-archiving adds rows; it cannot clear an archive that holds MORE than
    // the database (#835).
    await run({ perDay: { [DUE_TONIGHT]: facts({ sfExecutions: facts().pgExecutions + 3 }) } })
    const [alert] = raised()
    expect(alert.fix).toMatch(/re-archiving will not help/)
    expect(alert.fix).not.toMatch(/^Re-archive/)
  })

  it('tells the reader to fix the read and re-run the pass when the measurement threw', async () => {
    await run({ recordErrorFor: DUE_TONIGHT })
    expect(alerted().join(' ')).toMatch(/could not be measured, so it is not confirmed as backed up/)
    expect(alerted().join(' ')).toMatch(/recording blew up/)
    const [alert] = raised()
    expect(alert.fix).toMatch(/fix the read named above, then re-run the pass with POST \/api\/admin\/archive-gate/)
    expect(alert.fix).not.toMatch(/re-archive/)
  })

  it('says so when a day is past retention and the purge did not take it', async () => {
    // The purge ran last night and left this day's rows behind, whatever the
    // reason. That is the schedule failing to enforce retention, which is the
    // failure that went unnoticed for two nights before #1196, so it is named as
    // such rather than as a negative number of days left.
    const { summary } = await run({
      perDay: { [OLDEST_DAY]: facts({ sfExecutions: 2 }) },
    })

    expect(resultFor(summary, OLDEST_DAY).daysLeft).toBeLessThan(0)
    expect(alerted()).toHaveLength(1)
    expect(alerted()[0]).toMatch(/^Aug 14 cannot be verified as backed up in Snowflake: /)
  })

  it('records the refusal but stays quiet for a day with plenty of runway', async () => {
    // The runway rule, on a refusal that genuinely DOES clear itself. A day
    // partway through being archived is short some hours, and the hourly walk
    // fills them in on its own, so alerting daily on that is how an alert
    // becomes noise, loudest for the days with the most slack (L112).
    //
    // It used to use incomplete-rows for this, which was wrong: nothing clears
    // that one, so it is now reported at once instead (#871).
    const recent = '2026-08-21'
    const { summary } = await run({
      perDay: { [recent]: facts({ hoursRecorded: 20, hoursExecutions: 3 }) },
    })

    expect(resultFor(summary, recent).refusals.map((r) => r.code)).toEqual(['hours-missing'])
    expect(resultFor(summary, recent).daysLeft).toBeGreaterThan(ALERT_WHEN_DAYS_LEFT)
    expect(alerted()).toEqual([])
  })

  it('does not count a refused day as deletable', async () => {
    const { summary } = await run({ perDay: { [OLDEST_DAY]: facts({ orphanExecutions: 4 }) } })

    expect(summary.daysDeletable).toBe(CANDIDATE_COUNT - 1)
  })
})

describe('a day the purge has already emptied', () => {
  it('is skipped, not measured, and raises nothing', async () => {
    // Its execution partition is empty, so measuring it would read zero
    // executions against the archive's full count and refuse as a surplus, on a
    // day whose deletion has already happened. The stamp is the record that it
    // did, so the gate leaves it alone.
    const { summary, recorded } = await run({ stamped: [OLDEST_DAY] })

    expect(summary.daysConsidered).toBe(CANDIDATE_COUNT)
    expect(summary.daysStamped).toBe(1)
    expect(summary.daysMeasured).toBe(CANDIDATE_COUNT - 1)
    expect(summary.results.some((r) => r.archiveDay === OLDEST_DAY)).toBe(false)
    expect(recorded.some((r) => r.p_day === OLDEST_DAY)).toBe(false)
    expect(alerted()).toEqual([])
  })

  it('treats a failed stamped-days read as a failed run, not as no days stamped', async () => {
    // An empty answer here would measure every stamped day, refuse each as a
    // surplus and alert on all of them, about deletions that already happened.
    // So the read failing is the run failing (L215, L98).
    const { summary, recorded } = await run({ stampedReadError: 'connection reset' })

    expect(summary.failed).toBe(true)
    expect(summary.daysMeasured).toBe(0)
    expect(summary.results).toEqual([])
    expect(recorded).toEqual([])
    expect(alerted().join(' ')).toMatch(/the stamped days could not be read: .*connection reset/)
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
    expect(message).toMatch(new RegExp(`900 executions on ${OLDEST_DAY} have no archived row`))
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

  it('says how many bundles are missing, not only the first one', async () => {
    // One missing out of four reads as a data problem; three out of four reads
    // as the day never having been sent. Sixteen consecutive days of alerts
    // could not tell those apart (#1128).
    const sample = [
      { execution_id: 'e-1', trace_id: 't-1', step_count: 2 },
      { execution_id: 'e-2', trace_id: 't-2', step_count: 2 },
      { execution_id: 'e-3', trace_id: 't-3', step_count: 2 },
      { execution_id: 'e-4', trace_id: 't-4', step_count: 2 },
    ]
    const bundles = new Map([['e-2', { wire: await bundleFor('e-2', 2), traceId: 't-2' }]])
    const { summary } = await run({
      perDay: { [OLDEST_DAY]: facts({ sample }) },
      bundles,
    })

    const reason = resultFor(summary, OLDEST_DAY).measurement?.probeFailureReason ?? ''
    expect(reason).toMatch(/3 of the 4/)
    // Still names one, so somebody has an id to go and look at.
    expect(reason).toMatch(/e-1|e-3|e-4/)
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
    expect(summary.daysDeletable).toBe(CANDIDATE_COUNT)
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

    expect(summary.daysMeasured).toBe(CANDIDATE_COUNT - 1)
    expect(summary.failed).toBe(true)
    expect(resultFor(summary, OLDEST_DAY).error).toMatch(/warehouse could not resume/)
    expect(db.recorded.some((r) => r.p_day === OLDEST_DAY)).toBe(false)
    // The day it failed on is the closest to deletion, so it is alerted.
    // A day that could not be measured is not shown to be short, so the line
    // claims only what is known (L11).
    expect(alerted().join(' ')).toMatch(/Aug 14 could not be measured, so it is not confirmed as backed up in Snowflake: /)
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

/**
 * The gate's own run record (#1137).
 *
 * The gate is the job whose output authorises destroying a day of execution
 * data, and until this it was the one archive job leaving no durable trace of
 * having run: measured on production 2026-09-03, `job_runs` held exactly one job
 * name across its whole 422 row history, `execution-archive`. Its only liveness
 * signal was a KV heartbeat carrying a time and no outcome, so a pass cut short
 * partway (#1129) was indistinguishable from a clean one, and days carrying
 * readings six days apart all read as measured.
 */
describe('the gate records that it ran', () => {
  it('opens its run record BEFORE measuring anything, so a killed pass leaves no ending', async () => {
    const { events } = await run({})
    // The order is the whole mechanism. Opened late, a run killed mid pass
    // leaves no row at all, which reads exactly like a run that never started.
    expect(events[0]).toBe(`job_runs.insert:${ARCHIVE_GATE_JOB}`)
    expect(events.filter((e) => e.startsWith('measure:')).length).toBeGreaterThan(0)
    expect(events.indexOf('job_runs.close')).toBeGreaterThan(events.lastIndexOf(`measure:${OLDEST_DAY}`))
  })

  it('closes it with what the pass actually achieved, not merely that it finished', async () => {
    const { jobRuns, summary } = await run({})
    const close = jobRuns.find((r) => r.op === 'close')
    expect(close, 'the run record was never closed').toBeDefined()
    expect(close!.row.finished_at).toEqual(expect.any(String))
    expect(close!.row.outcome).toBe('ok')

    // Days measured out of days attempted, so a partial pass is visible AS
    // partial. A bare "it finished" cannot distinguish the two.
    const written = close!.row.summary as Record<string, unknown>
    expect(written.daysConsidered).toBe(summary.daysConsidered)
    expect(written.daysMeasured).toBe(summary.daysMeasured)
    expect(written.daysDeletable).toBe(summary.daysDeletable)
    expect(written.daysStamped).toBe(summary.daysStamped)
  })

  it('says a pass was partial when a day could not be measured', async () => {
    const { jobRuns, summary } = await run({ recordErrorFor: OLDEST_DAY })
    const close = jobRuns.find((r) => r.op === 'close')
    // Its own outcome, not 'ok' with a smaller number buried in the summary. A
    // run that measured 20 of 21 days and one that measured 21 must not read the
    // same from outside (L11).
    expect(close!.row.outcome).toBe('partial')
    const written = close!.row.summary as Record<string, unknown>
    expect(written.daysMeasured).toBe(summary.daysMeasured)
    expect(written.daysMeasured).toBeLessThan(Number(written.daysConsidered) - summary.daysStamped)
  })

  it('closes the record on the early return when the stamped days cannot be read', async () => {
    // An exit path that RETURNS rather than throws. It gives up before a single
    // day is considered, and it is the path a Postgres error takes, so an
    // unclosed row here would read as a killed run for a reason that is nothing
    // of the sort.
    const { jobRuns } = await run({ watermark: null, stampedReadError: 'postgres said no' })
    const close = jobRuns.find((r) => r.op === 'close')
    expect(close, 'the early return left the run record open').toBeDefined()
    expect(close!.row.outcome).toBe('failed')
    expect(String(close!.row.detail)).toContain('postgres said no')
  })

  it('closes the record when the pass THROWS, and still raises the error', async () => {
    // The test that actually proves the `finally`, which the returning paths
    // above cannot: cleanup written after the last `return` closes those too, so
    // they pass on a version with no finally at all (L515). Only a throw
    // separates the two, and a throw is what a Postgres client failure is.
    const db = supabaseDouble({
      watermark: WATERMARK,
      base: facts(),
      watermarkThrows: 'the connection went away mid pass',
    })
    const sf = snowflakeDouble(db.factsFor, new Map())
    await expect(
      runArchiveGate(env, db.client, { querySnowflake: sf.query, now: () => NOW }),
    ).rejects.toThrow('the connection went away mid pass')

    const close = db.jobRuns.find((r) => r.op === 'close')
    expect(close, 'a pass that threw left its run record open, so it reads as killed').toBeDefined()
    // Its own outcome. A pass that threw and a pass that was killed must not
    // read the same, or the record cannot answer the question it exists for.
    expect(close!.row.outcome).toBe('threw')
  })

  it('records exactly one run, so a pass cannot report itself twice', async () => {
    const { jobRuns } = await run({})
    expect(jobRuns.filter((r) => r.op === 'insert')).toHaveLength(1)
    expect(jobRuns.filter((r) => r.op === 'close')).toHaveLength(1)
  })
})

/**
 * Driving the gate in chunks that fit inside a request (#1129).
 *
 * A full pass takes about six minutes, 18 seconds per populated day across 20
 * days, and `POST /api/admin/archive-gate` did all of it inside the request. On
 * 2026-09-03 a two minute client timeout stopped it after 8 of 20 days, at the
 * exact second the caller was killed. No response was ever returned, so the
 * caller learned nothing, and the table was left holding some days measured that
 * run and others carrying readings up to six days old.
 */
describe('a caller can restrict the pass to a range of days', () => {
  it('measures only the days inside the range', async () => {
    const from = daysBeforeNow(RETENTION_DAYS + 1)
    const to = daysBeforeNow(RETENTION_DAYS - 1)
    const { summary, recorded } = await run({ restrictDays: { from, to } })

    const measured = recorded.map((r) => String(r.p_day)).sort()
    expect(measured).toEqual([from, daysBeforeNow(RETENTION_DAYS), to].sort())
    // Considered reports what THIS pass attempted, so a chunk does not read as a
    // full pass that found only three days.
    expect(summary.daysConsidered).toBe(3)
  })

  it('a limit takes the OLDEST days, which are the ones closest to deletion', async () => {
    const { recorded } = await run({ restrictDays: { limit: 2 } })
    expect(recorded.map((r) => String(r.p_day))).toEqual([
      daysBeforeNow(CANDIDATE_COUNT),
      daysBeforeNow(CANDIDATE_COUNT - 1),
    ])
  })

  it('reports how many days it could have measured, so a chunk is visibly a chunk', async () => {
    const { summary } = await run({ restrictDays: { limit: 2 } })
    expect(summary.daysConsidered).toBe(2)
    expect(summary.daysAvailable).toBe(CANDIDATE_COUNT)
  })

  it('an unrestricted pass still measures everything', async () => {
    const { summary } = await run({})
    expect(summary.daysConsidered).toBe(CANDIDATE_COUNT)
    expect(summary.daysAvailable).toBe(CANDIDATE_COUNT)
  })

  it('REFUSES a range that matches no candidate day rather than measuring them all', async () => {
    // A tool given a target it cannot use must refuse, never fall back to its
    // default scope: a silently ignored range makes a run about everything look
    // exactly like the run about one day that was asked for (L320). This is the
    // dangerous direction, because the fallback here is a six minute pass.
    await expect(run({ restrictDays: { from: '2019-01-01', to: '2019-01-02' } })).rejects.toThrow(
      /no candidate day/i,
    )
  })

  it('carries its run record id, so a caller whose client dies can look up what happened', async () => {
    const { summary } = await run({})
    expect(summary.runId).toBe('gate-run-1')
  })
})

/**
 * Asking the data as well as the arithmetic (#1025).
 *
 * The backlog walk asks Postgres which days it still holds; the gate computed
 * its list from the retention constant. On 2026-08-23 the constant said 7 while
 * the purge jobs said 9, so the two lists began on different days and nothing
 * compared them. The gate decides which days are safe to delete, so a day
 * outside its view is one it can never vouch for while the purge takes it.
 */
describe('the gate notices a day Postgres holds that it is not considering', () => {
  it('names it in the summary', async () => {
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 4)
    const { summary } = await run({ daysHeld: async () => [stranded] })
    expect(summary.daysBeneathTheGate).toEqual([stranded])
  })

  /**
   * The 2026-10-02 alert (#1720). Sep 23 was fully backed up and the 03:30
   * cleanup had lost its lock twice, so nothing was at risk, and the alert said
   * "found days at risk" and "nothing vouches for it" with three fixes. A backed
   * up day the cleanup missed is housekeeping, and says so in full sentences.
   */
  /**
   * The 2026-10-02 alert (#1720). Sep 23 was fully backed up and the 03:30
   * cleanup had lost its lock twice, so nothing was at risk, and the alert said
   * "found days at risk" and "nothing vouches for it" with three fixes. A backed
   * up day the cleanup missed is housekeeping: silent for two nights, then its
   * own alert in Dan's wording.
   */
  const backedUp = async (days: string[]) => new Map(days.map((d) => [d, { backedUp: true } as BeneathStatus]))

  it('stays silent about a backed up day for the first two missed cleanups', async () => {
    // One day past the oldest candidate: its own purge and one more have run.
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 1)
    const { summary } = await run({ daysHeld: async () => [stranded], beneathStatus: backedUp })
    expect(summary.daysBeneathTheGate).toEqual([stranded])
    expect(raised()).toEqual([])
  })

  it('alerts once a backed up day has survived three nightly cleanups, and says what the cleanup recorded', async () => {
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 2)
    await run({
      daysHeld: async () => [stranded],
      beneathStatus: backedUp,
      lastPurge: async () => new Map([[stranded, { outcome: 'refused_unverified', reason: 'stale-measurement' }]]),
    })
    // #835: "blocked" was never measured. The cleanup's own record says why.
    expect(sentTo(ARCHIVE_GATE_CLEANUP_JOB)).toEqual([
      `${spoken(stranded)} is still in the database. It is fully backed up in Snowflake, so nothing is lost. ` +
        'It has outlived 3 nightly cleanups, and the last cleanup recorded refused_unverified ' +
        '(stale-measurement) for it.',
    ])
    const [alert] = raised()
    expect(alert.title).toBe('Old run history has not been cleaned up')
    // The hand CALL refuses a day this old as stale, so it is not the fix.
    expect(alert.fix).not.toMatch(/CALL truncate_verified_execution_partitions/)
    expect(alert.fix).not.toMatch(/blocking/)
    // The pass re-measures held days now (#2085), so the fix says that rather
    // than that nothing reaches a day this old.
    expect(alert.fix).toMatch(/re-measures up to \d of these/)
  })

  it('says the cleanup record could not be read rather than guessing a cause', async () => {
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 2)
    await run({
      daysHeld: async () => [stranded],
      beneathStatus: backedUp,
      lastPurge: async () => {
        throw new Error('postgres said no')
      },
    })
    expect(sentTo(ARCHIVE_GATE_CLEANUP_JOB)[0]).toMatch(/the cleanup's record of it could not be read\.$/)
  })

  it('says when no cleanup recorded anything about the day', async () => {
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 2)
    await run({ daysHeld: async () => [stranded], beneathStatus: backedUp, lastPurge: async () => new Map() })
    expect(sentTo(ARCHIVE_GATE_CLEANUP_JOB)[0]).toMatch(/no cleanup has recorded anything about it\.$/)
  })

  // The stored status path: a day beyond the pass's re-measure cap (#2085).
  it('treats a day it cannot show is backed up as at risk, not as housekeeping', async () => {
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 1)
    await run({
      remeasureBeneath: 0,
      daysHeld: async () => [stranded],
      beneathStatus: async () => new Map([[stranded, { backedUp: false }]]),
    })
    expect(alerted()).toEqual([
      `${spoken(stranded)} is older than the days the gate measures, and its last measurement showed it not ` +
        'fully backed up in Snowflake.',
    ])
    expect(raised().map((r) => r.title)).toEqual(['Run history is held back from deletion until it is backed up'])
  })

  it('does not claim a day is safe when its backup status could not be read', async () => {
    // An unreadable status is not evidence of a backup (L215).
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 1)
    await run({
      remeasureBeneath: 0,
      daysHeld: async () => [stranded],
      beneathStatus: async () => {
        throw new Error('postgres said no')
      },
    })
    expect(alerted().join(' ')).toMatch(
      new RegExp(`${spoken(stranded)} is older than the days the gate measures, and whether it is backed up`),
    )
    // The fix says "fix the read named above", so the line has to name it (#835).
    expect(alerted().join(' ')).toMatch(/postgres said no/)
    expect(raised()[0].fix).toMatch(/fix the read named above/)
    expect(sentTo(ARCHIVE_GATE_CLEANUP_JOB)).toEqual([])
  })

  it('sends the two kinds as separate alerts, so neither title sits over the other kind', async () => {
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 3)
    await run({
      perDay: { [DUE_TONIGHT]: facts({ sfExecutions: 2 }) },
      daysHeld: async () => [stranded],
      beneathStatus: backedUp,
    })
    expect(raised().map((r) => [r.job, r.title])).toEqual([
      [ARCHIVE_GATE_JOB, 'Run history is held back from deletion until it is backed up'],
      [ARCHIVE_GATE_CLEANUP_JOB, 'Old run history has not been cleaned up'],
    ])
    expect(sentTo(ARCHIVE_GATE_JOB).join(' ')).not.toMatch(/nothing is lost/)
    expect(sentTo(ARCHIVE_GATE_CLEANUP_JOB).join(' ')).toMatch(/outlived 4 nightly cleanups/)
  })

  it('clears each alert on a run that has nothing to say about it', async () => {
    await run({ daysHeld: async () => [] })
    const cleared = vi
      .mocked(notifyExportFailure)
      .mock.calls.filter((c) => (c[2] as string[]).length === 0)
      .map((c) => c[1])
    expect(cleared).toEqual([ARCHIVE_GATE_JOB, ARCHIVE_GATE_CLEANUP_JOB, ARCHIVE_GATE_COST_JOB])
  })

  it('says nothing on the healthy day, which is every day', async () => {
    const { summary } = await run({ daysHeld: async () => [] })
    expect(summary.daysBeneathTheGate).toEqual([])
    expect(raised()).toEqual([])
  })

  it('does NOT clear the gate alerts on a restricted run with nothing at risk (#1783)', async () => {
    // A restricted run sees only its chunk, so days OUTSIDE it may still be at
    // risk, not cleaned up, or costly. It must never clear the full nightly
    // pass's standing conditions: a chunk with nothing to say leaves them alone.
    await run({ restrictDays: { from: daysBeforeNow(CANDIDATE_COUNT - 2) }, daysHeld: async () => [] })
    const cleared = vi
      .mocked(notifyExportFailure)
      .mock.calls.filter((c) => (c[2] as string[]).length === 0)
      .map((c) => c[1])
    expect(cleared).toEqual([])
  })

  it('still posts at-risk days found on a restricted run, it only withholds the clear (#1783)', async () => {
    // Add-only, not silence: a restricted run that finds something still pages.
    const stranded = daysBeforeNow(CANDIDATE_COUNT + 1)
    await run({
      restrictDays: { from: daysBeforeNow(CANDIDATE_COUNT - 2) },
      daysHeld: async () => [stranded],
      beneathStatus: async () => new Map([[stranded, { backedUp: false }]]),
    })
    expect(sentTo(ARCHIVE_GATE_JOB).join(' ')).toMatch(/not fully backed up/)
  })

  it('asks about the days BELOW its oldest candidate, not the ones above', async () => {
    const asked: Array<{ from: string; to: string }> = []
    await run({
      daysHeld: async (range) => {
        asked.push(range)
        return []
      },
    })
    expect(asked).toHaveLength(1)
    expect(asked[0].to).toBe(daysBeforeNow(CANDIDATE_COUNT))
    expect(asked[0].from < asked[0].to).toBe(true)
  })

  it('compares against the FULL candidate list, not the chunk it was asked for', async () => {
    // Otherwise every chunked call reports the days outside its own slice as
    // stranded, which is the check accusing on its own argument.
    // The chunk must NOT start at the oldest candidate, or the two lists have the
    // same first element and the fixture cannot tell them apart. The first draft
    // of this test used `limit: 1` and passed against both readings.
    const chunkStart = daysBeforeNow(CANDIDATE_COUNT - 3)
    const insideAvailableBelowChunk = daysBeforeNow(CANDIDATE_COUNT - 1)
    const { summary } = await run({
      restrictDays: { from: chunkStart },
      daysHeld: async () => [insideAvailableBelowChunk],
    })
    expect(insideAvailableBelowChunk < chunkStart).toBe(true)
    expect(summary.daysBeneathTheGate).toEqual([])
  })

  it('does not fail the pass when the check itself cannot read', async () => {
    // A watchdog must not share the abort behaviour of the work it watches, or
    // an incidental failure takes the work down with it (L71).
    const { summary } = await run({
      daysHeld: async () => {
        throw new Error('postgres said no')
      },
    })
    expect(summary.daysBeneathTheGate).toEqual([])
    expect(summary.daysMeasured).toBe(CANDIDATE_COUNT)
  })
})

/**
 * What one pass costs, measured rather than estimated (#1127).
 *
 * The gate runs inside the shared `0 13 * * *` invocation and the platform's
 * subrequest ceiling is per invocation, so the gate spending all of it starves
 * whatever runs beside it. The window is derived from RETENTION_DAYS, which has
 * changed three times in a fortnight, so the cost moves with a constant somebody
 * else edits. Recording it on every run rather than measuring it once means the
 * answer is a query rather than a sentence anybody has to maintain (L316).
 */
describe('the gate reports what it cost', () => {
  it('counts every outbound call it issued, not a figure derived from the day count', async () => {
    // Counted where each call is issued. A budget that counts only some of its
    // consumers reports headroom while the limit is breached (#965), so this
    // compares against what the doubles actually SAW.
    const seen: string[] = []
    const { summary, statements } = await run({
      daysHeld: async (range) => {
        seen.push(`${range.from}..${range.to}`)
        return []
      },
    })

    expect(summary.cost.snowflakeStatements).toBe(statements.length)
    // Three per measured day (two RPCs plus the measurement write), the watermark
    // read, the stamped read, and one existence query per day of the beneath check.
    const beneathQueries = summary.cost.postgresCalls - (3 * summary.daysMeasured + 2)
    expect(beneathQueries).toBeGreaterThan(0)
    expect(summary.cost.subrequests).toBe(summary.cost.snowflakeStatements + summary.cost.postgresCalls)
    expect(seen).toHaveLength(1)
  })

  it('reports cost per day, so a change in the window is separable from a change in the work', async () => {
    const { summary } = await run({})
    expect(summary.cost.subrequestsPerDay).toBe(
      Math.round(summary.cost.subrequests / summary.daysMeasured),
    )
    expect(summary.cost.msPerDay).toEqual(expect.any(Number))
  })

  it('reports no per-day figure at all when nothing was measured, rather than zero', async () => {
    // Zero would read as "each day was free", which is a measurement nobody took
    // (L90). Null says there was nothing to divide by.
    const { summary } = await run({ watermark: null })
    expect(summary.daysMeasured).toBe(0)
    expect(summary.cost.msPerDay).toBeNull()
    expect(summary.cost.subrequestsPerDay).toBeNull()
  })

  it('records the cost on the run, so the headroom question is a query', async () => {
    const { jobRuns } = await run({})
    const written = (jobRuns.find((r) => r.op === 'close')!.row.summary as Record<string, unknown>)
      .cost as Record<string, unknown>
    expect(written.subrequests).toEqual(expect.any(Number))
    expect(written.durationMs).toEqual(expect.any(Number))
  })

  it('says so when a pass outgrows its share of the shared invocation', () => {
    // Driven from a literal, because no fixture can push a real pass over the
    // line: its cost is set by RETENTION_DAYS and a fixed lookback. A test
    // written against the run would have passed whichever side it landed on,
    // which is what the first draft of this did (L1).
    const over = {
      durationMs: 1000,
      subrequests: GATE_SUBREQUEST_SHARE + 1,
      snowflakeStatements: 1,
      postgresCalls: GATE_SUBREQUEST_SHARE,
      msPerDay: 50,
      subrequestsPerDay: 15,
    }
    const said = costWarnings(over, 20)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/own cron/)
    expect(said[0]).toContain(String(GATE_SUBREQUEST_SHARE + 1))
    expect(said[0]).toContain('15 per day across 20 days')
  })

  it('says nothing at the threshold itself, so the ordinary run is silent', () => {
    const at = {
      durationMs: 1000,
      subrequests: GATE_SUBREQUEST_SHARE,
      snowflakeStatements: 1,
      postgresCalls: GATE_SUBREQUEST_SHARE - 1,
      msPerDay: 50,
      subrequestsPerDay: 15,
    }
    expect(costWarnings(at, 20)).toEqual([])
  })

  it('a real pass stays well inside the share, which is the finding #1127 asked for', () => {
    // The measurement the issue wanted, kept as an assertion rather than a
    // sentence with a date on it: at the retention in force it costs this, and
    // if retention changes this fails rather than going quietly stale.
    return run({}).then(({ summary }) => {
      expect(summary.cost.subrequests).toBeLessThan(GATE_SUBREQUEST_SHARE)
    })
  })
})

/**
 * A day the archive never touched is reported while it is still fixable (#1016).
 *
 * The gate alerts on days within ALERT_WHEN_DAYS_LEFT of deletion, which is
 * right for a refusal that clears itself: a day refusing for incomplete-rows one
 * day after it ends is normal, because the amend pass has a three day floor.
 *
 * `never-archived` does not clear itself. Nothing in the hourly walk goes back
 * for a day it has passed, so a day with no archived hour stays that way until
 * somebody re-archives it, and it is recoverable only until its partition is
 * purged. Waiting for the last three days to say so spends the runway that makes
 * it fixable.
 */
describe('a day with no archived hour at all is reported at once', () => {
  const alerts = () =>
    vi.mocked(notifyExportFailure).mock.calls.filter((c) => c[1] === ARCHIVE_GATE_JOB).flatMap((c) => c[2] as string[])

  /** A day with all its runway left, so nothing else would alert about it. */
  const NOT_URGENT = daysBeforeNow(RETENTION_DAYS - ALERT_WHEN_DAYS_LEFT - 1)

  it('alerts even with the whole retention window left', async () => {
    await run({ perDay: { [NOT_URGENT]: facts({ hoursRecorded: 0 }) } })

    const said = alerts().filter((m) => m.includes(spoken(NOT_URGENT)))
    expect(said, `nothing was said about ${NOT_URGENT}`).toHaveLength(1)
    expect(said[0]).toMatch(/cannot be verified as backed up in Snowflake/)
  })

  it('says what is uncovered, and no deadline the cleanup does not enforce', async () => {
    await run({ perDay: { [NOT_URGENT]: facts({ hoursRecorded: 0, pgExecutions: 104599 }) } })

    const said = alerts().find((m) => m.includes(spoken(NOT_URGENT))) as string
    expect(said).toMatch(new RegExp(`^${spoken(NOT_URGENT)} cannot be verified as backed up in Snowflake: `))
    expect(said).toMatch(/104,599/)
    expect(said).not.toMatch(/due to be deleted|cannot be recovered/)
  })

  it('reports incomplete rows while there is still runway to re-archive them', async () => {
    // REVERSED DELIBERATELY (#871). This used to assert silence, on the
    // reasoning that incomplete-rows clears itself once the amend pass catches
    // up. There is no amend pass: #932 closed that question after measuring
    // 1.4 million executions across two windows and finding nothing that would
    // trigger one. So an incomplete row clears only when somebody re-archives
    // the day, which makes it exactly like never-archived: it does not clear
    // itself, and staying quiet until the partition is due spends the runway
    // that makes it fixable.
    await run({ perDay: { [NOT_URGENT]: facts({ incomplete: 2 }) } })

    const said = alerts().filter((m) => m.includes(spoken(NOT_URGENT)))
    expect(said, `nothing was said about ${NOT_URGENT}`).toHaveLength(1)
    expect(raised()[0].fix).toMatch(/re-archive/i)
  })

  it('does not tell anybody to wait for a repair that does not exist', async () => {
    await run({ perDay: { [NOT_URGENT]: facts({ incomplete: 2 }) } })
    // Naming a mechanism nobody built is worse than saying nothing: it reads as
    // "this will sort itself out" and the day then refuses for ever (L11).
    expect(alerts().join(' ')).not.toMatch(/amend pass/i)
  })
})

/**
 * #835: an abandoned pass KEEPS the days it would have verified. The cleanup
 * takes only days measured in the last 36 hours, so "the purge still runs on its
 * own schedule" read as data about to go when nothing would be deleted.
 */
describe('the unreadable gate alert states the real consequence', () => {
  it('says the days are kept until a pass succeeds, not that the purge runs regardless', () => {
    expect(ARCHIVE_GATE_UNREADABLE_REMEDY.consequence).not.toMatch(/still runs on its own schedule/)
    expect(ARCHIVE_GATE_UNREADABLE_REMEDY.consequence).toMatch(/kept until a pass succeeds/)
    expect(ARCHIVE_GATE_UNREADABLE_REMEDY.fixHint).not.toMatch(/deadline/)
  })
})

describe('the cleanup record is read per day (lessons review, #835)', () => {
  it('asks for each day on its own, newest row first, so one busy day cannot crowd out another', async () => {
    const asked: Array<{ day: unknown; limit: unknown }> = []
    const client = {
      from: () => {
        const q: Record<string, unknown> = {}
        let day: unknown
        q.select = () => q
        q.eq = (_c: string, v: unknown) => ((day = v), q)
        q.order = () => q
        q.limit = (n: unknown) => {
          asked.push({ day, limit: n })
          return Promise.resolve({ data: [{ archive_day: day, outcome: 'refused_unverified', reason: 'stale-measurement' }], error: null })
        }
        return q
      },
    } as unknown as SupabaseClient
    const records = await readLastPurge(client, ['2026-08-01', '2026-08-02'])
    expect(asked).toEqual([
      { day: '2026-08-01', limit: 1 },
      { day: '2026-08-02', limit: 1 },
    ])
    expect(records.get('2026-08-02')?.outcome).toBe('refused_unverified')
  })
})

describe('the held day chooser with no days (lessons review, #835)', () => {
  it('returns the base remedy', () => {
    expect(heldRemedy([])).toBe(ARCHIVE_GATE_AT_RISK_REMEDY)
  })
})

/**
 * #2085: the cleanup takes only a day measured in the last 36 hours, and the gate
 * measured a day only until one night past its purge, so a backed up day that
 * missed twice could never be taken and its alert repeated for ever. Each full
 * pass now re-measures a few of the days beneath it, oldest first, AFTER the
 * candidate days so they never delay a day closer to deletion.
 */
describe('days beneath the gate are measured again (#2085)', () => {
  const beneathDays = (n: number) => Array.from({ length: n }, (_, i) => daysBeforeNow(CANDIDATE_COUNT + 2 + (n - 1 - i)))

  it('re-measures a held day, so a backed up one is verified for tonight\'s cleanup', async () => {
    const [stranded] = beneathDays(1)
    const { summary, recorded } = await run({ daysHeld: async () => [stranded], lastPurge: async () => new Map() })
    expect(recorded.map((r) => r.p_day)).toContain(stranded)
    expect(resultFor(summary, stranded).refusals).toEqual([])
    expect(summary.daysDeletable).toBe(CANDIDATE_COUNT + 1)
  })

  it(`re-measures at most ${BENEATH_REMEASURE_PER_PASS} a pass, oldest first, and reads the rest as before`, async () => {
    const days = beneathDays(BENEATH_REMEASURE_PER_PASS + 2)
    const read: string[][] = []
    const { recorded } = await run({
      daysHeld: async () => days,
      beneathStatus: async (d) => { read.push(d); return new Map(d.map((x) => [x, { backedUp: true } as BeneathStatus])) },
      lastPurge: async () => new Map(),
    })
    const measuredBeneath = recorded.map((r) => String(r.p_day)).filter((d) => days.includes(d))
    expect(measuredBeneath).toEqual([...days].sort().slice(0, BENEATH_REMEASURE_PER_PASS))
    expect(read.flat()).toEqual([...days].sort().slice(BENEATH_REMEASURE_PER_PASS))
  })

  it('measures the held days after every candidate day, so they never delay one closer to deletion', async () => {
    const [stranded] = beneathDays(1)
    const { recorded } = await run({ daysHeld: async () => [stranded], lastPurge: async () => new Map() })
    expect(recorded[recorded.length - 1].p_day).toBe(stranded)
  })

  it('re-measures nothing on a restricted run, which sees only its own chunk', async () => {
    const [stranded] = beneathDays(1)
    const { recorded } = await run({
      restrictDays: { from: daysBeforeNow(CANDIDATE_COUNT - 2) },
      daysHeld: async () => [stranded],
      beneathStatus: async (d) => new Map(d.map((x) => [x, { backedUp: true } as BeneathStatus])),
    })
    expect(recorded.map((r) => r.p_day)).not.toContain(stranded)
  })

  it('reports a held day that measures short once, with the re-archive fix, not also as beneath-short', async () => {
    const [stranded] = beneathDays(1)
    await run({ perDay: { [stranded]: facts({ sfExecutions: 2 }) }, daysHeld: async () => [stranded] })
    const lines = alerted().filter((l) => l.includes(spoken(stranded)))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/older than the days the gate measures/)
    expect(raised().find((r) => r.job === ARCHIVE_GATE_JOB)?.fix).toMatch(/Re-archive/)
  })

  it('says in the not cleaned up fix that each pass re-measures these days', async () => {
    const [stranded] = beneathDays(1)
    await run({ daysHeld: async () => [stranded], lastPurge: async () => new Map() })
    const alert = raised().find((r) => r.job === ARCHIVE_GATE_CLEANUP_JOB)
    expect(alert?.fix).toMatch(new RegExp(`re-measures up to ${BENEATH_REMEASURE_PER_PASS} of these`))
    expect(alert?.fix).not.toMatch(/until the deletion gate can measure days beneath it/)
  })
})
