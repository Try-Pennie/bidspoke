import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import {
  OPS_CONNECTION_LOGIN_SIGNAL, OPS_CONNECTION_LOGIN_STATE_KEY, readKeptConnectionLogins, readOpsConnectionName, runOpsConnectionLoginCheck,
  type OpsConnectionLoginDeps,
} from '../ops-connection-logins'
import { recoveryKey, RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { incidentSignal } from '../incident-signals'
import type { ConnectionLoginAlert, ConnectionLoginsReport } from '../ops-gateway-contract'
import { OPS_TICK_REPORT_FRESH_MS, OPS_TICK_REPORT_KEY } from '../ops-gateway'
import { opsConnectionLoginMessage } from '../slack'
import { outboxEvents, transitions } from './_incident-events'

/**
 * The page for an ops connection's login (#2340, phase 10 of #1689): the
 * bidding Worker reads the logins the ops tick judged due (its kept report),
 * pages each one to its organization through the ops-connection-login signal,
 * and sends the all clear once a complete list no longer names it. No ops
 * connection exists in production today, so every behaviour here is proven on
 * lists the test builds.
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

const needs = (over: Partial<ConnectionLoginAlert> = {}): ConnectionLoginAlert => ({
  organization_id: ORG_A, connection_id: CONN_A, service: 'salesforce', state: 'needs_reauth', reason: 'login_refused', since: iso(NOW - 3 * MIN), failures: null, ...over,
})
const failing = (over: Partial<ConnectionLoginAlert> = {}): ConnectionLoginAlert => ({
  ...needs(), state: 'refresh_failing', reason: null, since: iso(NOW - 20 * MIN), failures: 5, ...over,
})
const list = (logins: ConnectionLoginAlert[], complete = true): ConnectionLoginsReport => ({ complete, logins })

function harness(kv = fakeKv()) {
  const sendAlert = vi.fn<OpsConnectionLoginDeps['sendAlert']>(async () => true)
  const sendRecovery = vi.fn<OpsConnectionLoginDeps['sendRecovery']>(async () => true)
  const connectionName = vi.fn<OpsConnectionLoginDeps['connectionName']>(async () => 'Main ops')
  const run = (read: Awaited<ReturnType<OpsConnectionLoginDeps['readLogins']>>, at = NOW) => runOpsConnectionLoginCheck({
    kv, readLogins: async () => read, connectionName, sendAlert, sendRecovery, now: () => at,
  })
  return { kv, sendAlert, sendRecovery, connectionName, run }
}

const judged = (report: ConnectionLoginsReport) => ({ judged: true as const, report })

/** The two dashes the style rule forbids as punctuation, and a spaced hyphen, built so no literal sits in the source. */
const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), ` ${'-'} `]

