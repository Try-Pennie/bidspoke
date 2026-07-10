import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendCronHeartbeatAlert: vi.fn(async () => true),
}))

import { sendCronHeartbeatAlert } from '../slack'
import {
  runHeartbeatChecks,
  writeHeartbeat,
  heartbeatKey,
  firstSeenKey,
  CRON_JOBS,
  cronJob,
} from '../cron-heartbeat'

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

// Fresh every job so a job-under-test can be made stale in isolation.
function allFresh(nowMs: number): Record<string, string> {
  return Object.fromEntries(CRON_JOBS.map((j) => [heartbeatKey(j.id), iso(nowMs - 1)]))
}

beforeEach(() => {
  vi.mocked(sendCronHeartbeatAlert).mockClear()
})

describe('CRON_JOBS registry', () => {
  it('keeps the daily batch on its legacy KV key so a live deploy does not lose its heartbeat', () => {
    // Renaming this key would reset the daily job to never_ran on deploy and
    // false-alarm during the grace window. It must stay byte-for-byte.
    expect(heartbeatKey('daily-1300')).toBe('cron-heartbeat:daily-1300')
    expect(firstSeenKey('daily-1300')).toBe('cron-heartbeat:daily-1300:first-seen')
  })

  it('registers the two-hour export and purge crons as watched jobs', () => {
    const ids = CRON_JOBS.map((j) => j.id)
    expect(ids).toContain('sightings-export')
    expect(ids).toContain('sightings-purge')
  })

  it('watches the bids purge, which runs on its own cron so a sightings backlog cannot starve it', () => {
    // The bids purge got its own even-hour cron (2026-07-10: sharing one purge
    // invocation let an 87K sightings backlog exhaust the subrequest budget and
    // leave bids at zero). A separate cron that nothing watches is exactly the
    // #612 gap, so it must be registered too.
    const ids = CRON_JOBS.map((j) => j.id)
    expect(ids).toContain('sighting-bids-purge')
    expect(cronJob('sighting-bids-purge').triggerCron).toBe('47 0-22/2 * * *')
  })

  it('gives the two-hour jobs a tighter stale threshold than the daily job', () => {
    expect(cronJob('sightings-purge').staleMs).toBeLessThan(cronJob('daily-1300').staleMs)
    expect(cronJob('sighting-bids-purge').staleMs).toBeLessThan(cronJob('daily-1300').staleMs)
    // A 2h cadence must still tolerate one on-time run without flapping.
    expect(cronJob('sightings-purge').staleMs).toBeGreaterThan(2 * H)
    expect(cronJob('sighting-bids-purge').staleMs).toBeGreaterThan(2 * H)
  })
})

describe('writeHeartbeat', () => {
  it('records the run timestamp under the per-job heartbeat key', async () => {
    const kv = fakeKv()
    await writeHeartbeat(kv, 'sightings-purge', NOW)
    expect(kv.store.get(heartbeatKey('sightings-purge'))).toBe(iso(NOW))
    // Does not touch a different job's key.
    expect(kv.store.get(heartbeatKey('daily-1300'))).toBeUndefined()
  })
})

describe('runHeartbeatChecks', () => {
  it('is healthy and silent when every job ran recently', async () => {
    const kv = fakeKv(allFresh(NOW))
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    expect(results.every((r) => r.status === 'healthy')).toBe(true)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
  })

  it('alerts for the one dark job while the others stay silent', async () => {
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey('sightings-purge')]: iso(NOW - 5 * H),
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)

    const purge = results.find((r) => r.jobId === 'sightings-purge')
    expect(purge?.status).toBe('stale')
    expect(purge?.alerted).toBe(true)
    // Exactly one alert, and it names the purge job.
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0][2]).toMatchObject({ id: 'sightings-purge' })
  })

  it('uses a per-job cooldown so one dark job does not suppress alerts for another', async () => {
    // Purge already alerted (cooldown set); export goes dark next. The export
    // must still alert -- a shared cooldown key would swallow it.
    const kv = fakeKv({
      ...allFresh(NOW),
      [heartbeatKey('sightings-export')]: iso(NOW - 5 * H),
      'cron-heartbeat:sightings-purge:alerted': '1',
    })
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)

    expect(results.find((r) => r.jobId === 'sightings-export')?.alerted).toBe(true)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendCronHeartbeatAlert).mock.calls[0][2]).toMatchObject({ id: 'sightings-export' })
  })

  it('seeds a per-job first-seen marker and stays silent on a fresh deploy', async () => {
    const kv = fakeKv()
    const results = await runHeartbeatChecks(fakeSupabase([{ organization_id: 'o1' }]), kv, NOW)
    expect(results.every((r) => r.status === 'pending')).toBe(true)
    expect(sendCronHeartbeatAlert).not.toHaveBeenCalled()
    expect(kv.store.get(firstSeenKey('sightings-purge'))).toBe(iso(NOW))
    expect(kv.store.get(firstSeenKey('daily-1300'))).toBe(iso(NOW))
  })

  it('alerts every distinct Slack org once for a dark job', async () => {
    const kv = fakeKv({ ...allFresh(NOW), [heartbeatKey('daily-1300')]: iso(NOW - 30 * H) })
    const res = await runHeartbeatChecks(
      fakeSupabase([{ organization_id: 'o1' }, { organization_id: 'o1' }, { organization_id: 'o2' }]),
      kv,
      NOW,
    )
    expect(res.find((r) => r.jobId === 'daily-1300')?.alerted).toBe(true)
    expect(sendCronHeartbeatAlert).toHaveBeenCalledTimes(2)
  })
})
