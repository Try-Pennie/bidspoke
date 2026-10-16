/**
 * The one owner of "Bidspoke cannot read its database" (#2061, #1303 phase 3).
 *
 * Every scheduled read that fails reports here: the volume check's three reads
 * page at once, as they did; the minute probe and the per tick scheduled read
 * flag are fast, uncalibrated reads and page only on a second consecutive
 * failed minute. The all-clear waits until the probe and the volume check have
 * both answered for the re-arm window with no failure from anyone. Every clock
 * is injected; nothing here waits for real (L524).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../slack', () => ({
  sendDatabaseUnreachableAlert: vi.fn(),
  sendDatabaseRecoveredAlert: vi.fn(),
}))

import {
  reportDatabaseUnreachable,
  reportDatabaseReadable,
  runDatabaseReachabilityProbe,
  DB_PROBE_DEADLINE_MS,
} from '../database-reachability'
import { sendDatabaseUnreachableAlert, sendDatabaseRecoveredAlert } from '../slack'
import { encryptSecret, decryptSecret } from '../secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY, SLACK_COPY_SAVED_AT_KEY } from '../slack-copy'
import { RECOVERY_REARM_MINUTES } from '../alert-recovery'
import type { AlertClaims } from '../alert-claim'
import { fakeTimers, tableClient, TEST_KEY } from './_scheduled-slack-doubles'
import { outboxEvents, transitions } from './_incident-events'

const ORG = '55555555-5555-4555-8555-555555555555'
const CONN = { bot_token: 'xoxb-t', default_channel: 'C1', volume_alerts_enabled: true }
const MIN = 60_000
const T0 = Date.parse('2026-10-15T03:00:00Z')
const SAVED_AT = T0 - 12 * MIN

// The keys volume-cliff.ts wrote before the move, spelled out rather than
// derived from the new module, so a renamed key fails here (an open incident
// would otherwise be re-announced on the deploy).
const RECOVERY = `db-unreachable-recovery:${ORG}`
const ACTIVE = `db-unreachable-active:${ORG}`
const COOLDOWN = `db-unreachable:${ORG}:cooldown`
const CONDITION = `db-unreachable:${ORG}:condition`

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
    delete: (k: string) => { store.delete(k); return Promise.resolve() },
  }
}

async function copyBlob(conns: Record<string, unknown> = { [ORG]: CONN }, savedAtMs: number | null = SAVED_AT): Promise<string> {
  const body: Record<string, unknown> = { ...conns }
  if (savedAtMs !== null) body[SLACK_COPY_SAVED_AT_KEY] = new Date(savedAtMs).toISOString()
  return encryptSecret(JSON.stringify(body), TEST_KEY)
}

async function kvWithCopy(seed: Record<string, string> = {}) {
  return fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await copyBlob(), ...seed })
}

function deps(kv: ReturnType<typeof fakeKv>, at: number, claims?: AlertClaims) {
  return { kv, secretKeys: TEST_KEY, appUrl: 'https://app.example', claims, now: () => at }
}

const readFailure = { source: 'volume-cliff' as const, what: 'workflows', error: { message: 'connection refused', code: '08006' } }
const probeFailure = { source: 'probe' as const, what: 'the minute database probe', error: 'timeout: no answer in 5000 ms' }
const flagFailure = { source: 'scheduled-read' as const, what: 'heartbeat-checks slack organizations', error: 'timeout: no answer in 3000 ms' }

/** A probe client whose service_connections read answers with `rows`. */
const answering = (rows: unknown[] = [{ organization_id: ORG, config: { bot_token: CONN.bot_token, default_channel: CONN.default_channel } }]) =>
  tableClient({ service_connections: { data: rows } }).client
const failing = () => tableClient({ service_connections: { error: { message: 'connection refused', code: '08006' } } }).client

function probeDeps(kv: ReturnType<typeof fakeKv>, at: number, supabase = answering()) {
  return {
    ...deps(kv, at),
    supabase,
    sleep: fakeTimers('never').sleep,
    stamps: { started: vi.fn().mockResolvedValue(undefined), completed: vi.fn().mockResolvedValue(undefined) },
  }
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(sendDatabaseUnreachableAlert).mockReset().mockResolvedValue('ts-db')
  vi.mocked(sendDatabaseRecoveredAlert).mockReset().mockResolvedValue(true)
})
afterEach(() => vi.restoreAllMocks())

