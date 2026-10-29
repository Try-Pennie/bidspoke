/**
 * POST /api/connections, the create route (#2338, build PR 5; R13, R14, #2556).
 *
 * In order: the service must be one the catalogue declares; the login and the
 * target are built by the catalogue's connectionParts; a money identity, a
 * reserved or taken name and a Google mailbox or drive off the organization's
 * list are refused before anything is sealed; then the login is sealed under
 * a fresh uuid, OpsConnections.verify checks it, and only a verify that passes
 * is followed by the one INSERT. Every refusal answers its code with the
 * sentence the page shows.
 *
 * The database double enforces the table's unique (organization_id,
 * service_type, name) and the alert name CHECK, so a name race is decided as
 * the database decides it. The ops key pair is made per run; the sealed login
 * is opened in the round trip tests exactly as connectionFetch opens it, and
 * read by the real ops minters.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { open } from '@bidspoke/connection-seal'
import type { ServiceSchema } from '@bidspoke/service-catalogue/schema'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { parseRevokeRequest, parseVerifyRequest, type VerifyRequest } from '../../../lib/ops-connections-contract'
import { makeKeys, type TestKeys } from '../../../ops/connections/__tests__/harness'
import { makeSigningKey } from '../../../ops/connections/minters/__tests__/minter-harness'
import { opsServiceEntry } from '../../../ops/connections/services'
import { supabaseServiceEntry } from '../../../ops/connections/supabase-service'
import { rpcStub } from '../../../test-setup/rpc-stub'
import type { AuthorizeInput } from '../../../ops/connections/service-rules'
import { saveServedConnections, type ConnectionServeDb } from '../../../ops/connection-serve'
import type { UnservedIdentityRemoved } from '../../../ops/ops-writes'
import { CONNECTION_SERVE_WINDOW_MS } from '../../../lib/ops-gateway-contract'

const fixtures = vi.hoisted(() => {
  // The shipped Google entry declares its drives since #2572, so the route's drive check is driven through it.
  const supabase: ServiceSchema = {
    key: 'supabase',
    name: 'Supabase',
    actions: [],
    connection: {
      tile: 'A project, signed in with its service key',
      auth: 'static_key',
      fields: [
        { key: 'project_url', label: 'Project', input: 'text', required: true, target: 'project_url' },
        { key: 'service_key', label: 'Service key', input: 'secret', required: true, login: 'service_key' },
      ],
    },
  }
  // Slack is the real catalogue's own since #2337.
  // sealDelayMs: a real time delay before each seal, for the test that must not count on sealing being quick (L290).
  return { extra: [supabase], publicKeys: {} as Record<string, string>, sealDelayMs: 0 }
})

vi.mock('@bidspoke/service-catalogue/schema', async (importOriginal) => {
  const real = await importOriginal<typeof import('@bidspoke/service-catalogue/schema')>()
  return { ...real, CATALOGUE: [...real.CATALOGUE, ...fixtures.extra] }
})
vi.mock('@bidspoke/connection-seal', async (importOriginal) => {
  const real = await importOriginal<typeof import('@bidspoke/connection-seal')>()
  // Sealing is real crypto that takes real time; a test can make it slower still, in real time, through setImmediate,
  // which no fake timer here replaces (a slow machine in CI, #2721).
  const seal: typeof real.seal = async (...args) => {
    const until = Date.now() + fixtures.sealDelayMs
    while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve))
    return real.seal(...args)
  }
  return { ...real, seal, CURRENT_OPS_KID: 'ops-test-1', OPS_CONNECTION_PUBLIC_KEYS: fixtures.publicKeys }
})
vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/salesforce-creds')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { resolveSalesforceCredsFor } from '../../../lib/salesforce-creds'
import api from '../index'
import { encryptSecret } from '../../../lib/secret-crypto'
import { SLACK_TEST_KEY } from '../../../__tests__/helpers/sealed-slack-row'

const ALERT_SEALED = await encryptSecret('canary-alert-bot-token-2337', SLACK_TEST_KEY)

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002'
const USER = 'aa000000-0000-4000-8000-000000000001'
const KID = 'ops-test-1'

const CLIENT_SECRET = 'canary-client-secret-2338-pr5'
const MONEY_CLIENT_ID = '3MVG9-money-connected-app'
const OPS_CLIENT_ID = '3MVG9-ops-connected-app'
const SF_USERNAME = 'ops-integration@trypennie.com'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Row = Record<string, unknown>

interface StoreOptions {
  readError?: { code: string; message: string }
  insertError?: { code: string; message: string }
  /** The insert committed and its answer was lost on the way back (a dropped connection). */
  insertLandedThenFailed?: boolean
  /** Every read of this table errors (#2337: the money host sources). */
  failTable?: string
}

