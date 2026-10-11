/**
 * Real-time volume cliff detection — covers detection edge cases and threshold behavior.
 * Integration with Supabase + KV + Slack lives in `runVolumeCliffCheck`; tested by behavior
 * (cooldown, opt-out) once we wire E2E. Pure logic is tested here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../slack', () => ({
  postMessage: vi.fn().mockResolvedValue('ts-1'),
  getSlackConnection: vi.fn(),
  sendRecoveryAlert: vi.fn(),
  sendDatabaseUnreachableAlert: vi.fn(),
}))

import { detectCliff, runVolumeCliffCheck, sendCliffAlert, BASELINE_WINDOW_MINUTES, RECENT_WINDOW_MINUTES, MIN_BASELINE_PER_MIN, SLACK_CONNS_LASTGOOD_KEY, DB_UNREACHABLE_PREFIX } from '../volume-cliff'
import { getSlackConnection, postMessage, sendRecoveryAlert, sendDatabaseUnreachableAlert } from '../slack'
import { encryptSecret, decryptSecret } from '../secret-crypto'
import { recoveryKey, RECOVERY_TTL_SECONDS } from '../alert-recovery'
import { BACKOFF_STEPS_SECONDS } from '../alert-backoff'
import type { AlertClaims } from '../alert-claim'

// A real 32 byte key so the last-good copy is exercised through the real cipher.
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

function buckets(baselinePerMin: number, recentTotal: number): number[] {
  const arr = new Array(60).fill(0)
  for (let i = 0; i < BASELINE_WINDOW_MINUTES; i++) arr[i] = baselinePerMin
  // distribute recentTotal evenly across the recent window
  const per = Math.floor(recentTotal / RECENT_WINDOW_MINUTES)
  let remainder = recentTotal - per * RECENT_WINDOW_MINUTES
  for (let i = BASELINE_WINDOW_MINUTES; i < 60; i++) {
    arr[i] = per + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder--
  }
  return arr
}

describe('detectCliff()', () => {
  it('returns null when recent matches baseline', () => {
    expect(detectCliff(buckets(70, 70 * RECENT_WINDOW_MINUTES))).toBeNull()
  })

  it('detects a cliff when the recent window drops to zero', () => {
    const result = detectCliff(buckets(70, 0))
    expect(result).not.toBeNull()
    expect(result!.recentCount).toBe(0)
    expect(result!.baselinePerMin).toBe(70)
  })

  it('detects a cliff at 20% of expected (under 25% threshold)', () => {
    // baseline 70/min → expected 280 in 4 complete min → 25% threshold = 70
    const recent = 70 * RECENT_WINDOW_MINUTES * 0.2  // 56 = 20%
    const result = detectCliff(buckets(70, recent))
    expect(result).not.toBeNull()
    expect(result!.recentCount).toBe(recent)
  })

  it('does NOT alert at 30% of expected (above 25% threshold)', () => {
    expect(detectCliff(buckets(70, Math.ceil(70 * RECENT_WINDOW_MINUTES * 0.3)))).toBeNull()
  })

  it('does NOT alert exactly at the 25% threshold (must be strictly below)', () => {
    expect(detectCliff(buckets(70, 70 * RECENT_WINDOW_MINUTES * 0.25))).toBeNull()
  })

  it(`skips workflows with baseline below ${MIN_BASELINE_PER_MIN}/min (low-volume noise floor)`, () => {
    // baseline 5/min, recent 0 — would otherwise be a 100% drop
    expect(detectCliff(buckets(5, 0))).toBeNull()
  })

  it('uses median, not mean — robust to bursts', () => {
    // 54 minutes of 70/min, one burst of 1000, 5 minutes of 0
    const arr = new Array(60).fill(70)
    arr[0] = 1000  // outlier
    for (let i = 55; i < 60; i++) arr[i] = 0
    const result = detectCliff(arr)
    expect(result).not.toBeNull()
    expect(result!.baselinePerMin).toBe(70)  // median, not 88.7 mean
  })

  it('returns null when array length is wrong', () => {
    expect(detectCliff(new Array(30).fill(50))).toBeNull()
  })

  it('handles empty baseline correctly (median 0 → skipped)', () => {
    expect(detectCliff(new Array(60).fill(0))).toBeNull()
  })

  it('respects custom thresholds via parameters', () => {
    // baseline 70 → expected 280 in 4 min; recent 150 (~54% of expected).
    // default threshold 25% (= 70) → no alert
    expect(detectCliff(buckets(70, 150))).toBeNull()
    // bump threshold to 60% (= 168) — same data (150 < 168) should now alert
    expect(detectCliff(buckets(70, 150), 60)).not.toBeNull()
  })
})

describe('sendCliffAlert channel (#110)', () => {
  const cliff = { workflow_id: 'wf-1', workflow_name: 'Main Flow', organization_id: 'org-1', recent_count: 2, baseline_per_min: 20 }
  const selfCheck = { ok: true, status: 200, latency_ms: 10, error: null, database: { ok: true, latency_ms: 5, error: null } }

  it('posts to the channel it is given (the per-workflow override), not a hardcoded default', async () => {
    await sendCliffAlert({ bot_token: 'xoxb' }, '#leadflow-overrides', cliff, 'https://app.test', selfCheck)
    expect(vi.mocked(postMessage)).toHaveBeenCalledWith('xoxb', '#leadflow-overrides', expect.anything(), expect.any(String))
  })
})

// ── Recovery all-clear, driven through the real check (#253) ────────────────
//
// The decision logic is unit-tested in alert-recovery.test.ts. These drive
// runVolumeCliffCheck itself, because a recovery path that is written but never
// reached is exactly the failure this change exists to prevent (LESSONS L3:
// built is not wired). Nothing in this file exercised runVolumeCliffCheck before.
describe('runVolumeCliffCheck recovery (#253)', () => {
  const ORG = 'org-1'
  const WF = 'wf-1'
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1', volume_alerts_enabled: true }

  function fakeKv(seed: Record<string, string> = {}) {
    const store = new Map(Object.entries(seed))
    return {
      store,
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
      delete: (k: string) => { store.delete(k); return Promise.resolve() },
    }
  }

  /** Supabase double: one Slack-connected org with one active workflow. */
  function fakeSupabase(perMinute: { minute: string; cnt: number }[]) {
    const from = (table: string) => {
      const rows =
        table === 'service_connections'
          ? [{ organization_id: ORG, config: { bot_token: CONN.bot_token, default_channel: CONN.default_channel } }]
          : [{ id: WF, name: 'Main Flow', organization_id: ORG, slack_channel: null }]
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        is: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: rows, error: null }),
      }
      return builder
    }
    return {
      from,
      rpc: () => Promise.resolve({ data: perMinute.map((m) => ({ workflow_id: WF, ...m })), error: null }),
    } as unknown as Parameters<typeof runVolumeCliffCheck>[0]
  }

  /** 60 steady minutes, so detectCliff finds nothing and the run is healthy. */
  const healthyMinutes = () => {
    const base = Math.floor(Date.now() / 60000) * 60000 - 59 * 60000
    return Array.from({ length: 60 }, (_, i) => ({ minute: new Date(base + i * 60000).toISOString(), cnt: 50 }))
  }

  const run = (kv: ReturnType<typeof fakeKv>) =>
    runVolumeCliffCheck(fakeSupabase(healthyMinutes()), kv, 'https://app.example', 'https://self.example', TEST_KEY)

  beforeEach(() => {
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(sendRecoveryAlert).mockReset()
  })

  it('announces the all-clear when a previously alerted workflow is healthy again', async () => {
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const alertedAt = new Date(Date.now() - 45 * 60000).toISOString()
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': alertedAt, 'volume-cliff:wf-1:cooldown': '1' })

    await run(kv)

    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({
      signal: 'volume cliff',
      subject: 'Main Flow',
      alertedAt,
    })
    // Both keys cleared, so the next genuine cliff pages at once rather than
    // waiting out a cooldown left over from the incident that just ended.
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(false)
    expect(kv.store.has('volume-cliff:wf-1:cooldown')).toBe(false)
  })

  it('resets the reminder schedule when the cliff clears, so the next one starts over (#1337)', async () => {
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': new Date(Date.now() - 45 * 60000).toISOString(),
      'volume-cliff:wf-1:cooldown': '1',
      'volume-cliff:wf-1:condition': '{"since":"2026-09-13T12:00:00.000Z","alerts":3}',
    })
    await run(kv)
    // The standing reminder record is cleared, so a fresh cliff starts at the short
    // first interval rather than the daily one this incident had backed off to.
    expect(kv.store.has('volume-cliff:wf-1:condition')).toBe(false)
  })

  it('passes the recent window to the cliff all-clear so a one-tick cliff is not reported as a tick gap (#1108)', async () => {
    // The cliff check judges the trailing RECENT_WINDOW_MINUTES (4), so its
    // notice names the window it measured rather than the gap between ticks.
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const alertedAt = new Date(Date.now() - 45 * 60000).toISOString()
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': alertedAt, 'volume-cliff:wf-1:cooldown': '1' })

    await run(kv)

    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ measuredWindowMinutes: 4 })
  })

  it('HOLDS the all-clear when the baseline itself has collapsed, since a dead pipe is not a recovery (#817)', async () => {
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const alertedAt = new Date(Date.now() - 45 * 60000).toISOString()
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': alertedAt, 'volume-cliff:wf-1:cooldown': '1' })
    // Every minute near zero: the baseline is below MIN_BASELINE_PER_MIN, so
    // detectCliff finds no cliff, but this is a workflow that went quiet, not one
    // whose volume returned. The all-clear must be held, not sent.
    const base = Math.floor(Date.now() / 60000) * 60000 - 59 * 60000
    const quiet = Array.from({ length: 60 }, (_, i) => ({ minute: new Date(base + i * 60000).toISOString(), cnt: 2 }))
    await runVolumeCliffCheck(fakeSupabase(quiet), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })

  it('announces once recent volume returns, even while the baseline still reflects the outage (#817)', async () => {
    // After an outage of half an hour or more, the 55-minute baseline median
    // stays near zero long after traffic is back, so recovery must be judged on
    // the recent window, not the contaminated baseline. Here the first 55 minutes
    // are the outage and the last few carry full volume again.
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const alertedAt = new Date(Date.now() - 45 * 60000).toISOString()
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': alertedAt, 'volume-cliff:wf-1:cooldown': '1' })
    const base = Math.floor(Date.now() / 60000) * 60000 - 59 * 60000
    const returned = Array.from({ length: 60 }, (_, i) => ({
      minute: new Date(base + i * 60000).toISOString(),
      cnt: i < 55 ? 2 : 50,
    }))
    await runVolumeCliffCheck(fakeSupabase(returned), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(false)
  })

  it('stays silent on a healthy workflow that was never alerted', async () => {
    await run(fakeKv())
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
  })

  it('keeps both keys when the all-clear is refused, so it retries', async () => {
    // Slack answers HTTP 200 with ok:false for a kicked bot, which the sender
    // reports as false. Treating that as delivered would drop the all-clear and
    // leave the page as the last word.
    vi.mocked(sendRecoveryAlert).mockResolvedValue(false)
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': new Date(Date.now() - 45 * 60000).toISOString(),
      'volume-cliff:wf-1:cooldown': '1',
    })

    await run(kv)

    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
    expect(kv.store.has('volume-cliff:wf-1:cooldown')).toBe(true)
  })

  it('stamps the running end on a tick where the cliff is live (#814)', async () => {
    // Written on EVERY cliff tick, not only where it pages, or the incident's
    // end would be recorded at the cooldown's cadence instead of the failures'.
    const base = Math.floor(Date.now() / 60000) * 60000 - 59 * 60000
    const cliffMinutes = Array.from({ length: 60 }, (_, i) => ({
      minute: new Date(base + i * 60000).toISOString(),
      cnt: i < BASELINE_WINDOW_MINUTES ? 50 : 0,
    }))
    const kv = fakeKv({ 'volume-cliff:wf-1:cooldown': '1' }) // already paged, still spiking
    await runVolumeCliffCheck(fakeSupabase(cliffMinutes), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(kv.store.has('volume-cliff-active:wf-1')).toBe(true)
  })

  it('HOLDS the all-clear while the cliff was seen inside the re-arm window (#814)', async () => {
    // One quiet tick is not an ended incident. Before #814 this announced, and a
    // relapse minutes later was reported as a brand new short outage.
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': new Date(Date.now() - 45 * 60000).toISOString(),
      'volume-cliff-active:wf-1': new Date(Date.now() - 10 * 60000).toISOString(),
    })

    await run(kv)

    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })

  it('reports the end as the last cliff, not the announcement time (#814)', async () => {
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const endedAt = new Date(Date.now() - 40 * 60000).toISOString()
    const kv = fakeKv({
      'volume-cliff-recovery:wf-1': new Date(Date.now() - 90 * 60000).toISOString(),
      'volume-cliff-active:wf-1': endedAt,
    })

    await run(kv)

    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ endedAt })
  })

  it('sends nothing when the org opted out of volume alerts', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue({ ...CONN, volume_alerts_enabled: false } as never)
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    const kv = fakeKv({ 'volume-cliff-recovery:wf-1': new Date().toISOString() })

    await run(kv)

    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(kv.store.has('volume-cliff-recovery:wf-1')).toBe(true)
  })
})

