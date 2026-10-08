/**
 * AlertClaimObject (#1298)
 *
 * One claim per alert key per TTL, strongly consistent, so two cron ticks that
 * pass the KV cooldown together cannot both post. Tested directly on the DO.
 */
import { describe, it, expect } from 'vitest'
import { AlertClaimObject, TICK_RETRY_AFTER_MS, TICK_CLAIM_KEEP_MS } from '../alert-claim'
import type { ClaimResult, TickClaimResult } from '../alert-claim'

function makeDOState() {
  const store = new Map<string, unknown>()
  let alarm: number | null = null
  const state = {
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { store.set(key, value) },
      deleteAll: async () => { store.clear() },
      setAlarm: async (time: number) => { alarm = time },
      getAlarm: async () => alarm,
    },
  } as unknown as DurableObjectState
  return { state, getAlarm: () => alarm }
}

function req(path: string, body?: unknown): Request {
  return new Request(`http://do${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
}

const NOW = 1_700_000_000_000

describe('AlertClaimObject', () => {
  it('grants the first claim and refuses a second inside the TTL', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    const first = await (await obj.fetch(req('/claim', { now: NOW, ttl_seconds: 1800 }))).json<ClaimResult>()
    const second = await (await obj.fetch(req('/claim', { now: NOW + 5, ttl_seconds: 1800 }))).json<ClaimResult>()
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
  })

  it('grants again once the TTL has passed', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    await obj.fetch(req('/claim', { now: NOW, ttl_seconds: 60 }))
    const later = await (await obj.fetch(req('/claim', { now: NOW + 61_000, ttl_seconds: 60 }))).json<ClaimResult>()
    expect(later.claimed).toBe(true)
  })

  it('schedules its own cleanup at now + ttl and frees the claim when the alarm fires', async () => {
    const { state, getAlarm } = makeDOState()
    const obj = new AlertClaimObject(state)
    await obj.fetch(req('/claim', { now: NOW, ttl_seconds: 60 }))
    expect(getAlarm()).toBe(NOW + 60_000)
    await obj.alarm()
    const again = await (await obj.fetch(req('/claim', { now: NOW + 1, ttl_seconds: 60 }))).json<ClaimResult>()
    expect(again.claimed).toBe(true)
  })

  it('release frees the claim so a failed send can be retried by the next tick', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    await obj.fetch(req('/claim', { now: NOW, ttl_seconds: 1800 }))
    await obj.fetch(req('/release'))
    const again = await (await obj.fetch(req('/claim', { now: NOW + 1, ttl_seconds: 1800 }))).json<ClaimResult>()
    expect(again.claimed).toBe(true)
  })

  it('answers 404 for an unknown path', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    expect((await obj.fetch(req('/nope'))).status).toBe(404)
  })
})

/**
 * The cron tick claim (#1899): one run per (cron expression, scheduled minute).
 * One object per key, so these drive a single object the way two deliveries of
 * one tick would, with the caller's clock passed in.
 */
describe('AlertClaimObject cron tick claim (#1899)', () => {
  const tick = async (obj: AlertClaimObject, body: { now: number; scheduled_time: number; holder: string }) =>
    (await obj.fetch(req('/tick-claim', body))).json<TickClaimResult>()
  const done = async (obj: AlertClaimObject, holder: string) =>
    (await obj.fetch(req('/tick-done', { now: NOW, holder }))).json<{ marked: boolean }>()

  it('grants the first delivery and refuses a second one with a different scheduled second, naming the holder', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    const first = await tick(obj, { now: NOW, scheduled_time: NOW, holder: 'a' })
    const second = await tick(obj, { now: NOW + 36_000, scheduled_time: NOW + 36_000, holder: 'b' })
    expect(first).toMatchObject({ run: true, reason: 'first' })
    expect(second).toMatchObject({ run: false, reason: 'duplicate', holder: 'a', holder_status: 'running', holder_age_ms: 36_000, duplicates: 1 })
  })

  it('refuses a delivery with the same scheduled time that arrives while the holder is young (2026-10-05, 25.7 s apart)', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    await tick(obj, { now: NOW, scheduled_time: NOW, holder: 'a' })
    const twin = await tick(obj, { now: NOW + 25_700, scheduled_time: NOW, holder: 'b' })
    expect(twin).toMatchObject({ run: false, reason: 'duplicate', holder: 'a' })
  })

  it('hands the claim to a delivery with the same scheduled time once the holder is older than the retry floor, and only the retry can finish it', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    await tick(obj, { now: NOW, scheduled_time: NOW, holder: 'a' })
    const retry = await tick(obj, { now: NOW + TICK_RETRY_AFTER_MS, scheduled_time: NOW, holder: 'b' })
    expect(retry).toMatchObject({ run: true, reason: 'retry', holder: 'a' })
    expect(await done(obj, 'a')).toEqual({ marked: false })
    expect(await done(obj, 'b')).toEqual({ marked: true })
    const late = await tick(obj, { now: NOW + 2 * TICK_RETRY_AFTER_MS, scheduled_time: NOW, holder: 'c' })
    expect(late).toMatchObject({ run: false, holder: 'b', holder_status: 'done' })
  })

  it('never hands an old running claim to a delivery with a DIFFERENT scheduled time: only the dead run itself is retried', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    await tick(obj, { now: NOW, scheduled_time: NOW, holder: 'a' })
    const twin = await tick(obj, { now: NOW + 10 * TICK_RETRY_AFTER_MS, scheduled_time: NOW + 36_000, holder: 'b' })
    expect(twin).toMatchObject({ run: false, reason: 'duplicate' })
  })

  it('refuses every later delivery once the run is done, whatever its scheduled time', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    await tick(obj, { now: NOW, scheduled_time: NOW, holder: 'a' })
    await done(obj, 'a')
    const same = await tick(obj, { now: NOW + 10 * TICK_RETRY_AFTER_MS, scheduled_time: NOW, holder: 'b' })
    expect(same).toMatchObject({ run: false, holder_status: 'done', duplicates: 1 })
  })

  it('schedules its own cleanup an hour on, and the cleanup frees the key', async () => {
    const { state, getAlarm } = makeDOState()
    const obj = new AlertClaimObject(state)
    await tick(obj, { now: NOW, scheduled_time: NOW, holder: 'a' })
    expect(getAlarm()).toBe(NOW + TICK_CLAIM_KEEP_MS)
    await obj.alarm()
    expect(await tick(obj, { now: NOW + 1, scheduled_time: NOW + 1, holder: 'b' })).toMatchObject({ run: true, reason: 'first' })
  })

  it('answers 400 to a malformed body rather than granting on it', async () => {
    const obj = new AlertClaimObject(makeDOState().state)
    expect((await obj.fetch(req('/tick-claim', { now: NOW }))).status).toBe(400)
    expect((await obj.fetch(req('/tick-done', {}))).status).toBe(400)
  })
})