describe('the page', () => {
  it('pages a connection in needs_reauth to its own organization at once, naming it and its service, and opens its incident', async () => {
    const h = harness()
    const out = await h.run(judged(list([needs()])))
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    const [orgId, alert] = h.sendAlert.mock.calls[0]
    expect(orgId).toBe(ORG_A)
    expect(alert).toMatchObject({ name: 'Main ops', service: 'salesforce', state: 'needs_reauth', reason: 'login_refused', since: iso(NOW - 3 * MIN) })
    expect(h.connectionName).toHaveBeenCalledWith(ORG_A, CONN_A)
    expect(out.paged).toEqual([CONN_A])
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBe(iso(NOW))
    expect(transitions(h.kv.store)).toEqual([`opened ${CONN_A}`, `paged ${CONN_A}`])
    const [opened] = outboxEvents(h.kv.store)
    expect(opened).toMatchObject({ scope: 'org', organizationId: ORG_A, subjectLabel: 'Main ops (Salesforce)' })
  })

  it('pages a connection in refresh_failing with its failures and the start of the streak', async () => {
    const h = harness()
    await h.run(judged(list([failing()])))
    expect(h.sendAlert.mock.calls[0][1]).toMatchObject({ state: 'refresh_failing', failures: 5, since: iso(NOW - 20 * MIN) })
  })

  it('pages only the organization whose connection it is, each its own', async () => {
    const h = harness()
    await h.run(judged(list([needs(), needs({ organization_id: ORG_B, connection_id: CONN_B, service: 'snowflake' })])))
    expect(h.sendAlert.mock.calls.map(([org]) => org)).toEqual([ORG_A, ORG_B])
  })

  it('does not page again while the reminder interval runs, and keeps the incident open', async () => {
    const h = harness()
    await h.run(judged(list([needs()])))
    await h.run(judged(list([needs()])), NOW + MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBe(iso(NOW))
  })

  it('pages at once when a connection in refresh_failing goes on to needs_reauth, the same incident', async () => {
    const h = harness()
    await h.run(judged(list([failing()])))
    await h.run(judged(list([needs()])), NOW + 2 * MIN)
    expect(h.sendAlert.mock.calls.map(([, a]) => a.state)).toEqual(['refresh_failing', 'needs_reauth'])
    expect(transitions(h.kv.store)).toEqual([`opened ${CONN_A}`, `paged ${CONN_A}`, `paged ${CONN_A}`])
  })

  it('still pages when the name cannot be read, saying so rather than naming nothing', async () => {
    const h = harness()
    h.connectionName.mockRejectedValueOnce(new Error('the database did not answer'))
    await h.run(judged(list([needs()])))
    expect(h.sendAlert.mock.calls[0][1].name).toBeNull()
  })

  it('arms nothing when the page did not reach Slack, so the next check tries again', async () => {
    const h = harness()
    h.sendAlert.mockResolvedValueOnce(false)
    await h.run(judged(list([needs()])))
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBeUndefined()
    await h.run(judged(list([needs()])), NOW + MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
  })

  it('a page that throws for one connection leaves the other paged', async () => {
    const h = harness()
    h.sendAlert.mockRejectedValueOnce(new Error('slack is down'))
    const out = await h.run(judged(list([needs(), needs({ organization_id: ORG_B, connection_id: CONN_B })])))
    expect(out.paged).toEqual([CONN_B])
    expect(out.errors.join(' ')).toMatch(/slack is down/)
  })
})

describe('the all clear', () => {
  it('sends the all clear once a complete list no longer names a connection that needed a reconnect, and ends the incident', async () => {
    const h = harness()
    await h.run(judged(list([needs()])))
    const out = await h.run(judged(list([])), NOW + 5 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(1)
    expect(h.sendRecovery.mock.calls[0]).toEqual([ORG_A, { subject: 'Main ops (Salesforce)', alertedAt: iso(NOW), endedAt: iso(NOW), firstHealthyAt: iso(NOW + 5 * MIN) }])
    expect(out.allClear).toEqual([CONN_A])
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBeUndefined()
    expect(transitions(h.kv.store).at(-1)).toBe(`ended ${CONN_A} all_clear`)
    // A relapse after the all clear pages again at once.
    await h.run(judged(list([needs()])), NOW + 6 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
  })

  it('holds the all clear of a refresh_failing incident for the re-arm window, since a provider can flap', async () => {
    const h = harness()
    await h.run(judged(list([failing()])))
    await h.run(judged(list([])), NOW + 5 * MIN)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    await h.run(judged(list([])), NOW + (RECOVERY_REARM_MINUTES + 1) * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(1)
  })

  it('never sends an all clear from a list that is not complete, and keeps the incident open', async () => {
    const h = harness()
    await h.run(judged(list([needs()])))
    await h.run(judged(list([], false)), NOW + 5 * MIN)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBe(iso(NOW))
  })

  it.each([
    ['no report at all', { judged: false as const, why: 'no report' }],
    ['a stale report', { judged: false as const, why: 'the report is 11 minutes old' }],
    ['a tick that judged no login', { judged: false as const, why: 'the tick judged no login' }],
  ])('treats %s as unjudged: no page, no all clear, every open incident kept', async (_label, read) => {
    const h = harness()
    await h.run(judged(list([needs()])))
    h.kv.put.mockClear()
    await h.run(read, NOW + 5 * MIN)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBe(iso(NOW))
    // The marker's expiry is renewed, so an unjudged spell cannot lapse the incident.
    expect(h.kv.put).toHaveBeenCalledWith(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A), iso(NOW), expect.anything())
  })

  it('tries an all clear that did not deliver again on the next check', async () => {
    const h = harness()
    await h.run(judged(list([needs()])))
    h.sendRecovery.mockResolvedValueOnce(false)
    await h.run(judged(list([])), NOW + 5 * MIN)
    await h.run(judged(list([])), NOW + 6 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(2)
    expect(h.kv.store.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, CONN_A))).toBeUndefined()
  })

  it('remembers which connections are owed an all clear, and forgets one whose incident is settled', async () => {
    const h = harness()
    await h.run(judged(list([needs()])))
    expect(JSON.parse(h.kv.store.get(OPS_CONNECTION_LOGIN_STATE_KEY)!)).toEqual({ open: { [CONN_A]: { organization_id: ORG_A, service: 'salesforce', state: 'needs_reauth' } } })
    await h.run(judged(list([])), NOW + 5 * MIN)
    expect(JSON.parse(h.kv.store.get(OPS_CONNECTION_LOGIN_STATE_KEY)!)).toEqual({ open: {} })
  })

  it('never overwrites the open incidents when it could not read them, so an owed all clear survives a failed read', async () => {
    const h = harness()
    await h.run(judged(list([needs()])))
    // The record cannot be read this minute, and the list no longer names the connection.
    const get = h.kv.get.getMockImplementation()!
    h.kv.get.mockImplementation(async (k: string) => {
      if (k === OPS_CONNECTION_LOGIN_STATE_KEY) throw new Error('KV did not answer')
      return get(k)
    })
    const out = await h.run(judged(list([needs({ connection_id: CONN_B, organization_id: ORG_B })])), NOW + 5 * MIN)
    expect(out.errors.join(' ')).toMatch(/could not be read/)
    expect(JSON.parse(h.kv.store.get(OPS_CONNECTION_LOGIN_STATE_KEY)!).open).toHaveProperty(CONN_A)
    // Once it reads again, the all clear owed for the first connection goes.
    h.kv.get.mockImplementation(get)
    await h.run(judged(list([])), NOW + 6 * MIN)
    expect(h.sendRecovery.mock.calls.map(([org]) => org)).toContain(ORG_A)
  })

  it.each([
    ['not JSON', '{"open":'],
    ['an entry with no organization', JSON.stringify({ open: { [CONN_A]: { service: 'salesforce', state: 'needs_reauth' } } })],
  ])('says so when its record of open incidents is %s, rather than reading it as none', async (_label, raw) => {
    const h = harness()
    h.kv.store.set(OPS_CONNECTION_LOGIN_STATE_KEY, raw)
    const out = await h.run(judged(list([])))
    expect(out.errors.join(' ')).toMatch(/could not be read, so its all clear cannot be sent/)
  })

  it('writes its state only when it changes, not every minute', async () => {
    const h = harness()
    await h.run(judged(list([needs()])))
    h.kv.put.mockClear()
    await h.run(judged(list([needs()])), NOW + MIN)
    expect(h.kv.put.mock.calls.filter(([k]) => k === OPS_CONNECTION_LOGIN_STATE_KEY)).toEqual([])
  })
})

describe('readKeptConnectionLogins (the tick\'s kept report)', () => {
  const kept = (over: Record<string, unknown> = {}) => JSON.stringify({
    tick_id: 't', mode: 'observe', scheduled_time: null, started_at: iso(NOW - MIN), finished_at: iso(NOW - MIN), db_now: iso(NOW - MIN),
    outcome: 'ok', problems: [], problem_keys: [], counts: {}, not_configured_secrets: [], start_stamp_failed: false,
    connection_logins: { complete: true, logins: [needs()] }, received_at: iso(NOW - MIN), problem_streaks: [], ...over,
  })
  const read = async (raw: string | null, at = NOW) => {
    const kv = fakeKv()
    if (raw !== null) kv.store.set(OPS_TICK_REPORT_KEY, raw)
    return readKeptConnectionLogins(kv, at)
  }

  it('reads the logins of a fresh report', async () => {
    expect(await read(kept())).toEqual({ judged: true, report: { complete: true, logins: [needs()] } })
  })

  it.each([
    ['no report', null, /no report/],
    ['a report older than the window the heartbeat takes over at', kept({ received_at: iso(NOW - OPS_TICK_REPORT_FRESH_MS - 1) }), /old/],
    ['a report from an ops release before #2340', kept({ connection_logins: undefined }), /judged no login/],
    ['a report whose tick judged no login', kept({ connection_logins: null }), /judged no login/],
    ['a report that cannot be read', '{"tick_id":', /could not be read/],
    ['a report with an unreadable receipt time', kept({ received_at: 'soon' }), /could not be read/],
  ])('is unjudged for %s, never an empty list', async (_label, raw, why) => {
    const out = await read(raw)
    expect(out.judged).toBe(false)
    expect(out.judged === false && out.why).toMatch(why)
  })
})

describe('the copy (plain title, short full sentences, one fix)', () => {
  const words = (alert: Parameters<typeof opsConnectionLoginMessage>[0]) => {
    const m = opsConnectionLoginMessage(alert)
    return `${m.title}\n${m.sections.join('\n')}`
  }

  it.each([
    ['login_refused', /Salesforce refused the login/],
    ['refused_after_renew', /refused its requests even after a new login/],
    ['refresh_exhausted', /sign in service failed every sign in of .* for more than 15 minutes/],
    ['other', /login of .* stopped working/],
  ] as const)('says needs_reauth (%s) in words, with when and what to do', (reason, finding) => {
    const text = words({ name: 'Main ops', service: 'salesforce', state: 'needs_reauth', reason, since: '2026-10-19T17:57:00.000Z', failures: null })
    expect(text).toMatch(/^An ops connection needs to be reconnected/)
    expect(text).toMatch(finding)
    expect(text).toMatch(/Main ops/)
    expect(text).toMatch(/Oct 19, 1:57 PM E[DS]T/)
    expect(text).toMatch(/\*Fix:\* reconnect it on the Connections page/)
  })

  it('says refresh_failing with its failures and what happens next', () => {
    const text = words({ name: 'Main ops', service: 'snowflake', state: 'refresh_failing', reason: null, since: '2026-10-19T17:40:00.000Z', failures: 6 })
    expect(text).toMatch(/^An ops connection cannot sign in/)
    expect(text).toMatch(/failed to sign in 6 times in a row since Oct 19, 1:40 PM E[DS]T/)
    expect(text).toMatch(/next failed sign in will mark it as needing to be reconnected/)
    expect(text).toMatch(/\*Fix:\* check whether Snowflake is having an outage/)
  })

  it('names a connection whose name could not be read by its service, and escapes a name\'s markup', () => {
    expect(words({ name: null, service: 'salesforce', state: 'needs_reauth', reason: 'other', since: '2026-10-19T17:57:00.000Z', failures: null })).toMatch(/an ops Salesforce connection/)
    expect(words({ name: '<!channel> & co', service: 'salesforce', state: 'needs_reauth', reason: 'other', since: '2026-10-19T17:57:00.000Z', failures: null })).toMatch(/&lt;!channel&gt; &amp; co/)
  })

  it('carries no dash as punctuation', () => {
    for (const state of ['needs_reauth', 'refresh_failing'] as const) {
      const text = words({ name: 'Main ops', service: 'salesforce', state, reason: state === 'needs_reauth' ? 'login_refused' : null, since: '2026-10-19T17:57:00.000Z', failures: state === 'needs_reauth' ? null : 5 })
      for (const d of DASHES) expect(text.includes(d), JSON.stringify(d)).toBe(false)
    }
  })
})

describe('the signal', () => {
  it('records its incidents as an organization signal keyed on the connection, with its two kinds', () => {
    expect(incidentSignal(OPS_CONNECTION_LOGIN_SIGNAL)).toMatchObject({
      signal: 'ops-connection-login', scope: 'org', subject: 'connection', windowMinutes: null, kinds: ['needs_reauth', 'refresh_failing'],
    })
  })
})

describe('readOpsConnectionName (the name the page and the incident use)', () => {
  function client(answer: { status: number; body: unknown }) {
    const urls: string[] = []
    const fakeFetch = (async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : input.toString())
      return Response.json(answer.body, { status: answer.status })
    }) as typeof fetch
    const supabase = createClient('https://example.supabase.co', 'sb_secret_test', { global: { fetch: fakeFetch }, auth: { persistSession: false } }) as unknown as SupabaseClient
    return { supabase, urls }
  }

  it('reads the name of the connection inside its own organization only, and nothing else of the row', async () => {
    const c = client({ status: 200, body: [{ name: 'Main ops' }] })
    expect(await readOpsConnectionName(c.supabase, ORG_A, CONN_A)).toBe('Main ops')
    const url = new URL(c.urls[0])
    expect(url.pathname).toBe('/rest/v1/service_connections')
    expect(url.searchParams.get('select')).toBe('name')
    expect(url.searchParams.get('organization_id')).toBe(`eq.${ORG_A}`)
    expect(url.searchParams.get('id')).toBe(`eq.${CONN_A}`)
  })

  it('answers null for a connection with no row, which was removed', async () => {
    expect(await readOpsConnectionName(client({ status: 200, body: [] }).supabase, ORG_A, CONN_A)).toBeNull()
  })

  it('throws on a failed read rather than answering no name', async () => {
    await expect(readOpsConnectionName(client({ status: 500, body: { message: 'boom' } }).supabase, ORG_A, CONN_A)).rejects.toThrow()
  })
})
