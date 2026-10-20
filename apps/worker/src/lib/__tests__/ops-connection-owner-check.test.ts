import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fakePostgrest, type FakePostgrest, type Row } from '../../__tests__/helpers/postgrest-fake'
import {
  OPS_CONNECTION_OWNER_JOB,
  OPS_CONNECTION_OWNER_SIGNAL,
  OPS_CONNECTION_OWNER_STATE_KEY,
  liveOwnerCheckReads,
  runOpsConnectionOwnerCheck,
  type OpsConnectionOwnerDeps,
} from '../ops-connection-owner-check'
import { recoveryKey } from '../alert-recovery'
import { incidentSignal } from '../incident-signals'
import { cronJob } from '../cron-heartbeat'
import { opsConnectionOwnerMessage, type OpsConnectionOwnerAlert } from '../slack'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'

/**
 * #2340 phase 10 item 5: the daily owner check. A person bound ops connection
 * whose owner's email is no longer on user_allowlist pages the connection's
 * own organization, naming the connection and the workflows that use it. It is
 * judged by the allowlist, the predicate access uses, never by whether a users
 * row exists: the Access route deletes only the allowlist row.
 */

// The Access route reads the database through createSupabaseClient; here it is
// the same in memory PostgREST the check reads, so a removal made through the
// route is what the check sees.
let db: FakePostgrest
vi.mock('../supabase', () => ({
  createSupabaseClient: () => db.client,
  getSupabaseClient: () => db.client,
}))
const access = (await import('../../routes/api/access')).default

const NOW = Date.parse('2026-10-20T13:00:00.000Z')
const DAY = 24 * 60 * 60_000
const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const OWNER = '33333333-3333-4333-8333-333333333333'
const ADMIN = '44444444-4444-4444-8444-444444444444'
const CONNECTION = '55555555-5555-4555-8555-555555555555'
const SLACK_ROW = '66666666-6666-4666-8666-666666666666'

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

/** The live shape today: one Slack alert row, no person bound connection (measured 2026-10-17: 0 of 1). */
function todaysTables(): Record<string, Row[]> {
  return {
    service_connections: [
      { id: SLACK_ROW, organization_id: ORG, name: 'slack', service_type: 'slack', sealed_for: 'bidding_ring', person_bound: false, user_id: null },
    ],
    users: [
      { id: OWNER, organization_id: ORG, email: 'Owner.Person@trypennie.com', display_name: 'Owner Person' },
      { id: ADMIN, organization_id: ORG, email: 'admin.person@trypennie.com', display_name: 'Admin Person' },
    ],
    user_allowlist: [
      { email: 'owner.person@trypennie.com', added_by: 'system' },
      { email: 'admin.person@trypennie.com', added_by: 'system' },
    ],
    workflows: [],
    audit_log: [],
  }
}

/** Today's tables plus one person bound Salesforce connection owned by OWNER and the workflows around it. */
function withPersonBound(): Record<string, Row[]> {
  const t = todaysTables()
  t.service_connections.push({
    id: CONNECTION, organization_id: ORG, name: 'Sales team login', service_type: 'salesforce', sealed_for: 'ops_key', person_bound: true, user_id: OWNER,
  })
  const wf = (id: string, organization_id: string, name: string, extra: Row) =>
    ({ id, organization_id, name, is_active: true, deleted_at: null, updated_at: '2026-10-19T12:00:00.000000+00:00', ...extra })
  t.workflows.push(
    wf('wf-a', ORG, 'Daily lead sync', { definition: { nodes: [{ id: 'n1', type: 'code', config: { connection_id: CONNECTION } }] } }),
    // Switched off, so marked: switching it on runs it as the removed owner at once.
    wf('wf-b', ORG, 'Old export', { is_active: false, definition: { nodes: [{ id: 'n1', config: { connection: { id: CONNECTION } } }] } }),
    wf('wf-c', ORG, 'Unrelated flow', { definition: { nodes: [{ id: 'n1', config: { connection_id: 'another-connection' } }] } }),
    // Soft deleted: it cannot run, so it is not named.
    wf('wf-e', ORG, 'Deleted flow', { deleted_at: '2026-10-01T00:00:00.000Z', definition: { nodes: [{ config: { connection_id: CONNECTION } }] } }),
    // Another organization's workflow naming the same id is not this organization's to be told about.
    wf('wf-d', OTHER_ORG, 'Someone else', { definition: { nodes: [{ config: { connection_id: CONNECTION } }] } }),
  )
  return t
}

