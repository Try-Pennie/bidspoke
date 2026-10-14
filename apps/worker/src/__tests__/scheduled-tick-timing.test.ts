/**
 * The scheduled handler times the minute tick's jobs and names the one a slow
 * tick is waiting on (#2058). Drives the real handler: prewarm is made to hang,
 * the clock is faked so the 60 s checkpoint fires without waiting (L524), and
 * the database client is an empty double, so every other job fails at once
 * inside its own handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn(() => ({})) }))
vi.mock('../lib/cache-prewarm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cache-prewarm')>()),
  prewarmKvCaches: vi.fn(() => new Promise(() => {})),
}))

import worker from '../index'
import type { Env } from '../index'
import { TICK_CHECKPOINT_MS } from '../lib/tick-timing'

const env = {} as unknown as Env
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext

let warns: string[]
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-14T15:00:00.000Z') })
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const fire = (cron: string) => void worker.scheduled?.({ cron, scheduledTime: Date.now(), type: 'scheduled' } as unknown as ScheduledEvent, env, ctx())

describe('minute tick timing (#2058)', () => {
  it('names the hung minute job, by name, at the checkpoint', async () => {
    fire('* * * * *')
    await vi.advanceTimersByTimeAsync(TICK_CHECKPOINT_MS)
    const line = warns.find((w) => w.startsWith('[tick-timing]'))
    expect(line).toMatch(/cron="\* \* \* \* \*".*jobs=prewarm:\d+ unfinished.*\(checkpoint, still running\)/)
    // Every minute job is in the line, each by its own name.
    for (const name of ['stored-copy-sweep', 'buyer-sale-drain', 'unconfirmed-write-sweep', 'volume-cliff', 'heartbeat-checks']) {
      expect(line).toContain(`${name}:`)
    }
    expect(line).not.toMatch(/job#\d/)
  })

  it('logs nothing for an hourly tick, which runs long by design', async () => {
    fire('0 * * * *')
    await vi.advanceTimersByTimeAsync(TICK_CHECKPOINT_MS)
    expect(warns.filter((w) => w.startsWith('[tick-timing]'))).toEqual([])
  })
})
