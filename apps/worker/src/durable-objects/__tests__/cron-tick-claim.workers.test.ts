/**
 * The cron tick claim (#1899) against the real AlertClaim object in workerd.
 *
 * The Node suite drives the object through a Map double, which cannot show what
 * happens when two deliveries reach the object at the same instant (2026-10-05:
 * the hourly pair started 0.5 s apart). Here both ask the real object at once
 * through the real client, and exactly one may run. The clock is set in the
 * future so the object's cleanup alarm never fires underneath the test.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import { runCronTickOnce } from '../../lib/cron-once'
import { TICK_LEASE_STALE_MS } from '../alert-claim'

const bindings = env as unknown as Pick<Env, 'ALERT_CLAIM'>

/**
 * The object's semantics are under test here, not the deadline (the Node suite
 * covers that): a cold object in a busy workerd run can take over 2 s to
 * answer, which would fail the claim open and test nothing.
 */
// No real waiting on a same-time holder (#2064): the second ask comes at once.
const SLOW_OK = { deadlineMs: 30_000, sleep: async () => {} }

/** 2027-10-08 14:37 UTC. */
const MINUTE = Date.UTC(2027, 9, 8, 14, 37)

describe('the cron tick claim in workerd (#1899)', () => {
  it('lets exactly one of two simultaneous deliveries of one tick run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const jobs = vi.fn(async () => {})
    const outcomes = await Promise.all([
      runCronTickOnce(bindings.ALERT_CLAIM, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, jobs, { ...SLOW_OK, now: () => MINUTE + 8_300, holder: () => 'req-a' }),
      runCronTickOnce(bindings.ALERT_CLAIM, { cron: '0 * * * *', scheduledTime: MINUTE + 8_000 }, jobs, { ...SLOW_OK, now: () => MINUTE + 8_800, holder: () => 'req-b' }),
    ])
    expect(outcomes.sort()).toEqual(['ran', 'skipped'])
    expect(jobs).toHaveBeenCalledTimes(1)
  })

  it('runs the retry of a run that never finished, and every expression in the minute', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const minute = MINUTE + 60 * 60_000
    // The jobs are called only once the claim is granted, so waiting on them
    // proves the killed run holds the tick before anything else asks.
    const killedJobs = vi.fn(() => new Promise<void>(() => {}))
    // A killed run renews nothing (#2064): its renewal timer never fires.
    void runCronTickOnce(bindings.ALERT_CLAIM, { cron: '23 * * * *', scheduledTime: minute }, killedJobs, { ...SLOW_OK, now: () => minute, holder: () => 'killed', every: () => () => {} })
    await vi.waitFor(() => expect(killedJobs).toHaveBeenCalledTimes(1), { timeout: 30_000 })
    const twin = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '23 * * * *', scheduledTime: minute + 36_000 }, async () => {}, { ...SLOW_OK, now: () => minute + 36_000 })
    expect(twin).toBe('skipped')
    const retry = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '23 * * * *', scheduledTime: minute }, async () => {}, { ...SLOW_OK, now: () => minute + TICK_LEASE_STALE_MS + 1, holder: () => 'retry' })
    expect(retry).toBe('ran')
    const other = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '*/5 * * * *', scheduledTime: minute }, async () => {}, { ...SLOW_OK, now: () => minute })
    expect(other).toBe('ran')
  })
})

/**
 * A claim that answers after the deadline (#2646). 2026-10-22 03:00 UTC: the
 * `*\/15` tick's claim did not answer inside 5 s, the delivery failed open and
 * dropped its holder, the claim then reached the object and was stored as a
 * running holder nobody renewed or closed, and a same scheduled time delivery
 * at 03:08 took it over and ran the jobs again.
 *
 * The claim is held back from the real object until the test lets it through,
 * and only the claim's own deadline expires, so the renewals and the close
 * reach the object as they would.
 */
function lateClaimNamespace(real: DurableObjectNamespace) {
  let letThrough: () => void = () => {}
  const released = new Promise<void>((resolve) => { letThrough = resolve })
  let landed: Promise<Response> | null = null
  const ns = {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = real.get(id)
      return {
        fetch: (url: string, init?: RequestInit) => {
          if (!url.endsWith('/tick-claim')) return stub.fetch(url, init)
          // The body is read now, as the request leaves; it arrives later.
          const body = String(init?.body)
          landed = released.then(() => stub.fetch(url, { method: 'POST', body }))
          return landed
        },
      }
    },
  } as unknown as DurableObjectNamespace
  return {
    ns,
    /** Lets the held claim reach the object, and waits until it has. */
    arrive: async () => { letThrough(); await landed },
  }
}

/** The claim's deadline expires at once; every later wait (renewal, close) has 30 s. */
function claimDeadlineOnly() {
  let calls = 0
  return (ms: number) => (calls++ === 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms)))
}

