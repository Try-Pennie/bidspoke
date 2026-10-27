/**
 * The Connections page fixtures the accessibility job answers the page from are
 * what the connections routes answer (#2611, the pattern of #2134 and #2139).
 *
 * apps/web/e2e/fixtures/connections/ is invented, because the test
 * organization holds one connection and production's are not to be committed.
 * Each file is held here to the real route, given the database rows, ops
 * answers and Slack answer that would produce it, so the scan cannot pass over
 * a shape the Worker never sends: the list at the settled design's count (13
 * connections across eight services, every page status among them, and one
 * ops gives no status), two connections' History, the Google mailboxes and
 * drives, the Slack alerts login's settings, and a Remove whose ops revoke did
 * not answer (which is what opens the page's removal notice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import type { HealthRow } from '../../../lib/ops-connections-contract'
import { forgetConnectionStatusesMemory, forgetSlackAlertStatusMemory } from '../../../lib/connection-statuses'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/slack-token-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/slack-token-check')>()),
  verifySlackToken: vi.fn(),
}))

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { verifySlackToken } from '../../../lib/slack-token-check'
import { encryptSecret } from '../../../lib/secret-crypto'
import { SLACK_TEST_KEY } from '../../../__tests__/helpers/sealed-slack-row'
import api from '../index'

import listJson from '../../../../../web/e2e/fixtures/connections/list.json'
import historyJson from '../../../../../web/e2e/fixtures/connections/history.json'
import subjectsJson from '../../../../../web/e2e/fixtures/connections/google-subjects.json'
import slackJson from '../../../../../web/e2e/fixtures/connections/slack-alerts.json'
import removeJson from '../../../../../web/e2e/fixtures/connections/remove.json'

/** The moment the list was read: 12:00 PM ET on 2026-10-27. */
const NOW = '2026-10-27T16:00:00.000Z'
const ORG = '0e2e0000-0000-4000-8000-000000000001'
const USER = '0e2e0000-0000-4000-8000-0000000000a1'
const OWNER = '0e2e0000-0000-4000-8000-0000000000a2'

const id = (n: number) => `0e2e0c00-0000-4000-8000-${String(n).padStart(12, '0')}`
const wf = (n: number) => `0e2e0f00-0000-4000-8000-${String(n).padStart(12, '0')}`

type Row = Record<string, unknown>

/** A service_connections row as stored, before the list route reads it. */
const conn = (n: number, over: Row): Row => ({
  id: id(n),
  organization_id: ORG,
  acts_as: null,
  person_bound: false,
  user_id: null,
  target: null,
  sealed_for: 'ops_key',
  config: null,
  credential_enc: '{"v":1,"kid":"k","wrapped_key":"w","iv":"i","ct":"SECRET-CIPHERTEXT"}',
  created_at: '2026-10-14T14:00:00Z',
  updated_at: '2026-10-21T18:30:00Z',
  updated_by_email: null,
  ...over,
})

/** The alert row's Slack settings, as GET /integrations/slack reads its config. */
const ALERT_CONFIG = {
  workspace_name: 'Pennie',
  default_channel: 'C0FIXALERTS',
  volume_alerts_enabled: true,
  matrix_alerts_enabled: true,
  config_alerts_enabled: false,
  backup_alerts_enabled: true,
}

