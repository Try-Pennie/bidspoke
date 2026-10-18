/**
 * One read-only answer to "is the execution archive healthy" (#959).
 *
 * Two properties matter more than the shape of the report:
 *
 *  - it WRITES NOTHING. This is what somebody runs to look around when an alert
 *    fires, in a hurry, without re-reading the docs, and a name like "check"
 *    that quietly mutates is exactly the trap that catches them (L206).
 *  - a source that could not be READ says so on its own section. A failed
 *    lookup that comes back empty is indistinguishable from a healthy silence,
 *    and this report exists because every individual signal read green for
 *    nineteen hours while the archive did nothing (L215, L98).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { archiveHealth, hoursBehindWatermark, ARCHIVE_JOBS, COVERAGE_HOUR_ROWS_MAX } from '../archive-health'
import { RETENTION_DAYS } from '../../archive/candidate-days'
import type { Env } from '../../index'

const NOW = new Date('2026-09-10T12:00:00.000Z')

interface TableData {
  rows?: Array<Record<string, unknown>>
  error?: { message: string }
}

/** Records every write attempt, so "writes nothing" is asserted rather than assumed. */
function supabaseDouble(tables: Record<string, TableData>, rpcError?: { message: string }) {
  const writes: string[] = []
  const client = {
    rpc: async () => ({ data: rpcError ? null : [], error: rpcError ?? null }),
    from(table: string) {
      const answer = () =>
        Promise.resolve({
          data: tables[table]?.error ? null : (tables[table]?.rows ?? []),
          error: tables[table]?.error ?? null,
        })
      const chain: Record<string, unknown> = {
        select() { return chain },
        eq() { return chain },
        gte() { return chain },
        lte() { return chain },
        lt() { return chain },
        // PostgREST spells "column IS NOT NULL" as .not(col, 'is', null), and
        // the headroom read uses it (#1294). A double missing it does not answer
        // wrongly, it THROWS, and the section's own catch turns that into an
        // error nobody wrote, which reads as the reading having failed (L52).
        not() { return chain },
        order() { return chain },
        limit() { return chain },
        maybeSingle() {
          const t = tables[table]
          return Promise.resolve({
            data: t?.error ? null : (t?.rows ?? [])[0] ?? null,
            error: t?.error ?? null,
          })
        },
        insert() { writes.push(`insert ${table}`); return chain },
        update() { writes.push(`update ${table}`); return chain },
        upsert() { writes.push(`upsert ${table}`); return chain },
        delete() { writes.push(`delete ${table}`); return chain },
        then(res: (v: unknown) => unknown) { return answer().then(res) },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, writes }
}

function envWith(lock: string | null, kvWrites: string[] = []) {
  return {
    IDEMPOTENCY: {
      get: async () => lock,
      put: async (k: string) => { kvWrites.push(`put ${k}`) },
      delete: async (k: string) => { kvWrites.push(`delete ${k}`) },
    },
  } as unknown as Env
}

const HEALTHY = {
  job_runs: { rows: [{ job: 'execution-archive', started_at: '2026-09-10T11:23:00Z', finished_at: '2026-09-10T11:25:00Z', outcome: 'ok', detail: null }] },
  execution_archive_progress: { rows: [{ watermark_hour: '2026-09-10T10:00:00.000Z' }] },
  execution_archive_hours: { rows: [] },
  execution_archive_days: { rows: [] },
  workflow_executions: { rows: [] },
  purge_run_log: { rows: [{ job: 'truncate', archive_day: '2026-09-02', outcome: 'truncated' }] },
}

describe('archiveHealth', () => {
  it('writes nothing at all, to any store', async () => {
    const kvWrites: string[] = []
    const db = supabaseDouble(HEALTHY)

    await archiveHealth(envWith(null, kvWrites), db.client, { now: () => NOW })

    expect(db.writes).toEqual([])
    expect(kvWrites).toEqual([])
  })

  it('reports the last run of every archive job, named individually', async () => {
    const db = supabaseDouble(HEALTHY)

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    expect('error' in health.jobs).toBe(false)
    if ('error' in health.jobs) return
    // Named rather than counted, because a count passes when one job is
    // silently swapped for another (L63).
    expect(health.jobs.rows.map((r) => r.job)).toEqual([...ARCHIVE_JOBS])
  })

  it('reports the headroom before the busiest hour no longer fits (#1294)', async () => {
    // Built from run records the way production's are, so what is exercised is
    // the reading, not a hand-made HeadroomReading.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      job: 'execution-archive',
      started_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
      finished_at: new Date(NOW.getTime() - (i + 1) * 3_600_000 + 40_000).toISOString(),
      outcome: 'caught-up',
      detail: null,
      summary: { hoursArchived: 1, executionsArchived: 1_000 },
    }))
    const db = supabaseDouble({ ...HEALTHY, job_runs: { rows } })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    expect('error' in health.headroom).toBe(false)
    if ('error' in health.headroom) return
    expect(health.headroom.kind).toBe('measured')
  })

  it('says it cannot measure the headroom rather than reporting a flattering one', async () => {
    // No usable runs must not read as infinite room. A check with no data
    // reporting the healthiest possible answer is the shape of L98.
    const db = supabaseDouble({ ...HEALTHY, job_runs: { rows: [] } })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    if ('error' in health.headroom) throw new Error('headroom failed to read')
    expect(health.headroom.kind).toBe('too-few-runs')
  })

  it('reports the headroom read failing as an error, never as room', async () => {
    // The section catches, so a failed read becomes an error object. What must
    // not happen is it becoming a cheerful reading: an error state and an empty
    // state are different screens (L10), and here the empty one reads as the
    // archive having all the room in the world.
    const db = supabaseDouble({ ...HEALTHY, job_runs: { rows: [], error: { message: 'statement timeout' } } })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    expect('error' in health.headroom).toBe(true)
    if (!('error' in health.headroom)) return
    expect(health.headroom.error).toContain('statement timeout')
  })

  it('skips a run record it cannot read rather than failing the whole reading', async () => {
    // Run records written before the summary carried these fields, or by a run
    // that was killed mid-stamp, are real and will be in this window. One of
    // them must not take the headroom section down with it.
    const usable = Array.from({ length: 6 }, (_, i) => ({
      job: 'execution-archive',
      started_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
      finished_at: new Date(NOW.getTime() - (i + 1) * 3_600_000 + 40_000).toISOString(),
      outcome: 'caught-up',
      detail: null,
      summary: { hoursArchived: 1, executionsArchived: 1_000 },
    }))
    const rows = [
      { job: 'execution-archive', started_at: null, finished_at: null, outcome: null, detail: null, summary: null },
      { job: 'execution-archive', started_at: 'not a date', finished_at: 'nor this', outcome: null, detail: null, summary: { hoursArchived: 1, executionsArchived: 'many' } },
      ...usable,
    ]
    const db = supabaseDouble({ ...HEALTHY, job_runs: { rows } })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    if ('error' in health.headroom) throw new Error('headroom failed to read')
    expect(health.headroom.kind).toBe('measured')
    if (health.headroom.kind !== 'measured') return
    // The six usable ones, and neither of the two unreadable rows counted.
    expect(health.headroom.runsMeasured).toBe(6)
  })

  it('marks a run with a start and no ending as looking killed', async () => {
    const db = supabaseDouble({
      ...HEALTHY,
      job_runs: { rows: [{ job: 'execution-archive', started_at: '2026-09-10T11:23:00Z', finished_at: null, outcome: null, detail: null }] },
    })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    if ('error' in health.jobs) throw new Error('jobs failed to read')
    expect(health.jobs.rows[0].looksKilled).toBe(true)
  })

  it('does not call a job that has never run a killed one', async () => {
    // Never run and killed are different facts and only one is a defect (L11).
    const db = supabaseDouble({ ...HEALTHY, job_runs: { rows: [] } })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    if ('error' in health.jobs) throw new Error('jobs failed to read')
    expect(health.jobs.rows[0]).toMatchObject({ startedAt: null, looksKilled: false })
  })

  it('reports how far behind the watermark is', async () => {
    const db = supabaseDouble(HEALTHY)

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    expect(health.watermark).toEqual({ hour: '2026-09-10T10:00:00.000Z', hoursBehind: 2 })
  })

  it('reports whether the run lock is held', async () => {
    const held = await archiveHealth(envWith('taken-at-11:23'), supabaseDouble(HEALTHY).client, { now: () => NOW })
    expect(held.lock).toEqual({ held: true, value: 'taken-at-11:23' })

    const free = await archiveHealth(envWith(null), supabaseDouble(HEALTHY).client, { now: () => NOW })
    expect(free.lock).toEqual({ held: false, value: null })
  })

  it('reports step partitions held back only by the day before them', async () => {
    // The two authorised day lists legitimately differ, so a length comparison
    // cannot report this. These are the differences that are NOT expected, and
    // each one is real disk nothing else would mention (#1249).
    const db = supabaseDouble(HEALTHY)
    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    expect('error' in health.strandedStepPartitions).toBe(false)
  })

  it('says the stranded lookup could not be read rather than reporting none', async () => {
    // None stranded and could not tell are different answers, and only one of
    // them is a reason to stop worrying (L215).
    const db = supabaseDouble(HEALTHY, { message: 'permission denied' })
    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    expect('error' in health.strandedStepPartitions).toBe(true)
  })

  it('says a source could not be read rather than reporting it as empty', async () => {
    const db = supabaseDouble({ ...HEALTHY, purge_run_log: { error: { message: 'permission denied' } } })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    // The whole point: an unreadable source and a source with nothing in it
    // must not produce the same report.
    expect('error' in health.purgeLastRun).toBe(true)
    if (!('error' in health.purgeLastRun)) return
    expect(health.purgeLastRun.error).toMatch(/permission denied/)
  })

  it('still answers the other sections when one of them fails', async () => {
    // Somebody is reading this because something is already wrong. Withholding
    // six healthy readings because the seventh failed is the wrong trade.
    const db = supabaseDouble({ ...HEALTHY, execution_archive_progress: { error: { message: 'timeout' } } })

    const health = await archiveHealth(envWith(null), db.client, { now: () => NOW })

    expect('error' in health.watermark).toBe(true)
    expect('error' in health.jobs).toBe(false)
    expect(health.lock).toEqual({ held: false, value: null })
  })
})

