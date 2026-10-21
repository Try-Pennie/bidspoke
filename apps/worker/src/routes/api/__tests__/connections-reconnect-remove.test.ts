/**
 * POST /api/connections/:id/reconnect and DELETE /api/connections/:id (#2338,
 * build PR 6; R9, R19, R21; finishes finding F116).
 *
 * Reconnect with a new login: reseal under the connection's own id at the next
 * generation, verify that envelope passed in the call, commit it with
 * reconnect_ops_connection (a compare and set on the old generation), and only
 * then clearReauth. A compare and set that loses answers 409 and clearReauth is
 * never called, so ops never clears a flag for a login the one home did not
 * commit (the ops half is reconnect-candidate.test.ts). Reconnect without a new
 * login: clearReauth alone, with the row's own envelope and generation.
 *
 * Remove: remove_ops_connection, refused naming every workflow while any uses
 * the connection; on success revoke at once, and a revoke that fails leaves the
 * removal standing with the real bound on when ops stops using the login.
 *
 * The database double keeps the rules that decide these answers: every read is
 * filtered by the caller's organization, the compare and set answers
 * stale_generation unless the row is at the expected generation, and the
 * removal refuses while the row is referenced (all proven against Postgres in
 * supabase/tests/connections_page_bidding.test.sql).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { open } from '@bidspoke/connection-seal'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import { parseClearReauthRequest, parseRevokeRequest, parseVerifyRequest } from '../../../lib/ops-connections-contract'
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

const ORG = '0a000000-0000-4000-8000-000000000001'
const OTHER_ORG = '0b000000-0000-4000-8000-000000000002'
const USER = 'aa000000-0000-4000-8000-000000000001'
const CONN = 'c0000000-0000-4000-8000-000000000001'
const OTHER_CONN = 'c0000000-0000-4000-8000-000000000002'
const ALERT_ROW = 'c0000000-0000-4000-8000-000000000003'

const NEW_SECRET = 'canary-new-client-secret-2338-pr6'
const ALERT_TOKEN = 'canary-alert-bot-token-2338-pr6'
const CLIENT_ID = '3MVG9-ops-connected-app'
const TARGET = { instance_url: 'https://achieve.my.salesforce.com', client_id: CLIENT_ID }
const STORED_ENVELOPE = { v: 1, kid: 'ops-test-1', wrapped_key: 'd3JhcHBlZA==', iv: 'aXY=', ct: 'Y3Q=' }

type Row = Record<string, unknown>

function rows(): Row[] {
  return [
    {
      id: CONN, organization_id: ORG, service_type: 'salesforce', name: 'Achieve Salesforce', sealed_for: 'ops_key', credential_generation: 3,
      credential_enc: JSON.stringify(STORED_ENVELOPE), config: {}, target: TARGET, acts_as: 'pennie.api@achieve.example', person_bound: false,
    },
    {
      id: OTHER_CONN, organization_id: OTHER_ORG, service_type: 'salesforce', name: 'Their Salesforce', sealed_for: 'ops_key', credential_generation: 1,
      credential_enc: JSON.stringify(STORED_ENVELOPE), config: {}, target: TARGET, acts_as: null, person_bound: false,
    },
    {
      id: ALERT_ROW, organization_id: ORG, service_type: 'slack', name: 'slack', sealed_for: 'bidding_ring', credential_generation: 1,
      credential_enc: 'ring-ciphertext', config: { bot_token: ALERT_TOKEN }, target: null, acts_as: null, person_bound: false,
    },
  ]
}

type RpcAnswer = { data: unknown; error: { code: string; message: string } | null }

interface StoreOptions {
  /** remove_ops_connection's workflows using a connection, by id. */
  using?: Record<string, Array<{ id: string; name: string; deleted: boolean }>>
  /** Stand in for the database's answer to an rpc. */
  rpc?: Partial<Record<string, (args: Record<string, unknown>) => RpcAnswer>>
}

