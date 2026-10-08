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
import { AlertClaimObject, TICK_RETRY_AFTER_MS } from '../../durable-objects/alert-claim'
import { runCronTickOnce, cronTickKey, CRON_TICK_DEADLINE_MS } from '../cron-once'

/** Storage with the surface the claim object uses, held in a Map. */
function memoryState(): DurableObjectState {
  const store = new Map<string, unknown>()
  return {
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { store.set(key, value) },
      deleteAll: async () => { store.clear() },
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

  it('(b) runs one of two deliveries with the SAME scheduled time (2026-10-05)', async () => {
    const { ns } = claimNamespace()
    const job = pendingJob()
    const firstRun = runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, job.ran, { now: () => MINUTE + 8_300, holder: () => 'req-a' })
    await vi.waitFor(() => expect(job.ran).toHaveBeenCalledTimes(1))
    const twin = await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, job.ran, { now: () => MINUTE + 8_800, holder: () => 'req-b' })
    expect(twin).toBe('skipped')
    job.finish()
    await firstRun
    // and once the run is done, a late delivery of the same time is still a duplicate
    const late = await runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, job.ran, { now: () => MINUTE + 8_000 + 10 * TICK_RETRY_AFTER_MS, holder: () => 'req-c' })
    expect(late).toBe('skipped')
    expect(job.ran).toHaveBeenCalledTimes(1)
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
    void runCronTickOnce(ns, { cron: '0 * * * *', scheduledTime: scheduled }, killed, { now: () => scheduled, holder: () => 'req-killed' })
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
    expect(errors.join('\n')).toMatch(/FAILED OPEN.*cron="15 8 \* \* \*".*did not answer inside 2000ms/)
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

  it('marks the tick done even when the jobs threw, so the run is not mistaken for a dead one', async () => {
    const { ns } = claimNamespace()
    const scheduled = MINUTE + 1_000
    await expect(runCronTickOnce(ns, { cron: '0 13 * * *', scheduledTime: scheduled }, async () => { throw new Error('job blew up') }, { now: () => scheduled, holder: () => 'req-a' })).rejects.toThrow('job blew up')
    const later = await runCronTickOnce(ns, { cron: '0 13 * * *', scheduledTime: scheduled }, vi.fn(async () => {}), { now: () => scheduled + 10 * TICK_RETRY_AFTER_MS, holder: () => 'req-b' })
    expect(later).toBe('skipped')
  })
})