describe('an incident open at the deploy survives the move', () => {
  it('keeps the old keys: a standing outage inside its cooldown is not re-announced', async () => {
    const kv = await kvWithCopy({
      [RECOVERY]: new Date(T0 - 20 * MIN).toISOString(),
      [ACTIVE]: new Date(T0 - MIN).toISOString(),
      [COOLDOWN]: '1',
      [CONDITION]: JSON.stringify({ since: new Date(T0 - 20 * MIN).toISOString(), alerts: 1 }),
    })
    await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(sendDatabaseUnreachableAlert).not.toHaveBeenCalled()
    // The running end moved, on the same key the all-clear reads.
    expect(kv.store.get(ACTIVE)).toBe(new Date(T0).toISOString())
    expect(kv.store.get(RECOVERY)).toBe(new Date(T0 - 20 * MIN).toISOString())
  })

  it('continues the same backoff once the old cooldown lapses: the next page is a reminder', async () => {
    const kv = await kvWithCopy({
      [RECOVERY]: new Date(T0 - 20 * MIN).toISOString(),
      [ACTIVE]: new Date(T0 - MIN).toISOString(),
      [CONDITION]: JSON.stringify({ since: new Date(T0 - 20 * MIN).toISOString(), alerts: 1 }),
    })
    await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendDatabaseUnreachableAlert).mock.calls[0][2].repeat).toContain('reminder 2')
  })
})

describe('a failed scheduled read pages from the copy, naming its age', () => {
  it('pages at once for a volume check read, from the copy, with the copy age', async () => {
    const kv = await kvWithCopy()
    await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
    const [slack, channel, payload] = vi.mocked(sendDatabaseUnreachableAlert).mock.calls[0]
    expect(slack.bot_token).toBe('xoxb-t')
    expect(channel).toBe('C1')
    expect(payload.what).toBe('workflows')
    expect(payload.error).toContain('connection refused')
    expect(payload.copyAgeMs).toBe(12 * MIN)
    expect(kv.store.has(RECOVERY)).toBe(true)
    expect(kv.store.has(COOLDOWN)).toBe(true)
  })

  it('names the age unknown, never a guess, for a copy written before it was dated', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await copyBlob({ [ORG]: CONN }, null) })
    await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(vi.mocked(sendDatabaseUnreachableAlert).mock.calls[0][2].copyAgeMs).toBeNull()
  })

  it('says nobody can be told, rather than nothing, when there is no copy', async () => {
    const kv = fakeKv()
    await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(sendDatabaseUnreachableAlert).not.toHaveBeenCalled()
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('so nobody can be told'))).toBe(true)
  })

  it('records the opening and the page to the outbox', async () => {
    const kv = await kvWithCopy()
    await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(transitions(kv.store)).toEqual([`opened ${ORG}`, `paged ${ORG}`])
  })

  it('posts once when the volume check and the flag both report in one tick', async () => {
    const kv = await kvWithCopy()
    const held = new Set<string>()
    const claims: AlertClaims = {
      claim: async (k) => { if (held.has(k)) return false; held.add(k); return true },
      release: async (k) => { held.delete(k) },
    }
    // The flag already failed the minute before, so on its own it would page now too.
    await reportDatabaseUnreachable(deps(kv, T0 - MIN, claims), flagFailure)
    await Promise.all([
      reportDatabaseUnreachable(deps(kv, T0, claims), readFailure),
      reportDatabaseUnreachable(deps(kv, T0, claims), flagFailure),
    ])
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
  })
})

