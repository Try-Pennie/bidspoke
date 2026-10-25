/**
 * Sign in with your own Google account (#2338, build PR 13; R17):
 * POST /api/connections/google/sign-in and POST /api/connections/google/sign-in/finish.
 *
 * Dan's decision of 2026-10-22: the sign in app's secret lives only on the ops
 * Worker, so the start asks ops for the app's client id (signInClient), and the
 * finish hands the code to ops (exchangeOAuthCode), sealing into the new login
 * only the client id. The state is single use and bound to the person and the
 * organization that started it; claim_oauth_state's atomicity is proven against
 * Postgres in supabase/tests/oauth_states.test.sql, and the double here keeps
 * its rules (a claim of another person's state is not_found, a second claim is
 * used, an old one expired).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@bidspoke/connection-seal'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { parseExchangeOAuthCodeRequest, parseRevokeRequest, parseSignInClientRequest } from '../../../lib/ops-connections-contract'
import { pkceChallenge } from '../../../lib/google-sign-in'
import { makeKeys, type TestKeys } from '../../../ops/connections/__tests__/harness'
import { rpcStub } from '../../../test-setup/rpc-stub'

const fixtures = vi.hoisted(() => ({ publicKeys: {} as Record<string, string> }))

vi.mock('@bidspoke/connection-seal', async (importOriginal) => {
  const real = await importOriginal<typeof import('@bidspoke/connection-seal')>()
  return { ...real, CURRENT_OPS_KID: 'ops-test-1', OPS_CONNECTION_PUBLIC_KEYS: fixtures.publicKeys }
})
vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import api from '../index'

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002'
const USER = 'aa000000-0000-4000-8000-000000000001'
const OTHER_USER = 'aa000000-0000-4000-8000-000000000002'
const OWN = 'c0000000-0000-4000-8000-0000000002a1'
const SOMEONE_ELSES = 'c0000000-0000-4000-8000-0000000002a2'
const MAILBOX = 'c0000000-0000-4000-8000-0000000002a3'
const THEIRS = 'c0000000-0000-4000-8000-0000000002a4'
const STATE = '5e6c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b'
const CLIENT_ID = '1234-sign-in.apps.googleusercontent.com'
const CODE = 'google-authorization-code-canary-2338'
const ENVELOPE = { v: 1, kid: 'ops-test-1', wrapped_key: 'd3JhcHBlZA==', iv: 'aXY=', ct: 'Y3Q=' }
const CALLBACK = 'https://bidspoke.trypennie.dev/connections/google/callback'

type Row = Record<string, unknown>

function rows(): Row[] {
  const google = (id: string, org: string, owner: string | null, target: unknown, personBound: boolean) => ({
    id, organization_id: org, service_type: 'google', name: `Google ${id.slice(-2)}`, sealed_for: 'ops_key', person_bound: personBound, user_id: owner,
    credential_generation: 4, credential_enc: JSON.stringify(ENVELOPE), target, acts_as: personBound ? 'dan@trypennie.com' : 'ops@trypennie.com', config: {},
  })
  return [
    google(OWN, ORG, USER, { own_account: true }, true),
    google(SOMEONE_ELSES, ORG, OTHER_USER, { own_account: true }, true),
    google(MAILBOX, ORG, null, { subject: 'ops@trypennie.com' }, false),
    google(THEIRS, OTHER_ORG, USER, { own_account: true }, true),
  ]
}

interface StateRow {
  state_id: string; organization_id: string; user_id: string; connection_id: string; name: string | null; reconnect: boolean
  client_id: string; verifier: string; redirect_uri: string; expired: boolean; consumed: boolean
}

type RpcAnswer = { data: unknown; error: { code: string; message: string } | null }

/** The bidding database: service_connections, and oauth_states behind its two functions with their rules. */
function store(order: string[], opts: { states?: StateRow[]; insertError?: { code: string; message: string }; claimError?: boolean } = {}) {
  const table = rows()
  const states: StateRow[] = opts.states ?? []
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
  const inserts: Row[] = []
  const updates: Array<{ values: Row; filters: Record<string, unknown> }> = []
  const from = (name: string) => {
    if (name !== 'service_connections') throw new Error(`the double has no table ${name}`)
    const filters: Array<[string, unknown]> = []
    const matches = (r: Row) => filters.every(([k, v]) => r[k] === v)
    let pendingUpdate: Row | null = null
    const b = {
      select() { return b },
      eq(col: string, v: unknown) { filters.push([col, v]); return b },
      async maybeSingle() { return { data: table.find(matches) ?? null, error: null } },
      insert(row: Row) {
        order.push('insert')
        if (opts.insertError) return Promise.resolve({ data: null, error: opts.insertError })
        // As written, never as later updates leave it.
        inserts.push({ ...row })
        table.push({ ...row })
        return Promise.resolve({ data: null, error: null })
      },
      update(values: Row) { pendingUpdate = values; return b },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
        if (pendingUpdate) {
          order.push('update')
          updates.push({ values: pendingUpdate, filters: Object.fromEntries(filters) })
          const hit = table.filter(matches)
          for (const r of hit) Object.assign(r, pendingUpdate)
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve)
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return b
  }
  const functions: Record<string, (a: Record<string, unknown>) => RpcAnswer> = {
    create_oauth_state: (a) => {
      const row: StateRow = {
        state_id: STATE, organization_id: a.p_organization_id as string, user_id: a.p_user_id as string, connection_id: a.p_connection_id as string,
        name: (a.p_name as string | null) ?? null, reconnect: a.p_reconnect as boolean, client_id: a.p_client_id as string, verifier: a.p_verifier as string,
        redirect_uri: a.p_redirect_uri as string, expired: false, consumed: false,
      }
      states.push(row)
      return { data: [{ state_id: STATE, expires_at: '2026-10-23T16:10:00Z' }], error: null }
    },
    claim_oauth_state: (a) => {
      if (opts.claimError) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      const s = states.find((x) => x.state_id === a.p_state_id && x.organization_id === a.p_organization_id && x.user_id === a.p_user_id)
      const none = { service_type: null, connection_id: null, name: null, reconnect: null, client_id: null, verifier: null, redirect_uri: null }
      if (!s) return { data: [{ outcome: 'not_found', ...none }], error: null }
      if (s.expired) return { data: [{ outcome: 'expired', ...none }], error: null }
      if (s.consumed) return { data: [{ outcome: 'used', ...none }], error: null }
      s.consumed = true
      return { data: [{ outcome: 'claimed', service_type: 'google', connection_id: s.connection_id, name: s.name, reconnect: s.reconnect, client_id: s.client_id, verifier: s.verifier, redirect_uri: s.redirect_uri }], error: null }
    },
    remove_ops_connection: (a) => {
      const row = table.find((r) => r.id === a.p_connection_id && r.organization_id === a.p_organization_id)
      if (!row) return { data: null, error: { code: 'P0002', message: 'connection_not_found' } }
      table.splice(table.indexOf(row), 1)
      return { data: [{ outcome: 'removed', removed_generation: row.credential_generation, workflows: [] }], error: null }
    },
  }
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'auth_user_with_allowlist') {
      return Promise.resolve({ data: [{ id: USER, organization_id: ORG, email: 'dan@trypennie.com', display_name: 'Dan Wright', allowed: true }], error: null })
    }
    order.push(`rpc:${name}`)
    rpcs.push({ name, args })
    const fn = functions[name]
    return Promise.resolve(fn ? fn(args) : { data: null, error: { code: '42883', message: `no function ${name}` } })
  }
  return { from, rpc, table, states, rpcs, inserts, updates }
}

