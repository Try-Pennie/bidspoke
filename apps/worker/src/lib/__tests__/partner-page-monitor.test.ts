/**
 * The partners page delivery monitor (#2135, decision 2: a Worker check on the
 * existing five minute cron, signing in as a monitor user of a synthetic
 * organization with one new Worker secret).
 *
 * Every remote effect (the identity read, the sign in, the join, the ping, the
 * run record, the clock, the waits and every Slack send) is injected, so no test
 * waits on a real timer or reaches a network (L524).
 *
 * What it must get right:
 *  - a notice that does not arrive is a broken channel and pages at once; it is
 *    the only thing that pages at launch, and no miss threshold ships;
 *  - a day can start with no realtime.messages partition (ADR 0012): a join
 *    refused as MissingPartition is retried, and a send made while today's
 *    partition is absent is recorded as not judged, never as a failure;
 *  - Realtime shuts this project's connection down ten minutes after nobody
 *    stays connected, so a run can land on the shutdown (#2263): a join refused
 *    by it is retried, and a round whose notice never arrives is tried once more
 *    on a fresh connection before it counts as a miss;
 *  - a check that cannot run (no secret, no monitor organization, sign in or the
 *    database failing) is its own problem, paged after 30 minutes on the clock,
 *    and never reads as a healthy channel (L557, L98);
 *  - every run is recorded with its outcome, so pass and fail counts exist.
 */
