import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakePostgrest, type FakePostgrest, type Row } from '../../__tests__/helpers/postgrest-fake'
import {
  HTTP_MONEY_HOST_JOB,
  HTTP_MONEY_HOST_SIGNAL,
  HTTP_MONEY_HOST_STATE_KEY,
  liveHttpMoneyHostReads,
  runHttpMoneyHostCheck,
  storedHttpHost,
  type HttpMoneyHostDeps,
} from '../http-money-host-check'
import { recoveryKey } from '../alert-recovery'
import { incidentSignal } from '../incident-signals'
import { cronJob } from '../cron-heartbeat'
import { httpMoneyHostMessage, httpMoneyHostRecoveryWording, type HttpMoneyHostAlert } from '../slack'
import type { Env } from '../../index'

/**
 * #2761: the daily recheck of saved HTTP connections. A save refuses a host
 * bidding sends to (connection-money-targets.ts, moneyHostOf), but only at the
 * save, so a host bidding starts sending to later was never caught. Once a day
 * this recomputes the money hosts with the same moneyHostsFrom and pages the
 * connection's organization for each saved HTTP connection whose host is now
 * among them. Alert only (Dan, 2026-10-28): the connection keeps working.
 */

vi.mock('../salesforce-creds', () => ({ resolveSalesforceCredsFor: vi.fn() }))
const { resolveSalesforceCredsFor } = await import('../salesforce-creds')

let db: FakePostgrest

const NOW = Date.parse('2026-10-28T13:00:00.000Z')
const DAY = 24 * 60 * 60_000
const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const REGAL = '33333333-3333-4333-8333-333333333333'
const LENDER = '44444444-4444-4444-8444-444444444444'
const SLACK_ROW = '66666666-6666-4666-8666-666666666666'
const PARTNER = '77777777-7777-4777-8777-777777777777'

const ENV = {
  SUPABASE_URL: 'https://moneyref0123456789ab.supabase.co',
  APP_URL: 'https://bidspoke.trypennie.dev',
} as unknown as Env

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}
type Kv = ReturnType<typeof memoryKv>

const wf = (id: string, organization_id: string, name: string, extra: Row) =>
  ({ id, organization_id, name, is_active: true, deleted_at: null, lane: 'ops', updated_at: '2026-10-27T12:00:00.000000+00:00', ...extra })

/** Two HTTP connections saved when neither host was one bidding sends to, and a partner that does not name either. */
function tables(): Record<string, Row[]> {
  return {
    service_connections: [
      { id: SLACK_ROW, organization_id: ORG, name: 'slack', service_type: 'slack', sealed_for: 'bidding_ring', target: null },
      { id: REGAL, organization_id: ORG, name: 'Regal events', service_type: 'http', sealed_for: 'ops_key', target: { host: 'api.regal.io', header: 'Authorization', check_path: '/v1/ping' } },
      { id: LENDER, organization_id: ORG, name: 'Lender hook', service_type: 'http', sealed_for: 'ops_key', target: { host: 'api.lender.example', header: 'X-Key', check_path: '/ping' } },
    ],
    partner_configs: [
      { id: PARTNER, organization_id: ORG, slug: 'lendco', name: 'Lendco', api_endpoint: 'https://api.partner-one.example/leads', dedup_endpoint: null, click_url: null },
    ],
    workflows: [
      wf('wf-money', ORG, 'Engine Bidding', { lane: 'money', definition: { nodes: [{ id: 'n1', type: 'http', config: { url: 'https://api.partner-two.example/bid' } }] } }),
      wf('wf-a', ORG, 'Daily lead sync', { definition: { nodes: [{ id: 'n1', type: 'app_action', config: { connection_id: LENDER } }] } }),
      wf('wf-b', ORG, 'Old export', { is_active: false, definition: { nodes: [{ id: 'n1', config: { connection: { id: LENDER } } }] } }),
      wf('wf-c', ORG, 'Regal sync', { definition: { nodes: [{ id: 'n1', config: { connection_id: REGAL } }] } }),
    ],
  }
}