// ── A failed read is visible, not silence (#439) ─────────────────────────────
//
// The Slack-connection lookup is the worst shape: on a failed read the org list
// is empty, the check returns early, and every alert it owns silently does not
// run for that tick. Driving the real check, because the whole point is that the
// blind spot was invisible from inside the code.
describe('runVolumeCliffCheck logs a failed read (#439)', () => {
  function erroringSupabase() {
    return {
      from: () => {
        const chain: unknown = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              return (res: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { message: 'connection reset by peer', code: '08006' } }).then(res)
            }
            return () => chain
          },
        })
        return chain
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as unknown as Parameters<typeof runVolumeCliffCheck>[0]
  }

  it('says the read failed rather than returning quietly', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = { get: async () => null, put: async () => {}, delete: async () => {} }

    await runVolumeCliffCheck(erroringSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)

    const lines = spy.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('slack connections') && l.includes('connection reset by peer'))).toBe(true)
    spy.mockRestore()
  })
})

// ── The check can speak while the database is down (#1297) ───────────────────
//
// On 2026-09-10 Supabase was unresponsive for ten minutes. This check counts
// executions in that database and looks up the Slack token there too, so it
// said nothing until the database came back, then blamed the caller. It now
// keeps an encrypted last-good copy of the Slack connections in KV, posts a
// "cannot read the database" alert from that copy when its own reads fail, and
// the self-check probes the database beside the worker.
describe('runVolumeCliffCheck during a database outage (#1297)', () => {
  const ORG = 'org-1'
  const WF = 'wf-1'
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1', volume_alerts_enabled: true }

  function fakeKv(seed: Record<string, string> = {}) {
    const store = new Map(Object.entries(seed))
    return {
      store,
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
      delete: (k: string) => { store.delete(k); return Promise.resolve() },
    }
  }

  /** Tables read fine; the per-minute RPC fails the way a dead database fails. */
  function rpcDownSupabase() {
    const from = (table: string) => {
      const rows =
        table === 'service_connections'
          ? [{ organization_id: ORG, config: { bot_token: CONN.bot_token, default_channel: CONN.default_channel } }]
          : [{ id: WF, name: 'Main Flow', organization_id: ORG, slack_channel: null }]
      const builder: Record<string, unknown> = {
        select: () => builder, eq: () => builder, in: () => builder, is: () => builder, limit: () => builder, abortSignal: () => builder,
        then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: rows, error: null }),
      }
      return builder
    }
    return {
      from,
      rpc: () => Promise.resolve({ data: null, error: { message: 'connection refused', code: '08006' } }),
    } as unknown as Parameters<typeof runVolumeCliffCheck>[0]
  }

  /** Every read fails: the shape of the 22:30 to 22:40 window. */
  function allDownSupabase() {
    const chain: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'connection refused', code: '08006' } }).then(res)
        }
        return () => chain
      },
    })
    return {
      from: () => chain,
      rpc: () => Promise.resolve({ data: null, error: { message: 'connection refused', code: '08006' } }),
    } as unknown as Parameters<typeof runVolumeCliffCheck>[0]
  }

  function healthySupabase() {
    const base = Math.floor(Date.now() / 60000) * 60000 - 59 * 60000
    const minutes = Array.from({ length: 60 }, (_, i) => ({ minute: new Date(base + i * 60000).toISOString(), cnt: 50 }))
    const from = (table: string) => {
      const rows =
        table === 'service_connections'
          ? [{ organization_id: ORG, config: { bot_token: CONN.bot_token, default_channel: CONN.default_channel } }]
          : [{ id: WF, name: 'Main Flow', organization_id: ORG, slack_channel: null }]
      const builder: Record<string, unknown> = {
        select: () => builder, eq: () => builder, in: () => builder, is: () => builder, limit: () => builder, abortSignal: () => builder,
        then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: rows, error: null }),
      }
      return builder
    }
    return {
      from,
      rpc: () => Promise.resolve({ data: minutes.map((m) => ({ workflow_id: WF, ...m })), error: null }),
    } as unknown as Parameters<typeof runVolumeCliffCheck>[0]
  }

  const lastGood = () => encryptSecret(JSON.stringify({ [ORG]: CONN }), TEST_KEY)
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(sendDatabaseUnreachableAlert).mockReset().mockResolvedValue('ts-db')
    vi.mocked(sendRecoveryAlert).mockReset().mockResolvedValue(true)
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
  })
  afterEach(() => errSpy.mockRestore())

  it('writes an encrypted last-good copy of the Slack connections on a healthy tick', async () => {
    const kv = fakeKv()
    await runVolumeCliffCheck(healthySupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    const raw = kv.store.get(SLACK_CONNS_LASTGOOD_KEY)
    expect(raw).toBeDefined()
    expect(raw).not.toContain('xoxb')
    const copy = JSON.parse(await decryptSecret(raw!, TEST_KEY)) as Record<string, { bot_token: string }>
    expect(copy[ORG].bot_token).toBe('xoxb-t')
  })

  it('posts a database unreachable alert from the last-good copy when every read fails', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await lastGood() })
    await runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
    const [slack, channel, payload] = vi.mocked(sendDatabaseUnreachableAlert).mock.calls[0]
    expect(slack.bot_token).toBe('xoxb-t')
    expect(channel).toBe('C1')
    expect(payload.error).toContain('connection refused')
    expect(kv.store.has(recoveryKey(DB_UNREACHABLE_PREFIX, ORG))).toBe(true)
  })

  it('posts it when only the per-minute count fails, too', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await lastGood() })
    await runVolumeCliffCheck(rpcDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
  })

  it('does not repeat the alert inside the cooldown', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await lastGood() })
    await runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    await runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
  })

  it('keeps the recovery window longer than the longest reminder step, so an ongoing incident never expires mid-way (#1337)', async () => {
    // The volume condition TTL is the recovery window, refreshed on each post. The
    // longest gap between posts is the last backoff step, so the window must exceed
    // it or a standing incident's condition could lapse between two reminders and
    // the next would restart the schedule. The comment at VOLUME_CONDITION_TTL_SECONDS
    // asserts this; here it is checked.
    expect(RECOVERY_TTL_SECONDS).toBeGreaterThan(BACKOFF_STEPS_SECONDS[BACKOFF_STEPS_SECONDS.length - 1])
  })

  it('caps the condition TTL to the recovery window, so a held all-clear cannot leave it stale (#1337)', async () => {
    // When the pipe goes dead the all-clear is held (#817) and the recovery marker
    // expires after RECOVERY_TTL_SECONDS. The reminder condition must not outlive
    // it, or a future unrelated outage reads as a reminder of this one.
    const ttls = new Map<string, number | undefined>()
    const store = new Map<string, string>([[SLACK_CONNS_LASTGOOD_KEY, await lastGood()]])
    const kv = {
      store,
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      put: (k: string, v: string, opts?: { expirationTtl?: number }) => { store.set(k, v); ttls.set(k, opts?.expirationTtl); return Promise.resolve() },
      delete: (k: string) => { store.delete(k); return Promise.resolve() },
    }
    await runVolumeCliffCheck(allDownSupabase(), kv as never, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(ttls.get(`${DB_UNREACHABLE_PREFIX}:${ORG}:condition`)).toBe(RECOVERY_TTL_SECONDS)
  })

  it('escalates to a reminder once the cooldown lapses (#1337)', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await lastGood() })
    await runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(vi.mocked(sendDatabaseUnreachableAlert).mock.calls[0][2].repeat).toBeUndefined()

    // The 15-minute first interval elapses; the database is still unreadable.
    kv.store.delete(`${DB_UNREACHABLE_PREFIX}:${ORG}:cooldown`)
    await runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendDatabaseUnreachableAlert).mock.calls[1][2].repeat).toContain('reminder 2')
  })

  it('says it cannot alert, rather than nothing, when no last-good copy exists', async () => {
    const kv = fakeKv()
    await runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendDatabaseUnreachableAlert).not.toHaveBeenCalled()
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('no last-good Slack connection'))).toBe(true)
  })

  it('announces the all-clear once the database reads again', async () => {
    const kv = fakeKv({
      [recoveryKey(DB_UNREACHABLE_PREFIX, ORG)]: new Date(Date.now() - 45 * 60000).toISOString(),
      [`${DB_UNREACHABLE_PREFIX}-active:${ORG}`]: new Date(Date.now() - 40 * 60000).toISOString(),
    })
    await runVolumeCliffCheck(healthySupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ signal: 'database unreachable' })
    expect(kv.store.has(recoveryKey(DB_UNREACHABLE_PREFIX, ORG))).toBe(false)
  })

  it('resets the reminder schedule when the database reads again (#1337)', async () => {
    const kv = fakeKv({
      [recoveryKey(DB_UNREACHABLE_PREFIX, ORG)]: new Date(Date.now() - 45 * 60000).toISOString(),
      [`${DB_UNREACHABLE_PREFIX}-active:${ORG}`]: new Date(Date.now() - 40 * 60000).toISOString(),
      [`${DB_UNREACHABLE_PREFIX}:${ORG}:condition`]: '{"since":"2026-09-13T12:00:00.000Z","alerts":3}',
      [`${DB_UNREACHABLE_PREFIX}:${ORG}:cooldown`]: '1',
    })
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
    await runVolumeCliffCheck(healthySupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(kv.store.has(`${DB_UNREACHABLE_PREFIX}:${ORG}:condition`)).toBe(false)
  })
})