import { describe, it, expect } from 'vitest'
import {
  measurePartnerPageDelivery,
  runPartnerPageMonitor,
  JOIN_ATTEMPTS,
  MEASURE_ROUNDS,
  PARTNER_PAGE_MONITOR_STATE_KEY,
  RECEIPT_DEADLINE_MS,
  PING_RETRY_MS,
  UNMEASURED_ALERT_AFTER_MS,
  PARTNER_PAGE_LIVE_KEY,
  PARTNER_PAGE_MONITOR_UNMEASURED_KEY,
  type MeasureDeps,
  type MonitorDeps,
  type Outcome,
} from '../partner-page-monitor'
import { readCondition } from '../alert-backoff'
import { RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { transitions } from './_incident-events'

const MIN = 60 * 1000
const ORG = '11111111-1111-1111-1111-000000000099'
const PARTNER = '33333333-3333-3333-3333-000000000099'
const SAVE = '0b9f6c1e-3c2a-4d7e-8f10-2a3b4c5d6e7f'

/** A notice as the database sends it for the monitor's ping. */
const pingNotice = (saveId = SAVE) => ({
  id: 'e1d2c3b4-a596-4877-8695-a4b3c2d1e0f9', partner_id: PARTNER, partner_version: 0, profile_version: null,
  save_id: saveId, client_id: null, kind: 'monitor', changed_columns: null, direct: false,
})

interface World {
  now: number
  password: string | undefined
  identity: Awaited<ReturnType<MeasureDeps['findIdentity']>>
  signIn: Awaited<ReturnType<MeasureDeps['signIn']>>
  /** One answer per join attempt; the last repeats. */
  joins: Array<{ ok: true } | { ok: false; reason: string; missingPartition: boolean }>
  ping: { ok: true; partitionToday: boolean; partitionTomorrow: boolean } | { ok: false; reason: string }
  /** What arrives on the channel when the ping is sent, and after how long. */
  delivers: { payload: unknown; afterMs: number } | null
  /**
   * How many of the first pings are sent but never streamed: Realtime woken from
   * an idle shutdown answers SUBSCRIBED before its replication reader exists
   * (2026-10-16 01:45 UTC), so the first notice is lost and later ones arrive.
   */
  lostPings?: number
  /** What every ping after the first answers, when it differs from the first. */
  reping?: World['ping']
}

function world(over: Partial<World> = {}): World {
  return {
    now: Date.parse('2026-10-15T17:00:00Z'),
    password: 'secret-value',
    identity: { kind: 'found', organizationId: ORG, email: 'monitor@partner-page-monitor.trypennie.dev' },
    signIn: { ok: true, jwt: 'jwt-1', signOut: async () => {} },
    joins: [{ ok: true }],
    ping: { ok: true, partitionToday: true, partitionTomorrow: true },
    delivers: { payload: pingNotice(), afterMs: 120 },
    ...over,
  }
}

function measureDeps(w: World, log: string[] = []) {
  const calls = { joins: 0, pings: 0, pingSaveIds: [] as string[], pingTimes: [] as number[], sleeps: [] as number[], left: 0, signedOut: 0, signIns: [] as string[], topics: [] as string[] }
  let onPayload: ((p: unknown) => void) | null = null
  let pendingDelivery: (() => void) | null = null
  const deps: MeasureDeps = {
    password: w.password,
    findIdentity: async () => w.identity,
    signIn: async (email) => {
      calls.signIns.push(email)
      if (!w.signIn.ok) return w.signIn
      return { ok: true, jwt: w.signIn.jwt, signOut: async () => { calls.signedOut += 1 } }
    },
    join: async (_jwt, topic, cb) => {
      calls.topics.push(topic)
      const answer = w.joins[Math.min(calls.joins, w.joins.length - 1)]
      calls.joins += 1
      if (!answer.ok) return answer
      onPayload = cb
      return { ok: true, leave: async () => { calls.left += 1 } }
    },
    ping: async (_org, saveId) => {
      calls.pings += 1
      calls.pingSaveIds.push(saveId)
      calls.pingTimes.push(w.now)
      const answer = calls.pings > 1 && w.reping ? w.reping : w.ping
      if (answer.ok && w.delivers && calls.pings > (w.lostPings ?? 0)) {
        const d = w.delivers
        const payload = typeof d.payload === 'object' && d.payload !== null && (d.payload as { save_id?: unknown }).save_id === SAVE
          ? { ...(d.payload as object), save_id: saveId }
          : d.payload
        // Delivered once the clock reaches it: a deadline wait that is longer
        // sees it, a shorter one does not.
        pendingDelivery = () => onPayload?.(payload)
        if (d.afterMs === 0) { pendingDelivery(); pendingDelivery = null }
      }
      return answer
    },
    newSaveId: () => SAVE,
    now: () => w.now,
    sleep: async (ms) => {
      calls.sleeps.push(ms)
      if (pendingDelivery && w.delivers && w.delivers.afterMs <= ms) {
        w.now += w.delivers.afterMs
        const deliver = pendingDelivery
        pendingDelivery = null
        deliver()
        return
      }
      w.now += ms
    },
    log: (l) => log.push(l),
  }
  return { deps, calls }
}

describe('measurePartnerPageDelivery', () => {
  it('signs in as the monitor, joins its organization topic, pings, and times the receipt', async () => {
    const w = world()
    const { deps, calls } = measureDeps(w)
    const outcome = await measurePartnerPageDelivery(deps)
    expect(outcome).toEqual({ kind: 'received', latencyMs: 120, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 })
    expect(calls.signIns).toEqual(['monitor@partner-page-monitor.trypennie.dev'])
    expect(calls.topics).toEqual([`partners:${ORG}`])
    // Everything it opened is closed.
    expect(calls.left).toBe(1)
    expect(calls.signedOut).toBe(1)
  })

  it('a notice that never arrives is re-pinged every PING_RETRY_MS with the same save id, tried once more on a fresh connection, then is not received', async () => {
    const w = world({ delivers: null })
    const { deps, calls } = measureDeps(w)
    const pings = RECEIPT_DEADLINE_MS / PING_RETRY_MS
    expect(await measurePartnerPageDelivery(deps)).toEqual({ kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings, rounds: MEASURE_ROUNDS })
    expect(calls.pings).toBe(pings * MEASURE_ROUNDS)
    expect(new Set(calls.pingSaveIds)).toEqual(new Set([SAVE]))
    // Every wait is the injected sleep, none longer than the re-ping interval,
    // and together they spend exactly the deadline per round: no fixed wait.
    expect(calls.sleeps.every((ms) => ms <= PING_RETRY_MS)).toBe(true)
    expect(calls.sleeps.reduce((a, b) => a + b, 0)).toBe(RECEIPT_DEADLINE_MS * MEASURE_ROUNDS)
    expect(calls.pingTimes.slice(0, pings).map((t) => t - calls.pingTimes[0])).toEqual(Array.from({ length: pings }, (_, i) => i * PING_RETRY_MS))
    // Each round joined and left its own channel; one sign in for the run.
    expect(calls.joins).toBe(MEASURE_ROUNDS)
    expect(calls.left).toBe(MEASURE_ROUNDS)
    expect(calls.signIns).toHaveLength(1)
    expect(calls.signedOut).toBe(1)
  })

  it('a round lost to an idle shutdown is received on the fresh connection, and says it took a second round', async () => {
    // 2026-10-16 20:35:35 UTC: the run joined a second before Realtime shut the
    // idle tenant down, so none of its pings were streamed; the 20:40 run, on a
    // fresh connection, received. The whole first round is lost here.
    const pings = RECEIPT_DEADLINE_MS / PING_RETRY_MS
    const w = world({ lostPings: pings, delivers: { payload: pingNotice(), afterMs: 120 } })
    const { deps, calls } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toEqual({
      kind: 'received', latencyMs: 120, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 2,
    })
    expect(calls.joins).toBe(2)
    expect(calls.left).toBe(2)
  })

  it('a cold start that loses the first notice is received on the re-ping, timed from the first send', async () => {
    // 2026-10-16 01:45 UTC: Realtime woke from an idle shutdown, answered
    // SUBSCRIBED at once, and began streaming realtime.messages 0.66 s after
    // the ping was stored, so that notice was never sent; the 01:50 run got one
    // in 211 ms.
    const w = world({ lostPings: 1, delivers: { payload: pingNotice(), afterMs: 120 } })
    const { deps, calls } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toEqual({
      kind: 'received', latencyMs: PING_RETRY_MS + 120, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 2, rounds: 1,
    })
    expect(calls.pings).toBe(2)
  })

  it('a re-ping the database refuses is logged and the run waits out the deadline for the pings already sent', async () => {
    const log: string[] = []
    const pings = RECEIPT_DEADLINE_MS / PING_RETRY_MS
    const w = world({ delivers: null, reping: { ok: false, reason: 'statement timeout' } })
    const { deps, calls } = measureDeps(w, log)
    // The second round's first ping is refused too, so that round cannot run:
    // the first round's miss stands rather than turning into unmeasured.
    expect(await measurePartnerPageDelivery(deps)).toEqual({ kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 2 })
    expect(calls.pings).toBe(pings + 1)
    expect(log.filter((l) => l.includes('re-ping could not be sent: statement timeout'))).toHaveLength(pings - 1)
    expect(log.filter((l) => l.includes('round 2 could not run: the ping could not be sent: statement timeout'))).toHaveLength(1)
  })

  it('takes its partition figures from the first ping only', async () => {
    const w = world({
      lostPings: 1,
      ping: { ok: true, partitionToday: true, partitionTomorrow: false },
      reping: { ok: true, partitionToday: true, partitionTomorrow: true },
    })
    const { deps } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toMatchObject({ kind: 'received', partitionTomorrow: false, pings: 2 })
  })

  it('ignores a notice that is not its own ping (another save, another ping)', async () => {
    const w = world({ delivers: { payload: { ...pingNotice('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), kind: 'page' }, afterMs: 50 } })
    const { deps } = measureDeps(w)
    expect((await measurePartnerPageDelivery(deps)).kind).toBe('not_received')
  })

  it('a send made while today\'s partition is absent is not judged, whatever arrives', async () => {
    const w = world({ ping: { ok: true, partitionToday: false, partitionTomorrow: false }, delivers: null })
    const { deps } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toEqual({ kind: 'partition_missing_at_send', partitionTomorrow: false, joinAttempts: 1 })
  })

  it('retries a join refused as MissingPartition, then measures', async () => {
    const w = world({ joins: [{ ok: false, reason: 'MissingPartition: Realtime was unable to find the expected messages partition', missingPartition: true }, { ok: true }] })
    const { deps, calls } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toMatchObject({ kind: 'received', joinAttempts: 2 })
    expect(calls.joins).toBe(2)
  })

  it('a join still refused for the partition after every attempt is a broken channel, since no page can join either', async () => {
    const w = world({ joins: [{ ok: false, reason: 'MissingPartition: no partition', missingPartition: true }] })
    const { deps, calls } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toEqual({ kind: 'join_refused', reason: 'MissingPartition: no partition', joinAttempts: JOIN_ATTEMPTS, rounds: 1 })
    expect(calls.joins).toBe(JOIN_ATTEMPTS)
    expect(calls.pings).toBe(0)
  })

  it('retries a join refused while Realtime shuts the idle tenant down, which it words as a pool shortage, then measures', async () => {
    // 2026-10-16 04:45:14 UTC: the join's authorization query lost its
    // connection to the idle shutdown, and Realtime answered IncreaseConnectionPool.
    const log: string[] = []
    const w = world({ joins: [{ ok: false, reason: 'IncreaseConnectionPool: Please increase your connection pool size', missingPartition: false }, { ok: true }] })
    const { deps, calls } = measureDeps(w, log)
    expect(await measurePartnerPageDelivery(deps)).toMatchObject({ kind: 'received', joinAttempts: 2, rounds: 1 })
    expect(calls.joins).toBe(2)
    expect(log.some((l) => l.includes('join refused during an idle shutdown, attempt 1 of'))).toBe(true)
  })

  it('control: a join refused that way on every attempt is a broken channel', async () => {
    const w = world({ joins: [{ ok: false, reason: 'IncreaseConnectionPool: Please increase your connection pool size', missingPartition: false }] })
    const { deps, calls } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toEqual({
      kind: 'join_refused', reason: 'IncreaseConnectionPool: Please increase your connection pool size', joinAttempts: JOIN_ATTEMPTS, rounds: 1,
    })
    expect(calls.joins).toBe(JOIN_ATTEMPTS)
    expect(calls.pings).toBe(0)
  })

  it('a join refused for any other reason is not retried', async () => {
    const w = world({ joins: [{ ok: false, reason: 'Unauthorized: You do not have permissions to read from this Channel topic', missingPartition: false }] })
    const { deps, calls } = measureDeps(w)
    expect(await measurePartnerPageDelivery(deps)).toMatchObject({ kind: 'join_refused', joinAttempts: 1 })
    expect(calls.joins).toBe(1)
    expect(calls.signedOut).toBe(1)
  })

  it.each([
    ['the secret is not set', { password: undefined }, 'PARTNER_PAGE_MONITOR_PASSWORD is not set on the worker'],
    ['no organization is synthetic', { identity: { kind: 'missing' as const, reason: 'no organization is marked is_synthetic' } }, 'no organization is marked is_synthetic'],
    ['sign in fails', { signIn: { ok: false as const, reason: 'Invalid login credentials' } }, 'the monitor user could not sign in: Invalid login credentials'],
    ['the ping is refused', { ping: { ok: false as const, reason: 'monitor_organization_misconfigured' } }, 'the ping could not be sent: monitor_organization_misconfigured'],
  ])('cannot measure when %s, and says which', async (_label, over, reason) => {
    const { deps } = measureDeps(world(over as Partial<World>))
    expect(await measurePartnerPageDelivery(deps)).toEqual({ kind: 'unmeasured', reason })
  })

  it('never logs the password', async () => {
    const log: string[] = []
    const w = world({ signIn: { ok: false, reason: 'Invalid login credentials' } })
    const { deps } = measureDeps(w, log)
    await measurePartnerPageDelivery(deps)
    expect(log.join('\n')).not.toContain('secret-value')
  })
})

// ── Judging and alerting ─────────────────────────────────────────────────────

function fakeKv(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number | null }>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= clock.now) { store.delete(k); return null }
    return e
  }
  return {
    store,
    get: async (k: string) => live(k)?.value ?? null,
    put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value, expiresAt: opts?.expirationTtl ? clock.now + opts.expirationTtl * 1000 : null })
    },
    delete: async (k: string) => { store.delete(k) },
  }
}