// Phase 4 lessons review: one organization's failure must not stop the page,
// or the all-clear, for every organization after it.
describe('each organization is its own failure boundary', () => {
  const ORG2 = '66666666-6666-4666-8666-666666666666'
  const CONN2 = { bot_token: 'xoxb-2', default_channel: 'C2', volume_alerts_enabled: true }

  it('pages the second organization when the first one\'s post throws, and says which was told', async () => {
    const kv = fakeKv({ [SLACK_CONNS_LASTGOOD_KEY]: await copyBlob({ [ORG]: CONN, [ORG2]: CONN2 }) })
    vi.mocked(sendDatabaseUnreachableAlert).mockImplementation(async (slack) => {
      if (slack.bot_token === 'xoxb-t') throw new Error('Slack exploded')
      return 'ts-2'
    })
    const result = await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(vi.mocked(sendDatabaseUnreachableAlert).mock.calls.map((c) => c[1])).toEqual(['C1', 'C2'])
    expect(result.told).toEqual([ORG2])
    expect(result.failed).toEqual([{ orgId: ORG, reason: expect.stringContaining('Slack exploded') }])
    expect(kv.store.has(`db-unreachable:${ORG2}:cooldown`)).toBe(true)
    expect(kv.store.has(COOLDOWN)).toBe(false)
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(ORG) && String(c[0]).includes('Slack exploded'))).toBe(true)
  })

  it('sends the second organization its all-clear when settling the first one\'s throws', async () => {
    const open = (org: string) => ({
      [`db-unreachable-recovery:${org}`]: new Date(T0 - 90 * MIN).toISOString(),
      [`db-unreachable-active:${org}`]: new Date(T0 - 60 * MIN).toISOString(),
      [`db-unreachable:${org}:condition`]: '{"since":"2026-10-15T01:30:00.000Z","alerts":1}',
    })
    const kv = fakeKv({ ...open(ORG), ...open(ORG2) })
    for (let t = T0 - 40 * MIN; t <= T0 - MIN; t += MIN) {
      await reportDatabaseReadable(kv, 'probe', t)
      await reportDatabaseReadable(kv, 'volume-cliff', t)
    }
    const del = kv.delete
    kv.delete = (k: string) => (k === `db-unreachable:${ORG}:condition` ? Promise.reject(new Error('KV DELETE failed: 500')) : del(k))
    const rows = [
      { organization_id: ORG, config: { bot_token: CONN.bot_token, default_channel: CONN.default_channel } },
      { organization_id: ORG2, config: { bot_token: CONN2.bot_token, default_channel: CONN2.default_channel } },
    ]
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, answering(rows)))
    expect(vi.mocked(sendDatabaseRecoveredAlert).mock.calls.map((c) => c[1])).toEqual(['C1', 'C2'])
    expect(kv.store.has(`db-unreachable-recovery:${ORG2}`)).toBe(false)
    expect(kv.store.has(`db-unreachable:${ORG2}:condition`)).toBe(false)
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(ORG) && String(c[0]).includes('KV DELETE failed'))).toBe(true)
  })
})

// Merge review: the reader's record and the failed minute are bookkeeping; a
// KV refusal writing them must not stop the page itself.
describe('the bookkeeping before the page cannot stop it', () => {
  it('still pages a volume check failure when the reader record and failed minute writes are refused', async () => {
    const kv = await kvWithCopy()
    const put = kv.put
    kv.put = (k: string, v: string) => (k.startsWith('db-reachability:') ? Promise.reject(new Error('KV PUT failed: 500')) : put(k, v))
    const result = await reportDatabaseUnreachable(deps(kv, T0), readFailure)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
    expect(result.told).toEqual([ORG])
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('KV PUT failed'))).toBe(true)
  })
})

// Merge review at 390cc55: a reader saying it answered is bookkeeping too, and
// its callers (the cliff check, the probe's all-clear) must not stop on it.
describe('recording an answered run cannot stop its caller', () => {
  it('resolves and logs when KV refuses the reader record', async () => {
    const kv = fakeKv()
    kv.put = () => Promise.reject(new Error('KV PUT failed: 500'))
    await expect(reportDatabaseReadable(kv, 'volume-cliff', T0)).resolves.toBeUndefined()
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('KV PUT failed'))).toBe(true)
  })

  it('still sends an owed all-clear when the probe\'s own answered record is refused', async () => {
    const kv = await kvWithCopy({ [RECOVERY]: new Date(T0 - 90 * MIN).toISOString(), [ACTIVE]: new Date(T0 - 60 * MIN).toISOString() })
    for (let t = T0 - 40 * MIN; t <= T0 - MIN; t += MIN) {
      await reportDatabaseReadable(kv, 'probe', t)
      await reportDatabaseReadable(kv, 'volume-cliff', t)
    }
    const put = kv.put
    kv.put = (k: string, v: string) => (k === 'db-reachability:source:probe' ? Promise.reject(new Error('KV PUT failed: 500')) : put(k, v))
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).toHaveBeenCalledTimes(1)
  })
})