describe('the cliff alert reports what the self-check measured (#1297)', () => {
  const cliff = { workflow_id: 'wf-1', workflow_name: 'Main Flow', organization_id: 'org-1', recent_count: 0, baseline_per_min: 81 }
  const text = () => JSON.stringify(vi.mocked(postMessage).mock.calls.at(-1)?.[2])

  beforeEach(() => vi.mocked(postMessage).mockClear())

  it('names a failed database probe and does not blame the caller', async () => {
    await sendCliffAlert({ bot_token: 'x' }, 'C1', cliff, 'https://app', {
      ok: true, status: 403, latency_ms: 53, error: null,
      database: { ok: false, latency_ms: 5001, error: 'AbortError: timed out' },
    })
    expect(text()).toContain('Database read FAILED')
    expect(text()).not.toContain("upstream caller isn't sending")
  })

  it('reports both ends answering when both probes pass', async () => {
    await sendCliffAlert({ bot_token: 'x' }, 'C1', cliff, 'https://app', {
      ok: true, status: 403, latency_ms: 53, error: null,
      database: { ok: true, latency_ms: 120, error: null },
    })
    expect(text()).toContain('Database readable')
    expect(text()).toContain('Worker reachable')
  })
})

// ── One post per alert, however many ticks arrive together (#1298) ───────────
//
// The KV cooldown is a get and, after the post, a put. Two ticks released at the
// same instant both read nothing and both post: every cliff alert on 2026-09-10
// arrived twice. The claim is asked between the cooldown and the post, and only
// the tick it answers yes to may post.
describe('runVolumeCliffCheck posts once per claim (#1298)', () => {
  const ORG = 'org-1'
  const WF = 'wf-1'
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1', volume_alerts_enabled: true }

  function fakeKv() {
    const store = new Map<string, string>()
    return {
      store,
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
      delete: (k: string) => { store.delete(k); return Promise.resolve() },
    }
  }

  /** A claim ledger: the first caller per key wins until released. */
  function fakeClaims() {
    const held = new Set<string>()
    const calls: string[] = []
    const claims: AlertClaims = {
      claim: async (key) => { calls.push(`claim ${key}`); if (held.has(key)) return false; held.add(key); return true },
      release: async (key) => { calls.push(`release ${key}`); held.delete(key) },
    }
    return { claims, calls, held }
  }

  function cliffSupabase() {
    const base = Math.floor(Date.now() / 60000) * 60000 - 59 * 60000
    const minutes = Array.from({ length: 60 }, (_, i) => ({
      minute: new Date(base + i * 60000).toISOString(),
      cnt: i < BASELINE_WINDOW_MINUTES ? 50 : 0,
    }))
    const from = (table: string) => {
      const rows =
        table === 'service_connections'
          ? [{ organization_id: ORG, config: { bot_token: CONN.bot_token, default_channel: CONN.default_channel } }]
          : [{ id: WF, name: 'Main Flow', organization_id: ORG, slack_channel: null }]
      const builder: Record<string, unknown> = {
        select: () => builder, eq: () => builder, in: () => builder, is: () => builder, limit: () => builder, abortSignal: () => builder,
        then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: rows, error: null }),
      }
      return builder
    }
    return {
      from,
      rpc: () => Promise.resolve({ data: minutes.map((m) => ({ workflow_id: WF, ...m })), error: null }),
    } as unknown as Parameters<typeof runVolumeCliffCheck>[0]
  }

  function allDownSupabase() {
    const chain: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'connection refused', code: '08006' } }).then(res)
        }
        return () => chain
      },
    })
    return {
      from: () => chain,
      rpc: () => Promise.resolve({ data: null, error: { message: 'connection refused', code: '08006' } }),
    } as unknown as Parameters<typeof runVolumeCliffCheck>[0]
  }

  // The post resolves on the next macrotask, so both ticks reach the cooldown
  // gate before either has written the cooldown key. That is the 22:40 shape:
  // two checks released by the database returning at the same instant.
  const slowPost = <T,>(value: T) => () => new Promise<T>((resolve) => setTimeout(() => resolve(value), 0))

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(postMessage).mockReset().mockImplementation(slowPost('ts-1'))
    vi.mocked(sendDatabaseUnreachableAlert).mockReset().mockImplementation(slowPost('ts-db'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('control: without a claim the same two ticks post twice, so the fixture really races', async () => {
    const kv = fakeKv()
    await Promise.all([
      runVolumeCliffCheck(cliffSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY),
      runVolumeCliffCheck(cliffSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY),
    ])
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('posts the cliff once when two ticks pass the cooldown together', async () => {
    const kv = fakeKv()
    const { claims } = fakeClaims()
    await Promise.all([
      runVolumeCliffCheck(cliffSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY, claims),
      runVolumeCliffCheck(cliffSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY, claims),
    ])
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(kv.store.has('volume-cliff:wf-1:cooldown')).toBe(true)
  })

  it('escalates a standing cliff to a reminder once the cooldown lapses (#1337)', async () => {
    const kv = fakeKv()
    await runVolumeCliffCheck(cliffSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(postMessage).mock.calls[0][2])).not.toContain('reminder')

    // The cooldown interval elapses; the cliff still stands.
    kv.store.delete('volume-cliff:wf-1:cooldown')
    await runVolumeCliffCheck(cliffSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(postMessage).mock.calls[1][2])).toContain('reminder 2')
  })

  it('releases the claim when Slack refuses the post, so the next tick can retry', async () => {
    vi.mocked(postMessage).mockResolvedValue(null)
    const kv = fakeKv()
    const { claims, calls, held } = fakeClaims()
    await runVolumeCliffCheck(cliffSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY, claims)
    expect(calls).toEqual(['claim volume-cliff:wf-1', 'release volume-cliff:wf-1'])
    expect(held.size).toBe(0)
    expect(kv.store.has('volume-cliff:wf-1:cooldown')).toBe(false)
  })

  it('posts the database unreachable alert once when two ticks find the database down together', async () => {
    const kv = fakeKv()
    kv.store.set(SLACK_CONNS_LASTGOOD_KEY, await encryptSecret(JSON.stringify({ [ORG]: CONN }), TEST_KEY))
    const { claims } = fakeClaims()
    await Promise.all([
      runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY, claims),
      runVolumeCliffCheck(allDownSupabase(), kv, 'https://app.example', 'https://self.example', TEST_KEY, claims),
    ])
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
  })
})
