import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { outboxEvents, transitions, withTickingClock } from './_incident-events'
vi.mock('../slack', () => ({
  sendFailureSpikeAlert: vi.fn().mockResolvedValue('ts-1'),
  getSlackConnection: vi.fn(),
  sendRecoveryAlert: vi.fn(),
}))
import { signalMatches, matchesMutedSignal, detectFailureSpike, countWindowMatches, runFailureRateCheck, hasSucceedingRuns } from '../failure-rate'
import type { MutedFailureSignal } from '../failure-rate'
import { getSlackConnection, sendFailureSpikeAlert, sendRecoveryAlert } from '../slack'

const sig = (match: string, count = 10, window_minutes = 5): MutedFailureSignal => ({ match, count, window_minutes })

describe('signalMatches (#248)', () => {
  it('matches a case-insensitive substring of the error message', () => {
    expect(signalMatches('Service Exception... ACRO_GATEWAY HTTP 500', 'acro_gateway')).toBe(true)
    expect(signalMatches('equifax_api_error: upstream 500', 'equifax_api_error')).toBe(true)
  })

  it('does not match an unrelated error', () => {
    expect(signalMatches('Salesforce REQUEST_LIMIT_EXCEEDED', 'ACRO_GATEWAY')).toBe(false)
  })

  it('is false for an empty/missing error message or empty match', () => {
    expect(signalMatches(null, 'ACRO_GATEWAY')).toBe(false)
    expect(signalMatches(undefined, 'ACRO_GATEWAY')).toBe(false)
    expect(signalMatches('', 'ACRO_GATEWAY')).toBe(false)
    expect(signalMatches('some error', '')).toBe(false)
    expect(signalMatches('some error', '   ')).toBe(false)
  })
})

describe('matchesMutedSignal (#248)', () => {
  it('returns the first signal whose match is present in the error', () => {
    const signals = [sig('TIMEOUT'), sig('ACRO_GATEWAY'), sig('500')]
    const hit = matchesMutedSignal('upstream ACRO_GATEWAY failure 500', signals)
    expect(hit?.match).toBe('ACRO_GATEWAY')
  })

  it('returns null when no signal matches', () => {
    expect(matchesMutedSignal('Salesforce governor limit', [sig('ACRO_GATEWAY')])).toBeNull()
  })

  it('returns null for no configured signals or no message', () => {
    expect(matchesMutedSignal('ACRO_GATEWAY', [])).toBeNull()
    expect(matchesMutedSignal(null, [sig('ACRO_GATEWAY')])).toBeNull()
  })
})

describe('countWindowMatches (#248)', () => {
  const acro = sig('ACRO_GATEWAY', 3, 5)
  const t0 = Date.UTC(2026, 5, 22, 12, 0, 0) // window start
  const row = (workflow_id: string, error_message: string | null, minsAfterStart: number) => ({
    workflow_id,
    error_message,
    completed_at: new Date(t0 + minsAfterStart * 60_000).toISOString(),
  })

  it('counts only this workflow’s matching rows inside the window', () => {
    const rows = [
      row('wf-1', 'upstream ACRO_GATEWAY 500', 1),   // match, in window
      row('wf-1', 'ACRO_GATEWAY again', 4),          // match, in window
      row('wf-1', 'some other error', 2),            // no match
      row('wf-2', 'ACRO_GATEWAY elsewhere', 3),      // different workflow
      row('wf-1', 'ACRO_GATEWAY too early', -2),     // before window start
      row('wf-1', null, 1),                          // null message
    ]
    expect(countWindowMatches(rows, 'wf-1', acro, t0)).toBe(2)
  })

  it('returns 0 when nothing matches', () => {
    expect(countWindowMatches([row('wf-1', 'unrelated', 1)], 'wf-1', acro, t0)).toBe(0)
  })
})

describe('detectFailureSpike (#248)', () => {
  it('fires when the count reaches the threshold', () => {
    expect(detectFailureSpike(10, 10)).toBe(true)
    expect(detectFailureSpike(11, 10)).toBe(true)
  })

  it('stays quiet below the threshold', () => {
    expect(detectFailureSpike(9, 10)).toBe(false)
    expect(detectFailureSpike(0, 10)).toBe(false)
  })

  it('is disabled for a non-positive threshold', () => {
    expect(detectFailureSpike(100, 0)).toBe(false)
    expect(detectFailureSpike(100, -1)).toBe(false)
  })
})