/** The table as the database holds it: the unique per organization, service and name, and the alert name CHECK. */
function storeDouble(rows: Row[] = [], opts: StoreOptions = {}) {
  const inserts: Row[] = []
  const from = (table: string) => {
    // A row names its table as _table; one that names none is a service_connections row.
    const filters: Array<(r: Row) => boolean> = [(r) => (r._table ?? 'service_connections') === table]
    let inserted: Row | null = null
    const b = {
      select() { return b },
      order() { return b },
      // readOrgWorkflows pages with range (#2337: the money workflows an HTTP save reads).
      range(fromRow: number, toRow: number) {
        if (opts.failTable === table) return Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
        return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(fromRow, toRow + 1), error: null })
      },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
      is(col: string, v: unknown) { filters.push((r) => (r[col] ?? null) === v); return b },
      // onlySlackAlertRow's seal filter: sealed for bidding, or the legacy unsealed row.
      or() { filters.push((r) => r.sealed_for === 'bidding_ring' || r.sealed_for === null || r.sealed_for === undefined); return b },
      limit(n: number) {
        if (opts.readError) return Promise.resolve({ data: null, error: opts.readError })
        if (opts.failTable === table) return Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
        return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, n), error: null })
      },
      insert(row: Row) { inserted = row; return b },
      async maybeSingle() {
        if (opts.readError) return { data: null, error: opts.readError }
        const found = rows.filter((r) => filters.every((f) => f(r)))
        return { data: found[0] ?? null, error: null }
      },
      async single() {
        if (table !== 'service_connections' || inserted === null) return { data: null, error: { code: 'XX000', message: 'unexpected single' } }
        const row = inserted
        inserts.push(row)
        if (opts.insertLandedThenFailed) {
          rows.push({ created_at: '2026-10-20T22:00:00Z', ...row })
          return { data: null, error: { code: '', message: 'TypeError: fetch failed' } }
        }
        if (opts.insertError) return { data: null, error: opts.insertError }
        if (row.service_type === 'slack' && row.name === 'slack' && row.sealed_for === 'ops_key') {
          return { data: null, error: { code: '23514', message: 'new row for relation "service_connections" violates check constraint "service_connections_alert_name_reserved"' } }
        }
        if (rows.some((r) => r.organization_id === row.organization_id && r.service_type === row.service_type && r.name === row.name)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "service_connections_org_type_name_unique"' } }
        }
        const stored = { created_at: '2026-10-20T22:00:00Z', ...row }
        rows.push(stored)
        return { data: stored, error: null }
      },
    }
    return b
  }
  const rpc = (name: string) => {
    if (name === 'auth_user_with_allowlist') {
      return Promise.resolve({ data: [{ id: USER, organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright', allowed: true }], error: null })
    }
    return Promise.resolve({ data: null, error: { code: '42883', message: `no function ${name}` } })
  }
  return { from, rpc, rows, inserts }
}

type Verify = (request: VerifyRequest) => Promise<unknown>

const verified = (username = SF_USERNAME): Verify => async (r) => ({
  ok: true, service: r.candidate!.service, generation: r.candidate!.generation, identity: { kind: 'salesforce', sf_org_id: '00DDp00000170r6MAA', username },
})

const listed = (subjects: Array<{ kind: 'mailbox' | 'drive'; subject: string }>) => async () => ({
  ok: true,
  reached_limit: false,
  subjects: subjects.map((s) => ({ ...s, display_name: null, added_by: 'Dan Wright', added_at: '2026-10-20T15:00:00Z' })),
})

const WORKER_ENV = {
  SUPABASE_URL: 'https://moneyref0123456789ab.supabase.co',
  APP_URL: 'https://bidspoke.trypennie.dev',
  SNOWFLAKE_ACCOUNT: 'MONEY12345.us-east-1',
  SNOWFLAKE_USER: 'BIDSPOKE_EXPORT',
  ARCHIVE_WRITER_USER: 'ARCHIVE_WRITER',
  ARCHIVE_READER_USER: 'ARCHIVE_READER',
  ARCHIVE_ERASER_USER: 'ARCHIVE_ERASER',
}

function makeEnv(ops: { verify?: Verify; list?: () => Promise<unknown>; revoke?: (r: unknown) => Promise<unknown> } = {}) {
  const binding = {
    verify: vi.fn((r: unknown) => (ops.verify ?? verified())(r as VerifyRequest)),
    listDelegationSubjects: vi.fn(ops.list ?? listed([])),
    revoke: vi.fn(ops.revoke ?? (async () => ({ ok: true, outcome: 'recorded', copies_removed: 0 }))),
    clearReauth: vi.fn(), health: vi.fn(), lookup: vi.fn(), exchangeOAuthCode: vi.fn(),
  }
  // Shaped like the real RPC stub, so a call it would refuse fails here too (#2570).
  const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, OPS_CONNECTIONS: rpcStub(binding), ...WORKER_ENV, SECRET_ENCRYPTION_KEY: SLACK_TEST_KEY } as unknown as Env
  return { env, binding }
}

const ctx = recordingContext()

async function post(env: Env, body: unknown) {
  return api.request('/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env, ctx)
}

const salesforce = (over: Record<string, unknown> = {}) => ({
  service: 'salesforce',
  name: 'Pennie Salesforce',
  fields: { instance_url: 'https://trypennie.my.salesforce.com', client_id: OPS_CLIENT_ID, client_secret: CLIENT_SECRET },
  ...over,
})

interface Refusal { error: string; message: string; fields?: string[] }

let keys: TestKeys
let snowflakePem: string

beforeAll(async () => {
  keys = await makeKeys()
  Object.assign(fixtures.publicKeys, keys.publicKeys)
  snowflakePem = (await makeSigningKey()).pem
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
  vi.mocked(resolveSalesforceCredsFor).mockResolvedValue({
    creds: { instanceUrl: 'https://trypennie.my.salesforce.com', clientId: MONEY_CLIENT_ID, clientSecret: 'money-secret-never-read' }, missing: [],
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('POST /connections saves a connection only once verify passes', () => {
  it('seals the login under a fresh uuid, verifies it for the caller\'s organization, then inserts that one row', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv()
    const res = await post(env, salesforce())
    expect(res.status).toBe(201)
    const body = (await res.json()) as { connection: { id: string; name: string; service: string; acts_as: string } }
    expect(body.connection).toMatchObject({ name: 'Pennie Salesforce', service: 'salesforce', acts_as: SF_USERNAME })
    expect(body.connection.id).toMatch(UUID)

    expect(binding.verify).toHaveBeenCalledTimes(1)
    const request = parseVerifyRequest(binding.verify.mock.calls[0][0])
    expect(request.organization_id).toBe(ORG)
    expect(request.connection_id).toBe(body.connection.id)
    expect(request.candidate).toMatchObject({
      service: 'salesforce', generation: 1, public_config: {},
      target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: OPS_CLIENT_ID },
    })
    expect(request.candidate!.envelope.kid).toBe(KID)

    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0]).toMatchObject({
      id: body.connection.id,
      organization_id: ORG,
      service_type: 'salesforce',
      name: 'Pennie Salesforce',
      auth_type: 'oauth_client_credentials',
      sealed_for: 'ops_key',
      credential_generation: 1,
      target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: OPS_CLIENT_ID },
      acts_as: SF_USERNAME,
      person_bound: false,
      // The store's audit trigger names the actor from updated_by (20261018191000).
      updated_by: USER,
      updated_by_email: 'dan@pennie.com',
    })
    expect(JSON.parse(db.inserts[0].credential_enc as string)).toEqual(request.candidate!.envelope)
  })

  it('never carries the login in the clear: not to verify, not into the row, not in the answer', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv()
    const res = await post(env, salesforce())
    expect(await res.text()).not.toContain(CLIENT_SECRET)
    expect(JSON.stringify(binding.verify.mock.calls)).not.toContain(CLIENT_SECRET)
    expect(JSON.stringify(db.inserts)).not.toContain(CLIENT_SECRET)
  })

  it('inserts only ops_key rows, so it never writes the Slack alert row the saved Slack copy holds (#2060)', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({ verify: async (r) => ({ ok: true, service: r.candidate!.service, generation: 1, identity: { kind: 'snowflake', account_locator: 'AB1', organization_name: null, account_name: null, user: 'BOT' } }) })
    await post(env, salesforce())
    await post(env, { service: 'slack', name: 'Ops bot', fields: { team_id: 'T0PENNIE', bot_token: 'canary-ops-bot-token-2337' } })
    expect(db.inserts.map((r) => r.service_type)).toEqual(['salesforce', 'slack'])
    expect(db.inserts.every((r) => r.sealed_for === 'ops_key')).toBe(true)
  })

  it('writes no audit row of its own: the store trigger records the insert under the actor, so History shows it once', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv()
    expect((await post(env, salesforce())).status).toBe(201)
    expect(writeAuditLog).not.toHaveBeenCalled()
  })
})

