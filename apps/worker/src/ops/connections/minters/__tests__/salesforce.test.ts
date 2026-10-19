import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { connectionFetch, type ConnectionCall } from '../../connection-fetch'
import { ConnectionRefusal, RequeueAt } from '../../refusals'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Recorder, type TestKeys } from '../../__tests__/harness'
import { SALESFORCE_TOKEN_LIFE_MS, salesforceClientCredentialsAuth } from '../salesforce'
import { rulesOf, tokenEndpoint, type TokenEndpoint } from './minter-harness'

/**
 * The Salesforce client_credentials minter (#2335, PR 4 of phase 5): the ops
 * connected app of an org, its run as user, and the instance_url the target
 * declares. Driven through connectionFetch, so every answer below is what a
 * caller would get. The money path's getSalesforceToken and its KV cache are
 * not used and not touched.
 */

const TARGET = { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'ops-client-id-3MVG' }
const LOGIN = { client_id: 'ops-client-id-3MVG', client_secret: 'canary-sf-client-secret-5e7d' }
const URL_ = 'https://trypennie.my.salesforce.com/services/data/v60.0/query?q=SELECT+Id+FROM+Account'
const INVALID_SESSION = () => Response.json([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }], { status: 401 })

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { service: 'salesforce', plaintext: JSON.stringify(LOGIN) })
}, 120_000)

function setup(endpoint: TokenEndpoint, opts: { login?: SealedEnvelope; target?: unknown; tokenTimeoutMs?: number } = {}) {
  let now = T0
  const auth = salesforceClientCredentialsAuth({ now: () => now, tokenTimeoutMs: opts.tokenTimeoutMs })
  // The token request goes through connectionFetch's fetch, which hands it to the endpoint double.
  const d = makeDoubles(keys, usableCopy(opts.login ?? envelope, { service: 'salesforce', target: opts.target ?? TARGET }), () => [
    rulesOf('salesforce', auth, (target) => [new URL((target as { instance_url: string }).instance_url).hostname]),
  ], endpoint.fetch)
  return { d, auth, advance: (ms: number) => { now += ms; d.now.value = now } }
}

function call(rec: Recorder, overrides: Partial<ConnectionCall> = {}): ConnectionCall {
  return { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'lookup', record: async (r) => { rec.recorded.push(r) }, ...overrides }
}

async function refusal(promise: Promise<unknown>): Promise<ConnectionRefusal> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ConnectionRefusal) return err
    throw new Error(`expected a ConnectionRefusal, got ${String(err)}`, { cause: err })
  }
  throw new Error('expected a ConnectionRefusal, and the call answered')
}

const bearer = (d: ReturnType<typeof setup>['d'], i: number) => new Headers(d.rec.sent[i].init.headers).get('authorization')

