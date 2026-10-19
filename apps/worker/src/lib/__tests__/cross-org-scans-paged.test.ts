/**
 * The cross organization scans read every row past PostgREST's 1,000 row cap
 * (#1437 P5).
 *
 * Each read here is served by an in memory PostgREST that answers as the real
 * one does: sorted by the order the client sent, then offset and limit, then
 * cut at 1,000 rows whatever was asked, with rows that tie on the order coming
 * back in a different order on every request. So a read with no paging stops
 * at the 1,000th row, and a read paging on an order that is not unique skips
 * and repeats rows, here exactly as in production. Every test asks for more
 * rows than one page holds and expects each one exactly once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakePostgrest, type Row } from '../../__tests__/helpers/postgrest-fake'
import { readActiveWorkflows } from '../active-workflows'
import { readExecutionCountsPerMinute } from '../execution-counts'
import { loadWorkflowOrganizations } from '../execution-archive'
import { readLiveWorkflowDefinitions } from '../payload-print-check'
import { readOrgPlainGlobalVars } from '../required-env-vars'
import { readSecretRows } from '../secret-decrypt-health'
import { readDbSecrets } from '../secret-drift'
import { reencryptSecrets } from '../secret-reencrypt'
import { encryptSecret, secretKeys } from '../secret-crypto'
import { listSalesforceSyncedConfigs } from '../bid-matrix-sync'
import { productionChecksDeps } from '../buyer-sales-checks'
import { readPresenceWindow } from '../field-presence-anomaly'
import { readEverySlackAlertRow, slackOrgIds } from '../alert-fanout'
import { SLACK_ALERT_CONNECTION_NAME } from '../slack-connection'
import { registerScheduledSlack } from '../scheduled-slack'
import type { Env } from '../../index'

const CAP = { rowCap: 1000 }
/** More rows than two pages hold, so a read must page at least three times. */
const MANY = 2345

const pad = (i: number) => String(i).padStart(5, '0')

/** The rows in an order unlike their ids, so nothing passes on insertion order. */
function scrambled<T>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, k: (i * 7919) % rows.length })).sort((a, b) => a.k - b.k).map((x) => x.r)
}

/** Every id once: no row skipped, none repeated. */
function expectEachOnce(got: string[], want: string[]) {
  expect(got.length).toBe(want.length)
  expect(new Set(got).size).toBe(want.length)
  expect([...got].sort()).toEqual([...want].sort())
}

const ORGS = ['org-a', 'org-b', 'org-c']

function workflowRows(n: number): Row[] {
  return scrambled(
    Array.from({ length: n }, (_, i) => ({
      id: `wf-${pad(i)}`,
      name: `Workflow ${i}`,
      // Spread over three organizations, so the organization ties many rows.
      organization_id: ORGS[i % ORGS.length],
      slack_channel: null,
      definition: null,
      is_active: true,
      deleted_at: null,
      organizations: { id: ORGS[i % ORGS.length], slug: `slug-${i % ORGS.length}` },
    })),
  )
}

let quiet: ReturnType<typeof vi.spyOn>[] = []
beforeEach(() => {
  quiet = [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined)]
})
afterEach(() => quiet.forEach((s) => s.mockRestore()))

describe('the active workflows of every organization (#1437)', () => {
  it('reads every active workflow, not the first 1,000', async () => {
    const rows = workflowRows(MANY)
    const others: Row[] = [
      { id: 'wf-off', organization_id: 'org-a', is_active: false, deleted_at: null },
      { id: 'wf-gone', organization_id: 'org-a', is_active: true, deleted_at: '2026-10-01T00:00:00Z' },
    ]
    const db = fakePostgrest({ workflows: [...rows, ...others] }, {}, CAP)
    const got = await readActiveWorkflows<{ id: string }>(db.client, 'id, organization_id', 'test workflows')
    expectEachOnce(got.map((w) => w.id), rows.map((r) => r.id as string))
  })

  it('reads every active workflow of the organizations named, and none of any other', async () => {
    const rows = workflowRows(MANY)
    const db = fakePostgrest({ workflows: [...rows, { id: 'wf-elsewhere', organization_id: 'org-z', is_active: true, deleted_at: null }] }, {}, CAP)
    const got = await readActiveWorkflows<{ id: string }>(db.client, 'id, name, organization_id', 'test workflows', ORGS)
    expectEachOnce(got.map((w) => w.id), rows.map((r) => r.id as string))
  })

  it('fails on a page that fails, rather than answering with the pages before it', async () => {
    const db = fakePostgrest({ workflows: workflowRows(MANY) }, {}, CAP)
    let calls = 0
    const client = db.client
    const original = client.from.bind(client)
    // The second page answers an error.
    vi.spyOn(client, 'from').mockImplementation(((table: string) => {
      calls++
      if (calls === 2) throw new Error('connection reset')
      return original(table)
    }) as typeof client.from)
    await expect(readActiveWorkflows(client, 'id', 'test workflows')).rejects.toThrow(/connection reset/)
  })
})

