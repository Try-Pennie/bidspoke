import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isDrainStalled, runDrainStallCheck, DRAIN_STALL_THRESHOLD } from '../drain-stall'

describe('isDrainStalled', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(isDrainStalled(DRAIN_STALL_THRESHOLD - 1)).toBe(false)
    expect(isDrainStalled(0)).toBe(false)
    expect(isDrainStalled(DRAIN_STALL_THRESHOLD)).toBe(true)
    expect(isDrainStalled(DRAIN_STALL_THRESHOLD + 1000)).toBe(true)
  })
})

// Table-aware Supabase mock: the lead_sightings count query resolves { count },
// service_connections resolves the org list (then) and the per-org slack config
// (maybeSingle for getSlackConnection).
function makeSupabase(strandedCount: number) {
  function chainFor(table: string): unknown {
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === 'maybeSingle') {
          return async () => ({ data: { config: { bot_token: 'xoxb', default_channel: '#alerts' } }, error: null })
        }
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(
              table === 'lead_sightings'
                ? { count: strandedCount, error: null }
                : { data: [{ organization_id: 'org-1' }], error: null },
            )
        }
        return () => chainFor(table)
      },
    })
  }
  return { from: (table: string) => chainFor(table) }
}

function makeKv(cooldownSet = false) {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (k: string) => (cooldownSet ? '1' : store.get(k) ?? null)),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  } as unknown as KVNamespace & { put: ReturnType<typeof vi.fn> }
}

describe('runDrainStallCheck', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.2' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('stays quiet when the stranded backlog is below the threshold (drain is healthy)', async () => {
    const res = await runDrainStallCheck(makeSupabase(0) as never, makeKv())
    expect(res.stranded).toBe(0)
    expect(res.alerted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('alerts and sets the cooldown when the backlog is over the threshold (drain stalled)', async () => {
    const kv = makeKv()
    const res = await runDrainStallCheck(makeSupabase(DRAIN_STALL_THRESHOLD + 4000) as never, kv)
    expect(res.stranded).toBe(DRAIN_STALL_THRESHOLD + 4000)
    expect(res.alerted).toBe(true)
    expect(fetchMock).toHaveBeenCalled()
    expect((kv as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledWith(
      'drain-stall:alerted', '1', expect.anything(),
    )
  })

  it('stays quiet within the cooldown even when still stalled', async () => {
    const res = await runDrainStallCheck(makeSupabase(DRAIN_STALL_THRESHOLD + 4000) as never, makeKv(true))
    expect(res.alerted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
