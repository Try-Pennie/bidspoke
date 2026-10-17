/**
 * Run each cron tick once when Cloudflare delivers it twice (#1899).
 *
 * Since 2026-10-08 13:38:37 UTC every tick arrives twice, about 36 s apart with
 * different scheduled times; on 2026-10-05 each tick arrived twice with the same
 * scheduled time. A genuine retry of a killed run carries that run's own
 * scheduled time and must still run. These drive the real AlertClaimObject
 * through a namespace double, with the clock and the deadline timer injected so
 * no real time passes (L524).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AlertClaimObject, TICK_LEASE_STALE_MS, TICK_LEASE_RENEW_MS } from '../../durable-objects/alert-claim'
import { runCronTickOnce, cronTickKey, CRON_TICK_DEADLINE_MS, DELIVERY_LINE_PREFIX } from '../cron-once'
import { CLAIM_DEADLINE_MS } from '../alert-claim'
// The consumers of the FAILED OPEN line (#2166) and the delivery line (#2284), a
// separate app, imported to prove the contract.
import { failOpensIn } from '../../../../worker-tail/src/fail-opens'
import { deliveriesIn } from '../../../../worker-tail/src/deliveries'

/** Storage with the surface the claim object uses, held in a Map. */
function memoryState(): DurableObjectState {
  const store = new Map<string, unknown>()
  return {
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { store.set(key, value) },
      deleteAll: async () => { store.clear() },
      delete: async (key: string) => store.delete(key),
      setAlarm: async () => undefined,
    },
  } as unknown as DurableObjectState
}

/** One real claim object per name, reached the way the Worker reaches it. */
function claimNamespace() {
  const objects = new Map<string, AlertClaimObject>()
  const names: string[] = []
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (url: string, init?: RequestInit) => {
        names.push(name)
        if (!objects.has(name)) objects.set(name, new AlertClaimObject(memoryState()))
        return objects.get(name)!.fetch(new Request(url, init))
      },
    }),
  } as unknown as DurableObjectNamespace
  return { ns, names }
}

const MINUTE = Date.parse('2026-10-08T14:37:00.000Z')

let logs: string[]
let warns: string[]
let errors: string[]
beforeEach(() => {
  logs = []; warns = []; errors = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
})
afterEach(() => { vi.restoreAllMocks() })

/** A job whose completion the test decides. */
function pendingJob() {
  let finish: () => void = () => {}
  const ran = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  return { ran, finish: () => finish() }
}