function deps(over: Partial<OpsConnectionOwnerDeps> = {}) {
  const kv = (over.kv as Kv | undefined) ?? memoryKv()
  const sendAlert = vi.fn(async (_orgId: string, _alert: OpsConnectionOwnerAlert) => true)
  const sendRecovery = vi.fn(async (_orgId: string, _r: { subject: string; alertedAt: string; endedAt: string | null }) => true)
  const reportUnreadable = vi.fn(async (_problems: string[]) => undefined)
  const reportReadable = vi.fn(async () => undefined)
  const d: OpsConnectionOwnerDeps = {
    kv,
    reads: liveOwnerCheckReads(db.client),
    sendAlert,
    sendRecovery,
    reportUnreadable,
    reportReadable,
    now: () => NOW,
    ...over,
  }
  return { d, kv, sendAlert: vi.mocked(d.sendAlert), sendRecovery: vi.mocked(d.sendRecovery), reportUnreadable: vi.mocked(d.reportUnreadable), reportReadable: vi.mocked(d.reportReadable) }
}

const marker = (kv: Kv, id = CONNECTION) => kv.store.get(recoveryKey(OPS_CONNECTION_OWNER_SIGNAL, id))

/** The Access route, signed in as ADMIN of ORG. */
function accessApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
  app.use('*', async (c, next) => {
    c.set('user', { userId: ADMIN, orgId: ORG, email: 'admin.person@trypennie.com', name: 'Admin Person' })
    await next()
  })
  app.route('/api/access', access)
  return app
}

async function removeThroughAccess(email: string) {
  const res = await accessApp().request(`/api/access/${encodeURIComponent(email)}`, { method: 'DELETE' }, {} as Env)
  expect(res.status).toBe(200)
}

/** A client whose reads of one table fail as PostgREST answers a refused query; every other table is the fake's. */
function failingOn(table: string): SupabaseClient {
  const refused = { data: null, error: { message: `permission denied for table ${table}`, code: '42501' } }
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'is', 'in', 'order', 'range', 'limit']) chain[m] = () => chain
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(refused).then(resolve)
  return { from: (t: string) => (t === table ? chain : db.client.from(t)) } as unknown as SupabaseClient
}

beforeEach(() => {
  db = fakePostgrest(todaysTables())
})

describe('the registrations', () => {
  it('has a daily heartbeat entry and an organization scoped incident signal keyed on the connection', () => {
    expect(cronJob(OPS_CONNECTION_OWNER_JOB)).toMatchObject({ triggerCron: '0 13 * * *' })
    expect(incidentSignal(OPS_CONNECTION_OWNER_SIGNAL)).toMatchObject({ scope: 'org', subject: 'connection', windowMinutes: null, label: 'Ops connection owner' })
    expect(incidentSignal(OPS_CONNECTION_OWNER_SIGNAL).kinds).toEqual(['owner_removed', 'owner_missing'])
  })
})