// ── hasSucceedingRuns (recovery evidence, #817) ──────────────────────────────
//
// The orchestration tests above run through a chainable Supabase double that
// ignores filters, so they cannot show that the status filter actually excludes
// failed and degraded runs. These drive hasSucceedingRuns directly against a
// double that records its filters and returns a controlled row set.
describe('hasSucceedingRuns (#817)', () => {
  const iso = new Date().toISOString()
  function queryDouble(rows: unknown[] | null, error: { message: string } | null = null) {
    const calls: { in: unknown[][] } = { in: [] }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: (...args: unknown[]) => {
        calls.in.push(args)
        return chain
      },
      gte: () => chain,
      limit: () => chain,
      then: (res: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
        Promise.resolve({ data: rows, error }).then(res),
    }
    return { supabase: { from: () => chain }, calls }
  }

  it('counts only clean terminal runs (status completed or exited), so failed and degraded are excluded', async () => {
    const { supabase, calls } = queryDouble([{ id: '1' }])
    await hasSucceedingRuns(supabase as never, 'wf-1', iso, iso, 1)
    expect(calls.in).toContainEqual(['status', ['completed', 'exited']])
  })

  it('is true once at least `min` succeeding runs come back', async () => {
    const { supabase } = queryDouble([{ id: '1' }, { id: '2' }])
    expect(await hasSucceedingRuns(supabase as never, 'wf-1', iso, iso, 2)).toBe(true)
  })

  it('is false when the window holds no succeeding run (e.g. only failed or degraded, which the query excludes)', async () => {
    const { supabase } = queryDouble([])
    expect(await hasSucceedingRuns(supabase as never, 'wf-1', iso, iso, 1)).toBe(false)
  })

  it('throws on a read error, so the caller holds the all-clear rather than clearing it', async () => {
    const { supabase } = queryDouble(null, { message: 'boom' })
    await expect(hasSucceedingRuns(supabase as never, 'wf-1', iso, iso, 1)).rejects.toThrow(/boom/)
  })

  it('needs no query when the floor is zero', async () => {
    const { supabase, calls } = queryDouble([])
    expect(await hasSucceedingRuns(supabase as never, 'wf-1', iso, iso, 0)).toBe(true)
    expect(calls.in).toHaveLength(0)
  })
})

// ── runFailureRateCheck (cron orchestration) ────────────────────────────────
function makeKv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    store: m,
    get: vi.fn(async (k: string) => m.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
    delete: vi.fn(async (k: string) => { m.delete(k) }),
  }
}

// Minimal chainable Supabase: any builder method returns the same chain; awaiting
// it (or .range()) resolves { data } for the queried table. fetchAllPaged stops
// after one page since fixtures are < the page size.
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
  definition: {
    trigger: { type: 'http_webhook', config: { muted_failure_signals: [{ match: 'ACRO_GATEWAY', count: 3, window_minutes: 5 }] } },
  },
}
const recent = () => new Date(Date.now() - 60_000).toISOString() // 1 min ago, in-window
const failRow = (msg: string | null) => ({ workflow_id: 'wf-1', error_message: msg, completed_at: recent() })
// A succeeding terminal run, the evidence a recovery is real rather than a dead
// pipe (#817). The shared Supabase double returns the same workflow_executions
// array to both the failed query and the succeeding-runs query; these carry no
// error, so they add nothing to the failure count while standing as live traffic.
const okRow = () => ({ workflow_id: 'wf-1', error_message: null, status: 'completed', completed_at: recent(), started_at: recent() })