describe('the sealed login opens through the real ops minters (round trip)', () => {
  /** What connectionFetch does with a candidate: open it under the AAD it builds, then hand it to the service's minter. */
  async function mintFromCandidate(raw: unknown, fetch: AuthorizeInput['fetch']) {
    const request = parseVerifyRequest(raw)
    const candidate = request.candidate!
    const plaintext = await open(keys.privateKeys, candidate.envelope, {
      organization_id: request.organization_id, connection_id: request.connection_id, service: candidate.service, generation: candidate.generation, kid: candidate.envelope.kid,
    })
    // Supabase is built per request on ops (it reads the ops project from the env), so here with the lane projects named.
    const entry = candidate.service === 'supabase' ? supabaseServiceEntry({ laneProjectRefs: () => ['xvrmivmpfykwwtriqwpg', 'zwihpjxouklvkvngkvmw'] }) : opsServiceEntry(candidate.service)!
    return entry.rules.authorize({
      organizationId: request.organization_id as never, connectionId: request.connection_id, service: candidate.service, generation: candidate.generation,
      target: candidate.target, publicConfig: candidate.public_config, envelope: candidate.envelope, login: { plaintext }, candidate: true, renew: null,
      noteMint: () => undefined, noteUnreadableRateLimitHeader: () => undefined, fetch,
    })
  }

  it('Salesforce: the minter asks the declared org for a client credentials token with the client id and secret typed', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const sent: URLSearchParams[] = []
    const { env } = makeEnv({
      verify: async (r) => {
        const auth = await mintFromCandidate(r, async (_url, init) => {
          sent.push(new URLSearchParams(String(init?.body ?? '')))
          return Response.json({ access_token: 'canary-access-token', instance_url: 'https://trypennie.my.salesforce.com' })
        })
        expect(auth.headers.authorization).toBe('Bearer canary-access-token')
        return verified()(r)
      },
    })
    expect((await post(env, salesforce())).status).toBe(201)
    expect(sent).toHaveLength(1)
    expect(sent[0].get('grant_type')).toBe('client_credentials')
    expect(sent[0].get('client_id')).toBe(OPS_CLIENT_ID)
    expect(sent[0].get('client_secret')).toBe(CLIENT_SECRET)
  })

  it('Snowflake: the minter signs its own token with the private key typed, asking no endpoint', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    let header = ''
    const { env } = makeEnv({
      verify: async (r) => {
        const auth = await mintFromCandidate(r, async () => { throw new Error('a key pair login asks no token endpoint') })
        header = auth.headers.authorization
        return { ok: true, service: 'snowflake', generation: 1, identity: { kind: 'snowflake', account_locator: 'AB12345', organization_name: null, account_name: null, user: 'OPS_READER' } }
      },
    })
    const res = await post(env, {
      service: 'snowflake', name: 'Ops Snowflake', fields: { account: 'ab12345.us-east-1', user: 'OPS_READER', private_key: snowflakePem },
    })
    expect(res.status).toBe(201)
    expect(header).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('OPS_READER')
  })

  it('OpenAI (#2337): the key typed is sent with the project, and saved acting as its project in its organization', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    let headers: Record<string, string> = {}
    const { env } = makeEnv({
      verify: async (r) => {
        headers = { ...(await mintFromCandidate(r, async () => { throw new Error('a static key asks no token endpoint') })).headers }
        return { ok: true, service: 'openai', generation: 1, identity: { kind: 'openai', project_id: 'proj_0PS2337', organization: 'pennie-ops' } }
      },
    })
    const res = await post(env, { service: 'openai', name: 'Summaries', fields: { project_id: 'proj_0PS2337', api_key: 'canary-openai-key-2337' } })
    expect(res.status).toBe(201)
    expect(headers).toEqual({ authorization: 'Bearer canary-openai-key-2337', 'openai-project': 'proj_0PS2337' })
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('Project proj_0PS2337 in pennie-ops')
    expect(db.inserts.map((r) => [r.service_type, r.auth_type, r.sealed_for, r.target])).toEqual([['openai', 'api_key', 'ops_key', { project_id: 'proj_0PS2337' }]])
    expect(JSON.stringify(db.inserts)).not.toContain('canary-openai-key-2337')
  })

  it('Anthropic (#2337): the key typed is sent with the workspace, and saved acting as its workspace', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    let headers: Record<string, string> = {}
    const { env } = makeEnv({
      verify: async (r) => {
        headers = { ...(await mintFromCandidate(r, async () => { throw new Error('a static key asks no token endpoint') })).headers }
        return { ok: true, service: 'anthropic', generation: 1, identity: { kind: 'anthropic', workspace_id: 'wrkspc_0PS2337', organization_id: '0a1b2c3d-0000-4000-8000-000000002337' } }
      },
    })
    const res = await post(env, { service: 'anthropic', name: 'Lead notes 2', fields: { workspace_id: 'wrkspc_0PS2337', api_key: 'canary-ant-key-2337' } })
    expect(res.status).toBe(201)
    expect(headers).toEqual({ 'x-api-key': 'canary-ant-key-2337', 'anthropic-workspace-id': 'wrkspc_0PS2337' })
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('Workspace wrkspc_0PS2337')
    expect(db.inserts.map((r) => [r.service_type, r.auth_type, r.sealed_for, r.target])).toEqual([['anthropic', 'api_key', 'ops_key', { workspace_id: 'wrkspc_0PS2337' }]])
    expect(JSON.stringify(db.inserts)).not.toContain('canary-ant-key-2337')
  })

  it('HTTP (#2337): the header value typed is sent in the header declared, and saved acting as its host', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    let headers: Record<string, string> = {}
    const { env } = makeEnv({
      verify: async (r) => {
        headers = { ...(await mintFromCandidate(r, async () => { throw new Error('a static key asks no token endpoint') })).headers }
        return { ok: true, service: 'http', generation: 1, identity: { kind: 'http', host: 'api.lender.example' } }
      },
    })
    const fields = { host: 'https://api.lender.example/v2', header: 'X-Partner-Key', check_path: '/v2/me', api_key: 'canary-http-key-2337' }
    const res = await post(env, { service: 'http', name: 'Lender API', fields })
    expect(res.status).toBe(201)
    expect(headers).toEqual({ 'x-partner-key': 'canary-http-key-2337' })
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('api.lender.example')
    expect(db.inserts.map((r) => [r.service_type, r.auth_type, r.sealed_for, r.target])).toEqual([
      ['http', 'api_key', 'ops_key', { host: 'https://api.lender.example/v2', header: 'X-Partner-Key', check_path: '/v2/me' }],
    ])
    expect(JSON.stringify(db.inserts)).not.toContain('canary-http-key-2337')
  })

  it('Supabase (#2337): the service key typed is sent as apikey and bearer, and saved acting as its project', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    let headers: Record<string, string> = {}
    const { env } = makeEnv({
      verify: async (r) => {
        headers = { ...(await mintFromCandidate(r, async () => { throw new Error('a static key asks no token endpoint') })).headers }
        return { ok: true, service: 'supabase', generation: 1, identity: { kind: 'supabase', project_ref: 'blicjwldjfjubbukxatn' } }
      },
    })
    const fields = { project_url: 'https://blicjwldjfjubbukxatn.supabase.co', service_key: 'canary-supabase-key-2337' }
    const res = await post(env, { service: 'supabase', name: 'Forms database', fields })
    expect(res.status).toBe(201)
    expect(headers).toEqual({ apikey: 'canary-supabase-key-2337', authorization: 'Bearer canary-supabase-key-2337' })
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('Project blicjwldjfjubbukxatn')
    expect(db.inserts.map((r) => [r.service_type, r.auth_type, r.sealed_for, r.target])).toEqual([
      ['supabase', 'api_key', 'ops_key', { project_url: 'https://blicjwldjfjubbukxatn.supabase.co' }],
    ])
    expect(JSON.stringify(db.inserts)).not.toContain('canary-supabase-key-2337')
  })
})

describe('an ops Supabase connection never names the bidding project (#2337)', () => {
  it.each([
    ['its Project URL', 'https://moneyref0123456789ab.supabase.co'],
    ['its Project URL with a path', 'https://moneyref0123456789ab.supabase.co/rest/v1/'],
    ['its bare ref', 'moneyref0123456789ab'],
  ])('refuses %s at save, by the money check every service shares, before verify', async (_what, project_url) => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv()
    const res = await post(env, { service: 'supabase', name: 'Bidding database', fields: { project_url, service_key: 'canary-supabase-key-2337' } })
    expect(res.status).toBe(422)
    expect((await res.json()) as Refusal & { money: string; matched: string }).toMatchObject({ error: 'connection_money_identity', money: 'supabase_project', matched: 'SUPABASE_URL' })
    expect(binding.verify).not.toHaveBeenCalled()
    expect(db.inserts).toEqual([])
  })

  it('says a lane project verify refused in its own sentence', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'verify_supabase_lane_project', detail: 'named on ops' }) })
    const body = (await (await post(env, { service: 'supabase', name: 'Ops database', fields: { project_url: 'zwihpjxouklvkvngkvmw', service_key: 'canary-supabase-key-2337' } })).json()) as Refusal
    expect(body).toMatchObject({
      error: 'verify_supabase_lane_project',
      message: 'This is one of the Supabase projects Bidspoke itself runs on, which a workflow connection may never use. Nothing was saved. Use a project made for workflows.',
    })
  })
})