describe('runOpsConnectionOwnerCheck', () => {
  it('runs against today\'s data, finds no person bound connection, and is quiet', async () => {
    const { d, kv, sendAlert, sendRecovery, reportUnreadable, reportReadable } = deps()
    const s = await runOpsConnectionOwnerCheck(d)
    expect(s).toMatchObject({ judged: true, personBound: 0, orphaned: [], paged: [], allClear: [], unreadable: [] })
    expect(sendAlert).not.toHaveBeenCalled()
    expect(sendRecovery).not.toHaveBeenCalled()
    expect(reportUnreadable).not.toHaveBeenCalled()
    // A clean run stands down an earlier could-not-run page.
    expect(reportReadable).toHaveBeenCalledTimes(1)
    // It asked the one question and nothing more: no owner, allowlist or workflow read.
    expect(db.requests.map((r) => r.path)).toEqual(['service_connections'])
    expect(db.requests[0].params.get('person_bound')).toBe('eq.true')
    expect(kv.store.size).toBe(0)
  })

  it('is quiet while the owner is still on the allowlist, comparing emails without case', async () => {
    db = fakePostgrest(withPersonBound())
    const { d, sendAlert } = deps()
    const s = await runOpsConnectionOwnerCheck(d)
    expect(s).toMatchObject({ judged: true, personBound: 1, orphaned: [] })
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('pages the connection\'s organization once the owner is removed through the Access route, naming the workflows', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    // The route removed only the allowlist row: the users row stays, as in production.
    expect(db.tables.user_allowlist.map((r) => r.email)).toEqual(['admin.person@trypennie.com'])
    expect(db.tables.users.some((r) => r.id === OWNER)).toBe(true)

    const { d, kv, sendAlert, reportUnreadable } = deps()
    const s = await runOpsConnectionOwnerCheck(d)
    expect(s).toMatchObject({ judged: true, personBound: 1, orphaned: [CONNECTION], paged: [CONNECTION] })
    expect(sendAlert).toHaveBeenCalledTimes(1)
    const [orgId, alert] = sendAlert.mock.calls[0]
    expect(orgId).toBe(ORG)
    expect(alert).toEqual({
      kind: 'owner_removed',
      name: 'Sales team login',
      service: 'salesforce',
      ownerName: 'Owner Person',
      workflows: [{ name: 'Daily lead sync', active: true }, { name: 'Old export', active: false }],
      firstReportedAt: null,
    })
    expect(reportUnreadable).not.toHaveBeenCalled()
    // The incident is opened on the delivered page, and kept in the check's state for its all clear.
    expect(marker(kv)).toBe(new Date(NOW).toISOString())
    expect(JSON.parse(kv.store.get(OPS_CONNECTION_OWNER_STATE_KEY)!)).toEqual({ open: { [CONNECTION]: { organization_id: ORG, label: 'Sales team login (Salesforce)' } } })
  })

  it('pages a person bound connection with no owner recorded as its own kind', async () => {
    const t = withPersonBound()
    t.service_connections[1].user_id = null
    db = fakePostgrest(t)
    const { d, sendAlert } = deps()
    await runOpsConnectionOwnerCheck(d)
    expect(sendAlert.mock.calls[0][1]).toMatchObject({ kind: 'owner_missing', ownerName: null })
  })

  it('pages again the next day, saying when it was first reported, without moving the incident\'s start', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const first = deps()
    await runOpsConnectionOwnerCheck(first.d)
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    await runOpsConnectionOwnerCheck(next.d)
    expect(next.sendAlert.mock.calls[0][1].firstReportedAt).toBe(new Date(NOW).toISOString())
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
  })

  it('arms nothing when the page did not reach Slack, and tries again the next day', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const first = deps({ sendAlert: vi.fn(async () => false) })
    const s = await runOpsConnectionOwnerCheck(first.d)
    expect(s.paged).toEqual([])
    expect(marker(first.kv)).toBeUndefined()
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    await runOpsConnectionOwnerCheck(next.d)
    expect(next.sendAlert).toHaveBeenCalledTimes(1)
    expect(marker(first.kv)).toBe(new Date(NOW + DAY).toISOString())
  })

  it('still pages, saying the workflows could not be read, when that read fails', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const { d, sendAlert } = deps({ reads: liveOwnerCheckReads(failingOn('workflows')) })
    const s = await runOpsConnectionOwnerCheck(d)
    expect(s.paged).toEqual([CONNECTION])
    expect(sendAlert.mock.calls[0][1].workflows).toBeNull()
    expect(s.errors.join(' ')).toMatch(/workflows.*could not be read.*permission denied for table workflows/)
  })

  it.each(['service_connections', 'users', 'user_allowlist'])('pages as could not run when the %s read fails, never as quiet', async (table) => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const { d, sendAlert, reportUnreadable, reportReadable } = deps({ reads: liveOwnerCheckReads(failingOn(table)) })
    const s = await runOpsConnectionOwnerCheck(d)
    expect(s.judged).toBe(false)
    expect(sendAlert).not.toHaveBeenCalled()
    expect(reportReadable).not.toHaveBeenCalled()
    expect(reportUnreadable).toHaveBeenCalledTimes(1)
    expect(reportUnreadable.mock.calls[0][0].join(' ')).toContain(`permission denied for table ${table}`)
  })

  it('keeps an open incident, and sends no all clear, on a run whose reads fail', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const first = deps()
    await runOpsConnectionOwnerCheck(first.d)
    const next = deps({ kv: first.kv, now: () => NOW + DAY, reads: liveOwnerCheckReads(failingOn('user_allowlist')) })
    await runOpsConnectionOwnerCheck(next.d)
    expect(next.sendRecovery).not.toHaveBeenCalled()
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
    expect(first.kv.store.get(OPS_CONNECTION_OWNER_STATE_KEY)).toContain(CONNECTION)
  })

  it('sends the all clear once the owner is back on the allowlist, and forgets the incident', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const first = deps()
    await runOpsConnectionOwnerCheck(first.d)
    db.tables.user_allowlist.push({ email: 'owner.person@trypennie.com', added_by: 'admin.person@trypennie.com' })
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    const s = await runOpsConnectionOwnerCheck(next.d)
    expect(s.allClear).toEqual([CONNECTION])
    expect(next.sendRecovery).toHaveBeenCalledTimes(1)
    expect(next.sendRecovery.mock.calls[0][0]).toBe(ORG)
    expect(next.sendRecovery.mock.calls[0][1]).toMatchObject({ subject: 'Sales team login (Salesforce)', alertedAt: new Date(NOW).toISOString() })
    expect(marker(first.kv)).toBeUndefined()
    expect(JSON.parse(first.kv.store.get(OPS_CONNECTION_OWNER_STATE_KEY)!)).toEqual({ open: {} })
  })

  it('sends the all clear once the connection itself is removed', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const first = deps()
    await runOpsConnectionOwnerCheck(first.d)
    db.tables.service_connections = db.tables.service_connections.filter((r) => r.id !== CONNECTION)
    const next = deps({ kv: first.kv, now: () => NOW + DAY })
    const s = await runOpsConnectionOwnerCheck(next.d)
    expect(s.allClear).toEqual([CONNECTION])
  })

  it('keeps the incident when its all clear does not reach Slack', async () => {
    db = fakePostgrest(withPersonBound())
    await removeThroughAccess('owner.person@trypennie.com')
    const first = deps()
    await runOpsConnectionOwnerCheck(first.d)
    db.tables.user_allowlist.push({ email: 'owner.person@trypennie.com', added_by: 'admin.person@trypennie.com' })
    const next = deps({ kv: first.kv, now: () => NOW + DAY, sendRecovery: vi.fn(async () => false) })
    const s = await runOpsConnectionOwnerCheck(next.d)
    expect(s.allClear).toEqual([])
    expect(marker(first.kv)).toBe(new Date(NOW).toISOString())
    expect(first.kv.store.get(OPS_CONNECTION_OWNER_STATE_KEY)).toContain(CONNECTION)
  })
})

