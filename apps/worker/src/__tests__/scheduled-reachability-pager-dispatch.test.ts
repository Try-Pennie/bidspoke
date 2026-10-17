/**
 * The scheduled handler hands the database reachability owner the tick's
 * scheduled Slack (#2061), so the owner's "nobody can be told" path pages
 * Better Stack through the same pager the tick's lookups use. Drives the real
 * handler and reads what the probe was given: the outage simulation cannot
 * tell this apart, because a lookup in the same tick pages under the same key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'

vi.mock('../lib/database-reachability', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/database-reachability')>()
  return { ...real, runDatabaseReachabilityProbe: vi.fn(async () => ({ kind: 'answered' as const, organizations: 0 })) }
})

import worker, { MINUTE_JOB_DEADLINE_MS } from '../index'
import type { Env } from '../index'
import { runDatabaseReachabilityProbe, type ProbeDeps } from '../lib/database-reachability'
import { scheduledSlackFor } from '../lib/scheduled-slack'

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-15T01:00:00Z') })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('the owner is given the tick pager (#2061)', () => {
  it('passes the probe the scheduled Slack registered on the tick client', async () => {
    const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) }
    const env = { IDEMPOTENCY: kv, WORKFLOW_CACHE: kv, SUPABASE_URL: 'https://stalled.supabase.co', SUPABASE_SECRET_KEY: 'k', APP_URL: 'https://app.example' } as unknown as Env
    const ctx = recordingContext()
    void worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), type: 'scheduled' } as unknown as ScheduledEvent, env, ctx).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1)

    expect(runDatabaseReachabilityProbe).toHaveBeenCalledTimes(1)
    const deps = vi.mocked(runDatabaseReachabilityProbe).mock.calls[0][0] as ProbeDeps
    expect(deps.scheduled).toBeDefined()
    expect(deps.scheduled).toBe(scheduledSlackFor(deps.supabase))
    // Every fetch hangs, so the tick's jobs end only at the minute's deadline:
    // let it pass, so none is still running when the test ends (#2120).
    await vi.advanceTimersByTimeAsync(MINUTE_JOB_DEADLINE_MS)
    await ctx.settle()
  })
})