describe('runFailureRateCheck (#248)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires one aggregated alert and sets a cooldown when matches cross the threshold', async () => {
    const kv = makeKv()
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [
        failRow('Service Exception ACRO_GATEWAY 500'),
        failRow('upstream ACRO_GATEWAY again'),
        failRow('ACRO_GATEWAY third'),
        failRow('unrelated salesforce error'),
      ],
    })
    await runFailureRateCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendFailureSpikeAlert).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendFailureSpikeAlert).mock.calls[0][3]
    expect(payload).toMatchObject({ signal: 'ACRO_GATEWAY', failure_count: 3 })
    expect(kv.store.has('failure-rate-cooldown:wf-1:ACRO_GATEWAY')).toBe(true)
  })

  it('stays quiet below the threshold', async () => {
    const kv = makeKv()
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [failRow('ACRO_GATEWAY one'), failRow('ACRO_GATEWAY two')],
    })
    await runFailureRateCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendFailureSpikeAlert).not.toHaveBeenCalled()
  })

  // #2058: a cut, or a cooldown write KV refuses, right after the page must
  // leave the recovery marker in place, so the all-clear is still owed and the
  // next tick pages again rather than staying silent.
  it('keeps the all-clear owed, records opened before paged, and pages again when the cooldown write fails (#2058, #2115)', async () => {
    const kv = makeKv()
    const put = kv.put.getMockImplementation()!
    kv.put.mockImplementation(async (k: string, v: string) => {
      if (k === 'failure-rate-cooldown:wf-1:ACRO_GATEWAY') throw new Error('KV PUT failed: 500 Internal Server Error')
      return put(k, v)
    })
    const ORG_ID = '66666666-6666-4666-8666-666666666666'
    const spiking = () => makeSupabase({
      service_connections: [{ organization_id: ORG_ID }],
      workflows: [{ ...wf, organization_id: ORG_ID }],
      workflow_executions: [failRow('ACRO_GATEWAY'), failRow('ACRO_GATEWAY'), failRow('ACRO_GATEWAY')],
    })
    await withTickingClock(() => runFailureRateCheck(spiking() as never, kv as never, 'https://app.example.com').catch(() => undefined))
    expect(sendFailureSpikeAlert).toHaveBeenCalledTimes(1)
    expect(kv.store.has('failure-rate-recovery:wf-1:ACRO_GATEWAY')).toBe(true)
    expect(kv.store.has('failure-rate-cooldown:wf-1:ACRO_GATEWAY')).toBe(false)
    expect(transitions(kv.store)).toEqual(['opened wf-1:ACRO_GATEWAY', 'paged wf-1:ACRO_GATEWAY'])
    await runFailureRateCheck(spiking() as never, kv as never, 'https://app.example.com').catch(() => undefined)
    expect(sendFailureSpikeAlert).toHaveBeenCalledTimes(2)
  })

  it('suppresses while the per-signal cooldown is active', async () => {
    const kv = makeKv({ 'failure-rate-cooldown:wf-1:ACRO_GATEWAY': '1' })
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [failRow('ACRO_GATEWAY'), failRow('ACRO_GATEWAY'), failRow('ACRO_GATEWAY')],
    })
    await runFailureRateCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendFailureSpikeAlert).not.toHaveBeenCalled()
  })
})

// ── Recovery all-clear (#253) ────────────────────────────────────────────────
//
// Driven through runFailureRateCheck itself: a recovery path that is written but
// never reached is the failure this change exists to prevent (LESSONS L3).
describe('runFailureRateCheck recovery (#253)', () => {
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1' }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
  })

  // A genuine recovery: the matching failures have stopped AND the workflow is
  // still producing succeeding runs, so there is real evidence the pipe is alive
  // (#817). The evidence floor is one succeeding run; these three are comfortably
  // over it.
  const healthy = () =>
    makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [okRow(), okRow(), okRow()],
    })

  // A dead pipe: no runs at all in the window, so the absence of matching
  // failures is not evidence of recovery, it is evidence of silence.
  const quiet = () =>
    makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [],
    })

  it('announces the all-clear once the signal falls back under threshold', async () => {
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const kv = makeKv({
      'failure-rate-recovery:wf-1:ACRO_GATEWAY': alertedAt,
      'failure-rate-cooldown:wf-1:ACRO_GATEWAY': '1',
    })

    await runFailureRateCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ subject: 'Engine Bidding', alertedAt })
    expect(kv.store.has('failure-rate-recovery:wf-1:ACRO_GATEWAY')).toBe(false)
    expect(kv.store.has('failure-rate-cooldown:wf-1:ACRO_GATEWAY')).toBe(false)
  })

  it('passes the signal window to the all-clear so a one-tick incident is not reported as a tick gap (#1108)', async () => {
    // This check judges a trailing window (signal.window_minutes), so the notice
    // must name the window it measured rather than the gap between the ticks it
    // happened to look. The fixture signal is configured window_minutes: 5.
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const kv = makeKv({
      'failure-rate-recovery:wf-1:ACRO_GATEWAY': alertedAt,
      'failure-rate-cooldown:wf-1:ACRO_GATEWAY': '1',
    })

    await runFailureRateCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({ measuredWindowMinutes: 5 })
  })

  it('says nothing when the signal was never alerted', async () => {
    await runFailureRateCheck(healthy() as never, makeKv() as never, 'https://app.example.com')
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
  })

  it('HOLDS the all-clear over a dead pipe, where no failures means no traffic (#817)', async () => {
    // The matching failures are absent, but so is every other run: the workflow
    // stopped receiving leads. Announcing "back within normal range" here is the
    // all-clear over a dead pipe this guard exists to prevent (L98).
    const alertedAt = new Date(Date.now() - 90 * 60_000).toISOString()
    const kv = makeKv({
      'failure-rate-recovery:wf-1:ACRO_GATEWAY': alertedAt,
      'failure-rate-cooldown:wf-1:ACRO_GATEWAY': '1',
    })

    await runFailureRateCheck(quiet() as never, kv as never, 'https://app.example.com')

    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(kv.store.has('failure-rate-recovery:wf-1:ACRO_GATEWAY')).toBe(true)
  })

  it('keeps both keys when the all-clear is refused, so it retries', async () => {
    vi.mocked(sendRecoveryAlert).mockResolvedValue(false)
    const kv = makeKv({
      'failure-rate-recovery:wf-1:ACRO_GATEWAY': new Date(Date.now() - 90 * 60_000).toISOString(),
      'failure-rate-cooldown:wf-1:ACRO_GATEWAY': '1',
    })

    await runFailureRateCheck(healthy() as never, kv as never, 'https://app.example.com')

    expect(kv.store.has('failure-rate-recovery:wf-1:ACRO_GATEWAY')).toBe(true)
    expect(kv.store.has('failure-rate-cooldown:wf-1:ACRO_GATEWAY')).toBe(true)
  })

  it('records the marker keyed per signal when it does alert', async () => {
    // Per signal, not per workflow: one signal recovering must not clear another
    // still spiking on the same workflow.
    const kv = makeKv()
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [failRow('ACRO_GATEWAY a'), failRow('ACRO_GATEWAY b'), failRow('ACRO_GATEWAY c')],
    })

    await runFailureRateCheck(sb as never, kv as never, 'https://app.example.com')

    expect(kv.store.has('failure-rate-recovery:wf-1:ACRO_GATEWAY')).toBe(true)
  })
})

