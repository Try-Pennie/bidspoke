/**
 * The Connections routes (#2338, build PR 4: R1, R3, R5, R22, R23).
 *
 * GET /connections lists the caller's organization's connections with their
 * status from OpsConnections.health, the last known statuses when health does
 * not answer, and how many workflows use each. POST /connections/:id/lookup/:key
 * runs one lookup through OpsConnections.lookup. POST /connections, the create,
 * is connections-create.test.ts's (build PR 5); here only its refusal of the
 * old #2331 body. The legacy service type routes are gone.
 *
 * The database double here applies the filters a route sends (eq, in, is), so
 * an organization scope left out of a query shows as another organization's
 * row in the answer rather than passing unseen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import type { HealthRow } from '../../../lib/ops-connections-contract'
import {
  connectionStatusesCopyKey, forgetConnectionStatusesMemory, forgetSlackAlertStatusMemory, rememberConnectionStatuses, rememberSlackAlertStatus, slackAlertStatusCopyKey,
} from '../../../lib/connection-statuses'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/slack-token-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/slack-token-check')>()),
  verifySlackToken: vi.fn(),
}))

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { verifySlackToken } from '../../../lib/slack-token-check'
import { CONNECTIONS_LIST_MAX } from '../connections'

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002'
const USER = 'aa000000-0000-4000-8000-000000000001'
const OWNER = 'aa000000-0000-4000-8000-000000000002'
const SF = 'c1000000-0000-4000-8000-000000000001'
const GOOGLE = 'c2000000-0000-4000-8000-000000000002'
const ALERTS = 'c3000000-0000-4000-8000-000000000003'
const THEIRS = 'c9000000-0000-4000-8000-000000000009'

type Row = Record<string, unknown>

const connRow = (over: Row): Row => ({
  organization_id: ORG,
  name: 'x',
  service_type: 'salesforce',
  acts_as: null,
  person_bound: false,
  user_id: null,
  target: null,
  sealed_for: 'ops_key',
  cf_secret_key: null,
  credential_enc: '{"v":1,"kid":"k","wrapped_key":"w","iv":"i","ct":"SECRET-CIPHERTEXT"}',
  config: { bot_token: 'xoxb-SECRET' },
  created_at: '2026-10-17T14:02:00Z',
  updated_at: '2026-10-18T18:14:00Z',
  ...over,
})

const ROWS: Row[] = [
  connRow({ id: SF, name: 'Pennie Salesforce', acts_as: 'integration@trypennie.com', target: { instance_url: 'https://trypennie.my.salesforce.com' } }),
  connRow({ id: GOOGLE, name: "Dan's calendar", service_type: 'google', acts_as: 'dwright@trypennie.com', person_bound: true, user_id: OWNER }),
  // The alert row's token is its plaintext copy here (no sealed copy), which the list reads only to ask Slack about it.
  connRow({ id: ALERTS, name: 'slack', service_type: 'slack', sealed_for: 'bidding_ring', credential_enc: null, config: { bot_token: 'xoxb-SECRET', default_channel: 'C0ALERTS' } }),
  connRow({ id: THEIRS, organization_id: OTHER_ORG, name: 'Their Salesforce' }),
]

const USERS: Row[] = [
  { id: USER, organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright', allowed: true },
  { id: OWNER, organization_id: ORG, email: 'dwright@trypennie.com', display_name: 'Dan Wright' },
]

/** Workflows by the connection they reference, as connection_references answers them; deleted ones included. */
type Refs = Record<string, Array<{ workflow_id: string; name: string; deleted: boolean }>>

interface StoreOptions {
  listError?: { code: string; message: string }
  usersError?: { code: string; message: string }
  refs?: Refs
  refsError?: { code: string; message: string }
  history?: Record<string, Row[]>
  historyError?: { code: string; message: string }
}