/**
 * The lag reader, which the repair decides on (#1032).
 *
 * Null is the fail-safe answer and the repair refuses on it. That is right, and
 * it is also why the CAUSE has to survive: a repair refused because the
 * database was unreachable and one refused because the archive has never run
 * both arrive as null, and only the log tells them apart (L11).
 */
describe('hoursBehindWatermark', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reports whole hours behind', async () => {
    const db = supabaseDouble(HEALTHY)
    expect(await hoursBehindWatermark(db.client, NOW)).toBe(2)
  })

  it('answers null, not zero, when there is no watermark to read', async () => {
    // Zero would mean "keeping up perfectly", which is the one answer that
    // makes the repair proceed (L215).
    const db = supabaseDouble({ ...HEALTHY, execution_archive_progress: { rows: [] } })
    expect(await hoursBehindWatermark(db.client, NOW)).toBeNull()
  })

  it('answers null AND says why when the read itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = supabaseDouble({
      ...HEALTHY,
      execution_archive_progress: { error: { message: 'statement timeout' } },
    })

    expect(await hoursBehindWatermark(db.client, NOW)).toBeNull()
    expect(logged.mock.calls.flat().join(' ')).toMatch(/statement timeout/)
  })
})

/**
 * The coverage section against tables past PostgREST's row cap (#1437).
 *
 * `execution_archive_hours` held 1,531 rows on 2026-10-18 and nothing prunes it,
 * and `execution_archive_days` gains a row a day for ever. A read of either with
 * no bound in the query comes back as an arbitrary 1,000 of them, and a coverage
 * report built from the wrong 1,000 says finished days are missing hours.
 *
 * So this double behaves the way PostgREST does on the points that matter: it
 * applies the filters, the order and the limit the query actually asked for, and
 * then answers at most 1,000 rows, in storage order when no order was given.
 * Storage order here is oldest first, the order the rows were written in.
 */