// ── Re-arm window (#814) ─────────────────────────────────────────────────────
//
// Replays the real 2026-08-14 Equifax ACRO_GATEWAY outage minute by minute.
// Before this change the all-clear went out at 10:45 PM and the 11:03 relapse
// was announced as a fresh incident "lasting 5 minutes" (LESSONS L160).
describe('runFailureRateCheck re-arm (#814)', () => {
  const CONN = { bot_token: 'xoxb-t', default_channel: 'C1' }
  const url = 'https://app.example.com'
  const spiking = () =>
    makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [failRow('ACRO_GATEWAY a'), failRow('ACRO_GATEWAY b'), failRow('ACRO_GATEWAY c')],
    })
  // The signal has stopped firing, but the workflow is still alive and
  // succeeding, so there is evidence the recovery is real rather than a dead
  // pipe (#817). The unrelated failure does not match the ACRO signal.
  const quiet = () =>
    makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [wf],
      workflow_executions: [failRow('unrelated salesforce error'), okRow(), okRow(), okRow()],
    })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(getSlackConnection).mockResolvedValue(CONN as never)
    vi.mocked(sendRecoveryAlert).mockResolvedValue(true)
  })
  afterEach(() => vi.useRealTimers())

  // The clock moves BEFORE the fixture is built: rows stamped at the previous
  // tick would fall outside this tick's 5 minute window, and the check would
  // read as healthy for a reason the test never intended (LESSONS L130).
  const tickAt = async (iso: string, build: () => unknown, kv: unknown) => {
    vi.setSystemTime(new Date(iso))
    await runFailureRateCheck(build() as never, kv as never, url)
  }

  it('records the running end even on a tick the cooldown suppressed', async () => {
    // The last hour of an outage is invisible if the end is only stamped when we
    // PAGE, because paging happens at the cooldown's cadence, not the failures'.
    const kv = makeKv()
    await tickAt('2026-08-15T01:32:00.000Z', spiking, kv)
    await tickAt('2026-08-15T02:40:00.000Z', spiking, kv)
    expect(sendFailureSpikeAlert).toHaveBeenCalledTimes(1) // second was deduped
    expect(kv.store.get('failure-rate-active:wf-1:ACRO_GATEWAY')).toBe('2026-08-15T02:40:00.000Z')
  })

  it('holds the all-clear through a quiet stretch shorter than the re-arm window', async () => {
    const kv = makeKv()
    await tickAt('2026-08-15T01:32:00.000Z', spiking, kv)
    await tickAt('2026-08-15T01:50:00.000Z', quiet, kv) // 18 quiet minutes is not an ended outage
    expect(sendRecoveryAlert).not.toHaveBeenCalled()
    expect(kv.store.has('failure-rate-recovery:wf-1:ACRO_GATEWAY')).toBe(true)
  })

  it('reports ONE incident across a relapse, ending at the last failure', async () => {
    const kv = makeKv()
    await tickAt('2026-08-15T01:32:00.000Z', spiking, kv) // first page, 9:32 PM EDT
    await tickAt('2026-08-15T02:40:00.000Z', spiking, kv) // last failure of the first stretch
    await tickAt('2026-08-15T02:45:00.000Z', quiet, kv)
    await tickAt('2026-08-15T02:55:00.000Z', quiet, kv)
    await tickAt('2026-08-15T03:04:00.000Z', spiking, kv) // relapse, 11:04 PM EDT
    await tickAt('2026-08-15T03:20:00.000Z', quiet, kv)
    expect(sendRecoveryAlert).not.toHaveBeenCalled()

    await tickAt('2026-08-15T03:35:00.000Z', quiet, kv)
    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendRecoveryAlert).mock.calls[0][2]).toMatchObject({
      alertedAt: '2026-08-15T01:32:00.000Z',
      endedAt: '2026-08-15T03:04:00.000Z',
    })
  })

  it('re-arms with the signal cooldown when it is longer than the default', async () => {
    // The incident must not be declared over while a repeat page for it is still
    // suppressed, or the all-clear lands on an outage that is merely muted.
    const slowSignal = {
      ...wf,
      definition: {
        trigger: {
          type: 'http_webhook',
          config: {
            muted_failure_signals: [
              { match: 'ACRO_GATEWAY', count: 3, window_minutes: 5, cooldown_minutes: 90 },
            ],
          },
        },
      },
    }
    const withSignal = (rows: unknown[]) =>
      makeSupabase({
        service_connections: [{ organization_id: 'org-1' }],
        workflows: [slowSignal],
        workflow_executions: rows,
      })
    const kv = makeKv()
    await tickAt('2026-08-15T01:32:00.000Z', () => withSignal([failRow('ACRO_GATEWAY a'), failRow('ACRO_GATEWAY b'), failRow('ACRO_GATEWAY c')]), kv)
    await tickAt('2026-08-15T02:45:00.000Z', () => withSignal([failRow('unrelated'), okRow(), okRow(), okRow()]), kv)
    expect(sendRecoveryAlert).not.toHaveBeenCalled() // 73 min quiet, under the 90 min window
    await tickAt('2026-08-15T03:10:00.000Z', () => withSignal([failRow('unrelated'), okRow(), okRow(), okRow()]), kv)
    expect(sendRecoveryAlert).toHaveBeenCalledTimes(1)
  })
})