describe('an ops Slack connection is never the alerts bot (Dan\'s decision 6, #2337)', () => {
  const ALERT_TOKEN = 'canary-alert-bot-token-2337'
  // The alert row as stored (#2331's contract release): its token sealed with the Worker's key, no plaintext.
  const alertRow = { id: 'a1', organization_id: ORG, service_type: 'slack', name: 'slack', sealed_for: null, credential_enc: ALERT_SEALED, config: { default_channel: 'C0ALERTS' } }
  const opsSlack = { service: 'slack', name: 'Ops bot', fields: { team_id: 'T0PENNIE', bot_token: 'canary-ops-bot-token-2337' } }
  const measured = (botId: string): Verify => async (r) => ({
    ok: true, service: r.candidate!.service, generation: 1,
    identity: { kind: 'slack', team_id: 'T0PENNIE', team: 'Pennie', user_id: 'U0OPS', user: 'bidspoke_ops', bot_id: botId },
  })
  /** Slack's auth.test, as the bidding Worker asks it about the alerts token. */
  function alertsBotIs(answer: { bot_id: string } | Error) {
    const asked: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      asked.push(req)
      if (answer instanceof Error) throw answer
      return Response.json({ ok: true, team_id: 'T0PENNIE', team: 'Pennie', user_id: 'U0ALERTS', user: 'bidspoke_alerts', ...answer })
    }))
    return asked
  }
  afterEach(() => vi.unstubAllGlobals())

  it('is refused by name when the token verify measured is the alerts bot, and nothing is stored', async () => {
    const db = storeDouble([alertRow])
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const asked = alertsBotIs({ bot_id: 'B0ALERTS' })
    const { env } = makeEnv({ verify: measured('B0ALERTS') })
    const res = await post(env, opsSlack)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string; message: string; money: string }
    expect([body.error, body.money]).toEqual(['connection_money_identity', 'slack_alert_bot'])
    expect(body.message).toBe('This is the Slack bot that posts Bidspoke\'s own alerts, which a workflow connection may never use. Nothing was saved. Use a login made for workflows.')
    expect(JSON.stringify(body)).not.toContain(ALERT_TOKEN)
    expect(db.inserts).toEqual([])
    expect(asked.map((r) => r.headers.get('Authorization'))).toEqual([`Bearer ${ALERT_TOKEN}`])
  })

  it('is saved, acting as its bot in its workspace, when it is another bot', async () => {
    const db = storeDouble([alertRow])
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    alertsBotIs({ bot_id: 'B0ALERTS' })
    const { env } = makeEnv({ verify: measured('B0OPS') })
    const res = await post(env, opsSlack)
    expect(res.status).toBe(201)
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('bidspoke_ops in Pennie')
    expect(db.inserts.map((r) => [r.service_type, r.sealed_for, r.target])).toEqual([['slack', 'ops_key', { team_id: 'T0PENNIE' }]])
  })

  it("says which of verify's two Slack refusals it was, each in its own sentence", async () => {
    const sentences: Record<string, string> = {}
    for (const refused of ['verify_slack_not_a_bot', 'verify_slack_workspace_mismatch']) {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble([alertRow]) as never)
      const { env } = makeEnv({ verify: async () => ({ ok: false, refused, detail: 'named on ops' }) })
      const body = (await (await post(env, opsSlack)).json()) as { error: string; message: string }
      expect(body.error).toBe(refused)
      sentences[refused] = body.message
    }
    expect(sentences).toEqual({
      verify_slack_not_a_bot: 'This token acts as a person, not as a bot. Nothing was saved. Use the bot token from the ops Slack app and save again.',
      verify_slack_workspace_mismatch: 'Slack says this bot is in another workspace than the Workspace ID entered. Nothing was saved. Check the Workspace ID and save again.',
    })
  })

  it('is refused, never passed, when whether it is the alerts bot cannot be told', async () => {
    const db = storeDouble([alertRow])
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    alertsBotIs(new TypeError('network down'))
    const { env } = makeEnv({ verify: measured('B0OPS') })
    const res = await post(env, opsSlack)
    expect(((await res.json()) as { error: string }).error).toBe('connection_money_targets_unreadable')
    expect(db.inserts).toEqual([])
  })
})

describe('an ops OpenAI connection: a project\'s API key (#2337)', () => {
  const API_KEY = 'canary-openai-key-2337'
  const openai = { service: 'openai', name: 'Summaries', fields: { project_id: 'proj_0PS2337', api_key: API_KEY } }

  it('acts as its project alone when OpenAI named no organization', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ verify: async () => ({ ok: true, service: 'openai', generation: 1, identity: { kind: 'openai', project_id: 'proj_0PS2337', organization: null } }) })
    const res = await post(env, openai)
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('Project proj_0PS2337')
  })

  it('says an Anthropic key of another workspace in its own sentence', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'verify_anthropic_workspace_mismatch', detail: 'named on ops' }) })
    const body = (await (await post(env, { service: 'anthropic', name: 'Lead notes 2', fields: { workspace_id: 'wrkspc_0PS2337', api_key: 'canary-ant-key-2337' } })).json()) as { error: string; message: string }
    expect(body).toMatchObject({
      error: 'verify_anthropic_workspace_mismatch',
      message: 'Anthropic says this API key runs in another workspace than the Workspace ID entered. Nothing was saved. Check the Workspace ID and save again.',
    })
  })

  // A wrong Project ID with a valid key is answered by OpenAI with a 401 its error reference does not tell
  // apart from a bad key's (#2715), so verify answers connection_needs_reauth for both, and the sentence names both.
  it('says a refused key may be the key or the Project ID, and to check the Project ID first (#2715)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'connection_needs_reauth', detail: 'the login was refused', retry_at: null }) })
    const body = (await (await post(env, openai)).json()) as { error: string; message: string }
    expect(body).toMatchObject({
      error: 'connection_needs_reauth',
      message: 'OpenAI refused the API key with this Project ID, so either the key or the Project ID is wrong. Nothing was saved. Check the Project ID first, then the key, and save again.',
    })
  })

  it('a service whose key names no project keeps the plain refused key sentence (#2715)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'connection_needs_reauth', detail: 'the login was refused', retry_at: null }) })
    const body = (await (await post(env, { service: 'anthropic', name: 'Lead notes 2', fields: { workspace_id: 'wrkspc_0PS2337', api_key: 'canary-ant-key-2337' } })).json()) as { error: string; message: string }
    expect(body.error).toBe('connection_needs_reauth')
    expect(body.message).not.toContain('Workspace ID')
    expect(body.message).toMatch(/^Anthropic refused the /)
  })

  it('says a key of another project in its own sentence', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'verify_openai_project_mismatch', detail: 'named on ops' }) })
    const body = (await (await post(env, openai)).json()) as { error: string; message: string }
    expect(body).toMatchObject({
      error: 'verify_openai_project_mismatch',
      message: 'OpenAI says this API key belongs to another project than the Project ID entered. Nothing was saved. Check the Project ID and save again.',
    })
  })
})