/** service_connections as the bidding database keeps it, with the two functions' rules. */
function storeDouble(order: string[], opts: StoreOptions = {}) {
  const table = rows()
  const selects: string[] = []
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
  const from = (name: string) => {
    const filters: Array<(r: Row) => boolean> = []
    const b = {
      select(cols: string) { if (name === 'service_connections') selects.push(cols); return b },
      eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return b },
      async maybeSingle() {
        return { data: table.find((r) => filters.every((f) => f(r))) ?? null, error: null }
      },
    }
    return b
  }
  const found = (org: unknown, id: unknown) => table.find((r) => r.id === id && r.organization_id === org)
  const functions: Record<string, (a: Record<string, unknown>) => RpcAnswer> = {
    reconnect_ops_connection: (a) => {
      const row = found(a.p_organization_id, a.p_connection_id)
      if (!row) return { data: null, error: { code: 'P0002', message: 'connection_not_found' } }
      if (row.sealed_for !== 'ops_key') return { data: null, error: { code: 'BP422', message: 'connection_not_ops_key' } }
      if (row.credential_generation !== a.p_expected_generation) return { data: [{ outcome: 'stale_generation', current_generation: row.credential_generation }], error: null }
      Object.assign(row, { credential_enc: JSON.stringify(a.p_envelope), credential_generation: a.p_new_generation, acts_as: a.p_acts_as, updated_by: a.p_actor })
      return { data: [{ outcome: 'reconnected', current_generation: a.p_new_generation }], error: null }
    },
    remove_ops_connection: (a) => {
      const row = found(a.p_organization_id, a.p_connection_id)
      if (!row) return { data: null, error: { code: 'P0002', message: 'connection_not_found' } }
      if (row.sealed_for !== 'ops_key') return { data: null, error: { code: 'BP422', message: 'connection_not_ops_key' } }
      const using = opts.using?.[row.id as string] ?? []
      if (using.length > 0) return { data: [{ outcome: 'connection_in_use', removed_generation: null, workflows: using }], error: null }
      table.splice(table.indexOf(row), 1)
      return { data: [{ outcome: 'removed', removed_generation: row.credential_generation, workflows: [] }], error: null }
    },
  }
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === 'auth_user_with_allowlist') {
      return Promise.resolve({ data: [{ id: USER, organization_id: ORG, email: 'dan@pennie.com', display_name: 'Dan Wright', allowed: true }], error: null })
    }
    order.push(`rpc:${name}`)
    rpcs.push({ name, args })
    const answer = opts.rpc?.[name] ?? functions[name]
    return Promise.resolve(answer ? answer(args) : { data: null, error: { code: '42883', message: `no function ${name}` } })
  }
  return { from, rpc, table, selects, rpcs }
}

const VERIFIED = { kind: 'salesforce', sf_org_id: '00DDp00000170r6MAA', username: 'pennie.api@achieve.example' }

type OpsFn = (r: unknown) => Promise<unknown>

function makeEnv(order: string[], ops: Partial<Record<'verify' | 'clearReauth' | 'revoke', OpsFn>> = {}) {
  const recorded = (name: string, fn: OpsFn) => vi.fn(async (r: unknown) => { order.push(name); return fn(r) })
  const binding = {
    verify: recorded('verify', ops.verify ?? (async (r) => {
      const c = parseVerifyRequest(r).candidate!
      return { ok: true, service: c.service, generation: c.generation, identity: VERIFIED }
    })),
    clearReauth: recorded('clearReauth', ops.clearReauth ?? (async (r) => {
      const c = parseClearReauthRequest(r).candidate
      return { ok: true, service: c.service, generation: c.generation, identity: VERIFIED, cleared: true }
    })),
    revoke: recorded('revoke', ops.revoke ?? (async () => ({ ok: true, outcome: 'recorded', copies_removed: 1 }))),
    health: vi.fn(), lookup: vi.fn(), exchangeOAuthCode: vi.fn(),
    addDelegationSubject: vi.fn(), removeDelegationSubject: vi.fn(), listDelegationSubjects: vi.fn(),
  }
  // Shaped like the real RPC stub, so a call it would refuse fails here too (#2570).
  const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, OPS_CONNECTIONS: rpcStub(binding) } as unknown as Env
  return { env, binding }
}

const ctx = recordingContext()

async function call(env: Env, method: string, path: string, body?: unknown) {
  const { default: api } = await import('../index')
  return api.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }, env, ctx)
}

const reconnect = (env: Env, id: string, body?: unknown) => call(env, 'POST', `/connections/${id}/reconnect`, body)
const remove = (env: Env, id: string) => call(env, 'DELETE', `/connections/${id}`)

interface Answer { error?: string; message?: string; [k: string]: unknown }

let keys: TestKeys
let errors: string[]

