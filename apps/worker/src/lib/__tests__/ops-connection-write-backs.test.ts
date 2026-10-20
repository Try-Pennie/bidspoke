import { describe, expect, it, vi } from 'vitest'
import {
  OPS_CONNECTION_LOGIN_SIGNAL, OPS_CONNECTION_LOGIN_STATE_KEY, OPS_CONNECTION_WRITE_BACK_SIGNAL, OPS_CONNECTION_WRITE_BACK_STATE_KEY, readKeptWriteBacks, runOpsConnectionLoginCheck,
  runOpsConnectionWriteBackCheck, type OpsConnectionWriteBackDeps,
} from '../ops-connection-logins'
import { recoveryKey } from '../alert-recovery'
import { incidentSignal } from '../incident-signals'
import type { WriteBackAlert, WriteBacksReport } from '../ops-gateway-contract'
import { OPS_TICK_WRITE_BACKS_FRESH_MS, OPS_TICK_WRITE_BACKS_KEY } from '../ops-gateway'
import { opsConnectionWriteBackMessage } from '../slack'
import { outboxEvents, transitions } from './_incident-events'

/**
 * The page for a person bound login whose write back is pending (#2340, phase
 * 10 item 4 of #1689; the requirement is #2425's): the ops tick asks each
 * connection's ConnectionTokenObject on the connection check's interval and
 * lists each one pending past its bound; the bidding Worker keeps that list
 * apart from the tick's report (OPS_TICK_WRITE_BACKS_KEY), pages each one to
 * its organization through the ops-connection-write-back signal, and sends the
 * all clear once a complete list no longer names it. No ops connection exists
 * in production today, so every behaviour is proven on lists the test builds.
 */

const NOW = Date.parse('2026-10-19T18:00:00.000Z')
const MIN = 60_000
const ORG_A = '0b4c6a2e-6f3e-4d8a-9a51-1d1c4a0f7a11'
const ORG_B = '7e2f9c10-3b6d-4f55-8c2a-5a9e0d3b6c22'
const CONN_A = '00000000-0000-4000-8000-0000000c2341'
const CONN_B = '00000000-0000-4000-8000-0000000c2342'
const iso = (ms: number) => new Date(ms).toISOString()

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, _opts?: { expirationTtl?: number }) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

const waiting = (over: Partial<WriteBackAlert> = {}): WriteBackAlert => ({
  organization_id: ORG_A, connection_id: CONN_A, service: 'google_user', since: iso(NOW - 40 * MIN), attempts: 6, ...over,
})
const list = (pending: WriteBackAlert[], complete = true): WriteBacksReport => ({ complete, pending })
const judged = (report: WriteBacksReport) => ({ judged: true as const, report })

function harness(kv = fakeKv()) {
  const sendAlert = vi.fn<OpsConnectionWriteBackDeps['sendAlert']>(async () => true)
  const sendRecovery = vi.fn<OpsConnectionWriteBackDeps['sendRecovery']>(async () => true)
  const connectionName = vi.fn<OpsConnectionWriteBackDeps['connectionName']>(async () => 'Shared inbox')
  const run = (read: Awaited<ReturnType<OpsConnectionWriteBackDeps['readWriteBacks']>>, at = NOW) => runOpsConnectionWriteBackCheck({
    kv, readWriteBacks: async () => read, connectionName, sendAlert, sendRecovery, now: () => at,
  })
  return { kv, sendAlert, sendRecovery, connectionName, run }
}

/** The two dashes the style rule forbids as punctuation, and a spaced hyphen, built so no literal sits in the source. */
const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), ` ${'-'} `]

