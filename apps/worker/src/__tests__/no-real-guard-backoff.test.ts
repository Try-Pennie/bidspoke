/**
 * No unit test waits out the cron guard recorder's real backoff (#2166, L524).
 *
 * Eight test files fire the real scheduled handler, most with no ALERT_CLAIM or
 * IDEMPOTENCY binding, so each tick fails open and its KV record fails too. The
 * isolate's recorder then sleeps 250 ms and 1,000 ms before holding the event:
 * scheduled-export-dispatch.test.ts spent 21 s in those sleeps, and in
 * scheduled-tick-timing.test.ts a backoff still running at teardown logged into
 * a closed worker. src/test-setup/guard-recorder.ts swaps the singleton for one
 * whose sleep returns at once, for every unit test file; this proves the swap
 * holds, so a new file firing the handler cannot bring the wait back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isolateCronGuardRecorder, RECORD_BACKOFF_MS } from '../lib/cron-guard-record'

afterEach(() => { vi.restoreAllMocks() })

describe('the isolate cron guard recorder in unit tests', () => {
  it('backs off without a real timer when its store refuses every write', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = { put: vi.fn(() => Promise.reject(new Error('KV PUT failed: 500'))) }
    expect(await isolateCronGuardRecorder.record(kv, { kind: 'failed_open', id: 'setup-probe', atMs: 0 })).toBe('held')
    // It did retry: every attempt reached the store...
    expect(kv.put).toHaveBeenCalledTimes(RECORD_BACKOFF_MS.length + 1)
    // ...and none of its waits went through a real timer.
    const backoffTimers = timers.mock.calls.filter(([, ms]) => (RECORD_BACKOFF_MS as readonly number[]).includes(ms as number))
    expect(backoffTimers).toEqual([])
    await isolateCronGuardRecorder.flush({ put: () => Promise.resolve() })
  })
})