beforeAll(async () => {
  keys = await makeKeys()
  Object.assign(fixtures.publicKeys, keys.publicKeys)
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  errors = []
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')) })
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Reconnect with a new client secret: verify, then compare and set, then clearReauth (F116)', () => {
  it('reseals under the connection\'s id at the next generation, verifies that envelope, commits it, and only then clears', async () => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'reconnected', connection: { id: CONN, generation: 4, acts_as: 'pennie.api@achieve.example' } })
    expect(order).toEqual(['verify', 'rpc:reconnect_ops_connection', 'clearReauth'])

    const verify = parseVerifyRequest(binding.verify.mock.calls[0][0])
    expect(verify).toMatchObject({ organization_id: ORG, connection_id: CONN })
    expect(verify.candidate).toMatchObject({ service: 'salesforce', generation: 4, target: TARGET, public_config: {} })
    // The client id is kept from the row; the secret is the new one; the AAD binds this connection at generation 4.
    const plaintext = await open(keys.privateKeys, verify.candidate!.envelope, { organization_id: ORG, connection_id: CONN, service: 'salesforce', generation: 4, kid: 'ops-test-1' })
    expect(JSON.parse(plaintext)).toEqual({ client_id: CLIENT_ID, client_secret: NEW_SECRET })

    expect(db.rpcs[0].args).toEqual({
      p_organization_id: ORG, p_connection_id: CONN, p_expected_generation: 3, p_new_generation: 4, p_envelope: verify.candidate!.envelope,
      p_acts_as: 'pennie.api@achieve.example', p_actor: USER, p_actor_email: 'dan@pennie.com',
    })
    const clear = parseClearReauthRequest(binding.clearReauth.mock.calls[0][0])
    expect(clear.candidate).toEqual(verify.candidate)
    expect(db.table.find((r) => r.id === CONN)?.credential_generation).toBe(4)
  })

  it('the compare and set loses after verify passed: 409 by name, and clearReauth is never called', async () => {
    const order: string[] = []
    // Another Reconnect committed generation 4 while this one was being verified.
    const db = storeDouble(order, { rpc: { reconnect_ops_connection: () => ({ data: [{ outcome: 'stale_generation', current_generation: 4 }], error: null }) } })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET } })
    expect(res.status).toBe(409)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('reconnect_stale')
    expect(body.message).toMatch(/Nothing was saved/)
    expect(binding.verify).toHaveBeenCalledTimes(1)
    expect(binding.clearReauth).not.toHaveBeenCalled()
    expect(order).toEqual(['verify', 'rpc:reconnect_ops_connection'])
  })

  it('a compare and set that does not answer may have written, so it is not claimed either way, and clearReauth is never called', async () => {
    const order: string[] = []
    const db = storeDouble(order, { rpc: { reconnect_ops_connection: () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }) } })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('reconnect_unconfirmed')
    expect(binding.clearReauth).not.toHaveBeenCalled()
  })

  it.each<[string, OpsFn]>([
    ['ops refused the clearing', async () => ({ ok: false, refused: 'reauth_clear_unrecorded', detail: 'the clearing could not be written', retry_at: null })],
    ['ops did not answer', async () => { throw new Error('internal error; reference = 0a0b0c') }],
  ])('clearReauth failing after the commit (%s) answers that the login is saved but the check has not cleared', async (_why, clear) => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, { clearReauth: clear })

    const res = await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET } })
    expect(res.status).toBe(502)
    const body = (await res.json()) as Answer
    expect(body.error).toBe('reconnect_saved_check_not_cleared')
    expect(body.saved).toEqual({ generation: 4 })
    expect(body.message).toMatch(/^The new client secret is saved/)
    // The commit stands: it is the one home, and ops serves it within a minute.
    expect(db.table.find((r) => r.id === CONN)?.credential_generation).toBe(4)
    expect(order).toEqual(['verify', 'rpc:reconnect_ops_connection', 'clearReauth'])
  })

  it('a verify that refuses the new secret commits nothing and clears nothing, answering the save form\'s sentence', async () => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order, { verify: async () => ({ ok: false, refused: 'connection_needs_reauth', detail: 'the token endpoint refused the login', retry_at: null }) })

    const res = await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET } })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'connection_needs_reauth', message: 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.' })
    expect(db.rpcs).toEqual([])
    expect(binding.clearReauth).not.toHaveBeenCalled()
  })

  it('keeps what the connection names: a changed org or client id is refused before anything is sealed', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(order) as never)
    const { env } = makeEnv(order)
    const res = await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET, client_id: '3MVG9-another-app' } })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'reconnect_target_changed', fields: ['client_id'] })
    expect(order).toEqual([])
    // The same client id, sent back unchanged, is no change.
    expect((await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET, client_id: CLIENT_ID } })).status).toBe(200)
  })

  it('a blank new secret is named by its label, and nothing is sent', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(order) as never)
    const { env } = makeEnv(order)
    const res = await reconnect(env, CONN, { fields: { client_secret: '  ' } })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'connection_fields_missing', message: 'Client secret is empty. Nothing was saved. Fill it in and save again.' })
    expect(order).toEqual([])
  })

  it('never carries the new secret in the clear: not to ops, not into the database, not in the answer', async () => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)
    const res = await reconnect(env, CONN, { fields: { client_secret: NEW_SECRET } })
    expect(await res.text()).not.toContain(NEW_SECRET)
    expect(JSON.stringify([binding.verify.mock.calls, binding.clearReauth.mock.calls, db.rpcs, db.table])).not.toContain(NEW_SECRET)
  })
})

