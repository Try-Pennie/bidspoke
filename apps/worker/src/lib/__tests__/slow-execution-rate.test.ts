/**
 * Aggregated slow-execution-spike detection — covers the count floor, the
 * fraction gate, and their interaction. Supabase + KV + Slack integration lives
 * in `runSlowExecutionCheck`; pure logic is tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({
  sendSlowSpikeAlert: vi.fn().mockResolvedValue('ts-1'),
  getSlackConnection: vi.fn(),
  sendRecoveryAlert: vi.fn(),
}))
import { detectSlowSpike, buildSlowDurations, runSlowExecutionCheck, MIN_SLOW_COUNT, SLOW_FRACTION_PCT } from '../slow-execution-rate'
import { getSlackConnection, sendRecoveryAlert, sendSlowSpikeAlert } from '../slack'
import { transitions, withTickingClock } from './_incident-events'
import { claimLedger, gate, settle } from './_claims-double'

const THRESHOLD = 5000 // 5s

// n runs at `ms`, padded with `fastCount` runs well under threshold.
function runs(slowCount: number, slowMs: number, fastCount: number): number[] {
  return [
    ...new Array(slowCount).fill(slowMs),
    ...new Array(fastCount).fill(100),
  ]
}

describe('detectSlowSpike()', () => {
  it('returns null when no runs are slow', () => {
    expect(detectSlowSpike(runs(0, 0, 50), THRESHOLD)).toBeNull()
  })

  it('returns null when threshold is unset (0)', () => {
    expect(detectSlowSpike(runs(20, 9000, 0), 0)).toBeNull()
  })

  it('returns null on an empty window', () => {
    expect(detectSlowSpike([], THRESHOLD)).toBeNull()
  })

  it('fires when slow runs meet both the count floor and the fraction', () => {
    // 6 slow of 8 = 75% — over 50% and over the 5-count floor.
    const result = detectSlowSpike(runs(6, 9000, 2), THRESHOLD)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(6)
    expect(result!.totalCount).toBe(8)
    expect(result!.slowestMs).toBe(9000)
  })

  it('does NOT fire on a tiny sample below the count floor (3 of 4)', () => {
    // 75% slow, but only 3 slow runs — under MIN_SLOW_COUNT.
    expect(MIN_SLOW_COUNT).toBeGreaterThan(3)
    expect(detectSlowSpike(runs(3, 9000, 1), THRESHOLD)).toBeNull()
  })

  it('does NOT fire on a steady trickle on a busy workflow (6 of 3000)', () => {
    // Meets the count floor (6 ≥ 5) but only 0.2% — under the fraction gate.
    expect(detectSlowSpike(runs(6, 9000, 2994), THRESHOLD)).toBeNull()
  })

  it('fires exactly at the count floor when the fraction also passes', () => {
    // MIN_SLOW_COUNT slow of (MIN_SLOW_COUNT * 2) = exactly 50%.
    const total = MIN_SLOW_COUNT * 2
    const result = detectSlowSpike(runs(MIN_SLOW_COUNT, 9000, total - MIN_SLOW_COUNT), THRESHOLD)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(MIN_SLOW_COUNT)
  })

  it('does NOT fire just below the fraction gate', () => {
    // 5 slow of 11 = 45.5% — over the count floor, under 50%.
    expect(SLOW_FRACTION_PCT).toBe(50)
    expect(detectSlowSpike(runs(5, 9000, 6), THRESHOLD)).toBeNull()
  })

  it('treats a run exactly at the threshold as NOT slow (strict >)', () => {
    // All 10 runs sit exactly at the threshold — none exceed it.
    expect(detectSlowSpike(new Array(10).fill(THRESHOLD), THRESHOLD)).toBeNull()
  })

  it('reports median and slowest of the slow set only', () => {
    const result = detectSlowSpike([6000, 8000, 10000, 12000, 14000, 100], THRESHOLD)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(5)
    expect(result!.slowestMs).toBe(14000)
    expect(result!.medianSlowMs).toBe(10000) // middle of [6,8,10,12,14]k
  })

  it('honors custom floor and fraction overrides', () => {
    // 2 slow of 10 = 20%; passes with floor=2, fraction=10.
    const result = detectSlowSpike(runs(2, 9000, 8), THRESHOLD, 2, 10)
    expect(result).not.toBeNull()
    expect(result!.slowCount).toBe(2)
  })
})

// Issue #83: the monitor was blind to runs longer than its 5-min window (they
// leave the started_at window before completing). buildSlowDurations combines
// completed-in-window runs with the ongoing duration of in-flight runs, so a
// live hang is counted before it finishes.
describe('buildSlowDurations()', () => {
  const NOW = 1_000_000_000

  it('uses each completed run\'s final duration_ms', () => {
    const per = buildSlowDurations(
      [{ workflow_id: 'wf', duration_ms: 8000 }, { workflow_id: 'wf', duration_ms: 200 }],
      [],
      ['wf'],
      NOW,
    )
    expect(per.get('wf')).toEqual([8000, 200])
  })

  it('counts an in-flight run\'s ongoing duration (now - started_at)', () => {
    const startedAt = new Date(NOW - 8000).toISOString() // running for 8s
    const per = buildSlowDurations([], [{ workflow_id: 'wf', started_at: startedAt }], ['wf'], NOW)
    expect(per.get('wf')).toEqual([8000])
  })

  it('ignores rows for workflows that are not monitored', () => {
    const per = buildSlowDurations(
      [{ workflow_id: 'other', duration_ms: 9000 }],
      [{ workflow_id: 'other', started_at: new Date(NOW - 9000).toISOString() }],
      ['wf'],
      NOW,
    )
    expect(per.get('wf')).toEqual([])
    expect(per.has('other')).toBe(false)
  })

  it('a cluster of in-flight runs past the threshold fires a spike before any finishes', () => {
    // 5 runs each hung for 8s (> 5s threshold), none completed yet.
    const startedAt = new Date(NOW - 8000).toISOString()
    const running = Array.from({ length: 5 }, () => ({ workflow_id: 'wf', started_at: startedAt }))
    const per = buildSlowDurations([], running, ['wf'], NOW)
    const spike = detectSlowSpike(per.get('wf')!, THRESHOLD)
    expect(spike).not.toBeNull()
    expect(spike!.slowCount).toBe(5)
    expect(spike!.totalCount).toBe(5)
  })

  it('a fresh in-flight run (under threshold) counts toward total but not slow', () => {
    const per = buildSlowDurations(
      [],
      [
        ...Array.from({ length: 5 }, () => ({ workflow_id: 'wf', started_at: new Date(NOW - 8000).toISOString() })), // slow
        { workflow_id: 'wf', started_at: new Date(NOW - 100).toISOString() }, // just started
      ],
      ['wf'],
      NOW,
    )
    const spike = detectSlowSpike(per.get('wf')!, THRESHOLD)
    expect(spike!.slowCount).toBe(5)
    expect(spike!.totalCount).toBe(6)
  })
})

// ── Recovery all-clear (#253) ────────────────────────────────────────────────
//
// The first tests in this file to drive runSlowExecutionCheck itself. A recovery
// path that is written but never reached is the failure this change exists to
// prevent (LESSONS L3: built is not wired).
describe('runSlowExecutionCheck recovery (#253)', () => {
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1' }

  function makeKv(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial))
    return {
      store: m,
      get: vi.fn(async (k: string) => m.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
      delete: vi.fn(async (k: string) => { m.delete(k) }),
    }
  }

  /** Chainable Supabase double; awaiting any chain resolves the table's rows. */
  function makeSupabase(tables: Record<string, unknown[]>) {
    return {
      from: (table: string) => {
        const data = tables[table] ?? []
        const chain: unknown = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res)
            return () => chain
          },
        })
        return chain
      },
    }
  }

  const wf = {
    id: 'wf-1',
    name: 'Engine Bidding',
    organization_id: 'org-1',
    slack_channel: null,
    definition: { trigger: { type: 'http_webhook', config: { duration_alert_ms: THRESHOLD } } },
  }

  /**
   * A genuine recovery: enough fast runs that detectSlowSpike finds no spike AND
   * there is real evidence the pipe is alive (#817). Each row is read as both a
   * completed run (duration_ms) and an in-flight one (started_at) by the double,
   * which only adds more fast runs, so the window is well over MIN_SLOW_COUNT and
   * none of them is slow.
   */
  const healthy = () =>
    makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: new Array(MIN_SLOW_COUNT + 3)
        .fill(0)
        .map(() => ({ workflow_id: 'wf-1', duration_ms: 100, started_at: new Date(Date.now() - 1000).toISOString() })),
    })

  /** A workflow that went quiet: no runs in the window, so nothing to judge (#817). */
  const quiet = () =>
    makeSupabase({ service_connections: [{ organization_id: 'org-1' }], workflows: [wf], workflow_executions: [] })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
  })

  // A stalled tick overlapping the next minute's (#2062): each tick is held at
  // its post while the other reaches the same point (L157).
  describe('posts once across overlapping ticks (#2062)', () => {
    const url = 'https://app.example.com'
    const spiking = () =>
      makeSupabase({
        service_connections: [{ organization_id: 'org-1' }],
        workflows: [wf],
        workflow_executions: new Array(MIN_SLOW_COUNT + 3)
          .fill(0)
          .map(() => ({ workflow_id: 'wf-1', duration_ms: THRESHOLD * 4, started_at: new Date(Date.now() - 1000).toISOString() })),
      })
    const owed = () => makeKv({ 'slow-spike-recovery:wf-1': new Date(Date.now() - 90 * 60_000).toISOString() })

    async function overlap(run: () => Promise<void>, open: () => void) {
      const a = run()
      await settle()
      const b = run()
      await settle()
      open()
      await Promise.all([a, b])
    }

    it('control: with no claim the two ticks page twice, so the fixture really overlaps', async () => {
      const held = gate<string>()
      vi.mocked(sendSlowSpikeAlert).mockImplementationOnce(() => held.promise).mockImplementationOnce(() => held.promise)
      const kv = makeKv()
      await overlap(() => runSlowExecutionCheck(spiking() as never, kv as never, url), () => held.open('ts-1'))
      expect(sendSlowSpikeAlert).toHaveBeenCalledTimes(2)
    })

    it('pages once, under the minute page claim', async () => {
      const held = gate<string>()
      vi.mocked(sendSlowSpikeAlert).mockImplementationOnce(() => held.promise).mockImplementationOnce(() => held.promise)
      const kv = makeKv()
      const { claims, log } = claimLedger()
      await overlap(() => runSlowExecutionCheck(spiking() as never, kv as never, url, claims), () => held.open('ts-1'))
      expect(sendSlowSpikeAlert).toHaveBeenCalledTimes(1)
      expect(log).toEqual(['claim minute-alert:page:slow-spike:wf-1', 'claim minute-alert:page:slow-spike:wf-1'])
    })

    it('control: with no claim the two ticks send the all-clear twice', async () => {
      const held = gate<boolean>()
      vi.mocked(sendRecoveryAlert).mockImplementationOnce(() => held.promise).mockImplementationOnce(() => held.promise)
      const kv = owed()
      await overlap(() => runSlowExecutionCheck(healthy() as never, kv as never, url), () => held.open(true))
      expect(sendRecoveryAlert).toHaveBeenCalledTimes(2)
    })

    it('sends the all-clear once, under the minute all-clear claim', async () => {
      const held = gate<boolean>()
      vi.mocked(sendRecoveryAlert).mockImplementationOnce(() => held.promise).mockImplementationOnce(() => held.promise)
      const kv = owed()
      const { claims, log } = claimLedger()
      await overlap(() => runSlowExecutionCheck(healthy() as never, kv as never, url, claims), () => held.open(true))
      expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
      expect(log).toEqual(['claim minute-alert:all-clear:slow-spike:wf-1', 'claim minute-alert:all-clear:slow-spike:wf-1'])
    })

    it('makes no claim call on a healthy tick with nothing owed', async () => {
      const { claims, log } = claimLedger()
      await runSlowExecutionCheck(healthy() as never, makeKv() as never, url, claims)
      expect(log).toEqual([])
    })
  })

  it('records the opening before the page, on a clock that moves between reads (#2099)', async () => {
    const kv = makeKv()
    // The incident record refuses an organization id that is not a uuid.
    const ORG_ID = '55555555-5555-4555-8555-555555555555'
    const spiking = () =>
      makeSupabase({
        service_connections: [{ organization_id: ORG_ID }],
        workflows: [{ ...wf, organization_id: ORG_ID }],
        workflow_executions: new Array(MIN_SLOW_COUNT + 3)
          .fill(0)
          .map(() => ({ workflow_id: 'wf-1', duration_ms: THRESHOLD * 4, started_at: new Date(Date.now() - 1000).toISOString() })),
      })
    // The opening and the page must share the pass's one clock reading, or the
    // page sorts first.
    await withTickingClock(() => runSlowExecutionCheck(spiking() as never, kv as never, 'https://app.example.com'))
    expect(transitions(kv.store)).toEqual(['opened wf-1', 'paged wf-1'])
  })

  // #2058: a cut, or a cooldown write KV refuses, right after the page must
  // leave the recovery marker in place, so the all-clear is still owed and the
  // next tick pages again rather than staying silent.
  it('keeps the all-clear owed, records opened before paged, and pages again when the cooldown write fails (#2058, #2115)', async () => {
    const kv = makeKv()
    const put = kv.put.getMockImplementation()!
    kv.put.mockImplementation(async (k: string, v: string) => {
      if (k === 'slow-spike-cooldown:wf-1') throw new Error('KV PUT failed: 500 Internal Server Error')
      return put(k, v)
    })
    const ORG_ID = '77777777-7777-4777-8777-777777777777'
    const spiking = () =>
      makeSupabase({
        service_connections: [{ organization_id: ORG_ID }],
        workflows: [{ ...wf, organization_id: ORG_ID }],
        workflow_executions: new Array(MIN_SLOW_COUNT + 3)
          .fill(0)
          .map(() => ({ workflow_id: 'wf-1', duration_ms: THRESHOLD * 4, started_at: new Date(Date.now() - 1000).toISOString() })),
      })
    await withTickingClock(() => runSlowExecutionCheck(spiking() as never, kv as never, 'https://app.example.com').catch(() => undefined))
    expect(sendSlowSpikeAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has('slow-spike-recovery:wf-1')).toBe(true)
    expect(kv.store.has('slow-spike-cooldown:wf-1')).toBe(false)
    expect(transitions(kv.store)).toEqual(['opened wf-1', 'paged wf-1'])
    await runSlowExecutionCheck(spiking() as never, kv as never, 'https://app.example.com').catch(() => undefined)
    expect(sendSlowSpikeAlert).toHaveBeenCalledTimes(2)
  })

  it('announces the all-clear once the workflow is back under threshold', async () => {
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const kv = makeKv({ 'slow-spike-recovery:wf-1': alertedAt, 'slow-spike-cooldown:wf-1': '1' })

    await runSlowExecutionCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({
      signal: 'slow execution',
      subject: 'Engine Bidding',
      alertedAt,
    })
    expect(kv.store.has('slow-spike-recovery:wf-1')).toBe(false)
    expect(kv.store.has('slow-spike-cooldown:wf-1')).toBe(false)
  })

  it('passes the detection window to the all-clear so a one-tick incident is not reported as a tick gap (#1108)', async () => {
    // This check judges the trailing WINDOW_MINUTES (5), so the notice names the
    // window it measured rather than the gap between the ticks it looked.
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const kv = makeKv({ 'slow-spike-recovery:wf-1': alertedAt, 'slow-spike-cooldown:wf-1': '1' })

    await runSlowExecutionCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ measuredWindowMinutes: 5 })
  })

  it('HOLDS the all-clear when the workflow has gone quiet, with no runs to judge (#817)', async () => {
    // Absence of slow runs is not evidence of recovery when there are no runs at
    // all: a dead pipe must not read "back to normal".
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const kv = makeKv({ 'slow-spike-recovery:wf-1': alertedAt, 'slow-spike-cooldown:wf-1': '1' })

    await runSlowExecutionCheck(quiet() as never, kv as never, 'https://app.example.com')

    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(kv.store.has('slow-spike-recovery:wf-1')).toBe(true)
  })

  it('says nothing about a workflow that was never alerted', async () => {
    await runSlowExecutionCheck(healthy() as never, makeKv() as never, 'https://app.example.com')
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
  })

  it('stamps the running end on a tick where the spike is live (#814)', async () => {
    // Written on EVERY spiking tick, not only where it pages, or the incident's
    // end would be recorded at the cooldown's cadence instead of the runs'.
    const slowRows = Array.from({ length: 10 }, () => ({
      workflow_id: 'wf-1',
      duration_ms: THRESHOLD * 2,
      started_at: new Date().toISOString(),
    }))
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: slowRows,
    })
    const kv = makeKv({ 'slow-spike-cooldown:wf-1': '1' }) // already paged, still spiking

    await runSlowExecutionCheck(sb as never, kv as never, 'https://app.example.com')

    expect(kv.store.has('slow-spike-active:wf-1')).toBe(true)
  })

  it('HOLDS the all-clear while the spike was seen inside the re-arm window (#814)', async () => {
    const kv = makeKv({
      'slow-spike-recovery:wf-1': new Date(Date.now() - 90 * 60_000).toISOString(),
      'slow-spike-active:wf-1': new Date(Date.now() - 10 * 60_000).toISOString(),
    })

    await runSlowExecutionCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(kv.store.has('slow-spike-recovery:wf-1')).toBe(true)
  })

  it('reports the end as the last slow run, not the announcement time (#814)', async () => {
    const endedAt = new Date(Date.now() - 40 * 60_000).toISOString()
    const kv = makeKv({
      'slow-spike-recovery:wf-1': new Date(Date.now() - 90 * 60_000).toISOString(),
      'slow-spike-active:wf-1': endedAt,
    })

    await runSlowExecutionCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ endedAt })
  })

  it('keeps both keys when the all-clear is refused, so it retries', async () => {
    vi.mocked(sendRecoveryAlert).mockResolvedValue(false)
    const kv = makeKv({
      'slow-spike-recovery:wf-1': new Date(Date.now() - 90 * 60_000).toISOString(),
      'slow-spike-cooldown:wf-1': '1',
    })

    await runSlowExecutionCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(kv.store.has('slow-spike-recovery:wf-1')).toBe(true)
    expect(kv.store.has('slow-spike-cooldown:wf-1')).toBe(true)
  })
})
