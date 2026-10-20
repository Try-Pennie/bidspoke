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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@bidspoke/connection-seal'
import type { ServiceSchema } from '@bidspoke/service-catalogue/schema'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { parseVerifyRequest, type VerifyRequest } from '../../../lib/ops-connections-contract'
import { makeKeys, type TestKeys } from '../../../ops/connections/__tests__/harness'
import { makeSigningKey } from '../../../ops/connections/minters/__tests__/minter-harness'
import { opsServiceEntry } from '../../../ops/connections/services'
import type { AuthorizeInput } from '../../../ops/connections/service-rules'

const fixtures = vi.hoisted(() => {
  const google: ServiceSchema = {
    key: 'google',
    name: 'Google',
    actions: [],
    connection: {
      tile: 'A company mailbox or drive',
      auth: 'service_account_delegation',
      fields: [
        { key: 'subject', label: 'Mailbox', input: 'text', required: true, target: 'subject' },
        { key: 'drives', label: 'Drive', input: 'text', required: false, target: 'drives' },
        { key: 'client_email', label: 'Service account', input: 'text', required: true, login: 'client_email' },
        { key: 'private_key', label: 'Private key', input: 'secret_block', required: true, login: 'private_key' },
      ],
    },
  }
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
  const slack: ServiceSchema = {
    key: 'slack',
    name: 'Slack',
    actions: [],
    connection: {
      tile: 'A workspace, signed in as its bot',
      auth: 'static_key',
      fields: [{ key: 'bot_token', label: 'Bot token', input: 'secret', required: true, login: 'bot_token' }],
    },
  }
  return { extra: [google, supabase, slack], publicKeys: {} as Record<string, string> }
})

vi.mock('@bidspoke/service-catalogue/schema', async (importOriginal) => {
  const real = await importOriginal<typeof import('@bidspoke/service-catalogue/schema')>()
  return { ...real, CATALOGUE: [...real.CATALOGUE, ...fixtures.extra] }
})
vi.mock('@bidspoke/connection-seal', async (importOriginal) => {
  const real = await importOriginal<typeof import('@bidspoke/connection-seal')>()
  return { ...real, CURRENT_OPS_KID: 'ops-test-1', OPS_CONNECTION_PUBLIC_KEYS: fixtures.publicKeys }
})
vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/salesforce-creds')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { resolveSalesforceCredsFor } from '../../../lib/salesforce-creds'

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
}

/** The table as the database holds it: the unique per organization, service and name, and the alert name CHECK. */
function storeDouble(rows: Row[] = [], opts: StoreOptions = {}) {
  const inserts: Row[] = []
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let inserted: Row | null = null
    const b = {
      select() { return b },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
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
  SNOWFLAKE_ACCOUNT: 'MONEY12345.us-east-1',
  SNOWFLAKE_USER: 'BIDSPOKE_EXPORT',
  ARCHIVE_WRITER_USER: 'ARCHIVE_WRITER',
  ARCHIVE_READER_USER: 'ARCHIVE_READER',
  ARCHIVE_ERASER_USER: 'ARCHIVE_ERASER',
}

function makeEnv(ops: { verify?: Verify; list?: () => Promise<unknown> } = {}) {
  const binding = {
    verify: vi.fn((r: unknown) => (ops.verify ?? verified())(r as VerifyRequest)),
    listDelegationSubjects: vi.fn(ops.list ?? listed([])),
    clearReauth: vi.fn(), revoke: vi.fn(), health: vi.fn(), lookup: vi.fn(), exchangeOAuthCode: vi.fn(),
  }
  const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, OPS_CONNECTIONS: binding, ...WORKER_ENV } as unknown as Env
  return { env, binding }
}

const ctx = recordingContext()

async function post(env: Env, body: unknown) {
  const { default: api } = await import('../index')
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
    await post(env, { service: 'slack', name: 'Ops bot', fields: { bot_token: 'xoxb-canary' } })
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
    const entry = opsServiceEntry(candidate.service)!
    return entry.rules.authorize({
      organizationId: request.organization_id as never, connectionId: request.connection_id, service: candidate.service, generation: candidate.generation,
      target: candidate.target, publicConfig: candidate.public_config, envelope: candidate.envelope, login: { plaintext }, candidate: true, renew: null,
      noteMint: () => undefined, fetch,
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
    const r = await refused({ service: 'slack', name: 'Slack', fields: { bot_token: 'xoxb-canary' } })
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
  const google = (fields: Record<string, string>) => ({
    service: 'google', name: 'Ops mailbox', fields: { client_email: 'ops@pennie-ops.iam.gserviceaccount.com', private_key: 'pem', ...fields },
  })

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
    const res = await post(env, google({ subject: 'OPS@trypennie.com', drives: '0AFinanceDrive' }))
    expect(((await res.json()) as Refusal).message).toContain('0AFinanceDrive is not on the company list')
    expect(binding.verify).not.toHaveBeenCalled()
  })

  it('goes on to verify a mailbox and drive that are on the list', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble() as never)
    const { env, binding } = makeEnv({
      list: listed([{ kind: 'mailbox', subject: 'ops@trypennie.com' }, { kind: 'drive', subject: '0AFinanceDrive' }]),
      verify: async () => ({ ok: false, refused: 'connection_service_unknown', detail: 'no rules for the google service on this Worker', retry_at: null }),
    })
    const res = await post(env, google({ subject: 'Ops@TryPennie.com ', drives: '0AFinanceDrive' }))
    expect(binding.verify).toHaveBeenCalledTimes(1)
    expect(((await res.json()) as Refusal).error).toBe('connection_service_unknown')
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
      error: 'connection_needs_reauth', message: 'Salesforce refused the client secret. Nothing was saved. Check the client secret and save again.',
    })
    expect(db.rows).toEqual([])

    const retried = await post(env, salesforce())
    expect(retried.status).toBe(201)
    expect(db.rows).toHaveLength(1)
  })

  it('an org with no approved lane cap names the org and that Dan must approve one (#2556)', async () => {
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv({ verify: async () => ({ ok: false, refused: 'sf_cap_unset', detail: 'no approved cap', retry_at: null }) })
    const res = await post(env, salesforce({ name: 'Lendco Salesforce', fields: { instance_url: 'https://lendco.my.salesforce.com', client_id: OPS_CLIENT_ID, client_secret: CLIENT_SECRET } }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      error: 'sf_cap_unset',
      message: 'Bidspoke has no approved cap for the Salesforce org lendco.my.salesforce.com. Nothing was saved. Dan must approve a cap for this org before a connection to it can be saved.',
    })
    expect(db.rows).toEqual([])
  })

  it('a verify that does not answer in time is named, and writes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const db = storeDouble()
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv({ verify: () => new Promise(() => {}) })
    const pending = post(env, salesforce())
    // Step the clock until verify has been asked, then past the bidding deadline (50 s).
    for (let i = 0; i < 100 && binding.verify.mock.calls.length === 0; i++) await vi.advanceTimersByTimeAsync(0)
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
    const { env, binding } = makeEnv({ verify: async (r) => { await new Promise((resolve) => setTimeout(resolve, 5)); return verified()(r) } })
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
})
