/**
 * A guard event whose KV record fails is not dropped (#2166).
 *
 * On 2026-10-14 from 21:34 to 21:48 UTC the guard failed open six times, and the
 * KV put that should have counted each one failed in the same platform blip, so
 * the hourly check read zero and nobody was paged. Now a failed put is retried
 * with a short backoff, and one that still fails is held in the isolate and
 * written at its OWN time on the next tick that can reach the store, so the
 * count is at worst late, never silently short. The sleep is injected, so no
 * real time passes (L524).
 */
import { describe, it, expect, vi } from 'vitest'
import { createCronGuardRecorder, RECORD_BACKOFF_MS } from '../cron-guard-record'
import { countCronGuardEvents } from '../cron-guard-watch'

const NOW = Date.parse('2026-10-14T21:34:05.000Z')
const H = 60 * 60 * 1000

/** KV held in a Map, whose put can be made to fail, listing as the real namespace does. */
function flakyKv() {
  const store = new Map<string, string>()
  let failures = 0
  let failWith: Error = new Error('KV PUT failed: 500 Internal Server Error')
  return {
    store,
    failNext(n: number, err?: Error) { failures = n; if (err) failWith = err },
    failAlways(err?: Error) { failures = Infinity; if (err) failWith = err },
    recover() { failures = 0 },
    put: vi.fn(async (k: string, v: string) => {
      if (failures > 0) { failures--; throw failWith }
      store.set(k, v)
    }),
    list: vi.fn(async ({ prefix }: { prefix: string; cursor?: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
      list_complete: true,
    })),
  }
}

function recorder() {
  const slept: number[] = []
  const errors: string[] = []
  const logs: string[] = []
  const r = createCronGuardRecorder({
    sleep: async (ms) => { slept.push(ms) },
    error: (l) => { errors.push(l) },
    log: (l) => { logs.push(l) },
  })
  return { r, slept, errors, logs }
}

const failOpen = (id: string, atMs = NOW) => ({ kind: 'failed_open' as const, id, atMs })

describe('createCronGuardRecorder (#2166)', () => {
  it('retries a put that fails once after a short backoff, so the next hourly check counts it', async () => {
    const kv = flakyKv()
    kv.failNext(1)
    const { r, slept } = recorder()
    expect(await r.record(kv, failOpen('ev-1'))).toBe('recorded')
    expect(slept).toEqual([RECORD_BACKOFF_MS[0]])
    expect(await countCronGuardEvents(kv, 'failed_open', NOW + H)).toEqual({ count: 1, capped: false })
  })

  it('backs off a little longer each time, and the whole retry stays far inside waitUntil', async () => {
    const kv = flakyKv()
    kv.failNext(RECORD_BACKOFF_MS.length)
    const { r, slept } = recorder()
    expect(await r.record(kv, failOpen('ev-1'))).toBe('recorded')
    expect(slept).toEqual([...RECORD_BACKOFF_MS])
    expect(RECORD_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeLessThan(5_000)
  })

  it('holds one that keeps failing, and it is counted, at the time it happened, once recording recovers', async () => {
    const kv = flakyKv()
    kv.failAlways()
    const { r } = recorder()
    expect(await r.record(kv, failOpen('ev-1'))).toBe('held')
    expect(r.held().map((e) => e.id)).toEqual(['ev-1'])
    // Still down at the next tick: kept, not dropped.
    await r.flush(kv)
    expect(r.held()).toHaveLength(1)

    kv.recover()
    await r.flush(kv)
    expect(r.held()).toEqual([])
    // Counted by a check an hour later, and its key carries the fail-open's own time:
    // a check whose window ends before it happened does not count it.
    expect(await countCronGuardEvents(kv, 'failed_open', NOW + H)).toEqual({ count: 1, capped: false })
    expect(await countCronGuardEvents(kv, 'failed_open', NOW - 1)).toEqual({ count: 0, capped: false })
  })

  it('a late write of an event that did land after all counts it once, not twice', async () => {
    const kv = flakyKv()
    const { r } = recorder()
    await r.record(kv, failOpen('ev-1'))
    // A put that timed out may still have landed; holding and rewriting it must not double it.
    kv.failAlways()
    await r.record(kv, failOpen('ev-1'))
    kv.recover()
    await r.flush(kv)
    expect(await countCronGuardEvents(kv, 'failed_open', NOW + H)).toEqual({ count: 1, capped: false })
  })

  it('says why the store refused, with the event id, in the failure line, not just a stack frame', async () => {
    const kv = flakyKv()
    kv.failAlways(new Error('KV PUT failed: 500 Internal Server Error'))
    const { r, errors } = recorder()
    await r.record(kv, failOpen('ev-7'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/could not record failed_open event=ev-7 after 3 attempts: .*KV PUT failed: 500 Internal Server Error/)
    expect(errors[0]).toMatch(/held in this isolate \(1 held\)/)
  })

  it('logs a late write, naming how many and the oldest, so a delayed count is visible', async () => {
    const kv = flakyKv()
    kv.failAlways()
    const { r, logs } = recorder()
    await r.record(kv, failOpen('ev-1', NOW))
    await r.record(kv, failOpen('ev-2', NOW + 60_000))
    kv.recover()
    await r.flush(kv)
    expect(logs.join('\n')).toMatch(/recorded 2 held guard events late, the oldest from 2026-10-14T21:34:05.000Z, 0 still held/)
  })

  it('a flush that still fails stops at the first refusal and says so once, keeping every held event', async () => {
    const kv = flakyKv()
    kv.failAlways()
    const { r, errors } = recorder()
    await r.record(kv, failOpen('ev-1'))
    await r.record(kv, failOpen('ev-2'))
    errors.length = 0
    kv.put.mockClear()
    await r.flush(kv)
    expect(kv.put).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/still cannot record 2 held guard events.*KV PUT failed/)
    expect(r.held()).toHaveLength(2)
  })

  it('a flush with nothing held touches nothing', async () => {
    const kv = flakyKv()
    const { r } = recorder()
    await r.flush(kv)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('caps what it holds, dropping the oldest loudly rather than growing without bound', async () => {
    const kv = flakyKv()
    kv.failAlways()
    const errors: string[] = []
    const r = createCronGuardRecorder({ sleep: async () => {}, error: (l) => { errors.push(l) }, log: () => {}, maxHeld: 2 })
    await r.record(kv, failOpen('ev-1'))
    await r.record(kv, failOpen('ev-2'))
    await r.record(kv, failOpen('ev-3'))
    expect(r.held().map((e) => e.id)).toEqual(['ev-2', 'ev-3'])
    expect(errors.join('\n')).toMatch(/dropped held failed_open event=ev-1/)
  })
})
