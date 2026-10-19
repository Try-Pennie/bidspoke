import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { connectionFetch, type CandidateConnection, type ConnectionCall } from '../../connection-fetch'
import { ConnectionRefusal, LoginMintError } from '../../refusals'
import type { Authorization, AuthorizeInput, ServiceRules } from '../../service-rules'
import type { AccessTokenRequest, ExchangeRequest } from '../../token-object-contract'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type TestKeys } from '../../__tests__/harness'
import { exchangeOAuthCode, oauthUserAuth, type OAuthUserService, type TokenObjects } from '../oauth-user'

/**
 * The person bound minter (#2335, PR 5 of phase 5 of #1689; Dan's decision 1):
 * the auth for an OAuth user login, which goes to the connection's
 * ConnectionTokenObject for its token (single flight and the rotated refresh
 * token live there, proven in workerd: connection-token-object.workers.test.ts),
 * and exchangeOAuthCode, which hands a person's consent to the same object.
 * Here the object is a double: what is proven is what crosses to it, how its
 * answers become a LoginMintError by kind, and that connectionFetch then does
 * what Dan's decision 2 says with each.
 */

const TOKEN_URL = 'https://oauth2.example.test/token'
const SERVICE: OAuthUserService = {
  tokenUrl: (target) => {
    if ((target as { tenant?: unknown } | null)?.tenant === 'unknown') throw new LoginMintError('not_allowed', 'target_invalid')
    return TOKEN_URL
  },
  expired: (response) => response.status === 401,
}
const TARGET = { host: 'api.example.test' }

let keys: TestKeys
let envelope: SealedEnvelope
beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { service: 'example', plaintext: JSON.stringify({ client_id: 'app', refresh_token: 'refresh-token-canary-2335' }) })
}, 120_000)

interface ObjectDouble extends TokenObjects {
  accessCalls: AccessTokenRequest[]
  exchangeCalls: ExchangeRequest[]
  named: string[]
}

/** The token object: answers in order (the last repeats); an Error is thrown across the stub. */
function tokenObjects(...answers: unknown[]): ObjectDouble {
  const next = () => {
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (answer instanceof Error) throw answer
    return answer
  }
  const d: ObjectDouble = {
    accessCalls: [],
    exchangeCalls: [],
    named: [],
    get: (connectionId) => {
      d.named.push(connectionId)
      return {
        accessToken: async (request) => { d.accessCalls.push(request); return next() },
        exchange: async (request) => { d.exchangeCalls.push(request); return next() },
      }
    },
  }
  return d
}

const token = (value: string, over: Record<string, unknown> = {}) => ({ ok: true, token: value, tokenId: `id-of-${value}`, expiresAtMs: T0 + 3_600_000, minted: true, ...over })
const failed = (kind: string, reason: string, retryAtMs: number | null = null) => ({ ok: false, kind, reason, retryAtMs })

function input(over: Partial<AuthorizeInput> = {}): AuthorizeInput & { mints: number } {
  const counted = { mints: 0 }
  return Object.assign(counted, {
    organizationId: ORG,
    connectionId: CONN,
    service: 'example',
    generation: 1,
    target: TARGET,
    publicConfig: {},
    envelope,
    login: { plaintext: '{}' },
    candidate: false,
    renew: null,
    noteMint: () => { counted.mints += 1 },
    // A person bound login asks its token object, never a token endpoint, so this fetch is never called.
    fetch: async (): Promise<Response> => { throw new Error('a person bound auth asked a token endpoint itself') },
    ...over,
  })
}