describe('the page', () => {
  it('with no ops connection (today), nothing is pending and nothing pages', async () => {
    const h = harness()
    const out = await h.run(judged(list([])))
    expect(out).toEqual({ judged: true, paged: [], allClear: [], errors: [] })
    expect(h.sendAlert).not.toHaveBeenCalled()
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(outboxEvents(h.kv.store)).toEqual([])
  })

  it('pages a write back pending past the bound to its own organization, naming the connection and its service, since when and the tries, and opens its incident', async () => {
    const h = harness()
    const out = await h.run(judged(list([waiting()])))
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    const [orgId, alert] = h.sendAlert.mock.calls[0]
    expect(orgId).toBe(ORG_A)
    expect(alert).toEqual({ name: 'Shared inbox', service: 'google_user', since: iso(NOW - 40 * MIN), attempts: 6 })
    expect(h.connectionName).toHaveBeenCalledWith(ORG_A, CONN_A)
    expect(out.paged).toEqual([CONN_A])
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_WRITE_BACK_SIGNAL, CONN_A))).toBe(iso(NOW))
    expect(transitions(h.kv.store)).toEqual([`opened ${CONN_A}`, `paged ${CONN_A}`])
    const [opened] = outboxEvents(h.kv.store)
    expect(opened).toMatchObject({ signal: OPS_CONNECTION_WRITE_BACK_SIGNAL, scope: 'org', organizationId: ORG_A, subjectLabel: 'Shared inbox (Google user)' })
  })

  it('pages one pending since a time never recorded, saying it is unknown', async () => {
    const h = harness()
    await h.run(judged(list([waiting({ since: null })])))
    expect(h.sendAlert.mock.calls[0][1].since).toBeNull()
  })

  it('pages only the organization whose connection it is, each its own', async () => {
    const h = harness()
    await h.run(judged(list([waiting(), waiting({ organization_id: ORG_B, connection_id: CONN_B })])))
    expect(h.sendAlert.mock.calls.map(([org]) => org)).toEqual([ORG_A, ORG_B])
  })

  it('does not page again while the reminder interval runs, though the count of tries grows, and keeps the incident open', async () => {
    const h = harness()
    await h.run(judged(list([waiting()])))
    await h.run(judged(list([waiting({ attempts: 7 })])), NOW + 15 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_WRITE_BACK_SIGNAL, CONN_A))).toBe(iso(NOW))
  })

  it('is its own incident beside a login page about the same connection: neither silences nor clears the other', async () => {
    const h = harness()
    await h.run(judged(list([waiting()])))
    await runOpsConnectionLoginCheck({
      kv: h.kv,
      readLogins: async () => ({ judged: true, report: { complete: true, logins: [{ organization_id: ORG_A, connection_id: CONN_A, service: 'google_user', state: 'needs_reauth', reason: 'login_refused', since: iso(NOW), failures: null }] } }),
      connectionName: async () => 'Shared inbox', sendAlert: async () => true, sendRecovery: async () => true, now: () => NOW + MIN,
    })
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBe(iso(NOW + MIN))
    // The write back lands: its all clear goes, and the login's incident stands.
    await h.run(judged(list([])), NOW + 20 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(1)
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_WRITE_BACK_SIGNAL, CONN_A))).toBeUndefined()
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBe(iso(NOW + MIN))
  })

  it('arms nothing when the page did not reach Slack, so the next check tries again', async () => {
    const h = harness()
    h.sendAlert.mockResolvedValueOnce(false)
    await h.run(judged(list([waiting()])))
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_WRITE_BACK_SIGNAL, CONN_A))).toBeUndefined()
    await h.run(judged(list([waiting()])), NOW + MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
  })
})

describe('the all clear', () => {
  it('is sent once a complete list no longer names the connection, the write back having landed, and ends the incident', async () => {
    const h = harness()
    await h.run(judged(list([waiting()])))
    const out = await h.run(judged(list([])), NOW + 15 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(1)
    expect(h.sendRecovery.mock.calls[0]).toEqual([ORG_A, { subject: 'Shared inbox (Google user)', alertedAt: iso(NOW), endedAt: iso(NOW) }])
    expect(out.allClear).toEqual([CONN_A])
    expect(transitions(h.kv.store).at(-1)).toBe(`ended ${CONN_A} all_clear`)
    expect(JSON.parse(h.kv.store.get(OPS_CONNECTION_WRITE_BACK_STATE_KEY)!)).toEqual({ open: {} })
  })

  it('is never sent from a list that is not complete (an object that could not say), and the incident is kept', async () => {
    const h = harness()
    await h.run(judged(list([waiting()])))
    await h.run(judged(list([], false)), NOW + 15 * MIN)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_WRITE_BACK_SIGNAL, CONN_A))).toBe(iso(NOW))
  })

  it.each([
    ['no judgement kept', { judged: false as const, why: 'the ops tick has judged no write back' }],
    ['a stale judgement', { judged: false as const, why: 'the last write back judgement is 40 minutes old' }],
  ])('treats %s as unjudged: no page, no all clear, every open incident kept alive', async (_label, read) => {
    const h = harness()
    await h.run(judged(list([waiting()])))
    h.kv.put.mockClear()
    const out = await h.run(read, NOW + 15 * MIN)
    expect(out.judged).toBe(false)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(h.kv.put).toHaveBeenCalledWith(recoveryKey(OPS_CONNECTION_WRITE_BACK_SIGNAL, CONN_A), iso(NOW), expect.anything())
  })
})