type OpsFn = (r: unknown) => Promise<unknown>

function makeEnv(order: string[], ops: Partial<Record<'signInClient' | 'exchangeOAuthCode' | 'revoke', OpsFn>> = {}, appUrl = 'https://bidspoke.trypennie.dev') {
  const recorded = (name: string, fn: OpsFn) => vi.fn(async (r: unknown) => { order.push(name); return fn(r) })
  const binding = {
    signInClient: recorded('signInClient', ops.signInClient ?? (async (r) => ({ ok: true, service: parseSignInClientRequest(r).service, client_id: CLIENT_ID }))),
    exchangeOAuthCode: recorded('exchangeOAuthCode', ops.exchangeOAuthCode ?? (async () => ({ ok: true, generation: 2, account: 'dan@trypennie.com', reauth_cleared: true }))),
    revoke: recorded('revoke', ops.revoke ?? (async () => ({ ok: true, outcome: 'recorded', copies_removed: 0 }))),
  }
  const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, APP_URL: appUrl, OPS_CONNECTIONS: rpcStub(binding) } as unknown as Env
  return { env, binding }
}

const ctx = recordingContext()

async function post(env: Env, path: string, body: unknown) {
  return api.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) }, env, ctx)
}
const start = (env: Env, body: unknown) => post(env, '/connections/google/sign-in', body)
const finish = (env: Env, body: unknown) => post(env, '/connections/google/sign-in/finish', body)

