import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shouldAlertFallback, runHyperdriveFallbackCheck, recordHyperdriveFallback, FALLBACK_ALERT_THRESHOLD } from '../hyperdrive-fallback'

describe('recordHyperdriveFallback', () => {
  it('writes a short-lived marker keyed under the hdfb:m: prefix', () => {
    const put = vi.fn().mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordHyperdriveFallback({ IDEMPOTENCY: { put } } as any)
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toMatch(/^hdfb:m:/)
    expect(put.mock.calls[0][2]).toMatchObject({ expirationTtl: 300 })
  })

  it('is a no-op when there is no KV binding', () => {
    expect(() => recordHyperdriveFallback(undefined)).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => recordHyperdriveFallback({} as any)).not.toThrow()
  })
})

describe('shouldAlertFallback', () => {
  it('only alerts at or above the threshold', () => {
    expect(shouldAlertFallback(FALLBACK_ALERT_THRESHOLD - 1)).toBe(false)
    expect(shouldAlertFallback(FALLBACK_ALERT_THRESHOLD)).toBe(true)
    expect(shouldAlertFallback(0)).toBe(false)
  })
})

// KV mock: list returns `markerCount` marker keys; get/put track the cooldown.
function makeKv(markerCount: number, cooldownSet = false) {
  const store = new Map<string, string>()
  if (cooldownSet) store.set('hdfb:cooldown', '1')
  return {
    list: vi.fn().mockResolvedValue({
      keys: Array.from({ length: markerCount }, (_, i) => ({ name: `hdfb:m:${i}` })),
    }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    _store: store,
  } as unknown as KVNamespace & { put: ReturnType<typeof vi.fn>; _store: Map<string, string> }
}

// Supabase mock: service_connections rows + a slack config for getSlackConnection.
function makeSupabase() {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'select') return () => chain
      if (prop === 'eq') return () => chain
      if (prop === 'maybeSingle') return async () => ({ data: { config: { bot_token: 'xoxb-t', default_channel: '#alerts' } }, error: null })
      // service_connections list (select().eq() then awaited as a thenable)
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [{ organization_id: 'org-1' }], error: null })
      return () => chain
    },
  })
  return { from: () => chain }
}

describe('runHyperdriveFallbackCheck', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.2' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('does not alert below the threshold', async () => {
    const kv = makeKv(FALLBACK_ALERT_THRESHOLD - 1)
    const res = await runHyperdriveFallbackCheck(makeSupabase() as never, kv)
    expect(res.alerted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('alerts and sets a cooldown when the count crosses the threshold', async () => {
    const kv = makeKv(FALLBACK_ALERT_THRESHOLD + 2)
    const res = await runHyperdriveFallbackCheck(makeSupabase() as never, kv)
    expect(res.count).toBe(FALLBACK_ALERT_THRESHOLD + 2)
    expect(res.alerted).toBe(true)
    expect(fetchMock).toHaveBeenCalled()
    // cooldown was written
    expect((kv as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledWith('hdfb:cooldown', '1', expect.anything())
  })

  it('stays quiet while in cooldown even above the threshold', async () => {
    const kv = makeKv(FALLBACK_ALERT_THRESHOLD + 5, true)
    const res = await runHyperdriveFallbackCheck(makeSupabase() as never, kv)
    expect(res.alerted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
