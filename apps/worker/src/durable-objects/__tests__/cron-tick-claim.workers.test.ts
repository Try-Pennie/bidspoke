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
import { TICK_RETRY_AFTER_MS } from '../alert-claim'

const bindings = env as unknown as Pick<Env, 'ALERT_CLAIM'>

/**
 * The object's semantics are under test here, not the deadline (the Node suite
 * covers that): a cold object in a busy workerd run can take over 2 s to
 * answer, which would fail the claim open and test nothing.
 */
const SLOW_OK = { deadlineMs: 30_000 }

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
    void runCronTickOnce(bindings.ALERT_CLAIM, { cron: '23 * * * *', scheduledTime: minute }, () => new Promise(() => {}), { ...SLOW_OK, now: () => minute, holder: () => 'killed' })
    await vi.waitFor(async () => {
      const probe = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '23 * * * *', scheduledTime: minute + 36_000 }, async () => {}, { ...SLOW_OK, now: () => minute + 36_000 })
      expect(probe).toBe('skipped')
    })
    const retry = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '23 * * * *', scheduledTime: minute }, async () => {}, { ...SLOW_OK, now: () => minute + TICK_RETRY_AFTER_MS + 1, holder: () => 'retry' })
    expect(retry).toBe('ran')
    const other = await runCronTickOnce(bindings.ALERT_CLAIM, { cron: '*/5 * * * *', scheduledTime: minute }, async () => {}, { ...SLOW_OK, now: () => minute })
    expect(other).toBe('ran')
  })
})
