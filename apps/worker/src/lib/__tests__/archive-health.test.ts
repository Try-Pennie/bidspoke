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
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { archiveHealth, ARCHIVE_JOBS } from '../archive-health'
import type { Env } from '../../index'

const NOW = new Date('2026-09-10T12:00:00.000Z')

interface TableData {
  rows?: Array<Record<string, unknown>>
  error?: { message: string }
}

/** Records every write attempt, so "writes nothing" is asserted rather than assumed. */
function supabaseDouble(tables: Record<string, TableData>) {
  const writes: string[] = []
  const client = {
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
        lt() { return chain },
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
