import { describe, expect, it, vi } from 'vitest'
import { announceRecovery, recoveryKey, type PostAttempt } from '../alert-recovery'
import { connectionIncident, settleConnectionIncidents, type ConnectionIncidentFinding, type ConnectionIncidentsOptions } from '../standing-connection-incidents'
import { transitions } from './_incident-events'

/**
 * The open incident bookkeeping every connection check shares (#2761, #2947),
 * proven here for what a check brings of its own: the record it keeps with each
 * open incident (the daily checks keep a label, the minute login check keeps
 * the connection's service and login state), how it reads that record back,
 * how it sends its all clear from it, and what it settles once the incident is
 * over. The daily checks' own tests (ops-connection-owner-check,
 * http-money-host-check) and the minute checks' (ops-connection-logins,
 * ops-connection-write-backs) prove the rest through their callers.
 */

const NOW = Date.parse('2026-10-28T15:00:00.000Z')
const MIN = 60_000
const ORG = '0b4c6a2e-6f3e-4d8a-9a51-1d1c4a0f7a11'
const CONN = '00000000-0000-4000-8000-0000000c2947'
const SIGNAL = 'ops-connection-login'
const STATE_KEY = 'test-incidents:state'
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

/** A record of the minute login check's shape: no label, a service and a state. */
interface LoginOpen { organization_id: string; service: string; state: string }

const readLoginOpen = (value: unknown): LoginOpen | null => {
  const o = value as Partial<LoginOpen> | null
  return o && typeof o.organization_id === 'string' && typeof o.service === 'string' && (o.state === 'needs_reauth' || o.state === 'refresh_failing')
    ? { organization_id: o.organization_id, service: o.service, state: o.state }
    : null
}

function harness(kv = fakeKv()) {
  let at = NOW
  const send = vi.fn(async (_firstReportedAt: string | null): Promise<PostAttempt> => 'sent')
  const announce = vi.fn<ConnectionIncidentsOptions<LoginOpen>['announce']>(async (id, open) => {
    return announceRecovery(kv, SIGNAL, id, null, connectionIncident(open.organization_id, `${open.service} label`, []), async () => true, { now: at, rearmMinutes: 0 })
  })
  const settled = vi.fn(async (_id: string) => {})
  const finding = (state = 'needs_reauth'): ConnectionIncidentFinding<LoginOpen> => ({
    id: CONN, label: 'Main ops (Salesforce)', open: { organization_id: ORG, service: 'salesforce', state }, send,
  })
  const run = (findings: ConnectionIncidentFinding<LoginOpen>[] | null, when = NOW, unjudged?: () => boolean) => {
    at = when
    const errors: string[] = []
    return settleConnectionIncidents({
      kv, signal: SIGNAL, stateKey: STATE_KEY, nowMs: when, findings, readOpen: readLoginOpen, unjudged, announce, settled, errors,
    }).then((outcome) => ({ ...outcome, errors }))
  }
  return { kv, send, announce, settled, finding, run }
}