describe('the page', () => {
  const base: OpsConnectionOwnerAlert = {
    kind: 'owner_removed', name: 'Sales team login', service: 'salesforce', ownerName: 'Owner Person',
    workflows: [{ name: 'Daily lead sync', active: true }, { name: 'Old export', active: false }], firstReportedAt: null,
  }
  const DASH_PUNCTUATION = new RegExp(`[\\u2014\\u2013]|\\s${String.fromCharCode(45)}\\s`)

  it('names the connection, the owner and the workflows, and says what to do, with no email and no dashes', () => {
    const m = opsConnectionOwnerMessage(base)
    expect(m.title).toBe('An ops connection belongs to someone who was removed')
    const text = m.sections.join('\n')
    expect(text).toContain('Sales team login')
    expect(text).toContain('Owner Person')
    expect(text).toContain('Daily lead sync')
    expect(text).toContain('Old export (switched off)')
    expect(text).toMatch(/\*Fix:\*/)
    expect(text).not.toContain('@')
    expect(text).not.toMatch(DASH_PUNCTUATION)
  })

  it('says when no workflow uses it, and when they could not be read, as different sentences', () => {
    const none = opsConnectionOwnerMessage({ ...base, workflows: [] }).sections.join('\n')
    const unread = opsConnectionOwnerMessage({ ...base, workflows: null }).sections.join('\n')
    expect(none).toMatch(/No workflow uses it/)
    expect(unread).toMatch(/could not be read/)
    expect(none).not.toEqual(unread)
  })

  it('names at most ten workflows and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `Flow ${i + 1}`, active: true }))
    const text = opsConnectionOwnerMessage({ ...base, workflows: many }).sections.join('\n')
    expect(text).toContain('Flow 10')
    expect(text).not.toContain('Flow 11')
    expect(text).toContain('and 3 more')
  })

  it('has its own wording for a connection with no owner recorded', () => {
    const m = opsConnectionOwnerMessage({ ...base, kind: 'owner_missing', ownerName: null })
    expect(m.title).toBe('An ops connection has no owner recorded')
    expect(m.sections.join('\n')).not.toContain('Owner Person')
  })

  it('says when it was first reported on a repeat', () => {
    const m = opsConnectionOwnerMessage({ ...base, firstReportedAt: new Date(NOW).toISOString() })
    expect(m.sections.join('\n')).toMatch(/First reported/)
  })
})