function fakeClaims(clock: { now: number }) {
  const held = new Map<string, number>()
  return {
    claim: async (key: string, ttlSeconds: number) => {
      const until = held.get(key)
      if (until !== undefined && until > clock.now) return false
      held.set(key, clock.now + ttlSeconds * 1000)
      return true
    },
    release: async (key: string) => { held.delete(key) },
  }
}

function monitorHarness(opts: { env?: Record<string, string | undefined>; measure?: () => Promise<Outcome> } = {}) {
  const clock = { now: Date.parse('2026-10-15T17:00:00Z') }
  const kv = fakeKv(clock)
  const sent: Array<{ kind: string; payload: Record<string, unknown> }> = []
  const records: Array<{ outcome: string; summary: Record<string, unknown> }> = []
  let next: Outcome = { kind: 'received', latencyMs: 90, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 }
  const answer = (kind: string) => (_s: unknown, _c: string, payload: Record<string, unknown>) => {
    sent.push({ kind, payload })
    return Promise.resolve(kind === 'recovery' ? true : 'ts')
  }
  const deps: MonitorDeps = {
    kv,
    claims: fakeClaims(clock),
    env: opts.env ?? {},
    measure: opts.measure ?? (async () => next),
    record: async (outcome, summary) => { records.push({ outcome, summary }) },
    resolveSlack: async () => [{ bot_token: 't', default_channel: '#ops' }],
    senders: {
      live: answer('live') as unknown as MonitorDeps['senders']['live'],
      recovery: answer('recovery') as unknown as MonitorDeps['senders']['recovery'],
    },
    now: () => clock.now,
    log: () => {},
  }
  const set = (o: Outcome) => { next = o }
  const run = () => runPartnerPageMonitor(deps)
  const every5 = async (minutes: number) => {
    const out = []
    for (let i = 0; i * 5 <= minutes; i++) {
      if (i > 0) clock.now += 5 * MIN
      out.push(await run())
    }
    return out
  }
  return { clock, kv, sent, records, set, run, every5 }
}