describe('a tick claim that answers after the deadline (#2646)', () => {
  const minute = MINUTE + 3 * 60 * 60_000

  it('keeps the late claim, so a same scheduled time delivery after the lease window is skipped', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const late = lateClaimNamespace(bindings.ALERT_CLAIM)
    const clock = { t: minute + 51_391 }
    let finish: () => void = () => {}
    const jobs = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    let renew: () => void = () => {}
    const run = runCronTickOnce(late.ns, { cron: '*/15 * * * *', scheduledTime: minute + 51_391 }, jobs, {
      deadlineMs: 30_000, delay: claimDeadlineOnly(), now: () => clock.t, holder: () => 'late', every: (fn) => { renew = fn; return () => {} },
    })
    await vi.waitFor(() => expect(jobs).toHaveBeenCalledTimes(1), { timeout: 30_000 })
    await late.arrive()
    clock.t += 3_000
    renew()
    clock.t += 3_000
    renew()
    finish()
    await run
    const redelivery = vi.fn(async () => {})
    const outcome = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '*/15 * * * *', scheduledTime: minute + 51_391 }, redelivery, {
      ...SLOW_OK, now: () => minute + 51_391 + 7 * 60_000, holder: () => 'redelivery', every: () => () => {},
    })
    expect(outcome).toBe('skipped')
    expect(redelivery).not.toHaveBeenCalled()
  })

  it('closes the tick when its done reached the object BEFORE its late claim, so the redelivery is still skipped', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const late = lateClaimNamespace(bindings.ALERT_CLAIM)
    const scheduled = minute + 15 * 60_000 + 900
    // The jobs finish at once: tick-done is sent and refused before the claim lands.
    const ran = await runCronTickOnce(late.ns, { cron: '*/15 * * * *', scheduledTime: scheduled }, async () => {}, {
      deadlineMs: 30_000, delay: claimDeadlineOnly(), now: () => scheduled, holder: () => 'fast', every: () => () => {},
    })
    expect(ran).toBe('ran')
    await late.arrive()
    const redelivery = vi.fn(async () => {})
    const outcome = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '*/15 * * * *', scheduledTime: scheduled }, redelivery, {
      ...SLOW_OK, now: () => scheduled + TICK_LEASE_STALE_MS + 60_000, holder: () => 'redelivery', every: () => () => {},
    })
    expect(outcome).toBe('skipped')
    expect(redelivery).not.toHaveBeenCalled()
  })

  it('still lets the redelivery run when the late claim never arrives', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const late = lateClaimNamespace(bindings.ALERT_CLAIM)
    const scheduled = minute + 30 * 60_000 + 900
    await runCronTickOnce(late.ns, { cron: '*/15 * * * *', scheduledTime: scheduled }, async () => {}, {
      deadlineMs: 30_000, delay: claimDeadlineOnly(), now: () => scheduled, holder: () => 'lost', every: () => () => {},
    })
    // The claim is never let through.
    const redelivery = vi.fn(async () => {})
    const outcome = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '*/15 * * * *', scheduledTime: scheduled }, redelivery, {
      ...SLOW_OK, now: () => scheduled + TICK_LEASE_STALE_MS + 60_000, holder: () => 'redelivery', every: () => () => {},
    })
    expect(outcome).toBe('ran')
    expect(redelivery).toHaveBeenCalledTimes(1)
  })

  it('frees the tick when its jobs threw before the late claim arrived, so the redelivery runs them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const late = lateClaimNamespace(bindings.ALERT_CLAIM)
    const scheduled = minute + 45 * 60_000 + 900
    await expect(runCronTickOnce(late.ns, { cron: '*/15 * * * *', scheduledTime: scheduled }, async () => { throw new Error('no database client') }, {
      deadlineMs: 30_000, delay: claimDeadlineOnly(), now: () => scheduled, holder: () => 'threw', every: () => () => {},
    })).rejects.toThrow('no database client')
    await late.arrive()
    const redelivery = vi.fn(async () => {})
    const outcome = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '*/15 * * * *', scheduledTime: scheduled }, redelivery, {
      ...SLOW_OK, now: () => scheduled + 1_000, holder: () => 'redelivery', every: () => () => {},
    })
    expect(outcome).toBe('ran')
    expect(redelivery).toHaveBeenCalledTimes(1)
  })

  it('a done for a holder it has never seen leaves a tick another delivery holds alone', async () => {
    const stub = bindings.ALERT_CLAIM.get(bindings.ALERT_CLAIM.idFromName(`cron-tick:direct@${minute}`))
    const post = async (path: string, body: unknown) => (await stub.fetch(`https://do/${path}`, { method: 'POST', body: JSON.stringify(body) })).json<Record<string, unknown>>()
    expect(await post('tick-claim', { now: minute, scheduled_time: minute, holder: 'live' })).toMatchObject({ run: true, reason: 'first' })
    expect(await post('tick-done', { holder: 'stranger', now: minute + 1_000 })).toMatchObject({ marked: false })
    // The live holder is still running, and its own renewal and close still work.
    expect(await post('tick-renew', { holder: 'live', now: minute + 2_000 })).toEqual({ renewed: true })
    expect(await post('tick-claim', { now: minute + 2_500, scheduled_time: minute + 36_000, holder: 'twin' })).toMatchObject({ run: false, holder: 'live', holder_status: 'running' })
    expect(await post('tick-done', { holder: 'live', now: minute + 3_000 })).toEqual({ marked: true })
  })
})