describe('runCronTickOnce (#1899)', () => {
  it('(a) runs one of two deliveries of the same cron and minute with different seconds, and logs the skip with its holder', async () => {
    const { ns } = claimNamespace()
    const jobs = vi.fn(async () => {})
    const first = await runCronTickOnce(ns, { cron: '37 */2 * * *', scheduledTime: MINUTE + 1_000 }, jobs, { now: () => MINUTE + 1_000, holder: () => 'req-a' })
    const second = await runCronTickOnce(ns, { cron: '37 */2 * * *', scheduledTime: MINUTE + 37_000 }, jobs, { now: () => MINUTE + 37_000, holder: () => 'req-b' })
    expect([first, second]).toEqual(['ran', 'skipped'])
    expect(jobs).toHaveBeenCalledTimes(1)
    const skip = logs.find((l) => l.includes('skipped duplicate'))
    expect(skip).toContain('cron="37 */2 * * *"')
    expect(skip).toContain('scheduled=2026-10-08T14:37:37.000Z')
    expect(skip).toContain('holder=req-a')
    expect(skip).toContain('duplicates=1')
  })

  it('(a) skips the twin while the first run is still working, not only after it finished', async () => {
    const { ns } = claimNamespace()
    const job = pendingJob()
    const firstRun = runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 1_000 }, job.ran, { now: () => MINUTE + 1_000, holder: () => 'req-a' })
    await vi.waitFor(() => expect(job.ran).toHaveBeenCalledTimes(1))
    const twin = await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 37_000 }, job.ran, { now: () => MINUTE + 37_000, holder: () => 'req-b' })
    expect(twin).toBe('skipped')
    job.finish()
    expect(await firstRun).toBe('ran')
    expect(job.ran).toHaveBeenCalledTimes(1)
  })

  it('(b) runs one of two deliveries with the SAME scheduled time while the first is alive (2026-10-05)', async () => {
    const { ns } = claimNamespace()
    const clock = { t: MINUTE + 8_300 }
    const now = () => clock.t
    const job = pendingJob()
    let renewTick: () => void = () => {}
    const firstRun = runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, job.ran, {
      now, holder: () => 'req-a', every: (fn) => { renewTick = fn; return () => {} },
    })
    await vi.waitFor(() => expect(job.ran).toHaveBeenCalledTimes(1))
    clock.t += 500
    // The twin waits for a dead holder's lease to go stale; the live holder renews meanwhile.
    const twin = await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, job.ran, {
      now, holder: () => 'req-b',
      sleep: async (ms) => {
        for (let waited = 0; waited < ms; waited += TICK_LEASE_RENEW_MS) {
          clock.t += Math.min(TICK_LEASE_RENEW_MS, ms - waited)
          renewTick()
          await vi.waitFor(() => Promise.resolve())
        }
      },
    })
    expect(twin).toBe('skipped')
    job.finish()
    await firstRun
    // and once the run is done, a late delivery of the same time is still a duplicate
    const late = await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, job.ran, { now: () => MINUTE + 8_000 + 10 * TICK_LEASE_STALE_MS, holder: () => 'req-c' })
    expect(late).toBe('skipped')
    expect(job.ran).toHaveBeenCalledTimes(1)
  })

  // #2064, measured 2026-10-14 05:23 UTC: the first delivery was cancelled 1.7 s
  // in, and the retry with the same scheduled time arrived 0.4 s after it ended.
  // The 35 s floor dropped it and the hour's archive never ran.
  it('(b) runs the retry of a run cancelled seconds in, once its lease has gone stale (2026-10-14)', async () => {
    const { ns } = claimNamespace()
    const clock = { t: Date.parse('2026-10-14T05:23:12.299Z') }
    const now = () => clock.t
    const scheduled = Date.parse('2026-10-14T05:23:11.000Z')
    const killed = vi.fn(() => new Promise<void>(() => {}))
    // A killed run renews nothing: its renewal timer never fires.
    void runCronTickOnce(ns, { cron: '23 * * * *', scheduledTime: scheduled }, killed, { now, holder: () => '0d6edae1', every: () => () => {} })
    await vi.waitFor(() => expect(killed).toHaveBeenCalledTimes(1))
    clock.t = Date.parse('2026-10-14T05:23:13.834Z')
    const slept: number[] = []
    const retryJobs = vi.fn(async () => {})
    const retry = await runCronTickOnce(ns, { cron: '23 * * * *', scheduledTime: scheduled }, retryJobs, {
      now, holder: () => 'retry', every: () => () => {},
      sleep: async (ms) => { slept.push(ms); clock.t += ms },
    })
    expect(retry).toBe('ran')
    expect(retryJobs).toHaveBeenCalledTimes(1)
    // It waited only as long as a dead holder's lease takes to go stale, then asked once more.
    expect(slept).toHaveLength(1)
    expect(slept[0]).toBeLessThanOrEqual(TICK_LEASE_STALE_MS)
    expect(warns.join('\n')).toMatch(/took over.*cron="23 \* \* \* \*".*previous_holder=0d6edae1/)
  })

  // Lessons review: a renewal the object refuses means the tick was handed to a
  // retry; it was never read, so the old run carried on with no sign of it.
  it('says so when its renewal is refused because the tick was taken over', async () => {
    const { ns } = claimNamespace()
    const clock = { t: MINUTE }
    const job = pendingJob()
    let renew: () => void = () => {}
    let stopped = false
    const run = runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE }, job.ran, {
      now: () => clock.t, holder: () => 'old', every: (fn) => { renew = fn; return () => { stopped = true } },
    })
    await vi.waitFor(() => expect(job.ran).toHaveBeenCalledTimes(1))
    clock.t += TICK_LEASE_STALE_MS + 1
    expect(await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE }, vi.fn(async () => {}), { now: () => clock.t, holder: () => 'new', every: () => () => {} })).toBe('ran')
    renew()
    await vi.waitFor(() => expect(warns.join('\n')).toMatch(/renewal of .* was refused.*holder=old/))
    expect(stopped).toBe(true)
    job.finish()
    await run
  })

  // Lessons review: a renewal still in flight when the jobs finish reaches the
  // object after tick-done and is refused; that is not a takeover.
  it('does not call a renewal refused after its own finish a takeover', async () => {
    const { ns } = claimNamespace()
    const gate = { open: () => {} }
    const slowNs = {
      idFromName: ns.idFromName.bind(ns),
      get: (id: unknown) => {
        const stub = (ns.get as (i: unknown) => { fetch: (u: string, i?: RequestInit) => Promise<Response> })(id)
        return {
          fetch: async (url: string, init?: RequestInit) => {
            if (url.endsWith('/tick-renew')) await new Promise<void>((r) => { gate.open = r })
            return stub.fetch(url, init)
          },
        }
      },
    } as unknown as DurableObjectNamespace
    const job = pendingJob()
    let renew: () => void = () => {}
    const run = runCronTickOnce(slowNs, { cron: '0 * * * *', scheduledTime: MINUTE }, job.ran, {
      now: () => MINUTE, holder: () => 'req-a', every: (fn) => { renew = fn; return () => {} },
    })
    await vi.waitFor(() => expect(job.ran).toHaveBeenCalledTimes(1))
    renew()
    job.finish()
    await run
    gate.open()
    await new Promise((r) => setTimeout(r, 0))
    expect(warns.join('\n')).not.toMatch(/was refused/)
  })

  it('renews the lease while the jobs run, and stops when they finish', async () => {
    const { ns } = claimNamespace()
    const job = pendingJob()
    let renew: () => void = () => {}
    let stopped = false
    let interval = 0
    const run = runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE }, job.ran, {
      now: () => MINUTE, holder: () => 'req-a',
      every: (fn, ms) => { renew = fn; interval = ms; return () => { stopped = true } },
    })
    await vi.waitFor(() => expect(job.ran).toHaveBeenCalledTimes(1))
    expect(interval).toBe(TICK_LEASE_RENEW_MS)
    expect(stopped).toBe(false)
    renew()
    job.finish()
    await run
    expect(stopped).toBe(true)
  })

  it('(c) runs every expression that fires in the same minute: each is its own claim', async () => {
    const { ns, names } = claimNamespace()
    const jobs = vi.fn(async () => {})
    const crons = ['* * * * *', '*/5 * * * *', '*/15 * * * *', '0 * * * *', '0 9 * * *']
    const outcomes = []
    for (const cron of crons) {
      outcomes.push(await runCronTickOnce(ns, { cron, scheduledTime: MINUTE + 1_000 }, jobs, { now: () => MINUTE + 1_000 }))
    }
    expect(outcomes).toEqual(crons.map(() => 'ran'))
    expect(jobs).toHaveBeenCalledTimes(crons.length)
    expect(new Set(names).size).toBe(crons.length)
  })

  it('(c) keys a tick by its expression and its minute, not its second', () => {
    expect(cronTickKey('0 * * * *', MINUTE + 1_000)).toBe(cronTickKey('0 * * * *', MINUTE + 37_000))
    expect(cronTickKey('0 * * * *', MINUTE)).not.toBe(cronTickKey('*/5 * * * *', MINUTE))
    expect(cronTickKey('* * * * *', MINUTE)).not.toBe(cronTickKey('* * * * *', MINUTE + 60_000))
  })

  it('(d) runs the platform retry of a first run that never completed (14:00:01 canceled at 98.6 s, retried 14:01:41)', async () => {
    const { ns } = claimNamespace()
    const killed = vi.fn(() => new Promise<void>(() => {}))
    const scheduled = Date.parse('2026-10-08T14:00:01.000Z')
    void runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: scheduled }, killed, { now: () => scheduled, holder: () => 'req-killed', every: () => () => {} })
    await vi.waitFor(() => expect(killed).toHaveBeenCalledTimes(1))
    // the twin with a different second, while the killed run still holds the claim, stays skipped
    const twin = await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: scheduled + 36_000 }, vi.fn(async () => {}), { now: () => scheduled + 36_000, holder: () => 'req-twin' })
    expect(twin).toBe('skipped')
    const retryJobs = vi.fn(async () => {})
    const retry = await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: scheduled }, retryJobs, { now: () => Date.parse('2026-10-08T14:01:41.000Z'), holder: () => 'req-retry' })
    expect(retry).toBe('ran')
    expect(retryJobs).toHaveBeenCalledTimes(1)
    expect(warns.join('\n')).toMatch(/took over.*cron="0 \* \* \* \*".*previous_holder=req-killed/)
  })

  it('(e) runs anyway, inside the deadline, when the claim object never answers, and says it failed open', async () => {
    const hanging = { idFromName: (n: string) => n, get: () => ({ fetch: () => new Promise<Response>(() => {}) }) } as unknown as DurableObjectNamespace
    const waited: number[] = []
    const jobs = vi.fn(async () => {})
    const outcome = await runCronTickOnce(hanging, { cron: '15 8 * * *', scheduledTime: MINUTE }, jobs, {
      delay: async (ms) => { waited.push(ms) },
    })
    expect(outcome).toBe('ran')
    expect(jobs).toHaveBeenCalledTimes(1)
    expect(waited[0]).toBe(CRON_TICK_DEADLINE_MS)
    expect(errors.join('\n')).toMatch(/FAILED OPEN.*cron="15 8 \* \* \*".*did not answer inside 5000ms/)
  })

  it('(e) runs anyway when the claim object throws, answers an error, or the binding is missing', async () => {
    const throwing = { idFromName: () => { throw new TypeError('Invalid Durable Object ID') }, get: () => null } as unknown as DurableObjectNamespace
    const refusing = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('{"error":"x"}', { status: 400 }) }) } as unknown as DurableObjectNamespace
    const jobs = vi.fn(async () => {})
    expect(await runCronTickOnce(throwing, { cron: '0 9 * * *', scheduledTime: MINUTE }, jobs)).toBe('ran')
    expect(await runCronTickOnce(refusing, { cron: '0 9 * * *', scheduledTime: MINUTE }, jobs)).toBe('ran')
    expect(await runCronTickOnce(undefined, { cron: '0 9 * * *', scheduledTime: MINUTE }, jobs)).toBe('ran')
    expect(jobs).toHaveBeenCalledTimes(3)
    const failedOpen = errors.filter((e) => e.includes('FAILED OPEN'))
    expect(failedOpen).toHaveLength(3)
    expect(failedOpen[0]).toContain('Invalid Durable Object ID')
    expect(failedOpen[1]).toContain('400')
    expect(failedOpen[2]).toContain('no ALERT_CLAIM binding')
  })

  it('marks the tick done once the jobs resolved, so a later delivery of the same time is skipped', async () => {
    const { ns } = claimNamespace()
    const scheduled = MINUTE + 1_000
    await runCronTickOnce(ns, { cron: '0 13 * * *', scheduledTime: scheduled }, vi.fn(async () => {}), { now: () => scheduled, holder: () => 'req-a' })
    const later = await runCronTickOnce(ns, { cron: '0 13 * * *', scheduledTime: scheduled }, vi.fn(async () => {}), { now: () => scheduled + 10 * TICK_LEASE_STALE_MS, holder: () => 'req-b' })
    expect(later).toBe('skipped')
  })

  it('releases the tick and rethrows when the jobs threw, so the platform retry and any later delivery can run them', async () => {
    const { ns } = claimNamespace()
    const scheduled = MINUTE + 1_000
    await expect(
      runCronTickOnce(ns, { cron: '0 13 * * *', scheduledTime: scheduled }, async () => { throw new Error('createSupabaseClient threw') }, { now: () => scheduled, holder: () => 'req-a' }),
    ).rejects.toThrow('createSupabaseClient threw')
    expect(errors.join('\n')).toMatch(/released cron="0 13 \* \* \*".*jobs threw.*createSupabaseClient threw/)
    // the tick was released, so the next delivery runs at once, with no wait on a lease
    const retryJobs = vi.fn(async () => {})
    const retry = await runCronTickOnce(ns, { cron: '0 13 * * *', scheduledTime: scheduled }, retryJobs, { now: () => scheduled + 2_000, holder: () => 'req-b' })
    expect(retry).toBe('ran')
    expect(retryJobs).toHaveBeenCalledTimes(1)
  })
  // #1904: the guard's own outcomes are counted so someone can be told.
  it('reports each skip and each fail-open to onGuardEvent, and nothing for a tick it ran normally', async () => {
    const { ns } = claimNamespace()
    const events: string[] = []
    const onGuardEvent = (kind: string) => { events.push(kind) }
    const jobs = vi.fn(async () => {})
    await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 1_000 }, jobs, { now: () => MINUTE + 1_000, holder: () => 'a', onGuardEvent })
    await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 37_000 }, jobs, { now: () => MINUTE + 37_000, holder: () => 'b', onGuardEvent })
    await runCronTickOnce(undefined, { cron: '0 9 * * *', scheduledTime: MINUTE }, jobs, { onGuardEvent })
    expect(events).toEqual(['skipped_duplicate', 'failed_open'])
  })

  it('still runs the jobs when onGuardEvent throws: counting is bookkeeping, never a reason to skip', async () => {
    const jobs = vi.fn(async () => {})
    const outcome = await runCronTickOnce(undefined, { cron: '0 9 * * *', scheduledTime: MINUTE }, jobs, {
      onGuardEvent: () => { throw new Error('kv gone') },
    })
    expect(outcome).toBe('ran')
    expect(jobs).toHaveBeenCalledTimes(1)
    expect(errors.join('\n')).toMatch(/could not record failed_open.*kv gone/)
  })

  // #2166: the FAILED OPEN line is the fail-open's second record (the tail worker
  // copies it to the database), so the line and the counted record must name the
  // same event, or the hourly check cannot tell one fail-open seen twice from two.
  it('names each guard event once, with the same id in its log line and in what onGuardEvent is handed', async () => {
    const { ns } = claimNamespace()
    const events: Array<{ kind: string; id: string; atMs: number }> = []
    const ids = ['ev-skip', 'ev-open']
    const onGuardEvent = (kind: string, e: { id: string; atMs: number }) => { events.push({ kind, id: e.id, atMs: e.atMs }) }
    const eventId = () => ids.shift()!
    const jobs = vi.fn(async () => {})
    await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 1_000 }, jobs, { now: () => MINUTE + 1_000, holder: () => 'a', onGuardEvent, eventId })
    await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 37_000 }, jobs, { now: () => MINUTE + 37_000, holder: () => 'b', onGuardEvent, eventId })
    await runCronTickOnce(undefined, { cron: '0 9 * * *', scheduledTime: MINUTE }, jobs, { now: () => MINUTE + 5, onGuardEvent, eventId })
    expect(events).toEqual([
      { kind: 'skipped_duplicate', id: 'ev-skip', atMs: MINUTE + 37_000 },
      { kind: 'failed_open', id: 'ev-open', atMs: MINUTE + 5 },
    ])
    expect(errors.find((e) => e.includes('FAILED OPEN'))).toMatch(/^\[cron-once\] FAILED OPEN event=ev-open cron="0 9 \* \* \*" scheduled=/)
    expect(logs.find((l) => l.includes('skipped duplicate'))).toMatch(/ event=ev-skip$/)
  })

  // The line is a contract with another app: the tail worker parses it. So the
  // real line this guard writes is fed to the tail worker's real parser.
  it('writes a FAILED OPEN line the tail worker reads back as the same event', async () => {
    const onGuardEvent = vi.fn()
    await runCronTickOnce(undefined, { cron: '* * * * *', scheduledTime: MINUTE }, vi.fn(async () => {}), { now: () => MINUTE + 2_118, onGuardEvent })
    const line = errors.find((e) => e.includes('FAILED OPEN'))!
    const id = (onGuardEvent.mock.calls[0][1] as { id: string }).id
    const trace = {
      scriptName: 'bidspoke-worker',
      event: { cron: '* * * * *', scheduledTime: MINUTE },
      logs: [{ timestamp: MINUTE + 2_118, level: 'error', message: [line] }],
    } as unknown as TraceItem
    expect(failOpensIn(trace)).toEqual([{ event_id: id, occurred_at: new Date(MINUTE + 2_118).toISOString(), cron: '* * * * *', line }])
  })
})