describe('oauthUserAuth: the auth of a person bound login', () => {
  it('asks the connection\'s object with the sealed envelope, never the opened login, and answers a bearer token', async () => {
    const objects = tokenObjects(token('access-one'))
    const auth = oauthUserAuth({ tokens: objects, now: () => T0 }, SERVICE)
    const i = input()
    const authorization = await auth.authorize(i)
    expect(authorization).toEqual({ headers: { authorization: 'Bearer access-one' }, secrets: ['access-one'] })
    expect(objects.named).toEqual([CONN])
    expect(objects.accessCalls).toEqual([{ organizationId: ORG, connectionId: CONN, service: 'example', generation: 1, envelope, tokenUrl: TOKEN_URL, rejectedTokenId: null }])
    expect(JSON.stringify(objects.accessCalls)).not.toContain('refresh-token-canary-2335')
    expect(i.mints).toBe(1)
  })

  it('reuses its per isolate memo before going to the object, and counts no mint the object did not ask for', async () => {
    const objects = tokenObjects(token('access-one', { minted: false }))
    const auth = oauthUserAuth({ tokens: objects, now: () => T0 }, SERVICE)
    const first = input()
    await auth.authorize(first)
    await auth.authorize(input())
    expect(objects.accessCalls).toHaveLength(1)
    expect(first.mints).toBe(0)
  })

  it('on a renewal names the rejected token to the object, so it drops only that one, and mints afresh', async () => {
    const objects = tokenObjects(token('access-one'), token('access-two'))
    const auth = oauthUserAuth({ tokens: objects, now: () => T0 }, SERVICE)
    const rejected: Authorization = await auth.authorize(input())
    const renewed = await auth.authorize(input({ renew: { rejected } }))
    expect(renewed.secrets).toEqual(['access-two'])
    expect(objects.accessCalls.map((c) => c.rejectedTokenId)).toEqual([null, 'id-of-access-one'])
  })

  it('refuses a candidate: refreshing it for one call would spend a rotating refresh token (L5)', async () => {
    const objects = tokenObjects(token('never'))
    const auth = oauthUserAuth({ tokens: objects, now: () => T0 }, SERVICE)
    await expect(auth.authorize(input({ candidate: true }))).rejects.toMatchObject({ kind: 'not_allowed', reason: 'candidate_not_refreshable' })
    expect(objects.accessCalls).toEqual([])
  })

  it('a target the service cannot read is refused by rule before the object is asked', async () => {
    const objects = tokenObjects(token('never'))
    const auth = oauthUserAuth({ tokens: objects, now: () => T0 }, SERVICE)
    await expect(auth.authorize(input({ target: { tenant: 'unknown' } }))).rejects.toMatchObject({ kind: 'not_allowed', reason: 'target_invalid' })
    expect(objects.accessCalls).toEqual([])
  })

  it.each([
    ['refused', 'invalid_client', null],
    ['unavailable', 'token_endpoint_timeout', null],
    ['rate_limited', 'token_endpoint_rate_limited', T0 + 30_000],
    ['token_object_unavailable', 'token_object_failed', null],
  ] as const)('the object\'s %s failure is thrown as a LoginMintError of that kind', async (kind, reason, retryAtMs) => {
    const auth = oauthUserAuth({ tokens: tokenObjects(failed(kind, reason, retryAtMs)), now: () => T0 }, SERVICE)
    const err = await auth.authorize(input()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LoginMintError)
    expect(err).toMatchObject({ kind, reason, retryAt: retryAtMs === null ? null : new Date(retryAtMs) })
  })

  it.each([
    ['throws across the stub', new Error('Durable Object reset because its code was updated')],
    ['answers a shape this code does not read', { ok: true, token: 'x' }],
    ['answers a reason it does not know', failed('refused', 'something_new')],
  ])('an object that %s is token_object_unavailable, never a refresh failure', async (_what, answer) => {
    const auth = oauthUserAuth({ tokens: tokenObjects(answer), now: () => T0 }, SERVICE)
    await expect(auth.authorize(input())).rejects.toMatchObject({ kind: 'token_object_unavailable', reason: 'token_object_unavailable' })
  })
})

describe('through connectionFetch, Dan\'s decision 2 holds for a person bound login', () => {
  function personBoundRules(objects: TokenObjects): ServiceRules {
    return {
      service: 'example',
      declaredHosts: () => ['api.example.test'],
      ...oauthUserAuth({ tokens: objects, now: () => T0 }, SERVICE),
    }
  }
  const call = (): ConnectionCall => ({ organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'lookup', record: { recordsNothing: 'test' } })

  it('invalid_client from the token endpoint is needs_reauth at once', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), () => [personBoundRules(tokenObjects(failed('refused', 'invalid_client')))])
    const err = await connectionFetch(d.deps, call(), 'https://api.example.test/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectionRefusal)
    expect((err as ConnectionRefusal).code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: 'login_refused: invalid_client' }])
  })

  it('a timeout adds to the refresh streak, and is needs_reauth once the database says the bound is passed', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), () => [personBoundRules(tokenObjects(failed('unavailable', 'token_endpoint_timeout')))])
    const first = await connectionFetch(d.deps, call(), 'https://api.example.test/x').catch((e: unknown) => e)
    expect((first as ConnectionRefusal).code).toBe('connection_auth_unavailable')
    d.refreshAnswer('needs_reauth')
    const second = await connectionFetch(d.deps, call(), 'https://api.example.test/x').catch((e: unknown) => e)
    expect((second as ConnectionRefusal).code).toBe('connection_needs_reauth')
    expect(d.rec.refreshes.map((r) => r.result)).toEqual([{ ok: false, cause: 'token_endpoint_timeout' }, { ok: false, cause: 'token_endpoint_timeout' }])
  })

  it('a token the object minted ends the streak; one it held does not claim to', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), () => [personBoundRules(tokenObjects(token('access-one', { minted: false })))])
    await connectionFetch(d.deps, call(), 'https://api.example.test/x')
    expect(d.rec.refreshes).toEqual([])
    const m = makeDoubles(keys, usableCopy(envelope), () => [personBoundRules(tokenObjects(token('access-one')))])
    await connectionFetch(m.deps, call(), 'https://api.example.test/x')
    expect(m.rec.refreshes).toEqual([{ organizationId: ORG, connectionId: CONN, result: { ok: true } }])
  })
})