/** The lender's host is now one bidding sends to: a partner's endpoint was changed to it after the connection was saved. */
function lenderBecameAPartner(t = tables()): Record<string, Row[]> {
  t.partner_configs[0].api_endpoint = 'https://api.lender.example/v2/leads'
  return t
}

function deps(over: Partial<HttpMoneyHostDeps> = {}) {
  const kv = (over.kv as Kv | undefined) ?? memoryKv()
  const d: HttpMoneyHostDeps = {
    kv,
    reads: liveHttpMoneyHostReads(db.client, ENV),
    sendAlert: vi.fn(async (_orgId: string, _alert: HttpMoneyHostAlert) => true),
    sendRecovery: vi.fn(async (_orgId: string, _r: { subject: string; alertedAt: string; endedAt: string | null }) => true),
    reportUnreadable: vi.fn(async (_problems: string[]) => undefined),
    reportReadable: vi.fn(async () => undefined),
    now: () => NOW,
    ...over,
  }
  return { d, kv, sendAlert: vi.mocked(d.sendAlert), sendRecovery: vi.mocked(d.sendRecovery), reportUnreadable: vi.mocked(d.reportUnreadable), reportReadable: vi.mocked(d.reportReadable) }
}

const marker = (kv: Kv, id = LENDER) => kv.store.get(recoveryKey(HTTP_MONEY_HOST_SIGNAL, id))

/** A client whose reads of one table fail as PostgREST answers a refused query; every other table is the fake's. */
function failingOn(table: string): SupabaseClient {
  const refused = { data: null, error: { message: `permission denied for table ${table}`, code: '42501' } }
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'order', 'range', 'limit']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(refused).then(resolve)
  return { from: (t: string) => (t === table ? chain : db.client.from(t)) } as unknown as SupabaseClient
}

beforeEach(() => {
  db = fakePostgrest(tables())
  vi.mocked(resolveSalesforceCredsFor).mockReset()
  vi.mocked(resolveSalesforceCredsFor).mockResolvedValue({
    creds: { instanceUrl: 'https://lendco.my.salesforce.com', clientId: 'cid', clientSecret: 'secret' } as never,
    missing: [],
  })
})

describe('the registrations', () => {
  it('has a daily heartbeat entry and an organization scoped incident signal keyed on the connection', () => {
    expect(cronJob(HTTP_MONEY_HOST_JOB)).toMatchObject({ triggerCron: '0 13 * * *' })
    expect(incidentSignal(HTTP_MONEY_HOST_SIGNAL)).toMatchObject({ scope: 'org', subject: 'connection', windowMinutes: null, label: 'HTTP connection to a bidding host' })
  })
})

describe('storedHttpHost', () => {
  it('reads the stored host as the save reads it, whole addresses and case included', () => {
    expect(storedHttpHost({ host: 'API.Lender.example' })).toBe('api.lender.example')
    expect(storedHttpHost({ host: 'https://api.lender.example/v2/leads' })).toBe('api.lender.example')
  })

  it('reads a host another catalogue service owns, since bidding may send there too', () => {
    expect(storedHttpHost({ host: 'acme.my.salesforce.com' })).toBe('acme.my.salesforce.com')
  })

  it.each([[null], [{}], [{ host: 12 }], [{ host: 'http://api.lender.example' }], [{ host: '10.0.0.1' }], [['api.lender.example']]])('answers null for a target it cannot read a host from: %j', (target) => {
    expect(storedHttpHost(target)).toBeNull()
  })
})