describe('refused before anything is sealed or verified', () => {
  async function refused(body: unknown, db = storeDouble()) {
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv()
    const res = await post(env, body)
    expect(binding.verify).not.toHaveBeenCalled()
    expect(db.inserts).toEqual([])
    return { status: res.status, body: (await res.json()) as Refusal, binding }
  }

  it('a service the catalogue does not declare', async () => {
    const r = await refused(salesforce({ service: 'hubspot' }))
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('connection_service_undeclared')
    expect(r.body.message).toBe('Bidspoke cannot connect to hubspot yet. Nothing was saved. Choose one of the services the form offers.')
  })

  it('a blank required field, named by its label', async () => {
    const r = await refused(salesforce({ fields: { instance_url: 'https://trypennie.my.salesforce.com', client_id: OPS_CLIENT_ID, client_secret: '  ' } }))
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ error: 'connection_fields_missing', fields: ['client_secret'] })
    expect(r.body.message).toBe('Client secret is empty. Nothing was saved. Fill it in and save again.')
  })

  it('a field the service does not declare, by name', async () => {
    const r = await refused(salesforce({ fields: { instance_url: 'https://trypennie.my.salesforce.com', client_id: OPS_CLIENT_ID, client_secret: CLIENT_SECRET, username: 'x' } }))
    expect(r.body).toMatchObject({ error: 'connection_fields_undeclared', fields: ['username'] })
  })

  it('a blank name', async () => {
    expect((await refused(salesforce({ name: '   ' }))).body.error).toBe('connection_name_missing')
  })

  it('a body that names an organization: the caller\'s own is the only one a save can be for', async () => {
    const r = await refused(salesforce({ organization_id: OTHER_ORG }))
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('connection_request_invalid')
    expect(JSON.stringify(r.body)).toContain('organization_id')
  })

  it('a body that is not JSON', async () => {
    expect((await refused('{not json')).body.error).toBe('connection_request_invalid')
  })

  it('a body over the limit in bytes, though under it in characters', async () => {
    // Each of these is one UTF-16 unit and three bytes, so 12,000 of them is 36,000 bytes.
    const r = await refused(salesforce({ name: 'Pennie Salesforce', fields: { instance_url: 'https://trypennie.my.salesforce.com', client_id: OPS_CLIENT_ID, client_secret: '€'.repeat(12_000) } }))
    expect(r.body).toMatchObject({ error: 'connection_request_invalid', detail: 'the body is over 32768 bytes' })
  })

  it('a body whose declared length is over the limit, before it is read', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env, binding } = makeEnv()
    const res = await api.request('/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok', 'Content-Length': '999999' },
      body: JSON.stringify(salesforce()),
    }, env, ctx)
    expect(await res.json()).toMatchObject({ error: 'connection_request_invalid', detail: 'the body is over 32768 bytes' })
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('a name another connection of the service already has in the organization', async () => {
    const db = storeDouble([{ id: 'c1', organization_id: ORG, service_type: 'salesforce', name: 'Pennie Salesforce' }])
    const r = await refused(salesforce(), db)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('connection_name_taken')
  })

  it('the same name in another organization is not taken', async () => {
    const db = storeDouble([{ id: 'c9', organization_id: OTHER_ORG, service_type: 'salesforce', name: 'Pennie Salesforce' }])
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv()
    expect((await post(env, salesforce())).status).toBe(201)
    expect(db.rows.filter((r) => r.organization_id === ORG)).toHaveLength(1)
  })

  it('the Slack alert login\'s reserved name', async () => {
    const r = await refused({ service: 'slack', name: 'Slack', fields: { team_id: 'T0PENNIE', bot_token: 'canary-ops-bot-token-2337' } })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('connection_name_reserved')
  })

  it.each([
    ['the money Salesforce connected app', salesforce({ fields: { instance_url: 'https://lendco.my.salesforce.com', client_id: MONEY_CLIENT_ID, client_secret: CLIENT_SECRET } }), 'salesforce_client_id'],
    ['the export\'s Snowflake user', { service: 'snowflake', name: 'S', fields: { account: 'ab99999.us-east-1', user: 'bidspoke_export', private_key: 'k' } }, 'snowflake_user'],
    ['the archive writer', { service: 'snowflake', name: 'S', fields: { account: 'MONEY12345.us-east-1', user: 'ARCHIVE_WRITER', private_key: 'k' } }, 'snowflake_user'],
    ['the archive reader', { service: 'snowflake', name: 'S', fields: { account: 'MONEY12345', user: 'Archive_Reader', private_key: 'k' } }, 'snowflake_user'],
    ['the archive eraser', { service: 'snowflake', name: 'S', fields: { account: 'MONEY12345', user: 'ARCHIVE_ERASER', private_key: 'k' } }, 'snowflake_user'],
    ['the money Supabase project', { service: 'supabase', name: 'S', fields: { project_url: 'https://moneyref0123456789ab.supabase.co', service_key: 'k' } }, 'supabase_project'],
  ])('a money identity: %s', async (_what, body, kind) => {
    const r = await refused(body)
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('connection_money_identity')
    expect(r.body.message).toMatch(/which a workflow connection may never use\. Nothing was saved\./)
    const { matched, money, ...rest } = r.body as unknown as { matched: string; money: string }
    expect(money).toBe(kind)
    // Named by the secret it came from, never by its value.
    expect(Object.keys(WORKER_ENV).concat('SALESFORCE_CLIENT_ID', 'SUPABASE_URL')).toContain(matched)
    expect(JSON.stringify(rest)).not.toMatch(/BIDSPOKE_EXPORT|ARCHIVE_|moneyref0123456789ab|3MVG9-money/i)
  })

  it('anything, when the money identities cannot be read: never a pass', async () => {
    vi.mocked(resolveSalesforceCredsFor).mockRejectedValue(new Error('database down'))
    const r = await refused(salesforce())
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('connection_money_targets_unreadable')
  })
})