/** A database double that applies eq, in and is filters and projects the selected columns. */
function storeDouble(rows: Row[], opts: StoreOptions = {}) {
  const tables: Record<string, Row[]> = { service_connections: rows, users: USERS }
  const selects: Record<string, string[]> = {}
  const rpcCalls: Array<[string, Record<string, unknown>]> = []
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let columns: string[] | null = null
    let limit = Infinity
    const answer = () => {
      if (table === 'service_connections' && opts.listError) return { data: null, error: opts.listError }
      if (table === 'users' && opts.usersError) return { data: null, error: opts.usersError }
      const found = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit)
      return { data: found.map((r) => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r)), error: null }
    }
    const b = {
      select(cols: string) {
        columns = cols.split(',').map((c) => c.trim())
        ;(selects[table] ??= []).push(cols)
        return b
      },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
      in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return b },
      is(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
      // PostgREST's or, in the two forms the alert row filter sends: <col>.eq.<v> and <col>.is.null.
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
      maybeSingle() {
        const a = answer()
        return Promise.resolve(a.error ? a : { data: (a.data as Row[])[0] ?? null, error: null })
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(answer()).then(resolve, reject) },
    }
    return b
  }
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'auth_user_with_allowlist') return Promise.resolve({ data: [USERS[0]], error: null })
    rpcCalls.push([name, args])
    if (name === 'connection_history') {
      if (opts.historyError) return Promise.resolve({ data: null, error: opts.historyError })
      const ok = rows.some((r) => r.id === args.p_connection_id && r.organization_id === args.p_organization_id)
      if (!ok) return Promise.resolve({ data: null, error: { code: 'P0002', message: 'connection_not_found' } })
      return Promise.resolve({ data: opts.history?.[args.p_connection_id as string] ?? [], error: null })
    }
    if (name === 'connection_references') {
      if (opts.refsError) return Promise.resolve({ data: null, error: opts.refsError })
      // As the function does: a connection not of the named organization raises connection_not_found.
      const ok = rows.some((r) => r.id === args.p_connection_id && r.organization_id === args.p_organization_id)
      if (!ok) return Promise.resolve({ data: null, error: { code: 'P0002', message: 'connection_not_found' } })
      return Promise.resolve({ data: opts.refs?.[args.p_connection_id as string] ?? [], error: null })
    }
    return Promise.resolve({ data: null, error: { code: '42883', message: `no function ${name}` } })
  }
  return { from, rpc, selects, rpcCalls }
}

const healthRow = (connection_id: string, status: string, over: Partial<HealthRow> = {}): HealthRow => ({
  connection_id,
  service: 'salesforce',
  generation: 1,
  status,
  last_check_ok_at: '2026-10-20T15:48:00Z',
  last_check_failed_at: null,
  last_check_cause: null,
  needs_reauth_at: null,
  needs_reauth_cause: null,
  reauth_cleared_at: null,
  ...over,
})

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) { return store.get(key) ?? null },
    async put(key: string, value: string) { store.set(key, value) },
  }
}

function makeEnv(ops: Partial<Record<'health' | 'lookup', (req: unknown) => Promise<unknown>>>, kv = memoryKv()) {
  const binding = {
    verify: vi.fn(), clearReauth: vi.fn(), revoke: vi.fn(), exchangeOAuthCode: vi.fn(),
    health: vi.fn(ops.health ?? (async () => ({ ok: true, connections: [], reached_limit: false }))),
    lookup: vi.fn(ops.lookup ?? (async () => ({ ok: false, refused: 'lookup_not_supported', detail: 'x', retry_at: null }))),
  }
  const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: kv, OPS_CONNECTIONS: binding } as unknown as Env
  return { env, binding, kv }
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

const ctx = recordingContext()

function request(app: Awaited<ReturnType<typeof makeApp>>, method: string, path: string, env: Env, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env, ctx)
}

interface ListAnswer {
  connections: Array<{
    id: string; name: string; service: string; acts_as: string | null; person_bound: boolean
    owner: { user_id: string; name: string | null; email: string | null } | null
    status: string | null; status_word: string | null; used_by: number
    health: Record<string, unknown> | null
  }>
  statuses: { as_of: string | null; stale: boolean; unavailable: { cause: string; detail: string } | null }
}

let app: Awaited<ReturnType<typeof makeApp>>