describe('runHttpMoneyHostCheck', () => {
  it('is quiet while no saved HTTP connection reaches a host bidding sends to', async () => {
    const { d, kv, sendAlert, sendRecovery, reportUnreadable, reportReadable } = deps()
    const s = await runHttpMoneyHostCheck(d)
    expect(s).toMatchObject({ judged: true, connections: 2, found: [], paged: [], allClear: [], unreadable: [] })
    expect(sendAlert).not.toHaveBeenCalled()
    expect(sendRecovery).not.toHaveBeenCalled()
    expect(reportUnreadable).not.toHaveBeenCalled()
    // A clean run stands down an earlier could-not-run page.
    expect(reportReadable).toHaveBeenCalledTimes(1)
    // Only HTTP connections are read, and never their login.
    const read = db.requests.find((r) => r.path === 'service_connections')!
    expect(read.params.get('service_type')).toBe('eq.http')
    expect(read.params.get('select')).not.toMatch(/credential|config/)
    expect(kv.store.size).toBe(0)
  })

  it('pages the connection\'s organization once a partner endpoint names its host, naming the connection, the host, where bidding sends to it and the workflows', async () => {
    db = fakePostgrest(lenderBecameAPartner())
    const { d, kv, sendAlert, reportUnreadable, reportReadable } = deps()
    const s = await runHttpMoneyHostCheck(d)
    expect(s).toMatchObject({ judged: true, connections: 2, found: [LENDER], paged: [LENDER] })
    expect(sendAlert).toHaveBeenCalledTimes(1)
    const [orgId, alert] = sendAlert.mock.calls[0]
    expect(orgId).toBe(ORG)
    expect(alert).toEqual({
      name: 'Lender hook',
      host: 'api.lender.example',
      source: 'partner_configs',
      origin: { kind: 'partner', slug: 'lendco', name: 'Lendco' },
      // Every workflow naming it is read; the page itself lists the active ones.
      workflows: [{ id: 'wf-a', name: 'Daily lead sync', active: true }, { id: 'wf-b', name: 'Old export', active: false }],
      firstReportedAt: null,
    })
    expect(reportUnreadable).not.toHaveBeenCalled()
    expect(reportReadable).toHaveBeenCalledTimes(1)
    // The incident is opened on the delivered page, and kept for its all clear.
    expect(marker(kv)).toBe(new Date(NOW).toISOString())
    // The open incident keeps the partner the page named, for the all clear.
    expect(JSON.parse(kv.store.get(HTTP_MONEY_HOST_STATE_KEY)!)).toEqual({
      open: { [LENDER]: { organization_id: ORG, label: 'Lender hook (HTTP)', context: { source: 'partner_configs', origin_kind: 'partner', origin_ref: 'lendco', origin_name: 'Lendco' } } },
    })
  })

  it('pages a host written in a money workflow, and a host under the bidding Worker\'s zone', async () => {
    const t = tables()
    t.service_connections[1].target = { host: 'api.partner-two.example', header: 'Authorization', check_path: '/ping' }
    t.service_connections[2].target = { host: 'hooks.trypennie.dev', header: 'X-Key', check_path: '/ping' }
    db = fakePostgrest(t)
    const { d, sendAlert } = deps()
    const s = await runHttpMoneyHostCheck(d)
    expect(s.found.sort()).toEqual([REGAL, LENDER].sort())
    const bySource = Object.fromEntries(sendAlert.mock.calls.map(([, a]) => [a.name, [a.source, a.origin]]))
    expect(bySource).toEqual({
      'Regal events': ['money workflows', { kind: 'workflow', id: 'wf-money', name: 'Engine Bidding' }],
      'Lender hook': ['APP_URL', null],
    })
  })

  it('judges each connection against its own organization\'s money hosts, as the save does', async () => {
    const t = lenderBecameAPartner()
    // Another organization's connection to the same host: that organization's bidding does not send there.
    t.service_connections.push({ id: '88888888-8888-4888-8888-888888888888', organization_id: OTHER_ORG, name: 'Their hook', service_type: 'http', sealed_for: 'ops_key', target: { host: 'api.lender.example' } })
    db = fakePostgrest(t)
    const { d, sendAlert } = deps()
    const s = await runHttpMoneyHostCheck(d)
    expect(s.connections).toBe(3)
    expect(s.found).toEqual([LENDER])
    expect(sendAlert.mock.calls.map((c) => c[0])).toEqual([ORG])
  })

  it('pages again the next day, saying when it was first reported, without moving the incident\'s start', async () => {
    db = fakePostgrest(lenderBecameAPartner())
    const first = deps()
    await runHttpMoneyHostCheck(first.d)
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    await runHttpMoneyHostCheck(next.d)
    expect(next.sendAlert).toHaveBeenCalledTimes(1)
    expect(next.sendAlert.mock.calls[0][1].firstReportedAt).toBe(new Date(NOW).toISOString())
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
  })

  it('arms nothing when the page did not reach Slack, and tries again the next day', async () => {
    db = fakePostgrest(lenderBecameAPartner())
    const first = deps({ sendAlert: vi.fn(async () => false) })
    const s = await runHttpMoneyHostCheck(first.d)
    expect(s.paged).toEqual([])
    expect(marker(first.kv)).toBeUndefined()
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    await runHttpMoneyHostCheck(next.d)
    expect(next.sendAlert).toHaveBeenCalledTimes(1)
    expect(marker(first.kv)).toBe(new Date(NOW + DAY).toISOString())
  })

  it('still pages, saying the workflows could not be read, when only that read fails', async () => {
    db = fakePostgrest(lenderBecameAPartner())
    // The money workflows are read through the same table, so fail only the second workflows read.
    const client = db.client
    let workflowReads = 0
    const flaky = { from: (t: string) => (t === 'workflows' && ++workflowReads > 1 ? failingOn('workflows').from(t) : client.from(t)) } as unknown as SupabaseClient
    const { d, sendAlert } = deps({ reads: liveHttpMoneyHostReads(flaky, ENV) })
    const s = await runHttpMoneyHostCheck(d)
    expect(s.paged).toEqual([LENDER])
    expect(sendAlert.mock.calls[0][1].workflows).toBeNull()
    expect(s.errors.join(' ')).toMatch(/workflows.*could not be read.*permission denied for table workflows/)
  })

  it('sends the all clear once the partner no longer names the host, and forgets the incident', async () => {
    db = fakePostgrest(lenderBecameAPartner())
    const first = deps()
    await runHttpMoneyHostCheck(first.d)
    db.tables.partner_configs[0].api_endpoint = 'https://api.partner-one.example/leads'
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    const s = await runHttpMoneyHostCheck(next.d)
    expect(s.allClear).toEqual([LENDER])
    expect(next.sendAlert).not.toHaveBeenCalled()
    expect(next.sendRecovery).toHaveBeenCalledTimes(1)
    expect(next.sendRecovery.mock.calls[0][0]).toBe(ORG)
    // The partner no longer names the host, yet the all clear still names it, from what the incident recorded.
    expect(next.sendRecovery.mock.calls[0][1]).toEqual({
      subject: 'Lender hook (HTTP)',
      alertedAt: new Date(NOW).toISOString(),
      endedAt: expect.anything() as unknown,
      firstHealthyAt: expect.anything() as unknown,
      context: { source: 'partner_configs', origin_kind: 'partner', origin_ref: 'lendco', origin_name: 'Lendco' },
    })
    expect(marker(first.kv)).toBeUndefined()
    expect(JSON.parse(first.kv.store.get(HTTP_MONEY_HOST_STATE_KEY)!)).toEqual({ open: {} })
  })

  it('sends the all clear once the connection itself is removed', async () => {
    db = fakePostgrest(lenderBecameAPartner())
    const first = deps()
    await runHttpMoneyHostCheck(first.d)
    db.tables.service_connections = db.tables.service_connections.filter((r) => r.id !== LENDER)
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    const s = await runHttpMoneyHostCheck(next.d)
    expect(s.allClear).toEqual([LENDER])
  })

  it('pages as could not run when the connections cannot be read, never as quiet, and keeps an open incident', async () => {
    db = fakePostgrest(lenderBecameAPartner())
    const first = deps()
    await runHttpMoneyHostCheck(first.d)
    const next = deps({ kv: first.kv, now: () => NOW + DAY, reads: liveHttpMoneyHostReads(failingOn('service_connections'), ENV) })
    const s = await runHttpMoneyHostCheck(next.d)
    expect(s.judged).toBe(false)
    expect(next.sendAlert).not.toHaveBeenCalled()
    expect(next.sendRecovery).not.toHaveBeenCalled()
    expect(next.reportReadable).not.toHaveBeenCalled()
    expect(next.reportUnreadable).toHaveBeenCalledTimes(1)
    expect(next.reportUnreadable.mock.calls[0][0].join(' ')).toMatch(/HTTP connections could not be read.*permission denied for table service_connections/)
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
    expect(first.kv.store.get(HTTP_MONEY_HOST_STATE_KEY)).toContain(LENDER)
  })

  it.each([
    ['partner_configs', /partner endpoints could not be read/],
    ['workflows', /money workflows could not be read/],
  ])('pages as could not run when the %s source of the money hosts cannot be read, and judges none of that organization\'s connections', async (table, said) => {
    db = fakePostgrest(lenderBecameAPartner())
    const first = deps()
    await runHttpMoneyHostCheck(first.d)
    const next = deps({ kv: first.kv, now: () => NOW + DAY, reads: liveHttpMoneyHostReads(failingOn(table), ENV) })
    const s = await runHttpMoneyHostCheck(next.d)
    expect(s.found).toEqual([])
    expect(next.sendAlert).not.toHaveBeenCalled()
    // Not judged is not cleared: the open incident is kept, with no all clear.
    expect(next.sendRecovery).not.toHaveBeenCalled()
    expect(s.allClear).toEqual([])
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
    expect(first.kv.store.get(HTTP_MONEY_HOST_STATE_KEY)).toContain(LENDER)
    expect(next.reportReadable).not.toHaveBeenCalled()
    expect(next.reportUnreadable).toHaveBeenCalledTimes(1)
    expect(next.reportUnreadable.mock.calls[0][0].join(' ')).toMatch(said)
    // Told to every organization, so it counts the connections and names no organization.
    expect(next.reportUnreadable.mock.calls[0][0][0]).toMatch(/^2 HTTP connections were not checked against the hosts bidding sends to, because /)
    expect(next.reportUnreadable.mock.calls[0][0].join(' ')).not.toContain(ORG)
  })

  it('pages as could not run when the money Salesforce instance cannot be read', async () => {
    vi.mocked(resolveSalesforceCredsFor).mockRejectedValue(new Error('database down'))
    const { d, reportUnreadable, reportReadable, sendAlert } = deps()
    await runHttpMoneyHostCheck(d)
    expect(sendAlert).not.toHaveBeenCalled()
    expect(reportReadable).not.toHaveBeenCalled()
    expect(reportUnreadable.mock.calls[0][0].join(' ')).toMatch(/money Salesforce instance/)
  })

  it.each(['SUPABASE_URL', 'APP_URL'])('pages as could not run when %s gives no host, rather than judging against fewer hosts', async (name) => {
    db = fakePostgrest(lenderBecameAPartner())
    const env = { ...ENV, [name]: '' } as unknown as Env
    const { d, reportUnreadable, reportReadable, sendAlert } = deps({ reads: liveHttpMoneyHostReads(db.client, env) })
    const s = await runHttpMoneyHostCheck(d)
    expect(s.found).toEqual([])
    expect(sendAlert).not.toHaveBeenCalled()
    expect(reportReadable).not.toHaveBeenCalled()
    expect(reportUnreadable.mock.calls[0][0].join(' ')).toContain(name)
  })

  it('still judges the other connections when one stored host cannot be read, and says which could not be checked', async () => {
    const t = lenderBecameAPartner()
    t.service_connections[1].target = { host: 'http://api.regal.io' }
    db = fakePostgrest(t)
    const { d, sendAlert, reportUnreadable, reportReadable } = deps()
    const s = await runHttpMoneyHostCheck(d)
    expect(s.paged).toEqual([LENDER])
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(reportReadable).not.toHaveBeenCalled()
    // Told to every organization, so it names no connection; the log does.
    expect(reportUnreadable.mock.calls[0][0]).toEqual([expect.stringMatching(/^An HTTP connection was not checked because the host stored for it could not be read/)])
    expect(reportUnreadable.mock.calls[0][0].join(' ')).not.toContain('Regal events')
  })

  it('reads no money host source while there is no HTTP connection, and is quiet', async () => {
    const t = tables()
    t.service_connections = t.service_connections.filter((r) => r.service_type !== 'http')
    db = fakePostgrest(t)
    const { d, sendAlert, reportReadable } = deps()
    const s = await runHttpMoneyHostCheck(d)
    expect(s).toMatchObject({ judged: true, connections: 0, found: [] })
    expect(sendAlert).not.toHaveBeenCalled()
    expect(reportReadable).toHaveBeenCalledTimes(1)
    expect(db.requests.map((r) => r.path)).toEqual(['service_connections'])
  })
})