describe('Google: a mailbox or drive must be on the organization\'s list before verify is asked', () => {
  // The shipped Google entry's form: the mailbox it acts as, and the shared drives it names, a list (#2572).
  const google = (fields: Record<string, string | string[]>) => ({ service: 'google', name: 'Ops mailbox', fields })

  it('refuses a mailbox not on the list, naming it, and asks verify nothing', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({ list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }]) })
    const res = await post(env, google({ subject: 'ceo@trypennie.com' }))
    expect(res.status).toBe(422)
    const body = (await res.json()) as Refusal
    expect(body.error).toBe('google_subject_not_listed')
    expect(body.message).toContain('ceo@trypennie.com is not on the company list of mailboxes and drives')
    expect(binding.listDelegationSubjects).toHaveBeenCalledWith({ organization_id: ORG })
    expect(binding.verify).not.toHaveBeenCalled()
    expect(db.inserts).toEqual([])
  })

  it('refuses a drive not on the list, though its mailbox is', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env, binding } = makeEnv({ list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }]) })
    const res = await post(env, google({ subject: 'OPS@trypennie.com', drives: ['0AFinanceDrive'] }))
    expect(((await res.json()) as Refusal).message).toContain('0AFinanceDrive is not on the company list')
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('goes on to verify a mailbox and two drives that are on the list, sending the drives as the list the minter reads', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    let asked: VerifyRequest | null = null
    const { env, binding } = makeEnv({
      list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }, { kind: 'drive', subject: '0AFinanceDrive' }, { kind: 'drive', subject: '0AReportsDrive' }]),
      verify: async (r) => {
        asked = r
        return { ok: false, refused: 'connection_service_unknown', detail: 'no rules for the google service on this Worker', retry_at: null }
      },
    })
    const res = await post(env, google({ subject: 'Ops@TryPennie.com ', drives: ['0AFinanceDrive', '0AReportsDrive'] }))
    expect(binding.verify).toHaveBeenCalledTimes(1)
    expect(asked!.candidate!.target).toEqual({ subject: 'Ops@TryPennie.com ', drives: ['0AFinanceDrive', '0AReportsDrive'] })
    expect(((await res.json()) as Refusal).error).toBe('connection_service_unknown')
  })

  it('refuses a listed drive chosen as the mailbox it acts as, naming the drive as the list holds it, never lower cased', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env, binding } = makeEnv({ list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }, { kind: 'drive', subject: '0AFinanceDrive' }]) })
    const res = await post(env, google({ subject: '0AFinanceDrive' }))
    expect(res.status).toBe(422)
    const body = (await res.json()) as Refusal
    expect(body.error).toBe('google_subject_is_drive')
    expect(body.message).toContain('0AFinanceDrive is a shared drive')
    expect(body.message).not.toContain('0afinancedrive')
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('names a listed drive chosen as the mailbox by the name the list gives it', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({
      list: async () => ({ ok: true, reached_limit: false, subjects: [{ kind: 'drive', subject: '0AFinanceDrive', display_name: 'Finance', added_by: 'Dan Wright', added_at: '2026-10-20T15:00:00Z' }] }),
    })
    const body = (await (await post(env, google({ subject: '0AFinanceDrive' }))).json()) as Refusal
    expect(body.error).toBe('google_subject_is_drive')
    expect(body.message).toContain('Finance is a shared drive')
  })

  it('refuses drives sent as text rather than a list, before the list is asked, so the minter never sees a string', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env, binding } = makeEnv({ list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }, { kind: 'drive', subject: '0AFinanceDrive' }]) })
    const res = await post(env, google({ subject: 'ops@trypennie.com', drives: '0AFinanceDrive' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as Refusal & { detail: string })).toMatchObject({ error: 'connection_request_invalid', detail: 'drives is not in the shape its field takes' })
    expect(binding.listDelegationSubjects).not.toHaveBeenCalled()
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('refuses more drives than the minter reads, though every one is listed, and asks verify nothing (#2819)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const drives = Array.from({ length: 101 }, (_, i) => `0ADrive${i}`)
    const { env, binding } = makeEnv({ list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }, ...drives.map((subject) => ({ kind: 'drive' as const, subject }))]) })
    const res = await post(env, google({ subject: 'ops@trypennie.com', drives }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as Refusal).error).toBe('connection_request_invalid')
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('compares a drive as the minter sends it, so one with spaces around it is not the listed drive (#2819)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env, binding } = makeEnv({ list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }, { kind: 'drive', subject: '0AFinanceDrive' }]) })
    const res = await post(env, google({ subject: 'ops@trypennie.com', drives: [' 0AFinanceDrive'] }))
    expect(res.status).toBe(422)
    expect(((await res.json()) as Refusal).error).toBe('google_subject_not_listed')
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('refuses a list holding anything but text, by the field\'s name', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }]) })
    const res = await post(env, { service: 'google', name: 'Ops mailbox', fields: { subject: 'ops@trypennie.com', drives: ['0AFinanceDrive', 7] } })
    expect(((await res.json()) as Refusal & { detail: string })).toMatchObject({ error: 'connection_request_invalid', detail: 'drives is not text' })
  })

  it('refuses when the list cannot be read, never passing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env, binding } = makeEnv({ list: async () => ({ ok: false, refused: 'delegation_list_unavailable', detail: 'x', retry_at: null }) })
    const res = await post(env, google({ subject: 'ops@trypennie.com' }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as Refusal).error).toBe('google_list_unavailable')
    expect(binding.verify).not.toHaveBeenCalled()
  })
})

describe('an ops Google connection: a company mailbox on the list (#2337)', () => {
  it('seals an empty login, declares only the mailbox, and is saved acting as the mailbox verify read back', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    let sealed: VerifyRequest | null = null
    const { env } = makeEnv({
      list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }]),
      verify: async (r) => {
        sealed = r
        return { ok: true, service: 'google', generation: 1, identity: { kind: 'google', mailbox: 'ops@trypennie.com' } }
      },
    })
    const res = await post(env, { service: 'google', name: 'Ops mailbox', fields: { subject: 'ops@trypennie.com' } })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { connection: { acts_as: string } }).connection.acts_as).toBe('ops@trypennie.com')
    expect(sealed!.candidate!.target).toEqual({ subject: 'ops@trypennie.com' })
    expect(db.inserts.map((r) => [r.service_type, r.auth_type, r.sealed_for, r.target])).toEqual([['google', 'service_account', 'ops_key', { subject: 'ops@trypennie.com' }]])
  })

  it('says a mailbox Google answers as another in its own sentence', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({
      list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }]),
      verify: async () => ({ ok: false, refused: 'verify_google_mailbox_mismatch', detail: 'named on ops' }),
    })
    const body = (await (await post(env, { service: 'google', name: 'Ops mailbox', fields: { subject: 'ops@trypennie.com' } })).json()) as { error: string; message: string }
    expect(body).toMatchObject({
      error: 'verify_google_mailbox_mismatch',
      message: 'Google says this acts as another mailbox than the one chosen. Nothing was saved. Choose the mailbox again from the company list and save.',
    })
  })
})

describe('a verify that does not pass writes nothing', () => {
  it('answers verify\'s refusal with its sentence, leaves no row, and a retry under the same name then succeeds', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    let first = true
    const { env } = makeEnv({
      verify: async (r) => {
        if (first) {
          first = false
          return { ok: false, refused: 'connection_needs_reauth', detail: 'the login was refused', retry_at: null }
        }
        return verified()(r)
      },
    })
    const failed = await post(env, salesforce())
    expect(failed.status).toBe(422)
    expect(await failed.json()).toMatchObject({
      error: 'connection_needs_reauth', message: 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.',
    })
    expect(db.rows).toEqual([])

    const retried = await post(env, salesforce())
    expect(retried.status).toBe(201)
    expect(db.rows).toHaveLength(1)
  })

  it('an org with no approved lane cap names the org and asks Dan to set a limit for it (#2556, round 33)', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'sf_cap_unset', detail: 'no approved cap', retry_at: null }) })
    const res = await post(env, salesforce({ name: 'Lendco Salesforce', fields: { instance_url: 'https://lendco.my.salesforce.com', client_id: OPS_CLIENT_ID, client_secret: CLIENT_SECRET } }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: 'sf_cap_unset',
      message: 'Bidspoke has no limit set yet on how many Salesforce calls its workflows may make to lendco.my.salesforce.com, so it cannot connect to that org. Nothing was saved. Ask Dan to set a limit for this org, then save again.',
    })
    expect(db.rows).toEqual([])
  })

  it('a verify that does not answer in time is named, and writes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Sealing as slow as a loaded CI runner makes it: the wait below must not count on it being quick.
    fixtures.sealDelayMs = 300
    onTestFinished(() => { fixtures.sealDelayMs = 0 })
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({ verify: () => new Promise(() => {}) })
    const pending = post(env, salesforce())
    // Wait on the condition itself, verify having been asked, for up to 10 s of real time (Date is not faked),
    // never a count of turns, which a slow machine outruns (L290, #2721); the fake clock does not move meanwhile.
    // Then step the fake clock past the bidding deadline (50 s).
    const askedBy = Date.now() + 10_000
    while (binding.verify.mock.calls.length === 0 && Date.now() < askedBy) await vi.advanceTimersByTimeAsync(0)
    expect(binding.verify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50_000)
    const res = await pending
    expect(res.status).toBe(504)
    expect(await res.json()).toMatchObject({
      error: 'verify_timed_out', message: 'The login check with Salesforce did not finish in time. Nothing was saved. Save again.',
    })
    expect(db.inserts).toEqual([])
  })

  it('a code this Worker does not know is answered by name, never as a pass', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'something_new', detail: 'x', retry_at: null }) })
    const res = await post(env, salesforce())
    expect(((await res.json()) as Refusal).error).toBe('verify_refused_unknown')
    expect(db.inserts).toEqual([])
  })
})