/**
 * Timers on a virtual clock (L524): `sleep(ms)` resolves when the clock reaches
 * it, and `run` fires every timer in time order, letting each one's work settle
 * before the next, so a race between two timers is decided by their times alone.
 */
function virtualTimers() {
  let now = 0
  const queue: Array<{ at: number; seq: number; fire: () => void }> = []
  let seq = 0
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return {
    sleep: (ms: number) => new Promise<void>((resolve) => { queue.push({ at: now + ms, seq: seq++, fire: resolve }) }),
    async run<T>(work: Promise<T>): Promise<T> {
      let done = false
      const result = work.finally(() => { done = true })
      await settle()
      while (!done && queue.length) {
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = queue.shift()!
        now = next.at
        next.fire()
        await settle()
      }
      return result
    },
  }
}

// #2284: the tick claim had the alert claim's 2 s deadline. Measured 2026-10-17
// in Workers Logs, the claim object's own handler takes 26 ms at the median and
// 151 ms at p99 (755 ms the slowest of 7 days), so the misses are the trip to
// the object, not the object: the 15:15 UTC claim that failed open at 2 s
// reached its object 4 to 6 s after it was sent. The tick claim now waits 5 s.
describe('the tick claim has its own deadline (#2284)', () => {
  it('is 5 seconds, and is not the alert claim deadline', () => {
    expect(CRON_TICK_DEADLINE_MS).toBe(5_000)
    expect(CLAIM_DEADLINE_MS).toBe(2_000)
  })

  function slowNamespace(answerAfterMs: number, timers: ReturnType<typeof virtualTimers>) {
    const { ns } = claimNamespace()
    return {
      idFromName: (n: string) => n,
      get: (name: string) => ({
        fetch: async (url: string, init?: RequestInit) => {
          await timers.sleep(answerAfterMs)
          return ns.get(name as unknown as DurableObjectId).fetch(url, init)
        },
      }),
    } as unknown as DurableObjectNamespace
  }

  it('runs guarded when the claim answers just inside the deadline', async () => {
    const timers = virtualTimers()
    const jobs = vi.fn(async () => {})
    const outcome = await timers.run(runCronTickOnce(slowNamespace(CRON_TICK_DEADLINE_MS - 1, timers), { cron: '*/5 * * * *', scheduledTime: MINUTE }, jobs, {
      now: () => MINUTE, holder: () => 'slow-but-in-time', delay: timers.sleep, every: () => () => {},
    }))
    expect(outcome).toBe('ran')
    expect(errors.join('\n')).not.toMatch(/FAILED OPEN/)
    expect(logs.join('\n')).toMatch(/\[cron-once\] running cron="\*\/5 \* \* \* \*".*holder=slow-but-in-time/)
  })

  it('fails open when the claim answers just past the deadline', async () => {
    const timers = virtualTimers()
    const jobs = vi.fn(async () => {})
    const outcome = await timers.run(runCronTickOnce(slowNamespace(CRON_TICK_DEADLINE_MS + 1, timers), { cron: '*/5 * * * *', scheduledTime: MINUTE }, jobs, {
      now: () => MINUTE, holder: () => 'too-late', delay: timers.sleep, every: () => () => {},
    }))
    expect(outcome).toBe('ran')
    expect(errors.join('\n')).toMatch(/FAILED OPEN.*did not answer inside 5000ms/)
  })

  it('a claim answering in 3 s, which failed open at the old 2 s deadline, now runs guarded', async () => {
    const timers = virtualTimers()
    const outcome = await timers.run(runCronTickOnce(slowNamespace(3_000, timers), { cron: '*/5 * * * *', scheduledTime: MINUTE }, vi.fn(async () => {}), {
      now: () => MINUTE, holder: () => 'h', delay: timers.sleep, every: () => () => {},
    }))
    expect(outcome).toBe('ran')
    expect(errors.join('\n')).not.toMatch(/FAILED OPEN/)
  })
})

