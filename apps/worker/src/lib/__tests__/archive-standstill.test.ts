/**
 * The archive standstill check, end to end against a recording double (#946).
 *
 * The pure verdict is covered in `archive/__tests__/standstill.test.ts`. This
 * covers what the runner does with it: which alert is raised, how the marker is
 * maintained, and that a failed read is not mistaken for an absent row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import {
  checkArchiveStandstill,
  ARCHIVE_STANDSTILL_JOB,
  NO_PROGRESS_SINCE_KEY,
} from '../archive-standstill'
import { STANDSTILL_MS } from '../../archive/standstill'
import { heartbeatKey } from '../cron-heartbeat'
import { notifyExportFailure } from '../export-alerts'
import type { SupabaseClient } from '@supabase/supabase-js'

const NOW = new Date('2026-08-22T10:00:00.000Z')
const HOUR = 60 * 60 * 1000

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

function kvDouble(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

function supabaseDouble(answer: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(answer),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

/** What actually reached the alerting layer, rather than which function ran. */
function raised(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === ARCHIVE_STANDSTILL_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('checkArchiveStandstill', () => {
  it('says nothing, and clears the alert, when the archive is caught up', async () => {
    const kv = kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
    const supabase = supabaseDouble({
      data: { watermark_hour: '2026-08-22T07:00:00.000Z', updated_at: ago(30 * 60 * 1000) },
      error: null,
    })

    const result = await checkArchiveStandstill(supabase, kv, NOW)

    expect(result.verdict.status).toBe('healthy')
    expect(result.alerted).toBe(false)
    expect(raised()).toEqual([])
  })

  it('names the frozen watermark and how many hours are waiting', async () => {
    const kv = kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
    const supabase = supabaseDouble({
      data: { watermark_hour: '2026-08-21T20:00:00.000Z', updated_at: ago(12 * HOUR) },
      error: null,
    })

    const result = await checkArchiveStandstill(supabase, kv, NOW)

    expect(result.alerted).toBe(true)
    expect(raised()[0]).toMatch(/has not advanced for 12 hours/)
    expect(raised()[0]).toMatch(/11 closed and settled hours are waiting/)
  })

  it('records the observation the first time it sees a running job with no progress row', async () => {
    const kv = kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
    const supabase = supabaseDouble({ data: null, error: null })

    const result = await checkArchiveStandstill(supabase, kv, NOW)

    expect(result.verdict.status).toBe('no-progress-yet')
    expect(result.alerted).toBe(false)
    // Without this the next check starts over and the age never grows, so the
    // condition can never be reached however long it lasts.
    expect(kv.store.get(NO_PROGRESS_SINCE_KEY)).toBe(NOW.toISOString())
  })

  it('alerts once a running job has gone the threshold with no progress row', async () => {
    const kv = kvDouble({
      [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000),
      [NO_PROGRESS_SINCE_KEY]: ago(19 * HOUR),
    })
    const supabase = supabaseDouble({ data: null, error: null })

    const result = await checkArchiveStandstill(supabase, kv, NOW)

    expect(result.verdict.status).toBe('never-wrote-progress')
    expect(raised()[0]).toMatch(/never written a watermark/)
    expect(raised()[0]).toMatch(/19 hours/)
  })

  it('forgets the observation once a progress row exists', async () => {
    // So a row that later disappears starts a fresh clock rather than
    // inheriting a stale age and alerting instantly.
    const kv = kvDouble({
      [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000),
      [NO_PROGRESS_SINCE_KEY]: ago(19 * HOUR),
    })
    const supabase = supabaseDouble({
      data: { watermark_hour: '2026-08-22T07:00:00.000Z', updated_at: ago(30 * 60 * 1000) },
      error: null,
    })

    await checkArchiveStandstill(supabase, kv, NOW)

    expect(kv.store.has(NO_PROGRESS_SINCE_KEY)).toBe(false)
  })

  it('stays quiet about a job that has never run, because the heartbeat covers that', async () => {
    const kv = kvDouble()
    const supabase = supabaseDouble({ data: null, error: null })

    const result = await checkArchiveStandstill(supabase, kv, NOW)

    expect(result.verdict.status).toBe('never-ran')
    expect(raised()).toEqual([])
  })

  it('treats a failed read as its own condition, never as an absent progress row', async () => {
    // The dangerous confusion. Taking the absent branch on a failed read walks
    // this straight into the never-wrote-progress path and pages about a
    // standstill that may not exist (L214).
    const kv = kvDouble({
      [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000),
      [NO_PROGRESS_SINCE_KEY]: ago(19 * HOUR),
    })
    const supabase = supabaseDouble({ data: null, error: { message: 'connection reset' } })

    const result = await checkArchiveStandstill(supabase, kv, NOW)

    expect(result.verdict.status).toBe('unreadable')
    expect(raised()[0]).toMatch(/could not be read/)
    expect(raised()[0]).not.toMatch(/never written a watermark/)
  })

  it('does not alert on a watermark frozen just inside the threshold', async () => {
    // The negative control for the stall alert. Without it the assertion above
    // is satisfied by a check that alerts whenever any hour is waiting, which
    // would fire every single hour.
    const kv = kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
    const supabase = supabaseDouble({
      data: { watermark_hour: '2026-08-22T06:00:00.000Z', updated_at: ago(STANDSTILL_MS - 60_000) },
      error: null,
    })

    const result = await checkArchiveStandstill(supabase, kv, NOW)

    expect(result.verdict.status).toBe('healthy')
    expect(raised()).toEqual([])
  })
})