describe('two saves of one name', () => {
  it('both verify, one insert wins, and the other is refused as taken: exactly one row', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    // Neither verify answers until both have been asked, so both saves pass the
    // early name read and reach the insert: the unique alone decides.
    let release: () => void = () => undefined
    const bothAsked = new Promise<void>((resolve) => { release = resolve })
    let asked = 0
    const { env, binding } = makeEnv({
      verify: async (r) => {
        if (++asked === 2) release()
        await bothAsked
        return verified()(r)
      },
    })
    const [a, b] = await Promise.all([post(env, salesforce()), post(env, salesforce())])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const loser = a.status === 409 ? a : b
    expect(((await loser.json()) as Refusal).error).toBe('connection_name_taken')
    expect(binding.verify).toHaveBeenCalledTimes(2)
    expect(db.rows).toHaveLength(1)
  })

  it('a row the database refuses for any other reason is named, and nothing is claimed saved', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble([], { insertError: { code: '57014', message: 'canceling statement due to statement timeout' } }) as never)
    const { env } = makeEnv()
    const res = await post(env, salesforce())
    expect(res.status).toBe(503)
    expect(((await res.json()) as Refusal).error).toBe('connection_store_failed')
  })

  it('the loser of a name race is also withdrawn from ops: revoke is called for its own id', async () => {
    const db = storeDouble([{ organization_id: ORG, service_type: 'salesforce', name: 'Pennie Salesforce', id: 'held' }])
    // The early name read passes (a race the read could not see), and the unique then refuses the insert.
    db.from = ((orig) => (table: string) => {
      const b = orig(table) as { maybeSingle: () => Promise<unknown> }
      b.maybeSingle = async () => ({ data: null, error: null })
      return b
    })(db.from) as typeof db.from
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv()
    const res = await post(env, salesforce())
    expect(res.status).toBe(409)
    const verifiedId = parseVerifyRequest(binding.verify.mock.calls[0][0]).connection_id
    expect(binding.revoke).toHaveBeenCalledTimes(1)
    expect(parseRevokeRequest(binding.revoke.mock.calls[0][0])).toMatchObject({ organization_id: ORG, connection_id: verifiedId, generation: 1 })
  })
})

describe('a verify that passed, then an insert that failed: nothing is left behind on ops', () => {
  it('revokes the verified id at generation 1 before answering the save\'s error', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble([], { insertError: { code: '57014', message: 'canceling statement due to statement timeout' } }) as never)
    const order: string[] = []
    const { env, binding } = makeEnv({
      verify: async (r) => { order.push('verify'); return verified()(r) },
      revoke: async () => { order.push('revoke'); return { ok: true, outcome: 'recorded', copies_removed: 0 } },
    })
    const res = await post(env, salesforce())
    expect(res.status).toBe(503)
    expect(((await res.json()) as Refusal).error).toBe('connection_store_failed')
    expect(order).toEqual(['verify', 'revoke'])
    const revoke = parseRevokeRequest(binding.revoke.mock.calls[0][0])
    expect(revoke).toMatchObject({ organization_id: ORG, connection_id: parseVerifyRequest(binding.verify.mock.calls[0][0]).connection_id, generation: 1 })
    expect(Math.abs(Date.parse(revoke.removed_at) - Date.now())).toBeLessThan(60_000)
  })

  it.each([
    ['ops refused the tombstone', async () => ({ ok: false, refused: 'revoke_unrecorded', detail: 'x', retry_at: null })],
    ['ops did not answer', async () => { throw new Error('internal error; reference = 0a0b0c') }],
  ])('a revoke that fails (%s) still answers the save\'s error, and logs the leftover id by name', async (_why, revoke) => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble([], { insertError: { code: '57014', message: 'canceling statement due to statement timeout' } }) as never)
    const errors: string[] = []
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    const { env, binding } = makeEnv({ revoke })
    const res = await post(env, salesforce())
    expect(res.status).toBe(503)
    expect(((await res.json()) as Refusal).error).toBe('connection_store_failed')
    const id = parseVerifyRequest(binding.verify.mock.calls[0][0]).connection_id
    expect(errors.some((l) => l.includes('connection_create_left_on_ops') && l.includes(id))).toBe(true)
  })

  // #2573, end to end: the route's double failure, then the ops tick's serves.
  // What verify leaves on ops for a candidate is a Salesforce login's measured
  // identity and nothing else (ops-connections.ts), so that is what this ops
  // double keeps, with the ops clock injected. Its removal keeps the rule
  // remove_unserved_measured_identities holds, proven against Postgres in
  // supabase-ops/supabase/tests/unserved_measured_identities.test.sql.
  it('a revoke that also fails leaves a measured identity that the first complete serve over an hour on removes, while a stored connection\'s stays (#2573)', async () => {
    const T0 = Date.parse('2026-10-27T15:00:00.000Z')
    let opsNow = T0
    const measured = new Map<string, { organizationId: string; generation: number; measuredAt: number }>()
    const copies = new Set<string>()
    const ops: ConnectionServeDb = {
      async saveConnectionCopies(_servedAt, _complete, list) {
        for (const c of list) copies.add(c.connectionId)
        return { inserted: list.length, updated: 0, confirmed: 0, refusedOlder: 0, refusedExpired: 0, refusedRemoved: 0, withdrawn: 0 }
      },
      recordConnectionTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 0 }),
      async removeUnservedMeasuredIdentities(servedAt, named) {
        const before = Math.min(Date.parse(servedAt), opsNow) - 60 * 60_000
        const removed: UnservedIdentityRemoved[] = []
        for (const [id, m] of measured) {
          if (m.measuredAt < before && !named.includes(id) && !copies.has(id)) {
            measured.delete(id)
            removed.push({ organizationId: m.organizationId, connectionId: id, generation: m.generation, measuredAt: new Date(m.measuredAt).toISOString() })
          }
        }
        return removed
      },
    }

    const storeOpts: StoreOptions = { insertError: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const store = storeDouble([], storeOpts)
    vi.mocked(createSupabaseClient).mockReturnValue(store as never)
    const errors: string[] = []
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
    const { env, binding } = makeEnv({
      verify: async (r) => {
        measured.set(r.connection_id, { organizationId: r.organization_id, generation: r.candidate!.generation, measuredAt: opsNow })
        return verified()(r)
      },
      revoke: async () => ({ ok: false, refused: 'revoke_unrecorded', detail: 'the ops tombstone could not be written', retry_at: null }),
    })

    // The double failure: verify passed, the insert failed, the revoke failed.
    const failed = await post(env, salesforce())
    expect(failed.status).toBe(503)
    expect(((await failed.json()) as Refusal).error).toBe('connection_store_failed')
    const orphan = parseVerifyRequest(binding.verify.mock.calls[0][0]).connection_id
    expect(binding.revoke).toHaveBeenCalledTimes(1)
    expect(store.rows).toHaveLength(0)
    expect(measured.has(orphan)).toBe(true)
    expect(errors.some((l) => l.includes('connection_create_left_on_ops') && l.includes(orphan) && l.includes('first complete serve'))).toBe(true)

    // A second save, at the same moment, whose insert lands.
    delete storeOpts.insertError
    const saved = await post(env, salesforce({ name: 'Second Salesforce' }))
    expect(saved.status).toBe(201)
    const stored = ((await saved.json()) as { connection: { id: string } }).connection.id
    expect(measured.has(stored)).toBe(true)

    // The bidding Worker's serve: every ops row it holds, as readOpsConnections serves it.
    const serve = (at: number) => async () => ({
      served_at: new Date(at).toISOString(),
      complete: true,
      connections: store.rows.filter((r) => r.sealed_for === 'ops_key').map((r) => ({
        id: r.id, organization_id: r.organization_id, service: r.service_type, generation: r.credential_generation,
        envelope: JSON.parse(String(r.credential_enc)), public_config: {}, target: r.target, owner_user_id: null,
        serve_until: new Date(at + CONNECTION_SERVE_WINDOW_MS).toISOString(),
      })),
      tombstones: [],
    })

    // Half an hour on, a create's insert could still be landing: nothing is removed.
    opsNow = T0 + 30 * 60_000
    const early = await saveServedConnections(ops, serve(opsNow))
    expect(early.problems).toEqual([])
    expect(early.unservedIdentitiesRemoved).toEqual([])
    expect(measured.has(orphan)).toBe(true)

    // Over an hour on, the complete list that does not name it proves bidding never stored it.
    opsNow = T0 + 61 * 60_000
    const later = await saveServedConnections(ops, serve(opsNow))
    expect(later.problems).toEqual([])
    expect(later.unservedIdentitiesRemoved).toEqual([{ organizationId: ORG, connectionId: orphan, generation: 1, measuredAt: new Date(T0).toISOString() }])
    expect(later.counts.connection_unserved_identities_removed).toBe(1)
    expect(measured.has(orphan)).toBe(false)
    expect(measured.has(stored)).toBe(true)

    // And nothing more on the next serve.
    opsNow = T0 + 62 * 60_000
    expect((await saveServedConnections(ops, serve(opsNow))).unservedIdentitiesRemoved).toEqual([])
  })

  it('an insert whose answer was lost but which landed is read back and answered as saved, and nothing is revoked', async () => {
    const db = storeDouble([], { insertLandedThenFailed: true })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv()
    const res = await post(env, salesforce())
    expect(res.status).toBe(201)
    const body = (await res.json()) as { connection: { id: string } }
    expect(body.connection.id).toBe(parseVerifyRequest(binding.verify.mock.calls[0][0]).connection_id)
    expect(binding.revoke).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)
  })
})