beforeEach(async () => {
  vi.clearAllMocks()
  forgetConnectionStatusesMemory()
  forgetSlackAlertStatusMemory()
  vi.mocked(verifySlackToken).mockResolvedValue({ kind: 'ok', user: 'bidspoke_alerts', team: 'Pennie' })
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
  app = await makeApp()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GET /connections', () => {
  it("lists only the caller's organization's connections, and never another's", async () => {
    const db = storeDouble(ROWS)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({})
    const res = await request(app, 'GET', '/connections', env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListAnswer
    expect(body.connections.map((c) => c.id).sort()).toEqual([ALERTS, GOOGLE, SF].sort())
    // Health and the reference counts are asked for the caller's organization alone.
    expect(binding.health).toHaveBeenCalledWith({ organization_id: ORG })
    expect(db.rpcCalls.every(([, a]) => a.p_organization_id === ORG)).toBe(true)
    expect(db.rpcCalls.map(([, a]) => a.p_connection_id)).not.toContain(THEIRS)
  })

  it('names each connection, its service, who it acts as and its person bound owner, and carries no credential', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env } = makeEnv({})
    const res = await request(app, 'GET', '/connections', env)
    const raw = await res.text()
    expect(raw).not.toContain('SECRET')
    const body = JSON.parse(raw) as ListAnswer
    const sf = body.connections.find((c) => c.id === SF)!
    expect(sf).toMatchObject({ name: 'Pennie Salesforce', service: 'salesforce', acts_as: 'integration@trypennie.com', person_bound: false, owner: null })
    const google = body.connections.find((c) => c.id === GOOGLE)!
    expect(google).toMatchObject({ person_bound: true, owner: { user_id: OWNER, name: 'Dan Wright', email: 'dwright@trypennie.com' } })
  })

  it("gives each connection its ops status in the page's word, with the time it is as of", async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env } = makeEnv({
      health: async () => ({
        ok: true,
        reached_limit: false,
        connections: [
          healthRow(SF, 'needs_reauth', { needs_reauth_at: '2026-10-20T13:52:00Z', needs_reauth_cause: 'invalid_client' }),
          healthRow(GOOGLE, 'refresh_failing'),
          // Another organization's connection in ops's answer is never matched to ours.
          healthRow(THEIRS, 'healthy'),
        ],
      }),
    })
    const before = Date.now()
    const body = (await (await request(app, 'GET', '/connections', env)).json()) as ListAnswer
    const by = (id: string) => body.connections.find((c) => c.id === id)!
    expect(by(SF)).toMatchObject({ status: 'reauth', status_word: 'Needs reconnecting' })
    expect(by(SF).health).toMatchObject({ ops_status: 'needs_reauth', needs_reauth_at: '2026-10-20T13:52:00Z', needs_reauth_cause: 'invalid_client' })
    // When the login was last checked, either way.
    expect((by(SF) as unknown as { checked_at: string | null }).checked_at).toBe('2026-10-20T15:48:00Z')
    expect(by(GOOGLE)).toMatchObject({ status: 'failing', status_word: 'Check failing' })
    // The Slack alert login is not an ops connection: ops gives it no health, and its status is Slack's own answer (below).
    expect(by(ALERTS)).toMatchObject({ status: 'ok', status_word: 'Working', health: null })
    expect(body.statuses.stale).toBe(false)
    expect(body.statuses.unavailable).toBeNull()
    expect(Date.parse(body.statuses.as_of!)).toBeGreaterThanOrEqual(before - 1000)
  })

  it('counts every workflow using a connection, a soft deleted one included', async () => {
    const db = storeDouble(ROWS, {
      refs: { [SF]: [{ workflow_id: 'w1', name: 'Lead Completed sync', deleted: false }, { workflow_id: 'w2', name: 'Old import', deleted: true }] },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({})
    const body = (await (await request(app, 'GET', '/connections', env)).json()) as ListAnswer
    expect(body.connections.find((c) => c.id === SF)!.used_by).toBe(2)
    expect(body.connections.find((c) => c.id === GOOGLE)!.used_by).toBe(0)
    // Counted by the one predicate the Remove refusal reads, never by name.
    expect(db.rpcCalls.filter(([n]) => n === 'connection_references')).toHaveLength(3)
  })

  describe('when the login checks do not answer (R22, D22)', () => {
    async function seedCopy(kv: ReturnType<typeof memoryKv>, at: number) {
      await rememberConnectionStatuses(kv as unknown as KVNamespace, ORG, [healthRow(SF, 'check_failing'), healthRow(GOOGLE, 'healthy')], at)
      forgetConnectionStatusesMemory()
    }

    it('answers the last known statuses, flagged stale, with the time they are as of, when health does not answer in time', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      const kv = memoryKv()
      const at = Date.parse('2026-10-20T15:52:00Z')
      await seedCopy(kv, at)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { env } = makeEnv({ health: () => new Promise(() => {}) }, kv)
      const pending = request(app, 'GET', '/connections', env)
      await vi.advanceTimersByTimeAsync(15_000)
      const res = await pending
      expect(res.status).toBe(200)
      const body = (await res.json()) as ListAnswer
      expect(body.statuses).toMatchObject({ stale: true, as_of: new Date(at).toISOString(), unavailable: { cause: 'deadline' } })
      expect(body.connections.find((c) => c.id === SF)).toMatchObject({ status: 'failing', status_word: 'Check failing' })
      expect(body.connections.find((c) => c.id === GOOGLE)).toMatchObject({ status: 'ok' })
      // The list is whole: no connection is dropped for want of a status.
      expect(body.connections).toHaveLength(3)
    })

    it('does the same when health answers a refusal, and names the refusal', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      const kv = memoryKv()
      await seedCopy(kv, Date.parse('2026-10-20T15:52:00Z'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { env } = makeEnv({ health: async () => ({ ok: false, refused: 'health_unavailable', detail: 'the statuses could not be read', retry_at: null }) }, kv)
      const body = (await (await request(app, 'GET', '/connections', env)).json()) as ListAnswer
      expect(body.statuses).toMatchObject({ stale: true, unavailable: { cause: 'health_unavailable' } })
      expect(body.connections.find((c) => c.id === SF)!.status).toBe('failing')
    })

    it('with no last known copy, lists every connection with no status and no time, rather than an empty list or a made up status', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      const { env } = makeEnv({ health: async () => { throw new Error('internal error; reference = abc123') } })
      const body = (await (await request(app, 'GET', '/connections', env)).json()) as ListAnswer
      expect(body.connections).toHaveLength(3)
      // Every ops login has no status; the alert login's is Slack's own answer, which came.
      expect(body.connections.filter((c) => c.id !== ALERTS).every((c) => c.status === null && c.status_word === null)).toBe(true)
      expect(body.connections.find((c) => c.id === ALERTS)!.status).toBe('ok')
      expect(body.statuses).toMatchObject({ stale: true, as_of: null, unavailable: { cause: 'threw' } })
    })

    it('a healthy answer keeps the copy the next failed answer reads', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      const kv = memoryKv()
      const healthy = makeEnv({ health: async () => ({ ok: true, reached_limit: false, connections: [healthRow(SF, 'needs_reauth'), healthRow(THEIRS, 'healthy')] }) }, kv)
      await request(app, 'GET', '/connections', healthy.env)
      // Only this organization's own connections are kept.
      expect(kv.store.get(connectionStatusesCopyKey(ORG))).not.toContain(THEIRS)
      const down = makeEnv({ health: async () => ({ ok: false, refused: 'health_unavailable', detail: 'x', retry_at: null }) }, kv)
      const body = (await (await request(app, 'GET', '/connections', down.env)).json()) as ListAnswer
      expect(body.statuses.stale).toBe(true)
      expect(body.connections.find((c) => c.id === SF)!.status).toBe('reauth')
    })
  })

  describe('when the list itself cannot be read (R23, D23)', () => {
    it('answers an error by name, never an empty list, and asks ops nothing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS, { listError: { code: '57014', message: 'canceling statement due to statement timeout' } }) as never)
      const { env, binding } = makeEnv({})
      const res = await request(app, 'GET', '/connections', env)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: 'connections_unavailable' })
      expect(binding.health).not.toHaveBeenCalled()
    })

    it('answers the same error when the use counts cannot be read, rather than a list whose Used by is wrong', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS, { refsError: { code: '57014', message: 'timeout' } }) as never)
      const { env } = makeEnv({})
      const res = await request(app, 'GET', '/connections', env)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: 'connections_unavailable' })
    })

    it('answers the same error when the owners cannot be read', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS, { usersError: { code: '57014', message: 'timeout' } }) as never)
      const { env } = makeEnv({})
      expect((await request(app, 'GET', '/connections', env)).status).toBe(503)
    })

    it('drops a connection removed between the list read and its count, rather than failing the list', async () => {
      // connection_references raises connection_not_found for a row gone since the read.
      const db = storeDouble(ROWS)
      const gone = { ...db, rpc: (name: string, args: Record<string, unknown>) =>
        name === 'connection_references' && args.p_connection_id === GOOGLE
          ? Promise.resolve({ data: null, error: { code: 'P0002', message: 'connection_not_found' } })
          : db.rpc(name, args) }
      vi.mocked(createSupabaseClient).mockReturnValue(gone as never)
      const { env } = makeEnv({})
      const res = await request(app, 'GET', '/connections', env)
      expect(res.status).toBe(200)
      expect(((await res.json()) as ListAnswer).connections.map((c) => c.id)).not.toContain(GOOGLE)
    })

    it('asks for one row past its bound, and refuses a full answer rather than cutting it (#1437)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const many = Array.from({ length: CONNECTIONS_LIST_MAX + 1 }, (_, i) => connRow({ id: `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, name: `c${i}` }))
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(many) as never)
      const { env } = makeEnv({})
      const res = await request(app, 'GET', '/connections', env)
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: 'connections_list_too_long' })
    })
  })
})

