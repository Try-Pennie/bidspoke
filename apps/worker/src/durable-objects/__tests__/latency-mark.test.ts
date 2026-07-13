/**
 * LatencyMarkObject (#488)
 *
 * Tests: mark/check round trip, a genuinely absent mark, TTL self-cleanup via the
 * alarm, and re-marking. The DO is tested directly, no network layer required.
 */
import { describe, it, expect } from 'vitest'
import { LatencyMarkObject } from '../latency-mark'
import type { MarkCheckResult } from '../latency-mark'

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  return { state, store, getAlarm: () => alarm }
}

function req(path: string, body?: unknown): Request {
  return new Request(`http://do${path}`, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const NOW = 1_700_000_000_000

describe('LatencyMarkObject', () => {
  it('returns the stamped bid time on check after a mark', async () => {
    const { state } = makeDOState()
    const obj = new LatencyMarkObject(state)

    await obj.fetch(req('/mark', { marked_at: NOW, ttl_seconds: 86400 }))
    const res = await obj.fetch(req('/check'))

    expect(await res.json<MarkCheckResult>()).toEqual({ marked_at: NOW })
  })

  it('returns null for a bid that was never marked', async () => {
    // Strong consistency means this is a real answer, not "maybe not replicated yet".
    // That is what makes the gate's fail-safe reject trustworthy (#488).
    const { state } = makeDOState()
    const obj = new LatencyMarkObject(state)

    const res = await obj.fetch(req('/check'))
    expect(await res.json<MarkCheckResult>()).toEqual({ marked_at: null })
  })

  it('schedules its own cleanup at marked_at + ttl', async () => {
    // A DO has no TTL of its own, so without this every bid would leave a row behind
    // forever.
    const { state, getAlarm } = makeDOState()
    const obj = new LatencyMarkObject(state)

    await obj.fetch(req('/mark', { marked_at: NOW, ttl_seconds: 60 }))
    expect(getAlarm()).toBe(NOW + 60_000)
  })

  it('drops the mark when the TTL alarm fires, so a late confirmation is rejected', async () => {
    const { state } = makeDOState()
    const obj = new LatencyMarkObject(state)

    await obj.fetch(req('/mark', { marked_at: NOW, ttl_seconds: 60 }))
    await obj.alarm()

    const res = await obj.fetch(req('/check'))
    expect(await res.json<MarkCheckResult>()).toEqual({ marked_at: null })
  })

  it('overwrites an earlier mark, so a re-bid is measured from the latest bid', async () => {
    const { state, getAlarm } = makeDOState()
    const obj = new LatencyMarkObject(state)

    await obj.fetch(req('/mark', { marked_at: NOW, ttl_seconds: 60 }))
    await obj.fetch(req('/mark', { marked_at: NOW + 5000, ttl_seconds: 60 }))

    const res = await obj.fetch(req('/check'))
    expect(await res.json<MarkCheckResult>()).toEqual({ marked_at: NOW + 5000 })
    expect(getAlarm()).toBe(NOW + 5000 + 60_000)
  })

  it('404s an unknown path', async () => {
    const { state } = makeDOState()
    const obj = new LatencyMarkObject(state)

    const res = await obj.fetch(req('/nope'))
    expect(res.status).toBe(404)
  })
})
