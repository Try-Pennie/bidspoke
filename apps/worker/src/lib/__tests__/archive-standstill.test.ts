/**
 * The archive standstill check, end to end against a recording double (#946).
 *
 * The pure verdict is covered in `archive/__tests__/standstill.test.ts`. This
 * covers what the runner does with it: which alert is raised, how the marker is
 * maintained, and that a failed read is not mistaken for an absent row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

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

function supabaseDouble(
  answer: { data: unknown; error: unknown },
  runs?: Array<Record<string, unknown>>,
) {
  const progress: Record<string, unknown> = {
    select: () => progress,
    eq: () => progress,
    maybeSingle: () => Promise.resolve(answer),
  }
  const jobRuns: Record<string, unknown> = {
    select: () => jobRuns,
    eq: () => jobRuns,
    order: () => jobRuns,
    limit: () => Promise.resolve({ data: runs ?? [], error: null }),
  }
  return {
    from: (table: string) => (table === 'job_runs' ? jobRuns : progress),
  } as unknown as SupabaseClient
}

/** The advice actually sent, which is the half the reader acts on. */
function adviceGiven(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === ARCHIVE_STANDSTILL_JOB)
    .map((c) => (c[4] as { fixHint?: string } | undefined)?.fixHint ?? '')
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

/**
 * The alert says WHY, drawn from what the runs actually did (#1028).
 *
 * On 2026-08-23 this fired with "Check Snowflake availability and the export
 * credentials" while Snowflake was fine, the credentials were fine, and every
 * run was being skipped on a lock held by the archive's own repair. Three
 * healthy systems named, and a reader who followed the advice would have found
 * nothing wrong in any of them.
 */
describe('the standstill alert names the cause it measured', () => {
  const stalled = { watermark_hour: '2026-08-21T20:00:00.000Z', updated_at: ago(12 * HOUR) }
  const kvRunning = () => kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
  const settled = (outcome: string) => ({
    outcome,
    started_at: ago(30 * 60 * 1000),
    finished_at: ago(29 * 60 * 1000),
  })

  it('names the lock, and clears Snowflake, when every run was skipped', async () => {
    const supabase = supabaseDouble({ data: stalled, error: null }, [
      settled('skipped-locked'),
      settled('skipped-locked'),
    ])

    await checkArchiveStandstill(supabase, kvRunning(), NOW)

    expect(raised()[0]).toMatch(/skipped because the archive lock was already held/)
    expect(adviceGiven()[0]).toMatch(/holding the lock/)
    expect(adviceGiven()[0]).toMatch(/nothing is wrong with Snowflake/)
  })

  it('keeps the Snowflake advice when the runs are actually failing', async () => {
    const supabase = supabaseDouble({ data: stalled, error: null }, [settled('send-failed')])

    await checkArchiveStandstill(supabase, kvRunning(), NOW)

    expect(raised()[0]).toMatch(/failed, on send-failed/)
    expect(adviceGiven()[0]).toMatch(/Snowflake/)
  })

  it('says the runs completed and archived nothing, without naming a system', async () => {
    const supabase = supabaseDouble({ data: stalled, error: null }, [settled('caught-up')])

    await checkArchiveStandstill(supabase, kvRunning(), NOW)

    expect(raised()[0]).toMatch(/completed cleanly and archived nothing/)
    expect(adviceGiven()[0]).not.toMatch(/Snowflake/)
  })

  it('falls back to the general advice when the runs themselves cannot be read', async () => {
    // A failed read must not become "no run has been recorded", which is one of
    // the causes and has its own advice (L215).
    const brokenRuns: Record<string, unknown> = {
      select: () => brokenRuns,
      eq: () => brokenRuns,
      order: () => brokenRuns,
      limit: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
    }
    const progress: Record<string, unknown> = {
      select: () => progress,
      eq: () => progress,
      maybeSingle: () => Promise.resolve({ data: stalled, error: null }),
    }
    const supabase = {
      from: (t: string) => (t === 'job_runs' ? brokenRuns : progress),
    } as unknown as SupabaseClient

    const result = await checkArchiveStandstill(supabase, kvRunning(), NOW)

    expect(result.alerted).toBe(true)
    expect(raised()[0]).not.toMatch(/No run has been recorded/)
    expect(adviceGiven()[0]).toMatch(/execution_archive_progress/)
  })
})

/**
 * #835: the check measures the heartbeat and the watermark, nothing else. It
 * used to say the runs were "completing", "honestly successful" and the lock
 * "free" above a cause line that could say they failed or the lock was held.
 */
describe('the standstill alert claims only what it measured', () => {
  const consequenceSent = (): string =>
    (
      vi
        .mocked(notifyExportFailure)
        .mock.calls.find((c) => c[1] === ARCHIVE_STANDSTILL_JOB && (c[2] as string[]).length > 0)?.[4] as {
        consequence: string
      }
    ).consequence

  it('does not call failing runs successful when the cause says they failed', async () => {
    const kv = kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
    const supabase = supabaseDouble(
      { data: { watermark_hour: '2026-08-21T20:00:00.000Z', updated_at: ago(12 * HOUR) }, error: null },
      [
        { outcome: 'send-failed', started_at: ago(HOUR), finished_at: ago(HOUR - 60000) },
        { outcome: 'send-failed', started_at: ago(2 * HOUR), finished_at: ago(2 * HOUR - 60000) },
      ],
    )

    await checkArchiveStandstill(supabase, kv, NOW)

    const said = `${consequenceSent()} ${raised().join(' ')}`
    expect(said).toMatch(/failed/)
    expect(said).not.toMatch(/honestly successful|runs are completing|running and completing/)
  })

  it('does not claim the lock is free or the runs complete when it never wrote progress', async () => {
    const kv = kvDouble({
      [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000),
      'execution-archive:no-progress-since': ago(10 * HOUR),
    })
    const supabase = supabaseDouble({ data: null, error: null }, [
      { outcome: 'skipped-locked', started_at: ago(HOUR), finished_at: ago(HOUR) },
    ])

    await checkArchiveStandstill(supabase, kv, NOW)

    const said = `${consequenceSent()} ${raised().join(' ')}`
    expect(said).not.toMatch(/lock is free|the runs complete/)
  })

  it('does not say the archive is not moving when its progress could not be read', async () => {
    const kv = kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
    const supabase = supabaseDouble({ data: null, error: { message: 'connection reset' } })

    await checkArchiveStandstill(supabase, kv, NOW)

    expect(consequenceSent()).not.toMatch(/not actually moving|running and completing/)
    expect(consequenceSent()).toMatch(/could not be judged/)
  })
})

describe('an unreadable progress row keeps its own fix (lessons review, #835)', () => {
  it('does not swap in advice about the runs when the progress could not be read', async () => {
    const kv = kvDouble({ [heartbeatKey('execution-archive')]: ago(20 * 60 * 1000) })
    const supabase = supabaseDouble({ data: null, error: { message: 'connection reset' } }, [
      { outcome: 'send-failed', started_at: ago(HOUR), finished_at: ago(HOUR - 60000) },
    ])

    await checkArchiveStandstill(supabase, kv, NOW)

    expect(adviceGiven()[0]).toMatch(/execution_archive_progress/)
  })
})