describe('GET /connections: what the page draws each connection from (build PR 9)', () => {
  type Shown = ListAnswer['connections'][number] & { service_name: string; alert_login: boolean; org: string | null; checked_at: string | null; workflows: Array<{ id: string; name: string; deleted: boolean }> }
  const shown = async (env: Env) => {
    const res = await request(app, 'GET', '/connections', env)
    const raw = await res.text()
    expect(raw).not.toContain('SECRET')
    return JSON.parse(raw) as Omit<ListAnswer, 'connections'> & { connections: Shown[] }
  }

  it('names the workflows using each connection (deleted ones marked), the org a Salesforce connection signs in to, and each service by its catalogue name', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS, {
      refs: { [SF]: [{ workflow_id: 'w1', name: 'Lead Completed sync', deleted: false }, { workflow_id: 'w2', name: 'Old import', deleted: true }] },
    }) as never)
    const { env } = makeEnv({})
    const body = await shown(env)
    const sf = body.connections.find((c) => c.id === SF)!
    expect(sf).toMatchObject({ service: 'salesforce', service_name: 'Salesforce', org: 'trypennie.my.salesforce.com', alert_login: false, used_by: 2 })
    expect(sf.workflows).toEqual([{ id: 'w1', name: 'Lead Completed sync', deleted: false }, { id: 'w2', name: 'Old import', deleted: true }])
    expect(body.connections.find((c) => c.id === GOOGLE)!).toMatchObject({ org: null, workflows: [] })
  })

  describe('the Slack alert login, whose status Slack itself is asked for', () => {
    it("asks Slack about the stored token and lists it as Bidspoke Alerts under Slack, Working, acting as the bot Slack names", async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      const { env } = makeEnv({})
      const body = await shown(env)
      expect(vi.mocked(verifySlackToken)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(verifySlackToken)).toHaveBeenCalledWith('xoxb-SECRET')
      expect(body.connections.find((c) => c.id === ALERTS)!).toMatchObject({
        name: 'Bidspoke Alerts', service: 'slack', service_name: 'Slack', alert_login: true, acts_as: 'bidspoke_alerts in Pennie', status: 'ok', status_word: 'Working', health: null,
      })
      expect(body.statuses.stale).toBe(false)
    })

    it('reads Needs reconnecting when Slack refuses the token', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      vi.mocked(verifySlackToken).mockResolvedValue({ kind: 'refused', slackError: 'token_revoked' })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { env } = makeEnv({})
      const body = await shown(env)
      expect(body.connections.find((c) => c.id === ALERTS)!).toMatchObject({ status: 'reauth', status_word: 'Needs reconnecting' })
      // A refusal is an answer: nothing is stale.
      expect(body.statuses).toMatchObject({ stale: false, unavailable: null })
    })

    it('when Slack does not answer, shows the last known status under the stale strip, with the time it is as of', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      vi.mocked(verifySlackToken).mockRejectedValue(new Error('auth.test answered HTTP 503, so the token could not be checked'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const kv = memoryKv()
      const at = Date.parse('2026-10-20T15:52:00Z')
      await rememberSlackAlertStatus(kv as unknown as KVNamespace, ORG, { status: 'reauth', acts_as: 'bidspoke_alerts in Pennie' }, at)
      forgetSlackAlertStatusMemory()
      const { env } = makeEnv({}, kv)
      const body = await shown(env)
      expect(body.connections.find((c) => c.id === ALERTS)!).toMatchObject({ status: 'reauth', status_word: 'Needs reconnecting', acts_as: 'bidspoke_alerts in Pennie', checked_at: new Date(at).toISOString() })
      expect(body.statuses).toMatchObject({ stale: true, as_of: new Date(at).toISOString(), unavailable: { cause: 'slack_unanswered' } })
    })

    it('with no answer and no last known status, shows no status rather than a made up one', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      vi.mocked(verifySlackToken).mockRejectedValue(new TypeError('fetch failed'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { env } = makeEnv({})
      const body = await shown(env)
      expect(body.connections.find((c) => c.id === ALERTS)!).toMatchObject({ status: null, status_word: null, acts_as: null })
      expect(body.statuses).toMatchObject({ stale: true, as_of: null, unavailable: { cause: 'slack_unanswered' } })
    })

    it('gives up on a Slack that hangs at the health deadline, so the list still answers inside the same 15 s', async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      vi.mocked(verifySlackToken).mockReturnValue(new Promise(() => {}))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { env } = makeEnv({})
      const pending = request(app, 'GET', '/connections', env)
      await vi.advanceTimersByTimeAsync(15_000)
      const res = await pending
      expect(res.status).toBe(200)
      const body = (await res.json()) as { connections: Shown[]; statuses: ListAnswer['statuses'] }
      expect(body.connections.find((c) => c.id === ALERTS)!.status).toBeNull()
      expect(body.statuses).toMatchObject({ stale: true, unavailable: { cause: 'slack_unanswered' } })
    })

    it("keeps a measured answer as the last known status the next unanswered list reads", async () => {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
      const kv = memoryKv()
      await shown(makeEnv({}, kv).env)
      expect(JSON.parse(kv.store.get(slackAlertStatusCopyKey(ORG))!)).toMatchObject({ organization_id: ORG, status: 'ok', acts_as: 'bidspoke_alerts in Pennie' })
      vi.mocked(verifySlackToken).mockRejectedValue(new Error('no answer'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const body = await shown(makeEnv({}, kv).env)
      expect(body.connections.find((c) => c.id === ALERTS)!).toMatchObject({ status: 'ok', acts_as: 'bidspoke_alerts in Pennie' })
      expect(body.statuses.stale).toBe(true)
    })

    it('reads Needs reconnecting, without asking Slack, when the stored token cannot be read', async () => {
      const rows = ROWS.map((r) => (r.id === ALERTS ? { ...r, credential_enc: null, config: { default_channel: 'C0ALERTS' } } : r))
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(rows) as never)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { env } = makeEnv({})
      const body = await shown(env)
      expect(vi.mocked(verifySlackToken)).not.toHaveBeenCalled()
      expect(body.connections.find((c) => c.id === ALERTS)!).toMatchObject({ status: 'reauth', status_word: 'Needs reconnecting' })
    })

    it('never asks Slack about an ops Slack connection, whose status is health\'s', async () => {
      const opsSlack = connRow({ id: 'c4000000-0000-4000-8000-000000000004', name: 'Ops alerts bot', service_type: 'slack', sealed_for: 'ops_key' })
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble([...ROWS, opsSlack]) as never)
      const { env } = makeEnv({ health: async () => ({ ok: true, reached_limit: false, connections: [healthRow(opsSlack.id as string, 'healthy')] }) })
      const body = await shown(env)
      expect(vi.mocked(verifySlackToken)).toHaveBeenCalledTimes(1)
      expect(body.connections.find((c) => c.id === opsSlack.id)!).toMatchObject({ name: 'Ops alerts bot', alert_login: false, status: 'ok' })
    })
  })
})

