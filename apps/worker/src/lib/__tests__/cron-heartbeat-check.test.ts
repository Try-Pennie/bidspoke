import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendCronHeartbeatAlert: vi.fn(async () => true),
}))

import { sendCronHeartbeatAlert } from '../slack'
import { runDailyHeartbeatCheck, writeDailyHeartbeat, HEARTBEAT_KEY, FIRST_SEEN_KEY } from '../cron-heartbeat'

const NOW = Date.parse('2026-06-26T13:00:00.000Z')
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

function fakeSupabase(orgRows: { organization_id: string }[]): SupabaseClient {
  return {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: orgRows, error: null }) }) }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.mocked(sendCronHeartbeatAlert).mockClear()
})

describe('writeDailyHeartbeat', () => {
  it('records the run timestamp under the heartbeat key', async () => {
    const kv = fakeKv()
    await writeDailyHeartbeat(kv, NOW)
    expect(kv.store.get(HEARTBEAT_KEY)).toBe(iso(NOW))
  })
})

describe('runDailyHeartbeatCheck', () => {
  it('is healthy and silent when the last run is recent', async () => {
    const kv = fakeKv({ [HEARTBEAT_KEY]: iso(NOW - 1 * H) })
    const res = await runDailyHeartbeatCheck(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    expect(res.status).toBe('healthy')
    expect(res.alerted).toBe(false)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('seeds a first-seen marker and stays silent on a fresh deploy with no heartbeat yet', async () => {
    const kv = fakeKv()
    const res = await runDailyHeartbeatCheck(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    expect(res.status).toBe('pending')
    expect(res.alerted).toBe(false)
    expect(kv.store.get(FIRST_SEEN_KEY)).toBe(iso(NOW))
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('alerts each distinct Slack org once when the heartbeat is stale', async () => {
    const kv = fakeKv({ [HEARTBEAT_KEY]: iso(NOW - 27 * H) })
    const res = await runDailyHeartbeatCheck(
      fakeSupabase([{ organization_id: 'o1' }, { organization_id: 'o1' }, { organization_id: 'o2' }]),
      kv,
      NOW,
    )
    expect(res.status).toBe('stale')
    expect(res.alerted).toBe(true)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(2)
  })

  it('does not re-alert on the next run while the cooldown is active', async () => {
    const kv = fakeKv({ [HEARTBEAT_KEY]: iso(NOW - 27 * H) })
    await runDailyHeartbeatCheck(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    vi.mocked(sendCronHeartbeatAlert).mockClear()
    const res = await runDailyHeartbeatCheck(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW + 60_000)
    expect(res.alerted).toBe(false)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('alerts when the batch has never run since first being seen long ago', async () => {
    const kv = fakeKv({ [FIRST_SEEN_KEY]: iso(NOW - 27 * H) })
    const res = await runDailyHeartbeatCheck(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    expect(res.status).toBe('never_ran')
    expect(res.alerted).toBe(true)
  })
})