describe('runPartnerPageMonitor', () => {
  it('records every run with its outcome and figures, and pages nothing while notices arrive', async () => {
    const h = monitorHarness()
    await h.every5(10)
    expect(h.records.map((r) => r.outcome)).toEqual(['received', 'received', 'received'])
    expect(h.records[0].summary).toMatchObject({ latency_ms: 90, partition_today: true, partition_tomorrow: true, join_attempts: 1, pings: 1 })
    expect(h.sent).toEqual([])
  })

  it('pages at once when its notice does not arrive, keeps the incident, then sends one all-clear once it has arrived for the rearm window', async () => {
    const h = monitorHarness()
    h.set({ kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 })
    const first = await h.run()
    expect(first.alerts).toEqual(['channel'])
    expect(h.sent.map((s) => s.kind)).toEqual(['live'])
    expect(h.sent[0].payload).toMatchObject({ problem: 'channel' })
    expect((await readCondition(h.kv, PARTNER_PAGE_LIVE_KEY))?.alerts).toBe(1)

    h.set({ kind: 'received', latencyMs: 80, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 })
    await h.every5(RECOVERY_REARM_MINUTES + 5)
    expect(h.sent.filter((s) => s.kind === 'recovery')).toHaveLength(1)
    expect(await readCondition(h.kv, PARTNER_PAGE_LIVE_KEY)).toBeNull()
    expect(transitions(h.kv.store as unknown as Map<string, { value: string }>)).toEqual([
      'opened channel', 'paged channel', 'ended channel all_clear',
    ])
  })

  it('a cold start whose first notice is lost records received with the ping count, and pages nothing', async () => {
    const h = monitorHarness({ measure: () => measurePartnerPageDelivery(measureDeps(world({ lostPings: 1 })).deps) })
    const summary = await h.run()
    expect(summary.alerts).toEqual([])
    expect(h.records).toEqual([{ outcome: 'received', summary: expect.objectContaining({ latency_ms: PING_RETRY_MS + 120, pings: 2 }) }])
    expect(h.sent).toEqual([])
  })

  it('control: when no ping is ever delivered the run still records not_received with every ping counted, and pages', async () => {
    const h = monitorHarness({ measure: () => measurePartnerPageDelivery(measureDeps(world({ delivers: null })).deps) })
    const summary = await h.run()
    expect(summary.alerts).toEqual(['channel'])
    expect(h.records).toEqual([{ outcome: 'not_received', summary: expect.objectContaining({ pings: RECEIPT_DEADLINE_MS / PING_RETRY_MS, deadline_ms: RECEIPT_DEADLINE_MS, rounds: MEASURE_ROUNDS }) }])
    expect(h.sent.map((s) => s.kind)).toEqual(['live'])
    expect(h.sent[0].payload).toMatchObject({ problem: 'channel', reason: 'no notice arrived within 10 seconds of the first ping, after 4 pings, on a fresh connection as on the first' })
  })

  it('a run that needed the fresh connection records received with rounds 2, and pages nothing', async () => {
    const h = monitorHarness({ measure: () => measurePartnerPageDelivery(measureDeps(world({ lostPings: RECEIPT_DEADLINE_MS / PING_RETRY_MS })).deps) })
    expect((await h.run()).alerts).toEqual([])
    expect(h.records).toEqual([{ outcome: 'received', summary: expect.objectContaining({ rounds: 2, pings: 1 }) }])
    expect(h.sent).toEqual([])
  })

  it('control: a join refused during an idle shutdown on every attempt still pages', async () => {
    const reason = 'IncreaseConnectionPool: Please increase your connection pool size'
    const h = monitorHarness({ measure: () => measurePartnerPageDelivery(measureDeps(world({ joins: [{ ok: false, reason, missingPartition: false }] })).deps) })
    expect((await h.run()).alerts).toEqual(['channel'])
    expect(h.records).toEqual([{ outcome: 'join_refused', summary: { reason, join_attempts: JOIN_ATTEMPTS, rounds: 1 } }])
  })

  it('the alert counts the runs that missed out of the runs since the first miss, and the count ends with the all-clear', async () => {
    const h = monitorHarness()
    const miss: Outcome = { kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 4, rounds: 2 }
    const hit: Outcome = { kind: 'received', latencyMs: 80, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 }
    const window = async () => (JSON.parse((await h.kv.get(PARTNER_PAGE_MONITOR_STATE_KEY)) ?? '{}') as { channelWindow?: unknown }).channelWindow
    h.set(miss)
    await h.run()
    expect(h.sent[0].payload).toMatchObject({ problem: 'channel', since: '2026-10-15T17:00:00.000Z', checks: { runs: 1, misses: 1 } })
    for (const o of [hit, hit, miss]) {
      h.clock.now += 5 * MIN
      h.set(o)
      await h.run()
    }
    expect(await window()).toEqual({ since: '2026-10-15T17:00:00.000Z', lastMissAt: '2026-10-15T17:15:00.000Z', runs: 4, misses: 2 })
    // A run that could not measure is neither a run nor a miss.
    h.clock.now += 5 * MIN
    h.set({ kind: 'unmeasured', reason: 'the ping could not be sent: timeout' })
    await h.run()
    expect(await window()).toEqual({ since: '2026-10-15T17:00:00.000Z', lastMissAt: '2026-10-15T17:15:00.000Z', runs: 4, misses: 2 })
    h.set(hit)
    await h.every5(RECOVERY_REARM_MINUTES + 10)
    expect(h.sent.filter((s) => s.kind === 'recovery')).toHaveLength(1)
    expect(await window()).toBeUndefined()
  })

  it('a miss while the alert is muted still counts, so the alert after the mute says how many there were', async () => {
    const h = monitorHarness()
    await h.kv.put('partner-page-live:cooldown', '1', { expirationTtl: 3600 })
    const miss: Outcome = { kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 4, rounds: 2 }
    h.set(miss)
    await h.run()
    h.clock.now += 5 * MIN
    await h.run()
    const state = JSON.parse((await h.kv.get(PARTNER_PAGE_MONITOR_STATE_KEY)) ?? '{}') as { channelWindow?: unknown }
    expect(state.channelWindow).toEqual({ since: '2026-10-15T17:00:00.000Z', lastMissAt: '2026-10-15T17:05:00.000Z', runs: 2, misses: 2 })
  })

  it('a window left behind by an incident that lapsed is not carried into the next miss', async () => {
    const h = monitorHarness()
    // Its last miss is more than 25 hours before this run.
    await h.kv.put(PARTNER_PAGE_MONITOR_STATE_KEY, JSON.stringify({ channelWindow: { since: '2026-10-14T09:00:00.000Z', lastMissAt: '2026-10-14T15:59:00.000Z', runs: 40, misses: 9 } }))
    h.set({ kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 4, rounds: 2 })
    await h.run()
    expect(h.sent[0].payload).toMatchObject({ since: '2026-10-15T17:00:00.000Z', checks: { runs: 1, misses: 1 } })
  })

  it('a join refused pages as a broken channel too, naming the refusal', async () => {
    const h = monitorHarness()
    h.set({ kind: 'join_refused', reason: 'Unauthorized: You do not have permissions', joinAttempts: 1, rounds: 1 })
    expect((await h.run()).alerts).toEqual(['channel'])
    expect(h.sent[0].payload).toMatchObject({ problem: 'channel', reason: 'the monitor could not join the channel: Unauthorized: You do not have permissions' })
  })

  it('a send while the partition is absent neither pages nor counts toward an all-clear', async () => {
    const h = monitorHarness()
    h.set({ kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 })
    await h.run()
    h.set({ kind: 'partition_missing_at_send', partitionTomorrow: true, joinAttempts: 1 })
    await h.every5(RECOVERY_REARM_MINUTES + 10)
    expect(h.sent.map((s) => s.kind)).toEqual(['live'])
    expect(h.records.slice(1).every((r) => r.outcome === 'partition_missing_at_send')).toBe(true)
  })

  it('a check that cannot run pages only after 30 minutes on the clock, as its own problem, and stands down when it runs again', async () => {
    const h = monitorHarness()
    h.set({ kind: 'unmeasured', reason: 'PARTNER_PAGE_MONITOR_PASSWORD is not set on the worker' })
    const runs = await h.every5(UNMEASURED_ALERT_AFTER_MS / MIN - 5)
    expect(runs.every((r) => r.alerts.length === 0)).toBe(true)
    h.clock.now += 5 * MIN
    expect((await h.run()).alerts).toEqual(['monitor'])
    expect(h.sent.at(-1)?.payload).toMatchObject({ problem: 'monitor', reason: 'PARTNER_PAGE_MONITOR_PASSWORD is not set on the worker' })
    expect(h.records.every((r) => r.outcome === 'unmeasured')).toBe(true)

    h.set({ kind: 'received', latencyMs: 80, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 })
    await h.every5(RECOVERY_REARM_MINUTES + 5)
    expect(h.sent.filter((s) => s.kind === 'recovery')).toHaveLength(1)
    expect(await readCondition(h.kv, PARTNER_PAGE_MONITOR_UNMEASURED_KEY)).toBeNull()
  })

  it('a check that cannot run is never read as a working channel: a standing channel incident gets no all-clear from it', async () => {
    const h = monitorHarness()
    h.set({ kind: 'not_received', partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 })
    await h.run()
    h.set({ kind: 'unmeasured', reason: 'the ping could not be sent: timeout' })
    await h.every5(RECOVERY_REARM_MINUTES + 10)
    expect(h.sent.filter((s) => s.kind === 'recovery')).toHaveLength(0)
    // The first run that measures again starts the quiet window; it does not
    // close an incident whose last sighting was only the start of the gap.
    h.clock.now += 5 * MIN
    h.set({ kind: 'received', latencyMs: 80, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 })
    await h.run()
    expect(h.sent.filter((s) => s.kind === 'recovery' && (s.payload as { signal?: string }).signal === 'partners page live updates')).toHaveLength(0)
  })

  it('a measurement that throws is a check that cannot run, never a crash with no record', async () => {
    const h = monitorHarness()
    const summary = await runPartnerPageMonitor({ ...harnessDeps(h), measure: async () => { throw new Error('boom') } })
    expect(summary.outcome).toBe('unmeasured')
    expect(h.records[0]).toMatchObject({ outcome: 'unmeasured', summary: { reason: 'the check threw: boom' } })
  })

  it('in local dev it measures nothing and writes nothing', async () => {
    const h = monitorHarness({ env: { LOCAL_DEV: 'true' } })
    const summary = await h.run()
    expect(summary.mode).toBe('silent')
    expect(h.records).toEqual([])
    expect(h.kv.store.size).toBe(0)
  })
})

/** The harness's deps, rebuilt so one can be replaced. */
function harnessDeps(h: ReturnType<typeof monitorHarness>): MonitorDeps {
  return {
    kv: h.kv,
    claims: fakeClaims(h.clock),
    env: {},
    measure: async () => ({ kind: 'received', latencyMs: 1, partitionToday: true, partitionTomorrow: true, joinAttempts: 1, pings: 1, rounds: 1 }),
    record: async (outcome, summary) => { h.records.push({ outcome, summary }) },
    resolveSlack: async () => [],
    senders: { live: (async () => 'ts') as unknown as MonitorDeps['senders']['live'], recovery: (async () => true) as unknown as MonitorDeps['senders']['recovery'] },
    now: () => h.clock.now,
    log: () => {},
  }
}