const ROW_CAP = 1000

function postgrestDouble(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    rpc: async () => ({ data: [], error: null }),
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = []
      let order: Array<{ col: string; asc: boolean }> = []
      let window: { from: number; to: number } | null = null
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
        if (order.length > 0) {
          rows = [...rows].sort((a, b) => {
            for (const { col, asc } of order) {
              const x = String(a[col])
              const y = String(b[col])
              if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1)
            }
            return 0
          })
        }
        if (window) rows = rows.slice(window.from, window.to + 1)
        return rows.slice(0, ROW_CAP)
      }
      const chain: Record<string, unknown> = {
        select() { return chain },
        eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return chain },
        gte(col: string, v: string) { filters.push((r) => String(r[col]) >= v); return chain },
        gt(col: string, v: string) { filters.push((r) => String(r[col]) > v); return chain },
        lte(col: string, v: string) { filters.push((r) => String(r[col]) <= v); return chain },
        lt(col: string, v: string) { filters.push((r) => String(r[col]) < v); return chain },
        not(col: string) { filters.push((r) => r[col] !== null && r[col] !== undefined); return chain },
        order(col: string, opts?: { ascending?: boolean }) {
          order = [...order, { col, asc: opts?.ascending !== false }]
          return chain
        },
        limit(n: number) { window = { from: 0, to: n - 1 }; return chain },
        range(from: number, to: number) { window = { from, to }; return chain },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        then(res: (v: unknown) => unknown) { return Promise.resolve({ data: run(), error: null }).then(res) },
      }
      return chain
    },
  } as unknown as SupabaseClient
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** One row per hour, oldest first, ending with the hour before `end`. */
function hourRows(count: number, end: Date) {
  return Array.from({ length: count }, (_, i) => {
    const hourStart = new Date(end.getTime() - (count - i) * HOUR_MS).toISOString()
    return { hour_start: hourStart, archive_day: hourStart.slice(0, 10), execution_count: 10, step_count: 100 }
  })
}