// #2284: the hourly check pages on a tick that may really have run twice, which
// needs a durable record of every delivery, not the count of skips (a second
// delivery that ran leaves no skip). So the guard writes one line per delivery
// saying what it decided, and the tail worker copies it into cron_tick_deliveries.
describe('one delivery line per decision (#2284)', () => {
  const deliveryLines = () => [...logs, ...warns, ...errors]
    .filter((l) => l.startsWith(DELIVERY_LINE_PREFIX))
    .map((l) => JSON.parse(l.slice(DELIVERY_LINE_PREFIX.length)) as Record<string, unknown>)

  it('says ran, skipped, failed_open, and took_over, each with the delivery id, cron and scheduled time', async () => {
    const { ns } = claimNamespace()
    const jobs = vi.fn(async () => {})
    await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 1_000 }, jobs, { now: () => MINUTE + 1_000, holder: () => 'd-ran' })
    await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 37_000 }, jobs, { now: () => MINUTE + 37_000, holder: () => 'd-skip' })
    await runCronTickOnce(undefined, { cron: '0 9 * * *', scheduledTime: MINUTE }, jobs, { now: () => MINUTE, holder: () => 'd-open' })
    expect(deliveryLines()).toEqual([
      { delivery: 'd-ran', outcome: 'ran', cron: '0 * * * *', scheduled: new Date(MINUTE + 1_000).toISOString() },
      { delivery: 'd-skip', outcome: 'skipped', cron: '0 * * * *', scheduled: new Date(MINUTE + 37_000).toISOString() },
      { delivery: 'd-open', outcome: 'failed_open', cron: '0 9 * * *', scheduled: new Date(MINUTE).toISOString() },
    ])
  })

  it('says took_over for a delivery that takes a tick from a holder whose lease went stale', async () => {
    const { ns } = claimNamespace()
    const clock = { t: MINUTE }
    void runCronTickOnce(ns, { cron: '23 * * * *', scheduledTime: MINUTE }, () => new Promise<void>(() => {}), { now: () => clock.t, holder: () => 'd-first', every: () => () => {} })
    await vi.waitFor(() => expect(deliveryLines()).toHaveLength(1))
    clock.t = MINUTE + TICK_LEASE_STALE_MS
    await runCronTickOnce(ns, { cron: '23 * * * *', scheduledTime: MINUTE }, vi.fn(async () => {}), { now: () => clock.t, holder: () => 'd-second', every: () => () => {} })
    expect(deliveryLines().map((d) => [d.delivery, d.outcome])).toEqual([['d-first', 'ran'], ['d-second', 'took_over']])
  })

  it('names a delivery even when it fails open before any holder could ask', async () => {
    await runCronTickOnce(undefined, { cron: '0 9 * * *', scheduledTime: MINUTE }, vi.fn(async () => {}), { now: () => MINUTE })
    const [d] = deliveryLines()
    expect(d.outcome).toBe('failed_open')
    expect(typeof d.delivery).toBe('string')
    expect((d.delivery as string).length).toBeGreaterThan(0)
  })

  // A contract with another app: the real line is fed to the tail worker's real parser.
  it('is read back by the tail worker as the same delivery', async () => {
    const { ns } = claimNamespace()
    await runCronTickOnce(ns, { cron: '* * * * *', scheduledTime: MINUTE + 1_000 }, vi.fn(async () => {}), { now: () => MINUTE + 1_000, holder: () => 'd-1' })
    const line = logs.find((l) => l.startsWith(DELIVERY_LINE_PREFIX))!
    const trace = {
      scriptName: 'bidspoke-worker',
      outcome: 'ok',
      eventTimestamp: MINUTE + 1_000,
      event: { cron: '* * * * *', scheduledTime: MINUTE + 1_000 },
      logs: [{ timestamp: MINUTE + 1_050, level: 'log', message: [line] }],
    } as unknown as TraceItem
    expect(deliveriesIn(trace)).toEqual([{
      delivery_id: 'd-1',
      occurred_at: new Date(MINUTE + 1_050).toISOString(),
      cron: '* * * * *',
      scheduled_at: new Date(MINUTE + 1_000).toISOString(),
      outcome: 'ran',
      invocation_outcome: 'ok',
    }])
  })
})