describe('exchangeOAuthCode: a person\'s consent, handed to the connection\'s object', () => {
  const CODE = 'authorization-code-canary-2335'
  const VERIFIER = 'pkce-verifier-canary-2335-'.padEnd(43, 'x')
  const REDIRECT = 'https://bidspoke.trypennie.dev/oauth/callback'

  function exchangeCall(candidate: CandidateConnection, over: Record<string, unknown> = {}) {
    return { organizationId: ORG, connectionId: CONN, candidate, code: CODE, verifier: VERIFIER, redirectUri: REDIRECT, ...over }
  }
  const appCandidate = (generation = 1): CandidateConnection => ({ service: 'example', generation, envelope, target: TARGET, publicConfig: {} })

  it('hands the object the row\'s sealed app login and the code, and answers the new generation, never a token', async () => {
    const objects = tokenObjects({ ok: true, generation: 2 })
    const d = makeDoubles(keys, usableCopy(envelope), () => [])
    await expect(exchangeOAuthCode({ tokens: objects, readCopy: d.deps.readCopy }, SERVICE, exchangeCall(appCandidate()))).resolves.toEqual({ generation: 2 })
    expect(objects.exchangeCalls).toEqual([{
      organizationId: ORG, connectionId: CONN, service: 'example', generation: 1, envelope, tokenUrl: TOKEN_URL, code: CODE, verifier: VERIFIER, redirectUri: REDIRECT,
    }])
  })

  it('a new connection with no copy on ops yet may exchange', async () => {
    const objects = tokenObjects({ ok: true, generation: 2 })
    const d = makeDoubles(keys, { state: 'not_found', connectionId: CONN, service: null, generation: null, envelope: null, publicConfig: null, target: null, servedAt: null, serveUntil: null, dbNow: new Date(T0).toISOString() }, () => [])
    await expect(exchangeOAuthCode({ tokens: objects, readCopy: d.deps.readCopy }, SERVICE, exchangeCall(appCandidate()))).resolves.toEqual({ generation: 2 })
  })

  it.each([
    ['a removed connection', usableCopy(envelope, { state: 'connection_removed' }), appCandidate(), 'connection_removed'],
    ['a candidate older than the copy ops holds', usableCopy(envelope, { generation: 3 }), appCandidate(2), 'connection_generation_older'],
    ['a candidate of another service', usableCopy(envelope, { service: 'other' }), appCandidate(), 'connection_service_mismatch'],
  ] as const)('refuses %s before the object is asked', async (_what, copy, candidate, code) => {
    const objects = tokenObjects({ ok: true, generation: 2 })
    const d = makeDoubles(keys, copy, () => [])
    const err = await exchangeOAuthCode({ tokens: objects, readCopy: d.deps.readCopy }, SERVICE, exchangeCall(candidate)).catch((e: unknown) => e)
    expect((err as ConnectionRefusal).code).toBe(code)
    expect(objects.exchangeCalls).toEqual([])
  })

  it('refuses a malformed call by name', async () => {
    const objects = tokenObjects({ ok: true, generation: 2 })
    const d = makeDoubles(keys, usableCopy(envelope), () => [])
    for (const over of [{ organizationId: 'org' }, { connectionId: 'conn' }, { code: '' }, { verifier: 'short' }, { redirectUri: 'http://bidspoke.trypennie.dev/cb' }]) {
      const err = await exchangeOAuthCode({ tokens: objects, readCopy: d.deps.readCopy }, SERVICE, exchangeCall(appCandidate(), over)).catch((e: unknown) => e)
      expect((err as ConnectionRefusal).code).toBe('connection_call_invalid')
    }
    expect(objects.exchangeCalls).toEqual([])
  })

  it.each([
    [failed('refused', 'invalid_grant'), 'connection_needs_reauth'],
    [failed('refused', 'refresh_token_missing'), 'connection_needs_reauth'],
    [failed('unavailable', 'token_endpoint_5xx'), 'connection_auth_unavailable'],
    [failed('rate_limited', 'token_endpoint_rate_limited', T0 + 60_000), 'connection_auth_unavailable'],
    [failed('token_object_unavailable', 'token_object_failed'), 'connection_token_object_unavailable'],
    [new Error('the object was reset'), 'connection_token_object_unavailable'],
    [{ ok: true, generation: 'two' }, 'connection_token_object_unavailable'],
  ])('a failed exchange is refused by name, records nothing about the connection, and carries neither the code nor the verifier (F120)', async (answer, code) => {
    const d = makeDoubles(keys, usableCopy(envelope), () => [])
    const err = await exchangeOAuthCode({ tokens: tokenObjects(answer), readCopy: d.deps.readCopy }, SERVICE, exchangeCall(appCandidate())).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectionRefusal)
    expect((err as ConnectionRefusal).code).toBe(code)
    const text = `${(err as Error).message} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`
    expect(text).not.toContain(CODE)
    expect(text).not.toContain('pkce-verifier-canary')
    expect(d.rec.needsReauth).toEqual([])
    expect(d.rec.refreshes).toEqual([])
  })
})