async function rows(): Promise<Row[]> {
  return [
    conn(1, { name: 'Pennie Salesforce', service_type: 'salesforce', acts_as: 'integration@pennie.example', target: { instance_url: 'https://pennie.my.salesforce.com', client_id: '3MVG9fixture.pennie' } }),
    conn(2, { name: 'TPL2 Salesforce', service_type: 'salesforce', acts_as: 'bidspoke@tpl2.example', target: { instance_url: 'https://tpl2.my.salesforce.com', client_id: '3MVG9fixture.tpl2' }, created_at: '2026-10-27T15:50:00Z', updated_at: '2026-10-27T15:50:00Z' }),
    conn(3, { name: 'Achieve Salesforce', service_type: 'salesforce', acts_as: 'pennie.api@achieve.example', target: { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9fixture.achieve' } }),
    conn(4, { name: 'Reporting warehouse', service_type: 'snowflake', acts_as: 'OPS_SERVICE in PENNIE', target: { account: 'pennie-fx12345', user: 'OPS_SERVICE', warehouse: 'OPS_WH', role: 'OPS_ROLE' } }),
    conn(5, { name: 'Ops mailbox', service_type: 'google', acts_as: 'ops@pennie.example', target: { subject: 'ops@pennie.example' } }),
    conn(6, { name: 'Reports drive', service_type: 'google', acts_as: 'reports@pennie.example', target: { subject: 'reports@pennie.example', drives: ['0AFixtureReports'] } }),
    conn(7, { name: "Editor A's calendar", service_type: 'google', acts_as: 'editor-a@example.com', person_bound: true, user_id: OWNER, target: { own_account: true } }),
    conn(8, { name: 'Ops alerts bot', service_type: 'slack', acts_as: 'Bidspoke Ops in Pennie', target: { team_id: 'T0FIXTURE' } }),
    // The Slack alerts login as stored (#2331): the row named slack, its token sealed to the bidding ring.
    conn(9, {
      name: 'slack', service_type: 'slack', sealed_for: 'bidding_ring', credential_enc: await encryptSecret('xoxb-FIXTURE', SLACK_TEST_KEY),
      config: ALERT_CONFIG, created_at: '2026-06-02T13:00:00Z', updated_at: '2026-10-20T19:12:00Z', updated_by_email: 'editor-b@example.com',
    }),
    conn(10, { name: 'Summaries', service_type: 'openai', acts_as: 'Project proj_fixture_ops in pennie', target: { project_id: 'proj_fixture_ops' } }),
    conn(11, { name: 'Lead notes', service_type: 'anthropic', acts_as: 'Workspace wrkspc_fixture', target: { workspace_id: 'wrkspc_fixture' } }),
    conn(12, { name: 'Partner status API', service_type: 'http', target: { host: 'status.partner.example', header: 'X-Api-Key', check_path: '/health' } }),
    conn(13, { name: 'Bidspoke database', service_type: 'supabase', acts_as: 'Project fixtureref', target: { project_url: 'https://fixtureref.supabase.co' } }),
  ]
}

const USERS: Row[] = [
  { id: USER, organization_id: ORG, email: 'editor-b@example.com', display_name: 'Editor B', allowed: true },
  { id: OWNER, organization_id: ORG, email: 'editor-a@example.com', display_name: 'Editor A' },
]

const health = (n: number, status: string, over: Partial<HealthRow> = {}): HealthRow => ({
  connection_id: id(n),
  service: 'x',
  generation: 1,
  status,
  last_check_ok_at: '2026-10-27T15:48:00Z',
  last_check_failed_at: null,
  last_check_cause: null,
  needs_reauth_at: null,
  needs_reauth_cause: null,
  reauth_cleared_at: null,
  ...over,
})

/**
 * Every ops status but none for Partner status API, whose row ops holds no
 * health for, so the page shows Status not known. TPL2 was added minutes ago
 * and not yet checked (unchecked, which the page shows as Working).
 */
const HEALTH: HealthRow[] = [
  health(1, 'healthy', { last_check_ok_at: '2026-10-27T15:56:00Z' }),
  health(2, 'unchecked', { last_check_ok_at: null }),
  health(3, 'needs_reauth', { last_check_ok_at: '2026-10-27T13:40:00Z', last_check_failed_at: '2026-10-27T13:52:00Z', last_check_cause: 'login_refused: invalid_client', needs_reauth_at: '2026-10-27T13:52:00Z', needs_reauth_cause: 'login_refused: invalid_client' }),
  health(4, 'check_failing', { last_check_ok_at: '2026-10-27T11:02:00Z', last_check_failed_at: '2026-10-27T15:41:00Z', last_check_cause: 'check_failed: warehouse OPS_WH is suspended' }),
  health(5, 'healthy', { last_check_ok_at: '2026-10-27T15:49:00Z' }),
  health(6, 'refresh_failing', { last_check_ok_at: '2026-10-27T09:15:00Z', last_check_failed_at: '2026-10-27T15:20:00Z', last_check_cause: 'refresh_failed: Google did not answer' }),
  health(7, 'healthy', { last_check_ok_at: '2026-10-27T15:53:00Z' }),
  health(8, 'healthy', { last_check_ok_at: '2026-10-27T15:55:00Z' }),
  health(10, 'healthy', { last_check_ok_at: '2026-10-27T15:48:00Z' }),
  health(11, 'healthy', { last_check_ok_at: '2026-10-27T15:51:00Z' }),
  health(13, 'healthy', { last_check_ok_at: '2026-10-27T15:57:00Z' }),
]

const using = (names: Array<[number, string, boolean?]>) => names.map(([n, name, deleted]) => ({ workflow_id: wf(n), name, deleted: deleted === true }))

/** The workflows naming each connection, as connection_references answers them. Lead notes and the alerts login have none. */
const REFS: Record<string, ReturnType<typeof using>> = {
  [id(1)]: using([[1, 'Achieve report import'], [2, 'Daily Salesforce cleanup'], [3, 'Lead Completed sync'], [4, 'Partner report email'], [5, 'Reserve My Loan intake'], [6, 'Tripoint submission']]),
  [id(2)]: using([[7, 'TPL2 lead handoff'], [8, 'TPL2 nightly reconcile']]),
  [id(3)]: using([[1, 'Achieve report import']]),
  [id(4)]: using([[9, 'Warehouse daily export'], [10, 'Bid volume rollup'], [11, 'Partner payout report']]),
  [id(5)]: using([[4, 'Partner report email'], [12, 'Ops inbox triage'], [13, 'Weekly summary email'], [14, 'Lender reply parser']]),
  [id(6)]: using([[4, 'Partner report email'], [11, 'Partner payout report']]),
  [id(7)]: using([[15, 'Calendar hold for callbacks']]),
  [id(8)]: using([[16, 'Lead spike alert'], [17, 'Stuck lead alert'], [18, 'Partner down alert'], [19, 'Daily ops digest'], [20, 'Cap reached alert'], [21, 'Matrix change alert'], [22, 'Failed write alert'], [23, 'Weekend volume alert'], [24, 'Reconnect reminder']]),
  [id(10)]: using([[25, 'Call summary'], [26, 'Lead notes summary']]),
  // Used only by a deleted workflow: still counted (R5), and shown marked deleted.
  [id(12)]: using([[27, 'Old partner status check', true]]),
  [id(13)]: using([[28, 'Bid archive backfill']]),
}

/** connection_history rows for the two connections whose History tab the scan opens. */
const HISTORY: Record<string, Row[]> = {
  [id(3)]: [
    { audit_id: '0e2e0a00-0000-4000-8000-000000000003', action: 'UPDATE', changed_at: '2026-10-20T19:12:00Z', changed_by_name: 'Editor B', changed_by_email: 'editor-b@example.com', changes: { name: { old: 'Achieve', new: 'Achieve Salesforce' } }, credential_changed: false },
    { audit_id: '0e2e0a00-0000-4000-8000-000000000002', action: 'UPDATE', changed_at: '2026-10-16T19:40:00Z', changed_by_name: null, changed_by_email: 'editor-a@example.com', changes: {}, credential_changed: true },
    { audit_id: '0e2e0a00-0000-4000-8000-000000000001', action: 'INSERT', changed_at: '2026-10-14T14:00:00Z', changed_by_name: 'Editor A', changed_by_email: 'editor-a@example.com', changes: {}, credential_changed: false },
  ],
  [id(1)]: [
    { audit_id: '0e2e0a00-0000-4000-8000-000000000012', action: 'connection_rechecked', changed_at: '2026-10-22T13:05:00Z', changed_by_name: 'Editor B', changed_by_email: 'editor-b@example.com', changes: {}, credential_changed: false },
    { audit_id: '0e2e0a00-0000-4000-8000-000000000011', action: 'INSERT', changed_at: '2026-10-14T14:00:00Z', changed_by_name: 'Editor A', changed_by_email: 'editor-a@example.com', changes: {}, credential_changed: false },
  ],
}

/** The Google mailboxes and drives, as ops lists them. */
const SUBJECTS = [
  { kind: 'mailbox', subject: 'ops@pennie.example', display_name: null, added_by: 'Editor A', added_at: '2026-10-14T13:30:00Z' },
  { kind: 'mailbox', subject: 'reports@pennie.example', display_name: null, added_by: 'Editor A', added_at: '2026-10-14T13:31:00Z' },
  { kind: 'mailbox', subject: 'partners@pennie.example', display_name: null, added_by: 'Editor B', added_at: '2026-10-19T17:02:00Z' },
  { kind: 'drive', subject: '0AFixtureReports', display_name: 'Reports', added_by: 'Editor A', added_at: '2026-10-14T13:32:00Z' },
  { kind: 'drive', subject: '0AFixturePayouts', display_name: 'Partner payouts', added_by: 'Editor B', added_at: '2026-10-21T15:10:00Z' },
]

/** A database double that applies eq, in and the alert row's or filter, and projects the selected columns. */
function storeDouble(stored: Row[]) {
  const tables: Record<string, Row[]> = { service_connections: stored, users: USERS }
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let columns: string[] | null = null
    let limit = Infinity
    const answer = () => {
      const found = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit)
      return { data: found.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r)), error: null }
    }
    const b = {
      select(cols: string) { columns = cols.split(',').map((c) => c.trim()); return b },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
      in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return b },
      or(expr: string) {
        const alts = expr.split(',').map((a) => {
          const [col, op, v] = a.split('.')
          return (r: Row) => (op === 'is' && v === 'null' ? r[col] === null || r[col] === undefined : op === 'eq' && r[col] === v)
        })
        filters.push((r) => alts.some((f) => f(r)))
        return b
      },
      order() { return b },
      limit(n: number) { limit = n; return b },
      maybeSingle() { return Promise.resolve({ data: (answer().data as Row[])[0] ?? null, error: null }) },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(answer()).then(resolve, reject) },
    }
    return b
  }
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'auth_user_with_allowlist') return Promise.resolve({ data: [USERS[0]], error: null })
    if (args.p_organization_id !== ORG) return Promise.resolve({ data: null, error: { code: 'P0002', message: 'connection_not_found' } })
    if (name === 'connection_references') return Promise.resolve({ data: REFS[args.p_connection_id as string] ?? [], error: null })
    if (name === 'connection_history') return Promise.resolve({ data: HISTORY[args.p_connection_id as string] ?? [], error: null })
    if (name === 'remove_ops_connection') return Promise.resolve({ data: [{ outcome: 'removed', removed_generation: 2, workflows: [] }], error: null })
    return Promise.resolve({ data: null, error: { code: '42883', message: `no function ${name}` } })
  }
  return { from, rpc }
}