describe('readKeptWriteBacks (the judgement the bidding Worker keeps apart from the report)', () => {
  const kept = (over: Record<string, unknown> = {}) => JSON.stringify({ tick_id: 't', received_at: iso(NOW - 14 * MIN), write_backs: list([waiting()]), ...over })
  const read = async (raw: string | null, at = NOW) => {
    const kv = fakeKv()
    if (raw !== null) kv.store.set(OPS_TICK_WRITE_BACKS_KEY, raw)
    return readKeptWriteBacks(kv, at)
  }

  it('reads a judgement younger than two connection check intervals', async () => {
    expect(await read(kept())).toEqual({ judged: true, report: list([waiting()]) })
    expect(OPS_TICK_WRITE_BACKS_FRESH_MS).toBeGreaterThan(2 * 16 * MIN)
  })

  it.each([
    ['nothing kept', null, /judged no write back/],
    ['a judgement older than its window', kept({ received_at: iso(NOW - OPS_TICK_WRITE_BACKS_FRESH_MS - 1) }), /minutes old/],
    ['a judgement that cannot be read', '{"write_backs":', /could not be read/],
    ['a list that cannot be read', kept({ write_backs: { complete: true, pending: [{ connection_id: 'x' }] } }), /could not be read/],
    ['an unreadable receipt time', kept({ received_at: 'soon' }), /could not be read/],
  ])('is unjudged for %s, never an empty list', async (_label, raw, why) => {
    const out = await read(raw)
    expect(out.judged).toBe(false)
    expect(out.judged === false && out.why).toMatch(why)
  })

  it('is unjudged, never an empty list, when KV cannot be read', async () => {
    const kv = fakeKv()
    kv.get.mockRejectedValueOnce(new Error('KV did not answer'))
    const out = await readKeptWriteBacks(kv, NOW)
    expect(out).toMatchObject({ judged: false })
  })
})

describe('the copy (plain title, short full sentences, what the reader must do)', () => {
  const words = (alert: Parameters<typeof opsConnectionWriteBackMessage>[0]) => {
    const m = opsConnectionWriteBackMessage(alert)
    return `${m.title}\n${m.sections.join('\n')}`
  }

  it('names the connection, its service, since when and the tries, why it matters, and what to do', () => {
    const text = words({ name: 'Shared inbox', service: 'google_user', since: '2026-10-19T17:20:00.000Z', attempts: 6 })
    expect(text).toMatch(/^A new login of an ops connection is not saved/)
    expect(text).toMatch(/Google user connection named Shared inbox/)
    expect(text).toMatch(/Oct 19, 1:20 PM E[DS]T/)
    expect(text).toMatch(/6 tries to save it have failed/)
    expect(text).toMatch(/only copy/)
    expect(text).toMatch(/\*Fix:\*/)
    expect(text).toMatch(/store_rotated_envelope/)
    expect(text).toMatch(/Reconnecting it does not help/)
  })

  it('says a time never recorded is not known, rather than naming one', () => {
    expect(words({ name: 'Shared inbox', service: 'google_user', since: null, attempts: 2 })).toMatch(/at a time the ops Worker did not record/)
  })

  it('names a connection whose name could not be read by its service, escapes a name\'s markup, and says one try in the singular', () => {
    expect(words({ name: null, service: 'google_user', since: null, attempts: 1 })).toMatch(/^An ops Google user connection signed in/m)
    expect(words({ name: null, service: 'google_user', since: null, attempts: 1 })).toMatch(/1 try to save it has failed/)
    expect(words({ name: '<!channel> & co', service: 'google_user', since: null, attempts: 2 })).toMatch(/&lt;!channel&gt; &amp; co/)
  })

  it('carries no dash as punctuation', () => {
    for (const since of [null, '2026-10-19T17:20:00.000Z']) {
      const text = words({ name: 'Shared inbox', service: 'google_user', since, attempts: 6 })
      for (const d of DASHES) expect(text.includes(d), JSON.stringify(d)).toBe(false)
    }
  })
})

describe('the signal', () => {
  it('records its incidents as an organization signal keyed on the connection, apart from the login signal', () => {
    expect(incidentSignal(OPS_CONNECTION_WRITE_BACK_SIGNAL)).toMatchObject({
      signal: 'ops-connection-write-back', scope: 'org', subject: 'connection', windowMinutes: null, kinds: ['write_back_pending'],
    })
    expect(OPS_CONNECTION_WRITE_BACK_STATE_KEY).not.toBe(OPS_CONNECTION_LOGIN_STATE_KEY)
  })
})