describe('GET /connections/:id/history (the History tab, R5)', () => {
  const entry = (over: Row): Row => ({
    audit_id: 'a1000000-0000-4000-8000-000000000001', action: 'UPDATE', changed_at: '2026-10-18T18:14:00Z', changed_by: USER,
    changed_by_name: 'Dan Wright', changed_by_email: 'dan@pennie.com', changes: { credential_generation: { old: 1, new: 2 } }, credential_changed: true, ...over,
  })

  it("answers the connection's audit rows, newest first as the function gives them, each naming who and when, for the caller's organization", async () => {
    const db = storeDouble(ROWS, { history: { [SF]: [entry({}), entry({ audit_id: 'a2', action: 'INSERT', changed_at: '2026-10-17T14:02:00Z', credential_changed: false, changes: {} })] } })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({})
    const res = await request(app, 'GET', `/connections/${SF}/history`, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<Record<string, unknown>> }
    expect(body.entries).toEqual([
      { id: 'a1000000-0000-4000-8000-000000000001', action: 'UPDATE', at: '2026-10-18T18:14:00Z', by: 'Dan Wright', credential_changed: true, changes: { credential_generation: { old: 1, new: 2 } } },
      { id: 'a2', action: 'INSERT', at: '2026-10-17T14:02:00Z', by: 'Dan Wright', credential_changed: false, changes: {} },
    ])
    expect(db.rpcCalls).toContainEqual(['connection_history', { p_organization_id: ORG, p_connection_id: SF, p_limit: 50 }])
  })

  it('names who by email when the person has no name, and by nothing when the change had no person', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS, { history: { [SF]: [entry({ changed_by_name: null }), entry({ changed_by: null, changed_by_name: null, changed_by_email: null })] } }) as never)
    const { env } = makeEnv({})
    const body = (await (await request(app, 'GET', `/connections/${SF}/history`, env)).json()) as { entries: Array<{ by: string | null }> }
    expect(body.entries.map((e) => e.by)).toEqual(['dan@pennie.com', null])
  })

  it("refuses another organization's connection, or an id that is not one, as not found", async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env } = makeEnv({})
    expect((await request(app, 'GET', `/connections/${THEIRS}/history`, env)).status).toBe(404)
    expect((await request(app, 'GET', '/connections/not-an-id/history', env)).status).toBe(404)
  })

  it('answers a history that could not be read as an error by name with its sentence, never an empty history', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS, { historyError: { code: '57014', message: 'canceling statement due to statement timeout' } }) as never)
    const { env } = makeEnv({})
    const res = await request(app, 'GET', `/connections/${SF}/history`, env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'connection_history_unavailable', message: "The connection's history could not be read." })
  })
})