describe('every workflow with its organization, for the archive (#1437)', () => {
  it('maps every workflow, not the first 1,000', async () => {
    const rows = workflowRows(MANY)
    const db = fakePostgrest({ workflows: rows }, {}, CAP)
    const map = await loadWorkflowOrganizations(db.client)
    expectEachOnce([...map.keys()], rows.map((r) => r.id as string))
  })
})

describe('every undeleted definition, for the payload print scan (#1437)', () => {
  it('reads every undeleted workflow, active or not', async () => {
    const rows: Row[] = workflowRows(MANY).map((r, i) => ({ ...r, is_active: i % 2 === 0 }))
    const db = fakePostgrest({ workflows: [...rows, { id: 'wf-gone', deleted_at: '2026-10-01T00:00:00Z' }] }, {}, CAP)
    const got = await readLiveWorkflowDefinitions(db.client)
    expectEachOnce(got.map((w) => w.id), rows.map((r) => r.id as string))
  })
})

describe('the environment variable scans (#1437)', () => {
  const vars = (n: number, secret: boolean): Row[] =>
    scrambled(
      Array.from({ length: n }, (_, i) => ({
        id: `ev-${pad(i)}`,
        key: `KEY_${i}`,
        value: `v${i}`,
        organization_id: 'org-a',
        scope: 'global',
        workflow_id: null,
        is_secret: secret,
        workflows: null,
      })),
    )

  it('reads every plain global variable of an organization', async () => {
    const rows = vars(MANY, false)
    const db = fakePostgrest({ environment_variables: [...rows, ...vars(3, true).map((r) => ({ ...r, id: `s-${String(r.id)}` }))] }, {}, CAP)
    const got = await readOrgPlainGlobalVars(db.client, 'org-a')
    expectEachOnce(got.map((r) => r.key), rows.map((r) => r.key as string))
  })

  it('reads every secret of every organization, for the decrypt health check', async () => {
    const rows = vars(MANY, true)
    const db = fakePostgrest({ environment_variables: rows }, {}, CAP)
    const got = await readSecretRows(db.client)
    expectEachOnce(got.map((r) => r.key), rows.map((r) => r.key as string))
  })

  it('reads every secret of every organization, for the drift check', async () => {
    const rows = vars(MANY, true)
    const db = fakePostgrest({ environment_variables: rows }, {}, CAP)
    const got = await readDbSecrets(db.client)
    expectEachOnce(got.map((r) => r.key), rows.map((r) => r.key as string))
  })
})

describe('the key rotation reads every stored value (#1437)', () => {
  it('previews every row past the cap of the three tables that refused at it, rather than refusing', async () => {
    const primary = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const next = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    const keys = secretKeys({ SECRET_ENCRYPTION_KEY: primary, SECRET_ENCRYPTION_KEY_NEXT: next })
    const locked = await encryptSecret('value', primary)
    // Only the row sorting last holds a value, so reaching it proves the read
    // went past the cap at the cost of one decryption per table. The held
    // writebacks, the fourth table, paged before this change and have their
    // own test in secret-reencrypt.test.ts; here they are empty.
    const last = 1500 - 1
    const env = Array.from({ length: 1500 }, (_, i) => ({ id: `ev-${pad(i)}`, key: `K${i}`, value: i === last ? locked : null, is_secret: true }))
    const settings = Array.from({ length: 1500 }, (_, i) => ({ organization_id: `org-${pad(i % 3)}`, key: `k-${pad(i)}`, value_encrypted: i === last ? locked : null }))
    const connections = Array.from({ length: 1500 }, (_, i) => ({ id: `sc-${pad(i)}`, credential_enc: i === last ? locked : null, sealed_for: 'bidding_ring' }))
    const db = fakePostgrest(
      {
        environment_variables: scrambled(env),
        app_settings: scrambled(settings),
        outcome_writeback_deadletters: [],
        service_connections: scrambled(connections),
      },
      {},
      CAP,
    )
    const result = await reencryptSecrets(db.client, keys, { dryRun: true })
    const relocked = Object.fromEntries(result.tables.map((t) => [t.table, t.relocked]))
    expect(relocked).toEqual({ environment_variables: 1, app_settings: 1, outcome_writeback_deadletters: 0, service_connections: 1 })
  })
})

describe('the scheduled jobs over every organization config (#1437)', () => {
  it('lists every Salesforce synced matrix config, before any sync writes', async () => {
    const rows = scrambled(
      Array.from({ length: MANY }, (_, i) => ({ id: `pbc-${pad(i)}`, organization_id: ORGS[i % 3], slug: `s${i}`, sync_source: 'salesforce', is_active: true })),
    )
    const db = fakePostgrest({ partner_bid_configs: [...rows, { id: 'pbc-manual', sync_source: 'manual', is_active: true }] }, {}, CAP)
    const got = await listSalesforceSyncedConfigs(db.client)
    expectEachOnce(got.map((c) => c.id), rows.map((r) => r.id as string))
  })

  it('lists every offer sold buyer of every real organization', async () => {
    const rows = scrambled(
      Array.from({ length: MANY }, (_, i) => ({
        partner_id: `p-${pad(i)}`,
        sold_on: 'offer',
        hourly_lead_cap: null,
        daily_lead_cap: null,
        hourly_spend_cap_cents: null,
        daily_spend_cap_cents: null,
        partner_configs: { organization_id: ORGS[i % 3], slug: `buyer-${i}` },
        organizations: { is_synthetic: false },
      })),
    )
    const synthetic = { ...rows[0], partner_id: 'p-synthetic', organizations: { is_synthetic: true } }
    const db = fakePostgrest({ buyer_profiles: [...rows, synthetic] }, {}, CAP)
    const got = await productionChecksDeps(db.client, {} as Env).listBuyers()
    expectEachOnce(got.map((b) => b.partner_id), rows.map((r) => r.partner_id as string))
  })
})