describe('the Salesforce minter: client_credentials against the declared instance', () => {
  it('asks the declared instance\'s token endpoint with the sealed client, sends the token, and ends a refresh streak', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001', instance_url: TARGET.instance_url }))
    const { d } = setup(endpoint)
    const res = await connectionFetch(d.deps, call(d.rec), URL_)
    expect((res as Response).status).toBe(200)
    expect(endpoint.calls).toHaveLength(1)
    expect(endpoint.calls[0].url).toBe('https://trypennie.my.salesforce.com/services/oauth2/token')
    expect(Object.fromEntries(endpoint.calls[0].body)).toEqual({ grant_type: 'client_credentials', client_id: LOGIN.client_id, client_secret: LOGIN.client_secret })
    expect(bearer(d, 0)).toBe('Bearer sf-token-one-0001')
    expect(d.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: true } }])
    // Every Salesforce request takes a lease from the ops pool, inside connectionFetch.
    expect(d.rec.leases.map((l) => l.op)).toEqual(['acquire', 'release'])
  })

  it('reuses the token for later requests of the connection, and mints again once it is past its life (the expired token)', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }), Response.json({ access_token: 'sf-token-two-0002' }))
    const { d, advance } = setup(endpoint)
    await connectionFetch(d.deps, call(d.rec), URL_)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(endpoint.calls).toHaveLength(1)
    advance(SALESFORCE_TOKEN_LIFE_MS)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(endpoint.calls).toHaveLength(2)
    expect(bearer(d, 2)).toBe('Bearer sf-token-two-0002')
  })

  it('INVALID_SESSION_ID on a held token: exactly one new mint and one retry, and no needs_reauth', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }), Response.json({ access_token: 'sf-token-two-0002' }))
    const { d } = setup(endpoint)
    await connectionFetch(d.deps, call(d.rec), URL_)
    d.respond(INVALID_SESSION(), new Response('{"records":[]}', { status: 200 }))
    const res = await connectionFetch(d.deps, call(d.rec), URL_)
    expect((res as Response).status).toBe(200)
    expect(endpoint.calls).toHaveLength(2)
    expect([bearer(d, 1), bearer(d, 2)]).toEqual(['Bearer sf-token-one-0001', 'Bearer sf-token-two-0002'])
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a session refused again after the renewal is needs_reauth', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }), Response.json({ access_token: 'sf-token-two-0002' }))
    const { d } = setup(endpoint)
    d.respond(INVALID_SESSION())
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(err.code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: 'request_refused_after_renew' }])
    expect(endpoint.calls).toHaveLength(2)
  })

  it.each([
    ['invalid_grant', Response.json({ error: 'invalid_grant', error_description: 'no client credentials user enabled' }, { status: 400 })],
    ['invalid_client', Response.json({ error: 'invalid_client_id', error_description: 'client identifier invalid' }, { status: 400 })],
    ['invalid_client', Response.json({ error: 'invalid_client', error_description: 'invalid client credentials' }, { status: 401 })],
  ] as const)('a refused login (%s) is needs_reauth at once, and nothing is sent', async (reason, answer) => {
    const { d } = setup(tokenEndpoint(answer))
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(err.code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: `login_refused: ${reason}` }])
    expect(d.rec.refreshes).toEqual([])
    expect(d.rec.sent).toEqual([])
  })

  it('a token endpoint that times out is refresh_failing, never needs_reauth on its own', async () => {
    const { d } = setup(tokenEndpoint('hang'), { tokenTimeoutMs: 10 })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(err.code).toBe('connection_auth_unavailable')
    expect(d.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: false, cause: 'token_endpoint_timeout' } }])
    expect(d.rec.needsReauth).toEqual([])
    expect(d.rec.sent).toEqual([])
  })

  it('a token endpoint answering 5xx, or an edge page, is refresh_failing too', async () => {
    for (const [answer, cause] of [
      [new Response('unavailable', { status: 503 }), 'token_endpoint_5xx'],
      [new Response('<html><body>Service Unavailable</body></html>', { status: 400 }), 'token_endpoint_edge_page'],
    ] as const) {
      const { d } = setup(tokenEndpoint(answer))
      expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_auth_unavailable')
      expect(d.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: false, cause } }])
    }
  })

  it('a token endpoint answering 429 is a RequeueAt at its Retry-After, and no failure', async () => {
    const { d } = setup(tokenEndpoint(new Response('REQUEST_LIMIT_EXCEEDED', { status: 429, headers: { 'retry-after': '120' } })))
    const res = await connectionFetch(d.deps, call(d.rec), URL_)
    expect(res).toBeInstanceOf(RequeueAt)
    expect((res as RequeueAt).notBefore.getTime()).toBe(T0 + 120_000)
    expect(d.rec.refreshes).toEqual([])
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a 429 on the request itself is a RequeueAt, with the token still held', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }))
    const { d } = setup(endpoint)
    d.respond(new Response('[{"errorCode":"REQUEST_LIMIT_EXCEEDED"}]', { status: 429 }))
    expect(await connectionFetch(d.deps, call(d.rec), URL_)).toBeInstanceOf(RequeueAt)
    d.respond(new Response('{}', { status: 200 }))
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(endpoint.calls).toHaveLength(1)
  })

  it('a login whose client id is not the one the target declares is refused before anything is asked', async () => {
    const swapped = await sealLogin(keys, { service: 'salesforce', plaintext: JSON.stringify({ ...LOGIN, client_id: 'money-client-id' }) })
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }))
    const { d } = setup(endpoint, { login: swapped })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth[0].cause).toBe('login_refused: client_id_mismatch')
    expect(endpoint.calls).toEqual([])
  })

  it('a login missing its secret is malformed, and nothing is asked', async () => {
    const broken = await sealLogin(keys, { service: 'salesforce', plaintext: JSON.stringify({ client_id: LOGIN.client_id }) })
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }))
    const { d } = setup(endpoint, { login: broken })
    await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(d.rec.needsReauth[0].cause).toBe('login_refused: login_malformed')
    expect(endpoint.calls).toEqual([])
  })

  it('a target whose instance is not an https Salesforce host is refused by rule, and the secret is never sent', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }))
    const { d, auth } = setup(endpoint)
    for (const target of [{ ...TARGET, instance_url: 'https://collector.example.test' }, { ...TARGET, instance_url: 'http://trypennie.my.salesforce.com' }]) {
      await expect(auth.authorize({
        organizationId: ORG, connectionId: CONN, service: 'salesforce', generation: 1, target, publicConfig: {},
        envelope: null, login: { plaintext: JSON.stringify(LOGIN) }, candidate: false, renew: null, noteMint: () => {}, fetch: endpoint.fetch,
      })).rejects.toMatchObject({ kind: 'not_allowed', reason: 'target_invalid' })
    }
    expect(endpoint.calls).toEqual([])
    expect(d.rec.sent).toEqual([])
  })

  it('a candidate (verify, Reconnect) mints for its one call and leaves the committed token alone', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'sf-token-one-0001' }), Response.json({ access_token: 'sf-candidate-0002' }))
    const { d } = setup(endpoint)
    await connectionFetch(d.deps, call(d.rec), URL_)
    const next = await sealLogin(keys, { service: 'salesforce', generation: 2, plaintext: JSON.stringify(LOGIN) })
    await connectionFetch(d.deps, call(d.rec, {
      purpose: 'reconnect',
      source: { kind: 'candidate', candidate: { service: 'salesforce', generation: 2, envelope: next, target: TARGET, publicConfig: {} } },
    }), URL_)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect([bearer(d, 0), bearer(d, 1), bearer(d, 2)]).toEqual(['Bearer sf-token-one-0001', 'Bearer sf-candidate-0002', 'Bearer sf-token-one-0001'])
    expect(d.rec.refreshes).toHaveLength(1)
  })

  it('declares its instance host, which verify\'s bootstrap lease is keyed on', () => {
    const { auth } = setup(tokenEndpoint())
    expect(auth.salesforce?.instanceHost(TARGET)).toBe('trypennie.my.salesforce.com')
  })
})
