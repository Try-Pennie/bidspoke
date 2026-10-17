/**
 * The scheduled handler times the minute tick's jobs and names the one a slow
 * tick is waiting on (#2058), and stops waiting for a job at its deadline.
 * Drives the real handler: prewarm is made to hang, the clock is faked so the
 * 50 s deadline passes without waiting (L524), and the database client is an
 * empty double, so every other job fails at once inside its own handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/supabase')>()),
  createSupabaseClient: vi.fn(() => ({})),
}))
vi.mock('../lib/cache-prewarm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cache-prewarm')>()),
  prewarmKvCaches: vi.fn(() => new Promise(() => {})),
}))

import worker, { MINUTE_JOB_DEADLINE_MS } from '../index'
import type { Env } from '../index'
import { TICK_CHECKPOINT_MS } from '../lib/tick-timing'
import { SUPABASE_REQUEST_DEADLINE_MS } from '../lib/supabase'
import { prewarmKvCaches } from '../lib/cache-prewarm'
import { recordingContext } from '../test-setup/wait-until'

const env = {} as unknown as Env

let warns: string[]
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-14T15:00:00.000Z') })
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

/** Fires a tick. Every promise the handler hands to waitUntil, and the one it returns, is kept on the context returned. */
function fire(cron: string, tickEnv: Env = env) {
  const c = recordingContext()
  c.waitUntil(worker.scheduled({ cron, scheduledTime: Date.now(), type: 'scheduled' } as unknown as ScheduledEvent, tickEnv, c))
  return c
}

describe('minute tick timing (#2058)', () => {
  it('names the hung minute job, by name, when the minute ends at its deadline', async () => {
    fire('* * * * *')
    await vi.advanceTimersByTimeAsync(MINUTE_JOB_DEADLINE_MS)
    const line = warns.find((w) => w.startsWith('[tick-timing]'))
    expect(line).toMatch(new RegExp(`cron="\\* \\* \\* \\* \\*" total_ms=${MINUTE_JOB_DEADLINE_MS} jobs=prewarm:${MINUTE_JOB_DEADLINE_MS} timed out`))
    // The end of tick line, not the checkpoint: the minute stopped waiting.
    expect(line).not.toMatch(/checkpoint/)
    // Every minute job is in the line, each by its own name.
    for (const name of ['stored-copy-sweep', 'buyer-sale-drain', 'unconfirmed-write-sweep', 'database-reachability', 'volume-cliff', 'heartbeat-checks']) {
      expect(line).toContain(`${name}:`)
    }
    expect(line).not.toMatch(/job#\d/)
    expect(warns).toContain(`[minute-job] prewarm passed its ${MINUTE_JOB_DEADLINE_MS} ms deadline, so the minute stopped waiting for it`)
  })

  // The deadline frees the invocation only if nothing else still waits on the
  // hung job: every promise handed to waitUntil, and the one returned, settles.
  it('lets every promise the invocation waits on settle at the deadline while the job still hangs', async () => {
    const tick = fire('* * * * *')
    await vi.advanceTimersByTimeAsync(MINUTE_JOB_DEADLINE_MS - 1)
    expect(tick.pending(), 'the hung job must still be waited on before its deadline').toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(tick.handed.length).toBeGreaterThan(10)
    expect(tick.pending()).toBe(0)
  })

  // The 2026-10-14 shape: a KV call that never answers, inside the sweep.
  it('ends the minute at the deadline when a KV call inside the sweep never answers', async () => {
    vi.mocked(prewarmKvCaches).mockImplementationOnce(async () => ({ workflowsReadError: null, reconfirms: {} }))
    const hungKv = { list: () => new Promise(() => {}), get: () => new Promise(() => {}) }
    const tick = fire('* * * * *', { WORKFLOW_CACHE: hungKv } as unknown as Env)
    await vi.advanceTimersByTimeAsync(MINUTE_JOB_DEADLINE_MS)
    expect(tick.pending()).toBe(0)
    expect(warns).toContain(`[minute-job] stored-copy-sweep passed its ${MINUTE_JOB_DEADLINE_MS} ms deadline, so the minute stopped waiting for it`)
    expect(warns.find((w) => w.startsWith('[tick-timing]'))).toMatch(/jobs=stored-copy-sweep:\d+ timed out/)
  })

  // Under the checkpoint, so the minute ends before it, and over the database
  // deadline, so a stalled database call fails by its own message first.
  it('sits between the database request deadline and the tick checkpoint', () => {
    expect(MINUTE_JOB_DEADLINE_MS).toBeGreaterThan(SUPABASE_REQUEST_DEADLINE_MS)
    expect(MINUTE_JOB_DEADLINE_MS).toBeLessThan(TICK_CHECKPOINT_MS)
  })

  it('logs nothing for an hourly tick, which runs long by design', async () => {
    const tick = fire('0 * * * *')
    await vi.advanceTimersByTimeAsync(TICK_CHECKPOINT_MS)
    // Several hourly jobs load their module with a dynamic import, which moves
    // in real time whatever the faked clock says, so they are still running
    // here; left running, they logged after the file closed (#2120). Settled,
    // the assertion also covers the whole tick rather than its first part.
    await tick.settle()
    expect(warns.filter((w) => w.startsWith('[tick-timing]'))).toEqual([])
  })
})
