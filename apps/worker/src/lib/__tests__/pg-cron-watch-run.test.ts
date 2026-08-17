import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({ sendPgCronAlert: vi.fn(async () => true) }))

import { sendPgCronAlert } from '../slack'
import { runPgCronWatch, type PgCronJob } from '../pg-cron-watch'

/**
 * The orchestration half of the database scheduled-job watch (#770): what
 * reaches Slack, how often, and what happens when the check itself cannot read.
 */
const NOW = Date.parse('2026-08-17T20:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const HOUR = 3_600_000

const healthy = (name: string): PgCronJob => ({
  jobname: name,
  schedule: '0 3 * * *',
  active: true,
  failures_in_window: 0,
  last_failure_at: null,
  last_failure_message: null,
  last_success_at: iso(NOW - HOUR),
})

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

function fakeSupabase(rows: PgCronJob[] | null, opts: { rpcError?: string; orgs?: string[] } = {}) {
  return {
    rpc: vi.fn(async () =>
      opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: rows, error: null },
    ),
    from: () => ({
      select: () => ({
        eq: () =>
          Promise.resolve({
            data: (opts.orgs ?? ['org-1']).map((organization_id) => ({ organization_id })),
            error: null,
          }),
      }),
    }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.mocked(sendPgCronAlert).mockClear()
  vi.mocked(sendPgCronAlert).mockResolvedValue(true)
})

describe('runPgCronWatch: the quiet path', () => {
  it('says nothing when every job is healthy', async () => {
    const results = await runPgCronWatch(fakeSupabase([healthy('a'), healthy('b')]), fakeKv(), NOW)
    expect(results.every((r) => r.status === 'healthy')).toBe(true)
    expect(sendPgCronAlert).not.toHaveBeenCalled()
  })
})

describe('runPgCronWatch: a failing job', () => {
  const failing: PgCronJob = {
    ...healthy('refresh-workflow-stats-daily-full'),
    schedule: '45 3 * * *',
    failures_in_window: 24,
    last_failure_at: iso(NOW - 16 * HOUR),
    last_failure_message: 'ERROR: duplicate key value violates unique constraint',
  }

  it('alerts every Slack org once', async () => {
    const results = await runPgCronWatch(
      fakeSupabase([healthy('a'), failing], { orgs: ['org-1', 'org-2'] }),
      fakeKv(),
      NOW,
    )
    expect(results.find((r) => r.jobname === failing.jobname)?.status).toBe('failing')
    expect(sendPgCronAlert).toHaveBeenCalledTimes(2)
  })

  it('stays quiet on the next run while the cooldown holds', async () => {
    const kv = fakeKv()
    const supabase = fakeSupabase([failing])
    await runPgCronWatch(supabase, kv, NOW)
    vi.mocked(sendPgCronAlert).mockClear()
    await runPgCronWatch(supabase, kv, NOW + HOUR)
    expect(sendPgCronAlert).not.toHaveBeenCalled()
  })

  it('does not arm the cooldown when the alert was not delivered', async () => {
    // Otherwise a Slack outage during the first bad run buys six hours of
    // silence about a condition nobody was ever told.
    vi.mocked(sendPgCronAlert).mockResolvedValue(false)
    const kv = fakeKv()
    await runPgCronWatch(fakeSupabase([failing]), kv, NOW)
    expect([...kv.store.keys()]).toEqual([])
  })
})

describe('runPgCronWatch: the check itself cannot read', () => {
  it('throws rather than reporting an empty list of problems', async () => {
    // The L98 case, and the one that matters most here: returning [] on a failed
    // read makes an outage of this check indistinguishable from a database with
    // no failing jobs.
    await expect(runPgCronWatch(fakeSupabase(null, { rpcError: 'permission denied' }), fakeKv(), NOW)).rejects.toThrow(
      /permission denied/,
    )
  })

  it('throws when the response is not a list', async () => {
    await expect(runPgCronWatch(fakeSupabase(null), fakeKv(), NOW)).rejects.toThrow()
  })
})

describe('runPgCronWatch: one job must not silence the rest', () => {
  it('keeps checking after a job whose alert throws', async () => {
    // A watchdog must not share the abort behaviour of the work it watches (L71).
    vi.mocked(sendPgCronAlert).mockRejectedValueOnce(new Error('slack exploded'))
    const bad = { ...healthy('first'), failures_in_window: 1 }
    const alsoBad = { ...healthy('second'), failures_in_window: 1 }
    const results = await runPgCronWatch(fakeSupabase([bad, alsoBad]), fakeKv(), NOW)
    expect(results.length).toBe(2)
    expect(results.some((r) => r.detail.includes('slack exploded'))).toBe(true)
    expect(results.some((r) => r.status === 'failing')).toBe(true)
  })
})

describe('runPgCronWatch: reads a bounded window', () => {
  it('asks the database for a window rather than everything', async () => {
    // cron.job_run_details grows unboundedly and is not pruned, so an unbounded
    // read is the same row-cap trap as #115.
    const supabase = fakeSupabase([healthy('a')])
    await runPgCronWatch(supabase, fakeKv(), NOW)
    const rpc = vi.mocked((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc)
    expect(rpc).toHaveBeenCalledWith('pg_cron_health', expect.objectContaining({ window_hours: expect.any(Number) }))
  })
})