describe('Reconnect without a new login: clearReauth alone', () => {
  it('checks the row\'s own envelope at its own generation, commits nothing, and audits who asked', async () => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await reconnect(env, CONN)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'checked', connection: { id: CONN, generation: 3, acts_as: 'pennie.api@achieve.example' } })
    expect(order).toEqual(['clearReauth'])
    expect(parseClearReauthRequest(binding.clearReauth.mock.calls[0][0]).candidate).toEqual({
      service: 'salesforce', generation: 3, envelope: STORED_ENVELOPE, target: TARGET, public_config: {},
    })
    expect(writeAuditLog).toHaveBeenCalledWith(db, ORG, 'service_connection', CONN, 'connection_rechecked', USER, { generation: 3 })
    expect(JSON.stringify(vi.mocked(writeAuditLog).mock.calls[0].slice(1))).not.toContain(STORED_ENVELOPE.wrapped_key)
  })

  it('a check that fails is answered by its sentence, and nothing is audited as cleared', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(order) as never)
    const { env } = makeEnv(order, { clearReauth: async () => ({ ok: false, refused: 'connection_needs_reauth', detail: 'refused', retry_at: null }) })
    const res = await reconnect(env, CONN, {})
    expect(res.status).toBe(422)
    expect(((await res.json()) as Answer).error).toBe('connection_needs_reauth')
    expect(writeAuditLog).not.toHaveBeenCalled()
  })

  it('a clearing ops could not record has its own sentence', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(order) as never)
    const { env } = makeEnv(order, { clearReauth: async () => ({ ok: false, refused: 'reauth_clear_unrecorded', detail: 'x', retry_at: null }) })
    const res = await reconnect(env, CONN)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'reauth_clear_unrecorded', message: expect.stringMatching(/^The login check passed, but/) })
  })
})