describe('settleConnectionIncidents: the record a check keeps with each open incident', () => {
  it('keeps the record the check gives, in its own shape, and hands it back to the all clear', async () => {
    const h = harness()
    const paged = await h.run([h.finding('refresh_failing')])
    expect(paged.paged).toEqual([CONN])
    expect(JSON.parse(h.kv.store.get(STATE_KEY)!)).toEqual({ open: { [CONN]: { organization_id: ORG, service: 'salesforce', state: 'refresh_failing' } } })
    const cleared = await h.run([], NOW + 5 * MIN)
    expect(h.announce).toHaveBeenCalledWith(CONN, { organization_id: ORG, service: 'salesforce', state: 'refresh_failing' })
    expect(cleared.allClear).toEqual([CONN])
    expect(JSON.parse(h.kv.store.get(STATE_KEY)!)).toEqual({ open: {} })
  })

  it('keeps the newest record of a connection still found, so a change of state is what its all clear reads', async () => {
    const h = harness()
    await h.run([h.finding('refresh_failing')])
    await h.run([h.finding('needs_reauth')], NOW + MIN)
    expect(JSON.parse(h.kv.store.get(STATE_KEY)!).open[CONN].state).toBe('needs_reauth')
  })

  it('counts a stored record the check cannot read, says its incident closes as lapsed, and drops it', async () => {
    const h = harness()
    h.kv.store.set(STATE_KEY, JSON.stringify({ open: { [CONN]: { organization_id: ORG, service: 'salesforce', state: 'gone_sideways' } } }))
    const out = await h.run([])
    expect(out.errors.join(' ')).toMatch(/1 open incident record could not be read, so its all clear cannot be sent; each closes as lapsed when its marker expires/)
    expect(h.announce).not.toHaveBeenCalled()
  })

  it('arms the incident only once the page reached Slack, and keeps the record either way', async () => {
    const h = harness()
    h.send.mockResolvedValueOnce('not_sent')
    const out = await h.run([h.finding()])
    expect(out.paged).toEqual([])
    expect(h.kv.store.get(recoveryKey(SIGNAL, CONN))).toBeUndefined()
    expect(JSON.parse(h.kv.store.get(STATE_KEY)!).open).toHaveProperty(CONN)
    await h.run([h.finding()], NOW + MIN)
    expect(h.send).toHaveBeenLastCalledWith(null)
    expect(h.kv.store.get(recoveryKey(SIGNAL, CONN))).toBe(iso(NOW + MIN))
    // The refused page is recorded as not delivered (#3056), the delivered one as paged.
    expect(transitions(h.kv.store)).toEqual([`undelivered ${CONN}`, `opened ${CONN}`, `paged ${CONN}`])
  })

  it.each<PostAttempt>(['in_cooldown', 'claimed_elsewhere', 'not_tried'])('records nothing for a page this run did not try (%s), since none was refused (#3056)', async (attempt) => {
    const h = harness()
    h.send.mockResolvedValueOnce(attempt)
    const out = await h.run([h.finding()])
    expect(out.paged).toEqual([])
    expect(transitions(h.kv.store)).toEqual([])
  })
})

describe('settleConnectionIncidents: settling an incident', () => {
  it('settles one whose page never reached Slack without an all clear, since none is owed', async () => {
    const h = harness()
    h.send.mockResolvedValueOnce('not_sent')
    await h.run([h.finding()])
    const out = await h.run([], NOW + MIN)
    expect(h.announce).not.toHaveBeenCalled()
    expect(h.settled).toHaveBeenCalledWith(CONN)
    expect(out.allClear).toEqual([])
    expect(JSON.parse(h.kv.store.get(STATE_KEY)!)).toEqual({ open: {} })
  })

  it('settles one once its all clear reached Slack, and not while it did not', async () => {
    const h = harness()
    await h.run([h.finding()])
    h.announce.mockResolvedValueOnce(false)
    const held = await h.run([], NOW + MIN)
    expect(held.allClear).toEqual([])
    expect(h.settled).not.toHaveBeenCalled()
    expect(JSON.parse(h.kv.store.get(STATE_KEY)!).open).toHaveProperty(CONN)
    const sent = await h.run([], NOW + 2 * MIN)
    expect(sent.allClear).toEqual([CONN])
    expect(h.settled).toHaveBeenCalledWith(CONN)
  })

  it('keeps an incident whose settling failed, so its all clear is asked for again', async () => {
    const h = harness()
    await h.run([h.finding()])
    h.settled.mockRejectedValueOnce(new Error('KV did not answer'))
    const out = await h.run([], NOW + MIN)
    expect(out.allClear).toEqual([])
    expect(out.errors.join(' ')).toMatch(/the all clear failed: .*KV did not answer/)
    expect(JSON.parse(h.kv.store.get(STATE_KEY)!).open).toHaveProperty(CONN)
  })

  it('neither announces nor settles one the run did not judge, and keeps its marker alive', async () => {
    const h = harness()
    await h.run([h.finding()])
    h.kv.put.mockClear()
    await h.run([], NOW + MIN, () => true)
    expect(h.announce).not.toHaveBeenCalled()
    expect(h.settled).not.toHaveBeenCalled()
    expect(h.kv.put).toHaveBeenCalledWith(recoveryKey(SIGNAL, CONN), iso(NOW), expect.anything())
  })
})