describe('runFailureRateCheck and the incident record (#2099)', () => {
  beforeEach(() => vi.clearAllMocks())
  const ORG_ID = '44444444-4444-4444-8444-444444444444'
  const orgWf = { ...wf, organization_id: ORG_ID }

  it('records the opening and the page with this signal\'s own window, once, and nothing while the cooldown holds', async () => {
    vi.mocked(sendFailureSpikeAlert).mockResolvedValue('ts-1')
    const kv = makeKv()
    const sb = makeSupabase({
      service_connections: [{ organization_id: ORG_ID }],
      workflows: [orgWf],
      workflow_executions: [failRow('ACRO_GATEWAY 1'), failRow('ACRO_GATEWAY 2'), failRow('ACRO_GATEWAY 3')],
    })
    // A clock that moves on every read: the opening and the page must share the
    // pass's one reading, or the page sorts first.
    await withTickingClock(async () => {
      await runFailureRateCheck(sb as never, kv as never, 'https://app.example.com')
      await runFailureRateCheck(sb as never, kv as never, 'https://app.example.com')
    })
    expect(transitions(kv.store)).toEqual(['opened wf-1:ACRO_GATEWAY', 'paged wf-1:ACRO_GATEWAY'])
    expect(outboxEvents(kv.store)[0]).toMatchObject({
      signal: 'failure-rate', scope: 'org', organizationId: ORG_ID, subjectLabel: 'Engine Bidding: "ACRO_GATEWAY"', windowMinutes: 5,
    })
  })

  it('records nothing for an alert Slack refused', async () => {
    vi.mocked(sendFailureSpikeAlert).mockResolvedValue(null as never)
    const kv = makeKv()
    const sb = makeSupabase({
      service_connections: [{ organization_id: ORG_ID }],
      workflows: [orgWf],
      workflow_executions: [failRow('ACRO_GATEWAY 1'), failRow('ACRO_GATEWAY 2'), failRow('ACRO_GATEWAY 3')],
    })
    await runFailureRateCheck(sb as never, kv as never, 'https://app.example.com')
    expect(transitions(kv.store)).toEqual([])
  })
})