/** One row per day, oldest first, ending with the day of `end`. */
function dayRows(count: number, end: Date) {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(end.getTime() - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10)
    return { archive_day: day, pg_execution_count: 240, sf_execution_count: 240, hours_execution_count: 240 }
  })
}

/** An execution on each of the report's days, so Postgres holds all of them. */
const WINDOW_DAYS = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']
const EXECUTIONS = WINDOW_DAYS.map((d, i) => ({ id: `e${i}`, started_at: `${d}T05:00:00.000Z` }))

describe('archiveHealth coverage past the row cap (#1437)', () => {
  it('counts the recorded hours of the days it reports when the table holds 1,500 hours', async () => {
    // 1,500 contiguous hours ending at 11:00 today. The oldest 1,000 of them end
    // on 2026-08-20, so a read with no bound sees none of the report's days.
    const db = postgrestDouble({
      execution_archive_hours: hourRows(1500, NOW),
      execution_archive_days: dayRows(9, NOW),
      workflow_executions: EXECUTIONS,
    })

    const health = await archiveHealth(envWith(null), db, { now: () => NOW })

    if ('error' in health.days) throw new Error(`coverage failed to read: ${health.days.error}`)
    expect(health.days.map((d) => d.day)).toEqual(WINDOW_DAYS)
    // Every finished day complete, and today's twelve hours so far.
    expect(health.days.map((d) => d.hoursRecorded)).toEqual([24, 24, 24, 24, 24, 24, 24, 24, 12])
    if ('error' in health.backlog) throw new Error('backlog failed to read')
    expect(health.backlog.hoursOutstanding).toBe(0)
  })

  it('finds the measurements of the days it reports when the table holds 1,500 days', async () => {
    // A row a day since mid 2022: the oldest 1,000 end in 2025.
    const db = postgrestDouble({
      execution_archive_hours: hourRows(9 * 24, NOW),
      execution_archive_days: dayRows(1500, NOW),
      workflow_executions: EXECUTIONS,
    })

    const health = await archiveHealth(envWith(null), db, { now: () => NOW })

    if ('error' in health.days) throw new Error(`coverage failed to read: ${health.days.error}`)
    expect(health.days.map((d) => d.pgExecutions)).toEqual(WINDOW_DAYS.map(() => 240))
    expect(health.days.map((d) => d.sfExecutions)).toEqual(WINDOW_DAYS.map(() => 240))
  })

  it('refuses a reply holding more hours than its days can, rather than reporting part of it', async () => {
    // hour_start is the key and an hour's day is its UTC date, so nine days hold
    // at most 216 hours. More than that means one of those beliefs is wrong, and
    // a report silently built from the first 216 is the defect this replaced.
    const real = hourRows(9 * 24, new Date('2026-09-11T00:00:00.000Z'))
    const extra = { ...real[0], hour_start: '2026-09-02T00:30:00.000Z' }
    const db = postgrestDouble({
      execution_archive_hours: [...real, extra],
      execution_archive_days: dayRows(9, NOW),
      workflow_executions: EXECUTIONS,
    })

    const health = await archiveHealth(envWith(null), db, { now: () => NOW })

    expect('error' in health.days).toBe(true)
    if (!('error' in health.days)) return
    expect(health.days.error).toMatch(/more than 216/)
  })

  it('refuses a reply holding more day measurements than its days can, rather than reporting part of it', async () => {
    // archive_day is the key, so nine days hold at most nine measurements. A
    // tenth means that belief is wrong, and the report must say so rather than
    // pick whichever nine came first.
    const days = dayRows(9, NOW)
    const db = postgrestDouble({
      execution_archive_hours: hourRows(9 * 24, NOW),
      execution_archive_days: [...days, { ...days[4], pg_execution_count: 1 }],
      workflow_executions: EXECUTIONS,
    })

    const health = await archiveHealth(envWith(null), db, { now: () => NOW })

    expect('error' in health.days).toBe(true)
    if (!('error' in health.days)) return
    expect(health.days.error).toMatch(/reading the day measurements.*more than 9/)
  })

  it('reads a window whose largest possible reply fits one PostgREST page', () => {
    // The bound in the query is only a bound while its maximum, plus the one
    // extra row asked for to detect overflow, stays under the cap.
    expect(COVERAGE_HOUR_ROWS_MAX + 1).toBeLessThan(ROW_CAP)
    expect(COVERAGE_HOUR_ROWS_MAX).toBe((RETENTION_DAYS + 2) * 24)
  })
})
