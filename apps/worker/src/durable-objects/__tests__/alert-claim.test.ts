/**
 * AlertClaimObject (#1298)
 *
 * One claim per alert key per TTL, strongly consistent, so two cron ticks that
 * pass the KV cooldown together cannot both post. Tested directly on the DO.
 */
import { describe, it, expect } from 'vitest'
import { AlertClaimObject } from '../alert-claim'
import type { ClaimResult } from '../alert-claim'

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