describe('POST /connections/:id/lookup/:key', () => {
  it('runs the lookup through ops for a connection of the caller\'s organization, and answers what it found', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const answer = { key: 'objects', entries: [{ name: 'Lead', label: 'Lead' }] }
    const { env, binding } = makeEnv({ lookup: async () => ({ ok: true, answer }) })
    const res = await request(app, 'POST', `/connections/${SF}/lookup/objects`, env, { parents: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ answer })
    expect(binding.lookup).toHaveBeenCalledWith({ organization_id: ORG, connection_id: SF, key: 'objects', parents: [] })
  })

  it("refuses another organization's connection by id, and never asks ops", async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env, binding } = makeEnv({ lookup: async () => ({ ok: true, answer: {} }) })
    const res = await request(app, 'POST', `/connections/${THEIRS}/lookup/objects`, env, {})
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'connection_not_found' })
    expect(binding.lookup).not.toHaveBeenCalled()
  })

  it('answers a failed lookup by its name, with what ops said', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env } = makeEnv({ lookup: async () => ({ ok: false, refused: 'schema_auth_refused', detail: 'salesforce refused the login listing objects (401)', retry_at: null }) })
    const res = await request(app, 'POST', `/connections/${SF}/lookup/objects`, env, {})
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'schema_auth_refused', message: 'salesforce refused the login listing objects (401)', retry_at: null })
  })

  it('answers a rate limited lookup as 429 with when to try again', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env } = makeEnv({ lookup: async () => ({ ok: false, refused: 'lookup_rate_limited', detail: '60 a minute', retry_at: '2026-10-20T16:01:00Z' }) })
    const res = await request(app, 'POST', `/connections/${SF}/lookup/objects`, env, {})
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'lookup_rate_limited', retry_at: '2026-10-20T16:01:00Z' })
  })

  it('answers ops not answering as 503 ops_connections_unavailable, never an empty answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env } = makeEnv({ lookup: async () => { throw new Error('internal error; reference = r1') } })
    const res = await request(app, 'POST', `/connections/${SF}/lookup/objects`, env, {})
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'ops_connections_unavailable', cause: 'threw' })
  })

  it('refuses the Slack alert login, which ops does not serve, by name', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS) as never)
    const { env, binding } = makeEnv({})
    const res = await request(app, 'POST', `/connections/${ALERTS}/lookup/objects`, env, {})
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'lookup_not_supported' })
    expect(binding.lookup).not.toHaveBeenCalled()
  })

  it('refuses a malformed request before reading anything: an id that is not a uuid, a bad key, bad parents', async () => {
    const db = storeDouble(ROWS)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({})
    expect((await request(app, 'POST', '/connections/not-a-uuid/lookup/objects', env, {})).status).toBe(404)
    const badKey = await request(app, 'POST', `/connections/${SF}/lookup/Objects!`, env, {})
    expect(badKey.status).toBe(400)
    expect(await badKey.json()).toMatchObject({ error: 'lookup_request_invalid' })
    const badParents = await request(app, 'POST', `/connections/${SF}/lookup/fields`, env, { parents: ['a', 'b'] })
    expect(badParents.status).toBe(400)
    expect(binding.lookup).not.toHaveBeenCalled()
  })

  it('answers a failed connection read as an error, not as not found', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(ROWS, { listError: { code: '57014', message: 'timeout' } }) as never)
    const { env, binding } = makeEnv({})
    const res = await request(app, 'POST', `/connections/${SF}/lookup/objects`, env, {})
    expect(res.status).toBe(503)
    expect(binding.lookup).not.toHaveBeenCalled()
  })
})