interface Answer { error?: string; message?: string; [k: string]: unknown }

const state = (over: Partial<StateRow> = {}): StateRow => ({
  state_id: STATE, organization_id: ORG, user_id: USER, connection_id: 'c0000000-0000-4000-8000-0000000002b1', name: 'My Google', reconnect: false,
  client_id: CLIENT_ID, verifier: 'v'.repeat(43), redirect_uri: CALLBACK, expired: false, consumed: false, ...over,
})

let keys: TestKeys

beforeAll(async () => {
  keys = await makeKeys()
  Object.assign(fixtures.publicKeys, keys.publicKeys)
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@trypennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('starting a sign in', () => {
  it('asks ops for the app\'s client id, writes a single use state for this person, and answers Google\'s link, which carries no secret', async () => {
    const order: string[] = []
    const db = store(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await start(env, { name: 'My Google' })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(order).toEqual(['signInClient', 'rpc:create_oauth_state'])
    expect(parseSignInClientRequest(binding.signInClient.mock.calls[0][0])).toEqual({ organization_id: ORG, service: 'google' })

    const args = db.rpcs[0].args
    expect(args).toMatchObject({
      p_organization_id: ORG, p_user_id: USER, p_service_type: 'google', p_name: 'My Google', p_reconnect: false, p_client_id: CLIENT_ID, p_redirect_uri: CALLBACK,
    })
    expect(args.p_connection_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(args.p_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const link = new URL(url)
    expect(link.origin).toBe('https://accounts.google.com')
    expect(link.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(link.searchParams.get('state')).toBe(STATE)
    expect(link.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(link.searchParams.get('code_challenge')).toBe(await pkceChallenge(args.p_verifier as string))
    expect(link.searchParams.get('login_hint')).toBe('dan@trypennie.com')
    // The verifier stays in the database: the browser sees only its challenge.
    expect(url).not.toContain(args.p_verifier as string)
  })

  it('a name another Google connection has is refused before ops is asked', async () => {
    const order: string[] = []
    const db = store(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order)
    const res = await start(env, { name: 'Google a3' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as Answer).error).toBe('connection_name_taken')
    expect(order).toEqual([])
  })

  it.each([
    ['the sign in app is not set on ops', { ok: false, refused: 'sign_in_app_unset', detail: 'GOOGLE_OAUTH_CLIENT is not set', retry_at: null }, 503, 'google_sign_in_unset', /not set up on Bidspoke yet/],
    ['the sign in app on ops cannot be read', { ok: false, refused: 'sign_in_app_malformed', detail: 'x', retry_at: null }, 503, 'google_sign_in_misconfigured', /set up wrongly/],
  ])('when %s, it says so by name and writes no state', async (_what, answer, status, code, words) => {
    const order: string[] = []
    const db = store(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, { signInClient: async () => answer })
    const res = await start(env, { name: 'My Google' })
    expect(res.status).toBe(status)
    const body = (await res.json()) as Answer
    expect(body.error).toBe(code)
    expect(body.message).toMatch(words)
    expect(db.rpcs).toEqual([])
  })

  it('an ops Worker that does not answer is told apart from one that refused', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(store(order) as never)
    const { env } = makeEnv(order, { signInClient: async () => { throw new Error('internal error; reference = abc123') } })
    const res = await start(env, { name: 'My Google' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('ops_connections_unavailable')
  })

  it('a Reconnect signs the caller\'s own account connection in again, offering the account it acts as', async () => {
    const order: string[] = []
    const db = store(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order)
    const res = await start(env, { connection_id: OWN })
    expect(res.status).toBe(200)
    expect(db.rpcs[0].args).toMatchObject({ p_connection_id: OWN, p_reconnect: true, p_name: null })
    expect(new URL(((await res.json()) as { url: string }).url).searchParams.get('login_hint')).toBe('dan@trypennie.com')
  })

  it.each([
    ['another person\'s own account connection', SOMEONE_ELSES, 403, 'google_sign_in_not_owner'],
    ['a company mailbox connection', MAILBOX, 422, 'google_sign_in_not_person'],
    ['another organization\'s connection', THEIRS, 404, 'connection_not_found'],
  ])('a Reconnect of %s is refused, and nothing is written', async (_what, id, status, code) => {
    const order: string[] = []
    const db = store(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order)
    const res = await start(env, { connection_id: id })
    expect(res.status).toBe(status)
    expect(((await res.json()) as Answer).error).toBe(code)
    expect(order).toEqual([])
  })

  it('refuses when the app\'s address gives no https page to come back to', async () => {
    const order: string[] = []
    const db = store(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, {}, 'http://localhost:3000')
    const res = await start(env, { name: 'My Google' })
    expect(((await res.json()) as Answer).error).toBe('google_sign_in_no_return')
    expect(db.rpcs).toEqual([])
  })
})

describe('finishing a sign in: a new connection', () => {
  it('claims the state for this person, saves the row first holding only the app\'s client id, then hands the code to ops, and records whom it acts as', async () => {
    const order: string[] = []
    const db = store(order, { states: [state()] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ outcome: 'created', connection: { id: state().connection_id, name: 'My Google', service: 'google', acts_as: 'dan@trypennie.com' } })
    // The row before the exchange: the token object writes the new login back to it at once.
    expect(order).toEqual(['rpc:claim_oauth_state', 'insert', 'exchangeOAuthCode', 'update'])
    expect(db.rpcs[0].args).toEqual({ p_state_id: STATE, p_organization_id: ORG, p_user_id: USER })

    const row = db.inserts[0]
    expect(row).toMatchObject({
      id: state().connection_id, organization_id: ORG, service_type: 'google', name: 'My Google', auth_type: 'oauth_user', sealed_for: 'ops_key',
      credential_generation: 1, target: { own_account: true }, person_bound: true, user_id: USER, updated_by: USER, acts_as: null,
    })
    const envelope = JSON.parse(row.credential_enc as string)
    const login = await open(keys.privateKeys, envelope, { organization_id: ORG, connection_id: state().connection_id, service: 'google', generation: 1, kid: 'ops-test-1' })
    // Dan's decision of 2026-10-22: the client id only, never the app's secret.
    expect(JSON.parse(login)).toEqual({ client_id: CLIENT_ID })

    const exchange = parseExchangeOAuthCodeRequest(binding.exchangeOAuthCode.mock.calls[0][0])
    expect(exchange).toEqual({
      organization_id: ORG, connection_id: state().connection_id, code: CODE, verifier: 'v'.repeat(43), redirect_uri: CALLBACK,
      candidate: { service: 'google', generation: 1, envelope, target: { own_account: true }, public_config: {} },
      // The person's own Bidspoke address: ops stores nothing signed in as anyone else (Dan, 2026-10-23).
      expected_account: 'dan@trypennie.com',
    })
    expect(db.updates[0]).toEqual({
      values: expect.objectContaining({ acts_as: 'dan@trypennie.com', updated_by: USER }),
      filters: { id: state().connection_id, organization_id: ORG, person_bound: true, sealed_for: 'ops_key' },
    })
  })

  it('a sign in as another Google account than the person\'s Bidspoke one is refused by name, and the row it was for is removed on bidding and ops (Dan, 2026-10-23)', async () => {
    const order: string[] = []
    const db = store(order, { states: [state()] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, {
      exchangeOAuthCode: async () => ({ ok: false, refused: 'exchange_account_mismatch', detail: 'the person signed in as another account than the one asked for', retry_at: null }),
    })
    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('google_sign_in_wrong_account')
    expect(body.message).toMatch(/^You signed in to Google as another account than your Bidspoke one\. Nothing was saved\./)
    expect(order).toEqual(['rpc:claim_oauth_state', 'insert', 'exchangeOAuthCode', 'rpc:remove_ops_connection', 'revoke'])
    expect(db.table.find((r) => r.id === state().connection_id)).toBeUndefined()
  })

  it.each([
    ['another account', 'someone.else@trypennie.com'],
    ['no account at all', null],
  ])('an ops Worker that answers %s for the sign in is refused the same way, never saved (an ops deploy older than this one)', async (_what, account) => {
    const order: string[] = []
    const db = store(order, { states: [state()] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order, { exchangeOAuthCode: async () => ({ ok: true, generation: 3, account, reauth_cleared: true }) })
    const res = await finish(env, { state: STATE, code: CODE })
    expect(((await res.json()) as Answer).error).toBe('google_sign_in_wrong_account')
    // The generation the exchange answered is withdrawn on ops too.
    expect(parseRevokeRequest(binding.revoke.mock.calls[0][0]).generation).toBe(3)
    expect(order).toEqual(['rpc:claim_oauth_state', 'insert', 'exchangeOAuthCode', 'rpc:remove_ops_connection', 'revoke'])
    expect(db.table.find((r) => r.id === state().connection_id)).toBeUndefined()
  })

  it('denied consent says so by name, and writes nothing', async () => {
    const order: string[] = []
    const db = store(order, { states: [state()] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order)
    const res = await finish(env, { state: STATE, error: 'access_denied' })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('google_sign_in_denied')
    expect(body.message).toMatch(/did not allow Bidspoke/)
    expect(order).toEqual(['rpc:claim_oauth_state'])
  })

  it('any other error Google answers is a failed sign in, said differently from a denial', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(store(order, { states: [state()] }) as never)
    const { env } = makeEnv(order)
    const body = (await (await finish(env, { state: STATE, error: 'server_error' })).json()) as Answer
    expect(body.error).toBe('google_sign_in_failed')
  })

  it.each([
    ['older than 10 minutes', [state({ expired: true })], 410, 'google_sign_in_expired', /more than 10 minutes/],
    ['already used', [state({ consumed: true })], 409, 'google_sign_in_used', /already finished/],
    ['another person\'s', [state({ user_id: OTHER_USER })], 404, 'google_sign_in_unknown', /did not start this sign in for you/],
    ['another organization\'s', [state({ organization_id: OTHER_ORG })], 404, 'google_sign_in_unknown', /did not start this sign in for you/],
  ])('a state %s is refused by its own name, and nothing is written or exchanged', async (_what, states, status, code, words) => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(store(order, { states }) as never)
    const { env, binding } = makeEnv(order)
    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(status)
    const body = (await res.json()) as Answer
    expect(body.error).toBe(code)
    expect(body.message).toMatch(words)
    expect(order).toEqual(['rpc:claim_oauth_state'])
    expect(binding.exchangeOAuthCode).not.toHaveBeenCalled()
  })

  it('two finishes with one state: the first saves the connection, the second is refused as used', async () => {
    const order: string[] = []
    const db = store(order, { states: [state()] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)
    const [a, b] = await Promise.all([finish(env, { state: STATE, code: CODE }), finish(env, { state: STATE, code: CODE })])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(binding.exchangeOAuthCode).toHaveBeenCalledTimes(1)
    expect(db.inserts).toHaveLength(1)
  })

  it('Google refusing the code removes the row it was for, on bidding and on ops, and says so by name', async () => {
    const order: string[] = []
    const db = store(order, { states: [state()] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, {
      exchangeOAuthCode: async () => ({ ok: false, refused: 'connection_needs_reauth', detail: 'the google authorization code exchange failed: refused: invalid_grant', retry_at: null }),
    })
    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('google_code_refused')
    expect(body.message).toMatch(/did not accept the sign in/)
    expect(order).toEqual(['rpc:claim_oauth_state', 'insert', 'exchangeOAuthCode', 'rpc:remove_ops_connection', 'revoke'])
    expect(db.table.find((r) => r.id === state().connection_id)).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(CODE)
  })

  it('an exchange that does not answer removes the row too, so nothing is left without a login', async () => {
    const order: string[] = []
    const db = store(order, { states: [state()] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, { exchangeOAuthCode: async () => { throw new Error('internal error; reference = abc') } })
    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('ops_connections_unavailable')
    expect(db.table.find((r) => r.id === state().connection_id)).toBeUndefined()
  })

  it('a name taken since the start is refused at the insert, and the code is never exchanged', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(store(order, { states: [state()], insertError: { code: '23505', message: 'duplicate key value violates unique constraint "service_connections_org_type_name_unique"' } }) as never)
    const { env, binding } = makeEnv(order)
    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(409)
    expect(((await res.json()) as Answer).error).toBe('connection_name_taken')
    expect(binding.exchangeOAuthCode).not.toHaveBeenCalled()
  })

  it('a state the database could not claim is never read as a pass', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(store(order, { states: [state()], claimError: true }) as never)
    const { env, binding } = makeEnv(order)
    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('google_sign_in_unavailable')
    expect(binding.exchangeOAuthCode).not.toHaveBeenCalled()
  })
})

describe('finishing a sign in: a Reconnect', () => {
  it('exchanges with the row\'s own login and generation, records the account and an audit row naming no login, and says whether ops cleared the flag', async () => {
    const order: string[] = []
    const db = store(order, { states: [state({ connection_id: OWN, reconnect: true, name: null })] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order, { exchangeOAuthCode: async () => ({ ok: true, generation: 5, account: 'dan@trypennie.com', reauth_cleared: false }) })
    const res = await finish(env, { state: STATE, code: CODE })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'reconnected', connection: { id: OWN, acts_as: 'dan@trypennie.com' }, cleared: false })
    expect(order).toEqual(['rpc:claim_oauth_state', 'exchangeOAuthCode', 'update'])
    const exchange = parseExchangeOAuthCodeRequest(binding.exchangeOAuthCode.mock.calls[0][0])
    expect(exchange.candidate).toEqual({ service: 'google', generation: 4, envelope: ENVELOPE, target: { own_account: true }, public_config: {} })
    expect(db.inserts).toEqual([])
    expect(writeAuditLog).toHaveBeenCalledWith(expect.anything(), ORG, 'service_connection', OWN, 'connection_signed_in_again', USER, { generation: 5 })
  })

  it('a Reconnect as another Google account is refused by name, and the connection keeps its account (Dan, 2026-10-23)', async () => {
    const order: string[] = []
    const db = store(order, { states: [state({ connection_id: OWN, reconnect: true, name: null })] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order, {
      exchangeOAuthCode: async () => ({ ok: false, refused: 'exchange_account_mismatch', detail: 'x', retry_at: null }),
    })
    const res = await finish(env, { state: STATE, code: CODE })
    expect(((await res.json()) as Answer).error).toBe('google_sign_in_wrong_account')
    expect(parseExchangeOAuthCodeRequest(binding.exchangeOAuthCode.mock.calls[0][0]).expected_account).toBe('dan@trypennie.com')
    expect(order).toEqual(['rpc:claim_oauth_state', 'exchangeOAuthCode'])
    expect(db.table.find((r) => r.id === OWN)).toMatchObject({ acts_as: 'dan@trypennie.com', credential_generation: 4 })
  })

  it('a Reconnect whose exchange is refused changes nothing on bidding', async () => {
    const order: string[] = []
    const db = store(order, { states: [state({ connection_id: OWN, reconnect: true, name: null })] })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, { exchangeOAuthCode: async () => ({ ok: false, refused: 'connection_needs_reauth', detail: 'x', retry_at: null }) })
    const res = await finish(env, { state: STATE, code: CODE })
    expect(((await res.json()) as Answer).error).toBe('google_code_refused')
    expect(order).toEqual(['rpc:claim_oauth_state', 'exchangeOAuthCode'])
    expect(db.table.find((r) => r.id === OWN)).toBeDefined()
  })
})