describe('Remove: refused while used, otherwise removed and then revoked at once', () => {
  it('removes a connection no workflow uses, then revokes that generation on ops straight away', async () => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await remove(env, CONN)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'removed', connection: { id: CONN, generation: 3 }, ops: { told: true } })
    expect(order).toEqual(['rpc:remove_ops_connection', 'revoke'])
    expect(db.rpcs[0].args).toEqual({ p_organization_id: ORG, p_connection_id: CONN, p_actor: USER })
    const revoke = parseRevokeRequest(binding.revoke.mock.calls[0][0])
    expect(revoke).toMatchObject({ organization_id: ORG, connection_id: CONN, generation: 3 })
    expect(Math.abs(Date.parse(revoke.removed_at) - Date.now())).toBeLessThan(60_000)
    expect(db.table.some((r) => r.id === CONN)).toBe(false)
  })

  it('while workflows use it, answers 409 naming every one, deleted ones marked, and revokes nothing (D9)', async () => {
    const order: string[] = []
    const using = [
      { id: 'a1000000-0000-4000-8000-000000000001', name: 'Achieve report import', deleted: false },
      { id: 'a1000000-0000-4000-8000-000000000002', name: 'Old import', deleted: true },
    ]
    const db = storeDouble(order, { using: { [CONN]: using } })
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const res = await remove(env, CONN)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'connection_in_use',
      message: 'Achieve report import and Old import (deleted) use this connection, so it cannot be removed. Nothing was removed. Take it out of each of them first, and ask Dan about a deleted one.',
      workflows: using,
    })
    expect(binding.revoke).not.toHaveBeenCalled()
    expect(db.table.some((r) => r.id === CONN)).toBe(true)
  })

  it.each<[string, OpsFn]>([
    ['ops could not write the tombstone', async () => ({ ok: false, refused: 'revoke_unrecorded', detail: 'the ops tombstone could not be written', retry_at: null })],
    ['ops did not answer', async () => { throw new Error('internal error; reference = 0a0b0c') }],
  ])('a revoke that fails (%s) leaves the removal standing, and says when ops stops using the login', async (_why, revoke) => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env } = makeEnv(order, { revoke })

    const res = await remove(env, CONN)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { outcome: string; ops: { told: boolean; cause: string; message: string } }
    expect(body.outcome).toBe('removed')
    expect(body.ops.told).toBe(false)
    expect(body.ops.message).toMatch(/^The connection is removed\..*within 6 hours at the latest/)
    expect(db.table.some((r) => r.id === CONN)).toBe(false)
    expect(errors.some((l) => l.includes('connection_revoke_failed') && l.includes(CONN))).toBe(true)
  })

  it('a removal that does not answer is not claimed either way, and revokes nothing', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(order, { rpc: { remove_ops_connection: () => ({ data: null, error: { code: '08006', message: 'connection failure' } }) } }) as never)
    const { env, binding } = makeEnv(order)
    const res = await remove(env, CONN)
    expect(res.status).toBe(503)
    expect(((await res.json()) as Answer).error).toBe('connection_remove_unconfirmed')
    expect(binding.revoke).not.toHaveBeenCalled()
  })
})

describe('the Slack alert login and other organizations are refused by every route', () => {
  it('another organization\'s connection is no such connection to reconnect, remove or look up, and ops is asked nothing', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(order) as never)
    const { env, binding } = makeEnv(order)
    for (const res of [
      await reconnect(env, OTHER_CONN, { fields: { client_secret: NEW_SECRET } }),
      await reconnect(env, OTHER_CONN),
      await remove(env, OTHER_CONN),
      await call(env, 'POST', `/connections/${OTHER_CONN}/lookup/objects`, {}),
    ]) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as Answer).error).toBe('connection_not_found')
    }
    expect([binding.verify, binding.clearReauth, binding.revoke, binding.lookup].every((f) => f.mock.calls.length === 0)).toBe(true)
  })

  it('the Slack alert row is neither reconnected nor removed here, and its token is never read (#2060: the saved Slack copy is untouched)', async () => {
    const order: string[] = []
    const db = storeDouble(order)
    vi.mocked(createSupabaseClient).mockReturnValue(db as never)
    const { env, binding } = makeEnv(order)

    const r = await reconnect(env, ALERT_ROW, { fields: { client_secret: NEW_SECRET } })
    expect(r.status).toBe(422)
    expect(((await r.json()) as Answer).error).toBe('connection_not_reconnectable')
    const d = await remove(env, ALERT_ROW)
    expect(d.status).toBe(422)
    expect(((await d.json()) as Answer).error).toBe('connection_not_removable')

    expect(binding.verify).not.toHaveBeenCalled()
    expect(binding.revoke).not.toHaveBeenCalled()
    expect(db.rpcs.filter((c) => c.name === 'reconnect_ops_connection')).toEqual([])
    expect(db.table.find((r) => r.id === ALERT_ROW)).toMatchObject({ credential_enc: 'ring-ciphertext', config: { bot_token: ALERT_TOKEN } })
    // Only the read filtered to ops_key rows asks for config; the one that finds the alert row asks for its id alone.
    expect(db.selects.filter((cols) => /config|credential_enc/.test(cols))).toHaveLength(1)
  })

  it('a body naming an organization is refused: the caller\'s own is the only one', async () => {
    const order: string[] = []
    vi.mocked(createSupabaseClient).mockReturnValue(storeDouble(order) as never)
    const { env } = makeEnv(order)
    const res = await reconnect(env, CONN, { organization_id: OTHER_ORG, fields: { client_secret: NEW_SECRET } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as Answer).error).toBe('connection_request_invalid')
    expect(order).toEqual([])
  })
})