// #2331 phase 1a: the old body put a CONN_ secret, and each put deployed a new
// version of the bidding Worker. The sealed create (build PR 5,
// connections-create.test.ts) reads no such body: it is refused by name before
// any table is read.
describe('POST /connections refuses the old service_type and credentials body (#2331)', () => {
  it('answers connection_request_invalid and reads no table', async () => {
    const db = storeDouble(ROWS)
    const from = vi.spyOn(db, 'from')
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({})
    const res = await request(app, 'POST', '/connections', env, { service_type: 'salesforce', credentials: { access_token: 'tok' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'connection_request_invalid' })
    expect(from).not.toHaveBeenCalled()
    expect(binding.verify).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

// #2338 build PR 4: the legacy service type routes are retired. DELETE
// /:service_type had the same path shape as the id routes to come, and
// sync-schema read a Cloudflare secret no connection has.
describe('the legacy service type routes are gone', () => {
  it.each([
    ['DELETE', '/connections/salesforce'],
    ['POST', '/connections/salesforce/sync-schema'],
    ['POST', '/connections/snowflake/sync-schema'],
  ])('%s %s answers 404 and touches nothing', async (method, path) => {
    const db = storeDouble(ROWS)
    const from = vi.spyOn(db, 'from')
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({})
    const res = await request(app, method, path, env)
    expect(res.status).toBe(404)
    expect(from).not.toHaveBeenCalled()
    expect(db.rpcCalls).toEqual([])
  })
})