describe('the minute and presence rollups through rpc (#1437)', () => {
  it('reads every per minute run count, not the first 1,000', async () => {
    const want = scrambled(
      Array.from({ length: MANY }, (_, i) => ({
        workflow_id: `wf-${pad(i % 40)}`,
        minute: new Date(Date.UTC(2026, 9, 18, 12, Math.floor(i / 40))).toISOString(),
        cnt: '3',
      })),
    )
    const db = fakePostgrest({}, { execution_counts_per_minute: () => ({ data: want }) }, CAP)
    const got = await readExecutionCountsPerMinute(db.client, ['wf-1'], '2026-10-18T12:00:00Z', 'test counts')
    expectEachOnce(got.map((r) => `${r.workflow_id}@${r.minute}`), want.map((r) => `${r.workflow_id}@${r.minute}`))
  })

  it('reads every field of every workflow in the presence window', async () => {
    const want = scrambled(
      Array.from({ length: MANY }, (_, i) => ({ workflow_id: `wf-${pad(i % 40)}`, field_path: `field.${pad(Math.floor(i / 40))}`, ran_count: '5', present_count: '4' })),
    )
    const db = fakePostgrest({}, { field_presence_window: () => ({ data: want }) }, CAP)
    const got = await readPresenceWindow(db.client, ['wf-1'], 60)
    expectEachOnce(got.map((r) => `${r.workflow_id}@${r.field_path}`), want.map((r) => `${r.workflow_id}@${r.field_path}`))
  })
})

describe('every organization Slack alert row (#1437)', () => {
  const alertRows = (n: number): Row[] =>
    scrambled(
      Array.from({ length: n }, (_, i) => ({
        id: `sc-${pad(i)}`,
        organization_id: `org-${pad(i)}`,
        service_type: 'slack',
        name: SLACK_ALERT_CONNECTION_NAME,
        sealed_for: null,
        config: {},
        credential_enc: null,
      })),
    )

  it('lists every organization with an alert row, not the first 1,000', async () => {
    const rows = alertRows(MANY)
    const db = fakePostgrest({ service_connections: rows }, {}, CAP)
    const list = await slackOrgIds(db.client, 'test', 'measure-from-database')
    expect(list.kind).toBe('live')
    expectEachOnce(list.kind === 'live' ? list.orgIds : [], rows.map((r) => r.organization_id as string))
  })

  /** A deadline timer that never fires: every read here answers. */
  const neverExpires = (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))

  it('lists every organization on the scheduled client too, each page one bounded read', async () => {
    const rows = alertRows(MANY)
    const db = fakePostgrest({ service_connections: rows }, {}, CAP)
    registerScheduledSlack(db.client, { kv: { get: async () => null }, secretKeys: 'unused', sleep: neverExpires })
    const list = await slackOrgIds(db.client, 'test', 'measure-from-database')
    expect(list.kind).toBe('live')
    expectEachOnce(list.kind === 'live' ? list.orgIds : [], rows.map((r) => r.organization_id as string))
    expect(db.requests.filter((r) => r.path === 'service_connections')).toHaveLength(3)
  })

  it('on the scheduled client, a later page that fails is the database not answering, never the pages before it', async () => {
    const db = fakePostgrest({ service_connections: alertRows(MANY) }, {}, CAP)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const original = db.client.from.bind(db.client)
    let calls = 0
    vi.spyOn(db.client, 'from').mockImplementation(((table: string) => {
      calls++
      if (calls < 2) return original(table)
      // The second page answers an error.
      const failing: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'range', 'eq', 'or', 'retry', 'abortSignal']) failing[m] = () => failing
      failing.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(resolve)
      return failing
    }) as unknown as typeof db.client.from)
    registerScheduledSlack(db.client, { kv: { get: async () => null }, secretKeys: 'unused', sleep: neverExpires })
    const list = await slackOrgIds(db.client, 'test', 'measure-from-database')
    expect(list).toEqual({ kind: 'unreachable', reason: 'database_not_answering' })
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/connection reset/)
    errors.mockRestore()
  })

  it('reads every alert row straight from the database, for the volume check', async () => {
    const rows = alertRows(MANY)
    const db = fakePostgrest({ service_connections: rows }, {}, CAP)
    const got = await readEverySlackAlertRow(db.client)
    expectEachOnce(got.map((r) => r.organization_id), rows.map((r) => r.organization_id as string))
  })
})