describe('the page', () => {
  const APP = 'https://bidspoke.trypennie.dev'
  const base: HttpMoneyHostAlert = {
    name: 'Lender hook', host: 'api.lender.example', source: 'partner_configs', origin: { kind: 'partner', slug: 'lendco', name: 'Lendco' },
    workflows: [{ id: 'wf-a', name: 'Daily lead sync', active: true }, { id: 'wf-b', name: 'Old export', active: false }], firstReportedAt: null,
  }
  const DASH_PUNCTUATION = new RegExp(`[\\u2014\\u2013]|\\s${String.fromCharCode(45)}\\s`)
  const REPLACE_FIX = '*Fix:* use Replace on the Connections page to move the workflows that use it onto an HTTP connection with another host, then remove this one.'

  it('opens with the finding, names and links the partner and the active workflows only, and says what to do', () => {
    const m = httpMoneyHostMessage(base, APP)
    expect(m.sections).toEqual([
      'The HTTP connection named Lender hook sends to api.lender.example, and bidding now sends there too: it is in the settings of the partner <https://bidspoke.trypennie.dev/partners?selected=lendco|Lendco>.',
      'Workflows that use it: <https://bidspoke.trypennie.dev/workflows/wf-a|Daily lead sync>.',
      REPLACE_FIX,
    ])
    // The notification preview is the opening sentence, without link markup.
    expect(m.fallback).toBe('The HTTP connection named Lender hook sends to api.lender.example, and bidding now sends there too: it is in the settings of the partner Lendco.')
    expect(m).not.toHaveProperty('title')
    expect(m.sections.join('\n')).not.toMatch(DASH_PUNCTUATION)
    expect(m.sections.join('\n')).not.toContain('may never reach')
  })

  it('names and links the bidding workflow a host came from', () => {
    const m = httpMoneyHostMessage({ ...base, source: 'money workflows', origin: { kind: 'workflow', id: 'wf-money', name: 'Engine Bidding' } }, APP)
    expect(m.sections[0]).toBe('The HTTP connection named Lender hook sends to api.lender.example, and bidding now sends there too: it is written in the bidding workflow <https://bidspoke.trypennie.dev/workflows/wf-money|Engine Bidding>.')
    expect(m.fallback).toBe('The HTTP connection named Lender hook sends to api.lender.example, and bidding now sends there too: it is written in the bidding workflow Engine Bidding.')
  })

  it.each([
    ['SUPABASE_URL', 'it is the bidding database.'],
    ['APP_URL', 'it is one of Bidspoke\'s own addresses.'],
    ['SALESFORCE_INSTANCE_URL', 'it is the Salesforce bidding writes to.'],
    ['ACHIEVE_HOSTS', 'the Achieve offers step calls it.'],
  ] as const)('says where bidding sends to it in words for %s', (source, words) => {
    const m = httpMoneyHostMessage({ ...base, source, origin: null }, APP)
    expect(m.sections[0]).toBe(`The HTTP connection named Lender hook sends to api.lender.example, and bidding now sends there too: ${words}`)
    expect(m.fallback).toBe(m.sections[0])
  })

  it('makes a name safe as a link label', () => {
    const m = httpMoneyHostMessage({ ...base, origin: { kind: 'partner', slug: 'a&b', name: 'A|B <Co>' } }, APP)
    expect(m.sections[0]).toContain('<https://bidspoke.trypennie.dev/partners?selected=a%26b|A/B &lt;Co&gt;>')
  })

  it('asks only for the removal when no active workflow uses it, a switched off one included', () => {
    for (const workflows of [[], [{ id: 'wf-b', name: 'Old export', active: false }]]) {
      const m = httpMoneyHostMessage({ ...base, workflows }, APP)
      expect(m.sections.slice(1)).toEqual(['No active workflow uses it.', '*Fix:* remove it on the Connections page.'])
    }
  })

  it('names at most ten active workflows and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `wf-${i + 1}`, name: `Flow ${i + 1}`, active: true }))
    const line = httpMoneyHostMessage({ ...base, workflows: many }, APP).sections[1]
    expect(line).toContain('<https://bidspoke.trypennie.dev/workflows/wf-10|Flow 10>, and 3 more.')
    expect(line).not.toContain('Flow 11')
  })

  it('says the workflows could not be read, and still says to move any first', () => {
    const m = httpMoneyHostMessage({ ...base, workflows: null }, APP)
    expect(m.sections.slice(1)).toEqual(['The workflows that use it could not be read, so this page cannot name them.', REPLACE_FIX])
  })

  it('says when it was first reported on a repeat', () => {
    const m = httpMoneyHostMessage({ ...base, firstReportedAt: new Date(NOW).toISOString() }, APP)
    expect(m.sections[3]).toBe('First reported Oct 28, 9:00 AM EDT.')
  })

  it('has the all clear name the source the page named, linked', () => {
    const partner = { source: 'partner_configs', origin_kind: 'partner', origin_ref: 'lendco', origin_name: 'Lendco' }
    const workflow = { source: 'money workflows', origin_kind: 'workflow', origin_ref: 'wf-money', origin_name: 'Engine Bidding' }
    expect(httpMoneyHostRecoveryWording(partner, APP).recoveredPhrase).toBe('no longer reaches a host bidding sends to for <https://bidspoke.trypennie.dev/partners?selected=lendco|Lendco>')
    expect(httpMoneyHostRecoveryWording(workflow, APP).recoveredPhrase).toBe('no longer reaches a host bidding sends to for <https://bidspoke.trypennie.dev/workflows/wf-money|Engine Bidding>')
    expect(httpMoneyHostRecoveryWording({ source: 'SUPABASE_URL' }, APP).recoveredPhrase).toBe('no longer reaches a host bidding sends to for the bidding database')
    expect(httpMoneyHostRecoveryWording({ source: 'ACHIEVE_HOSTS' }, APP).recoveredPhrase).toBe('no longer reaches a host bidding sends to for the Achieve offers step')
    // A record from before the source was kept, or one unreadable, still says the finding ended.
    expect(httpMoneyHostRecoveryWording(null, APP).recoveredPhrase).toBe('no longer reaches a host bidding sends to')
    expect(httpMoneyHostRecoveryWording({ source: 'nonsense' }, APP).recoveredPhrase).toBe('no longer reaches a host bidding sends to')
  })
})