describe('an ops HTTP connection never reaches the money lane (#2337)', () => {
  const API_KEY = 'canary-http-key-2337'
  const http = (host: string) => ({ service: 'http', name: 'Lender API', fields: { host, header: 'X-Partner-Key', check_path: '/v2/me', api_key: API_KEY } })
  const httpVerified: Verify = async () => ({ ok: true, service: 'http', generation: 1, identity: { kind: 'http', host: 'api.lender.example' } })
  const partner = (api_endpoint: string): Row => ({ _table: 'partner_configs', organization_id: ORG, api_endpoint, dedup_endpoint: null, click_url: null })
  const moneyWorkflow = (url: string, over: Row = {}): Row => ({
    _table: 'workflows', id: crypto.randomUUID(), name: 'Main Flow', is_active: true, updated_at: '2026-10-20T00:00:00Z', organization_id: ORG, lane: 'money', deleted_at: null, definition: { nodes: [{ type: 'webhook', data: { config: { url } } }] }, ...over,
  })

  it('saves a host bidding does not send to, after reading every money host source for the caller\'s organization only', async () => {
    const db = storeDouble([partner('https://tripoint-proxy.trypennie.dev/bid'), moneyWorkflow('https://api.equifax.example/v1'), moneyWorkflow('https://api.lender.example/v2', { organization_id: OTHER_ORG })])
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({ verify: httpVerified })
    const res = await post(env, http('https://api.lender.example/v2'))
    expect(res.status).toBe(201)
    expect(binding.verify).toHaveBeenCalledTimes(1)
    expect(resolveSalesforceCredsFor).toHaveBeenCalledWith(expect.anything(), expect.anything(), ORG)
  })

  it.each([
    ['a host the bidding Worker answers on its partner subdomains', 'https://tripoint.trypennie.dev', [], 'APP_URL'],
    ['a money partner\'s endpoint', 'tripoint-proxy.trypennie.example', [partner('https://tripoint-proxy.trypennie.example/bid')], 'partner_configs'],
    ['a host a money workflow sends to', 'https://api.equifax.example/v1/report', [moneyWorkflow('https://api.equifax.example/v1')], 'money workflows'],
    ['the money Salesforce instance on its own domain', 'login.lendco.example', [], 'SALESFORCE_INSTANCE_URL'],
  ])('refuses %s by name before verify sends anything to it', async (_what, host, rows, source) => {
    vi.mocked(resolveSalesforceCredsFor).mockResolvedValue({ creds: { instanceUrl: 'https://login.lendco.example', clientId: MONEY_CLIENT_ID, clientSecret: 'never-read' }, missing: [] })
    const db = storeDouble(rows as Row[])
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({ verify: httpVerified })
    const res = await post(env, http(host))
    expect(res.status).toBe(422)
    const body = (await res.json()) as Refusal & { matched: string }
    expect(body.error).toBe('connection_money_host')
    expect(body.matched).toBe(source)
    expect(body.message).toMatch(/^The host [a-z0-9.-]+ is one Bidspoke's bidding sends to, which a workflow connection may never reach\. Nothing was saved\. Use another host\.$/)
    expect(binding.verify).not.toHaveBeenCalled()
    expect(db.inserts).toEqual([])
  })

  it('takes a deleted money workflow\'s hosts, and another organization\'s, as no money host', async () => {
    const db = storeDouble([moneyWorkflow('https://api.equifax.example/v1', { deleted_at: '2026-10-01T00:00:00Z' }), moneyWorkflow('https://api.equifax.example/v1', { organization_id: OTHER_ORG })])
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({ verify: httpVerified })
    expect((await post(env, http('api.equifax.example'))).status).toBe(201)
  })

  it('refuses a host another catalogue service owns, naming that service, before verify', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({ verify: httpVerified })
    const body = (await (await post(env, http('https://otherref987.supabase.co/rest/v1'))).json()) as Refusal
    expect(body).toMatchObject({
      error: 'connection_host_owned',
      message: 'The host otherref987.supabase.co belongs to Supabase, which an HTTP connection may never reach. Nothing was saved. Use another host, or a Supabase connection where Bidspoke offers one.',
    })
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('refuses a host that is not a name on https before verify, as the address entered', async () => {
    for (const host of ['localhost', '10.0.0.7', 'http://api.lender.example', 'api.lender.example:8443']) {
      vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
      const { env, binding } = makeEnv({ verify: httpVerified })
      const body = (await (await post(env, http(host))).json()) as Refusal
      expect(body.error, host).toBe('connection_target_invalid')
      expect(binding.verify).not.toHaveBeenCalled()
    }
  })

  it.each(['partner_configs', 'workflows'])('is refused, never passed, when the %s read fails', async (table) => {
    const db = storeDouble([], { failTable: table })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({ verify: httpVerified })
    const res = await post(env, http('api.lender.example'))
    expect(res.status).toBe(503)
    expect(((await res.json()) as Refusal).error).toBe('connection_money_targets_unreadable')
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('says a check path the API refused in its own sentence', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'verify_http_check_refused', detail: 'named on ops' }) })
    const body = (await (await post(env, http('api.lender.example'))).json()) as Refusal
    expect(body).toMatchObject({
      error: 'verify_http_check_refused',
      message: 'The Check path did not answer with this header value. Nothing was saved. Check the Check path, the Header and the Header value, and save again.',
    })
  })
})