describe('the fast reads page only on a second failed minute in a row', () => {
  it('one failed probe does not page', async () => {
    const kv = await kvWithCopy()
    await reportDatabaseUnreachable(deps(kv, T0), probeFailure)
    expect(sendDatabaseUnreachableAlert).not.toHaveBeenCalled()
  })

  it('two failed probes in consecutive minutes page once', async () => {
    const kv = await kvWithCopy()
    await reportDatabaseUnreachable(deps(kv, T0), probeFailure)
    await reportDatabaseUnreachable(deps(kv, T0 + MIN), probeFailure)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendDatabaseUnreachableAlert).mock.calls[0][2].what).toBe('the minute database probe')
  })

  it('two failed probes with a minute between them do not page', async () => {
    const kv = await kvWithCopy()
    await reportDatabaseUnreachable(deps(kv, T0), probeFailure)
    await reportDatabaseUnreachable(deps(kv, T0 + 2 * MIN), probeFailure)
    expect(sendDatabaseUnreachableAlert).not.toHaveBeenCalled()
  })

  it('a flag only failure reports: the first minute holds an open incident, the second consecutive minute pages', async () => {
    const kv = await kvWithCopy({ [RECOVERY]: new Date(T0 - 60 * MIN).toISOString(), [ACTIVE]: new Date(T0 - 40 * MIN).toISOString() })
    await reportDatabaseUnreachable(deps(kv, T0), flagFailure)
    expect(sendDatabaseUnreachableAlert).not.toHaveBeenCalled()
    expect(kv.store.get(ACTIVE)).toBe(new Date(T0).toISOString())
    await reportDatabaseUnreachable(deps(kv, T0 + MIN), flagFailure)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendDatabaseUnreachableAlert).mock.calls[0][2].what).toBe('heartbeat-checks slack organizations')
  })
})

describe('the all-clear waits for the probe and every reporting read', () => {
  const OPEN = { [RECOVERY]: new Date(T0 - 90 * MIN).toISOString(), [ACTIVE]: new Date(T0 - 60 * MIN).toISOString(), [COOLDOWN]: '1', [CONDITION]: '{"since":"2026-10-15T01:30:00.000Z","alerts":2}' }

  /** Both required sources answered on every minute from `from` to `to`. */
  async function healthyMinutes(kv: ReturnType<typeof fakeKv>, sources: ('probe' | 'volume-cliff')[], from: number, to: number) {
    for (let t = from; t <= to; t += MIN) for (const s of sources) await reportDatabaseReadable(kv, s, t)
  }

  it('holds it while only the probe has answered for the window', async () => {
    const kv = await kvWithCopy(OPEN)
    await healthyMinutes(kv, ['probe'], T0 - 40 * MIN, T0 - MIN)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).not.toHaveBeenCalled()
    expect(kv.store.has(RECOVERY)).toBe(true)
  })

  it('a probe that answers while the volume check reads fail does not stand down', async () => {
    const kv = await kvWithCopy(OPEN)
    await healthyMinutes(kv, ['probe', 'volume-cliff'], T0 - 40 * MIN, T0 - 3 * MIN)
    await reportDatabaseUnreachable(deps(kv, T0 - 2 * MIN), readFailure)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).not.toHaveBeenCalled()
  })

  it('holds it while both have answered for less than the window', async () => {
    const kv = await kvWithCopy(OPEN)
    await healthyMinutes(kv, ['probe', 'volume-cliff'], T0 - (RECOVERY_REARM_MINUTES - 2) * MIN, T0 - MIN)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).not.toHaveBeenCalled()
  })

  it('holds it when the volume check has gone quiet, however long it answered before', async () => {
    const kv = await kvWithCopy(OPEN)
    await healthyMinutes(kv, ['probe', 'volume-cliff'], T0 - 50 * MIN, T0 - 10 * MIN)
    await healthyMinutes(kv, ['probe'], T0 - 9 * MIN, T0 - MIN)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).not.toHaveBeenCalled()
  })

  it('holds it when a scheduled read failed inside the window', async () => {
    const kv = await kvWithCopy(OPEN)
    await healthyMinutes(kv, ['probe', 'volume-cliff'], T0 - 40 * MIN, T0 - MIN)
    await reportDatabaseUnreachable(deps(kv, T0 - 5 * MIN), flagFailure)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).not.toHaveBeenCalled()
  })

  it('holds it for a scheduled read failure that had no copy to stamp the incident with', async () => {
    const kv = await kvWithCopy(OPEN)
    await healthyMinutes(kv, ['probe', 'volume-cliff'], T0 - 40 * MIN, T0 - MIN)
    const copy = kv.store.get(SLACK_CONNS_LASTGOOD_KEY)!
    kv.store.delete(SLACK_CONNS_LASTGOOD_KEY)
    await reportDatabaseUnreachable(deps(kv, T0 - 5 * MIN), flagFailure)
    kv.store.set(SLACK_CONNS_LASTGOOD_KEY, copy)
    expect(kv.store.get(ACTIVE)).toBe(OPEN[ACTIVE])
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).not.toHaveBeenCalled()
  })

  it('sends it once both have answered for the window, saying what was measured, and settles the old keys', async () => {
    const kv = await kvWithCopy(OPEN)
    await healthyMinutes(kv, ['probe', 'volume-cliff'], T0 - 40 * MIN, T0 - MIN)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    expect(sendDatabaseRecoveredAlert).toHaveBeenCalledTimes(1)
    const [, channel, payload] = vi.mocked(sendDatabaseRecoveredAlert).mock.calls[0]
    expect(channel).toBe('C1')
    expect(payload.alertedAt).toBe(OPEN[RECOVERY])
    expect(payload.endedAt).toBe(OPEN[ACTIVE])
    expect(payload.measured).toMatch(/minute database probe/)
    expect(payload.measured).toMatch(/volume check/)
    expect(payload.measured).toMatch(/40 minutes/)
    for (const k of [RECOVERY, ACTIVE, COOLDOWN, CONDITION]) expect(kv.store.has(k)).toBe(false)
    expect(transitions(kv.store)).toEqual([`ended ${ORG} all_clear`])
    expect(outboxEvents(kv.store)[0]).toMatchObject({ signal: 'db-unreachable', scope: 'org', organizationId: ORG, startedAt: OPEN[RECOVERY], endedAt: OPEN[ACTIVE] })
  })
})