function memoryKv() {
  const store = new Map<string, string>()
  return { async get(key: string) { return store.get(key) ?? null }, async put(key: string, value: string) { store.set(key, value) } }
}

function makeEnv() {
  const binding = {
    verify: vi.fn(), clearReauth: vi.fn(), exchangeOAuthCode: vi.fn(), lookup: vi.fn(),
    health: vi.fn(async () => ({ ok: true, connections: HEALTH, reached_limit: false })),
    listDelegationSubjects: vi.fn(async () => ({ ok: true, subjects: SUBJECTS, reached_limit: false })),
    // Ops did not answer the revoke: the removal stands, and the page says when ops stops using the login.
    revoke: vi.fn(async () => { throw new Error('ops is not answering') }),
  }
  return { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: memoryKv(), OPS_CONNECTIONS: binding, SECRET_ENCRYPTION_KEY: SLACK_TEST_KEY } as unknown as Env
}

const ctx = recordingContext()

async function call(method: string, path: string) {
  vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(await rows()) as never)
  return api.request(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' } }, makeEnv(), ctx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  forgetConnectionStatusesMemory()
  forgetSlackAlertStatusMemory()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'editor-b@example.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(verifySlackToken).mockResolvedValue({ kind: 'ok', user: 'bidspoke_alerts', team: 'Pennie', botId: 'B0FIXALERTS' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the Connections page fixtures are what their routes answer (#2611)', () => {
  it('GET /connections: thirteen connections, every page status, one with none, owners, use counts and a deleted user', async () => {
    const res = await call('GET', '/connections')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(listJson)
  })

  it('the list holds what the scan depends on: each page status, an unknown one, a removable one and a person bound one', () => {
    const list = listJson as { connections: Array<{ name: string; status: string | null; used_by: number; person_bound: boolean; alert_login: boolean }> }
    expect(list.connections).toHaveLength(13)
    expect(new Set(list.connections.map((c) => c.status))).toEqual(new Set(['ok', 'reauth', 'failing', null]))
    expect(list.connections.some((c) => c.used_by === 0 && !c.alert_login)).toBe(true)
    expect(list.connections.some((c) => c.person_bound)).toBe(true)
    expect(list.connections.filter((c) => c.alert_login)).toHaveLength(1)
  })

  it('GET /connections/:id/history for each connection whose History the scan opens', async () => {
    const history = historyJson as Record<string, unknown>
    expect(Object.keys(history).sort()).toEqual(Object.keys(HISTORY).sort())
    for (const [cid, answer] of Object.entries(history)) {
      const res = await call('GET', `/connections/${cid}/history`)
      expect(res.status, cid).toBe(200)
      expect(await res.json(), cid).toEqual(answer)
    }
  })

  it('GET /connections/google/subjects: the mailboxes and drives', async () => {
    const res = await call('GET', '/connections/google/subjects')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(subjectsJson)
  })

  it('GET /integrations/slack: the Slack alerts login\'s settings', async () => {
    const res = await call('GET', '/integrations/slack')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(slackJson)
  })

  it('DELETE /connections/:id: Lead notes removed while ops did not answer the revoke', async () => {
    const res = await call('DELETE', `/connections/${id(11)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(removeJson)
  })
})