describe('the minute probe writes the copy and stamps its heartbeat', () => {
  it('writes the copy from its read, dated by its clock', async () => {
    const kv = fakeKv()
    await runDatabaseReachabilityProbe(probeDeps(kv, T0))
    const copy = JSON.parse(await decryptSecret(kv.store.get(SLACK_CONNS_LASTGOOD_KEY)!, TEST_KEY)) as Record<string, { bot_token?: string } | string>
    expect(copy[SLACK_COPY_SAVED_AT_KEY]).toBe(new Date(T0).toISOString())
    expect((copy[ORG] as { bot_token: string }).bot_token).toBe('xoxb-t')
  })

  it('writes an empty copy when the read answers with no connected organization', async () => {
    const kv = await kvWithCopy()
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, answering([])))
    const copy = JSON.parse(await decryptSecret(kv.store.get(SLACK_CONNS_LASTGOOD_KEY)!, TEST_KEY)) as Record<string, unknown>
    expect(copy).toEqual({ [SLACK_COPY_SAVED_AT_KEY]: new Date(T0).toISOString() })
  })

  it('keeps the copy, and says so, when rows came back but none could be read as a connection', async () => {
    const kv = await kvWithCopy()
    const before = kv.store.get(SLACK_CONNS_LASTGOOD_KEY)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, answering([{ organization_id: ORG, config: { renamed_token: 'x' } }])))
    expect(kv.store.get(SLACK_CONNS_LASTGOOD_KEY)).toBe(before)
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('none could be read as a Slack connection'))).toBe(true)
  })

  it('leaves the copy as it was when its read fails, and reports the failure', async () => {
    const kv = await kvWithCopy()
    const before = kv.store.get(SLACK_CONNS_LASTGOOD_KEY)
    await runDatabaseReachabilityProbe(probeDeps(kv, T0, failing()))
    await runDatabaseReachabilityProbe(probeDeps(kv, T0 + MIN, failing()))
    expect(kv.store.get(SLACK_CONNS_LASTGOOD_KEY)).toBe(before)
    expect(sendDatabaseUnreachableAlert).toHaveBeenCalledTimes(1)
  })

  it('gives up on a read that never answers after its own deadline, and counts it as failed', async () => {
    const kv = await kvWithCopy()
    const timers = fakeTimers('now')
    const supabase = tableClient({ service_connections: 'stall' }).client
    const d = { ...probeDeps(kv, T0, supabase), sleep: timers.sleep }
    const result = await runDatabaseReachabilityProbe(d)
    expect(result.kind).toBe('failed')
    expect(timers.asked).toEqual([DB_PROBE_DEADLINE_MS])
  })

  it('stamps started before it reads and completed after', async () => {
    const kv = fakeKv()
    const d = probeDeps(kv, T0)
    await runDatabaseReachabilityProbe(d)
    expect(d.stamps.started).toHaveBeenCalledTimes(1)
    expect(d.stamps.completed).toHaveBeenCalledTimes(1)
  })

  it('stamps completed even when the probe throws', async () => {
    const kv = fakeKv()
    const supabase = { from: () => { throw new Error('client exploded') } } as never
    const d = probeDeps(kv, T0, supabase)
    await expect(runDatabaseReachabilityProbe(d)).rejects.toThrow('client exploded')
    expect(d.stamps.completed).toHaveBeenCalledTimes(1)
  })
})
